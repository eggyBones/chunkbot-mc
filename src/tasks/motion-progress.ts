// Owned client-only motion can advance the task stall guard, never its outcome.
// Guidance is supplied by application code from current route/cue authority.
import type { ActionCandidate, AdmittedTask } from '../contracts/index.ts';
import type { OwnedMotionSample, SkillExecutorImpl } from '../execution/executor.ts';

export interface TaskMotionProgressPort {
  watch(task: AdmittedTask, candidate: ActionCandidate, progressed: (receipt: { atMs: number; netProgress: number; provenance: 'client_only' }) => void): () => void;
}

interface MotionGuidance { authorityId: string; bearingRad: number }
type PointSample = { self: OwnedMotionSample['self']; atMs: number; bearingRad: number; correctionSeq: number };

export class TaskMotionProgress implements TaskMotionProgressPort {
  private readonly deps: {
    executor: Pick<SkillExecutorImpl, 'observeMotion'>;
    guidance(task: AdmittedTask, candidate: ActionCandidate, sample: OwnedMotionSample): MotionGuidance | undefined;
  };
  // One active task; net/high-water persist across its local execution windows.
  private state?: { taskKey: string; authorityId: string; origin: OwnedMotionSample['self']; net: number; credited: number; lastObserved?: PointSample };

  constructor(deps: TaskMotionProgress['deps']) { this.deps = deps; }

  watch(task: AdmittedTask, candidate: ActionCandidate, progressed: Parameters<TaskMotionProgressPort['watch']>[2]): () => void {
    const taskKey = JSON.stringify([task.goalId, task.goalEpoch, task.taskId, candidate.connectionEpoch]);
    let last: PointSample | undefined;
    let leaseId: number | undefined;
    return this.deps.executor.observeMotion((sample) => {
      const owner = sample.owner;
      if (candidate.goalEpoch !== task.goalEpoch || owner.kind !== 'goal' || owner.goalId !== task.goalId || owner.taskId !== task.taskId || owner.goalEpoch !== task.goalEpoch || sample.actionId !== candidate.id || sample.capability !== candidate.capability || sample.connectionEpoch !== candidate.connectionEpoch || !task.isCurrent() || task.signal.aborted) return;
      leaseId ??= sample.leaseId;
      if (sample.leaseId !== leaseId) return;
      const guidance = this.deps.guidance(task, candidate, sample);
      if (!guidance || !Number.isFinite(guidance.bearingRad) || ![sample.atMs, sample.self.x, sample.self.y, sample.self.z].every(Number.isFinite)) { last = undefined; return; }
      if (this.state?.taskKey !== taskKey) this.state = { taskKey, authorityId: guidance.authorityId, origin: { ...sample.self }, net: 0, credited: 0 };
      // A replacement grant in the same task cannot reinitialize progress.
      if (this.state.authorityId !== guidance.authorityId) { last = undefined; return; }
      const previous = last;
      last = { self: { ...sample.self }, atMs: sample.atMs, bearingRad: guidance.bearingRad, correctionSeq: sample.correctionSeq };
      const priorObserved = this.state.lastObserved;
      this.state.lastObserved = last;
      if (!previous || sample.commandsIssued < 1 || sample.atMs <= previous.atMs || sample.atMs - previous.atMs > 1_000 || sample.correctionSeq !== previous.correctionSeq) {
        // Discontinuities grant nothing. Conservatively retain negative motion
        // across windows/guidance gaps/corrections so retracing cannot refill.
        if (priorObserved) {
          const dx = sample.self.x - priorObserved.self.x, dz = sample.self.z - priorObserved.self.z;
          this.state.net += Math.min(0, dx * Math.cos(priorObserved.bearingRad) + dz * Math.sin(priorObserved.bearingRad), dx * Math.cos(guidance.bearingRad) + dz * Math.sin(guidance.bearingRad));
        }
        return;
      }
      const dx = sample.self.x - previous.self.x, dz = sample.self.z - previous.self.z;
      // Conservative projection on BOTH current and previous fresh bearings.
      const projection = (bearing: number) => dx * Math.cos(bearing) + dz * Math.sin(bearing);
      this.state.net += Math.min(projection(previous.bearingRad), projection(guidance.bearingRad));
      // Also cap by net displacement from this task's first owned sample. A
      // retreat during a gap or between windows cannot make retracing old
      // ground look like new progress, even if the cue changed direction.
      const useful = Math.min(this.state.net, Math.hypot(sample.self.x - this.state.origin.x, sample.self.z - this.state.origin.z));
      if (useful - this.state.credited < 2) return;
      this.state.credited = useful;
      progressed({ atMs: sample.atMs, netProgress: useful, provenance: 'client_only' });
    });
  }
}
