// Test doubles for ports. These are fixtures for foundation behavior; they are
// never wired into the real CLI.
import { EventEmitter } from 'node:events';
import type {
  ChatEnvelope,
  ConnectionEndReason,
  ConnectionState,
  GameLifecycleEvent,
  GamePort,
  PlannerPort,
  PlannerProposal,
  PlannerRequest,
  ReadyInfo,
  Readiness,
} from '../src/contracts/index.ts';
import { sequentialIds } from '../src/contracts/index.ts';
import { GoalEngine, type GoalEngineDeps, type OwnerNotice } from '../src/goals/goal-engine.ts';
import {
  NotReadyKnowledge,
  NotReadyObservation,
  NotReadyPlanner,
  NotReadySkillExecutor,
  StaticCapabilityRegistry,
} from '../src/goals/not-ready.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { PlannerError } from '../src/planner/errors.ts';

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until `predicate` is true (bounded). */
export async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await tick(2);
  }
}

export const READY_INFO: ReadyInfo = {
  serverVersion: '26.1.2',
  protocolVersion: 775,
  dimension: 'overworld',
  position: { x: 0.5, y: -60, z: 0.5 },
  gameMode: 'survival',
  serverOnlineMode: false,
};

/** Planner whose turns are resolved manually by the test. */
export class ScriptedPlanner implements PlannerPort {
  readonly requests: PlannerRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private pending: Array<{ resolve: (p: PlannerProposal) => void; reject: (e: Error) => void }> = [];
  readonly log: string[];
  constructor(log: string[] = []) {
    this.log = log;
  }
  readiness(): Readiness {
    return { ready: true, detail: 'scripted test planner' };
  }
  propose(request: PlannerRequest, signal: AbortSignal): Promise<PlannerProposal> {
    this.requests.push(request);
    this.signals.push(signal);
    this.log.push(`planner:request:${request.instruction}`);
    // Like a real adapter (PlannerPort: "must honor the abort signal"), an aborted
    // turn's process ends: the promise rejects `aborted`. Non-cooperative planners
    // are covered separately (tests/handoff-slot.test.ts).
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      signal.addEventListener('abort', () => {
        this.log.push(`planner:aborted:${request.instruction}`);
        reject(new PlannerError('aborted', 'turn aborted'));
      }, { once: true });
    });
  }
  respond(proposal: unknown): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending planner turn');
    next.resolve(proposal as PlannerProposal);
  }
  get waiting(): number {
    return this.pending.length;
  }
}

/** A LEGACY (pre-MB-PLAN-006) clarification proposal: raw planner output that code must refuse (never a question to relay). */
export function clarify(question: string): unknown {
  return { version: 1, disposition: 'needs_clarification', interpretation: 'needs a detail', question };
}

export interface EngineHarness {
  engine: GoalEngine;
  store: MemoryRunStore;
  notices: OwnerNotice[];
  log: string[];
  setReady(ready: boolean): void;
}

export function makeEngine(overrides: Partial<GoalEngineDeps> = {}, log: string[] = []): EngineHarness {
  const store = new MemoryRunStore();
  const notices: OwnerNotice[] = [];
  let ready = true;
  const engine = new GoalEngine({
    planner: new NotReadyPlanner(),
    knowledge: new NotReadyKnowledge(),
    observation: new NotReadyObservation(),
    capabilities: new StaticCapabilityRegistry(),
    executor: new NotReadySkillExecutor(),
    store,
    clock: { now: () => Date.now() },
    ids: sequentialIds(),
    limits: {
      maxInstructionChars: 500,
      plannerTurnsPerGoal: 20,
      plannerTimeoutMs: 1_000,
      planWindowSteps: 8,
      totalTaskCeiling: 64,
      goalDeadlineMs: 60_000,
      cleanupTimeoutMs: 200,
    },
    notify: (n) => notices.push(n),
    isGameReady: () => ready,
    ...overrides,
  });
  return { engine, store, notices, log, setReady: (r) => (ready = r) };
}

/** In-memory GamePort that the test drives explicitly. */
export class FakeGame implements GamePort {
  state: ConnectionState = 'disconnected';
  connectionEpoch = 0;
  readonly replies: string[] = [];
  readonly disconnects: ConnectionEndReason[] = [];
  selfUuid: string | undefined = '00000000-0000-3000-8000-00000000b0b0';
  serverOnlineMode = false;
  private readonly events = new EventEmitter();
  private joining: { resolve: (i: ReadyInfo) => void; reject: (e: Error) => void } | undefined;

  connect(signal: AbortSignal): Promise<ReadyInfo> {
    this.connectionEpoch += 1;
    this.state = 'joining';
    this.emit({ type: 'joining', connectionEpoch: this.connectionEpoch });
    return new Promise((resolve, reject) => {
      this.joining = { resolve, reject };
      signal.addEventListener('abort', () => this.end('operator_stop', 'join cancelled by operator'), { once: true });
    });
  }
  completeJoin(info: ReadyInfo = READY_INFO): void {
    this.state = 'ready';
    this.emit({ type: 'ready', connectionEpoch: this.connectionEpoch, info });
    this.joining?.resolve(info);
    this.joining = undefined;
  }
  end(reason: ConnectionEndReason, detail: string): void {
    if (this.state === 'ended' || this.state === 'disconnected') return;
    this.state = 'ended';
    this.emit({ type: 'ended', connectionEpoch: this.connectionEpoch, reason, detail });
    this.joining?.reject(new Error(reason));
    this.joining = undefined;
  }
  async disconnect(reason: ConnectionEndReason, detail = reason): Promise<void> {
    this.disconnects.push(reason);
    this.end(reason, detail);
  }
  emit(event: GameLifecycleEvent): void {
    this.events.emit('lifecycle', event);
  }
  chat(envelope: Partial<ChatEnvelope> & Pick<ChatEnvelope, 'kind' | 'text'>): void {
    this.events.emit('chat', { signatureVerified: false, receivedAtMs: Date.now(), ...envelope });
  }
  onLifecycle(listener: (e: GameLifecycleEvent) => void) {
    this.events.on('lifecycle', listener);
    return () => this.events.off('lifecycle', listener);
  }
  onChat(listener: (e: ChatEnvelope) => void) {
    this.events.on('chat', listener);
    return () => this.events.off('chat', listener);
  }
  admissionContext() {
    return { selfUuid: this.selfUuid, serverOnlineMode: this.serverOnlineMode };
  }
  replyToOwner(text: string): void {
    this.replies.push(text);
  }
  statusInfo() {
    return this.state === 'ready' ? { dimension: 'overworld', position: { x: 0, y: -60, z: 0 }, health: 20 } : {};
  }
}
