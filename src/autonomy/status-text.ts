// Read-only rendering of the supervisor status (terminal `status` and the
// compact in-game reply). No inference, no world access, no account reads.
import type { AutonomyStatus } from '../contracts/autonomy.ts';
import type { LocatorHint } from '../contracts/locator.ts';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function autonomyStatusLines(s: AutonomyStatus, extra: { locator?: LocatorHint | null; admission?: { anchor: { x: number; y: number; z: number }; radius: number } | null } = {}): string[] {
  const lines: string[] = [];
  lines.push(`autonomy: ${s.mode} — ${clip(s.detail, 220)}`);
  const scope = s.scope ? `${s.scope.worldProfile}@r${s.scope.worldRevision}/${s.scope.botProfile}` : 'none';
  lines.push(`autonomy scope: ${scope}; durable state ${s.persistence.state} (rev ${s.persistence.revision}); stop latch ${s.latch.paused ? `PAUSED since ${s.latch.sinceMs ?? '?'} (${s.latch.source ?? 'stop'}; durable ${s.latch.durable})` : `clear (durable ${s.latch.durable})`}`);
  if (s.active) lines.push(`autonomy active: ${s.active.goalId} ${s.active.priority} (${s.active.source.kind}${s.active.source.kind === 'support' ? ` ${s.active.source.routine}` : ''})`);
  if (s.ownerIntent) {
    const intent = s.ownerIntent;
    const continuation = intent.state === 'active' ? '' : intent.requiresOwnerDecision
      ? ' (held, not continued automatically; a new instruction replaces it; resume does not clear it)'
      : ' (held; continues when it is safe; stop cancels it)';
    lines.push(`owner intent: ${intent.state} "${clip(intent.instruction, 80)}" — ${clip(intent.detail, 160)}${continuation}`);
  }
  const sess = s.session;
  lines.push(`autonomy session: progression ${sess.progressionGoals}/${sess.limits.maxProgressionGoals}, support ${sess.supportGoals}/${sess.limits.maxSupportGoals}, automatic planner turns ${sess.plannerTurns}/${sess.limits.maxPlannerTurns}, completed ${sess.completed}, unproductive in a row ${sess.consecutiveUnproductive}, safety revocations ${sess.safetyRevocations}${s.nextAssessmentAtMs !== null ? `; next assessment at ${s.nextAssessmentAtMs}` : ''}`);
  if (s.blocker) lines.push(`autonomy blocker: ${s.blocker.code} — ${clip(s.blocker.detail, 200)}`);
  if (s.lastOutcome) lines.push(`autonomy last: ${s.lastOutcome.goalId} (${s.lastOutcome.source}) ${s.lastOutcome.state} ${s.lastOutcome.reason} — ${clip(s.lastOutcome.detail, 160)}`);
  if (s.home) {
    const h = s.home;
    lines.push(`home: ${h.id} ${h.state} at ${h.origin.x},${h.origin.y},${h.origin.z} ${h.dimension} (${h.outer.x}x${h.outer.z}, entrance ${h.entranceFacing}); own confirmed ${h.progress.ownConfirmed}/${h.progress.cells}; ${h.verified ? `verified ${h.verified.status} ${h.verified.satisfied}/${h.verified.total}` : 'not verified yet'} — ${clip(h.detail, 160)}`);
  }
  if (s.support) {
    const v = s.support;
    lines.push(`survival: ${v.enabled ? 'enabled' : 'disabled'}; store ${v.store.state}${v.activeRoutine ? `; active ${v.activeRoutine.routine} (${v.activeRoutine.goalId})` : ''}${v.lastDecision ? `; last decision ${v.lastDecision.kind}${v.lastDecision.routine ? ` ${v.lastDecision.routine}` : ''}: ${clip(v.lastDecision.reason, 80)}` : ''}`);
    for (const i of v.incidents.slice(0, 2)) lines.push(`death incident ${i.episodeId}: ${i.status}/${i.phase}; site ${i.site.source}${i.site.at ? ` ${Math.round(i.site.at.x)},${Math.round(i.site.at.y)},${Math.round(i.site.at.z)}` : ''}; missing ${i.missing.reduce((n, m) => n + m.count, 0)}, regained ${i.regained.reduce((n, m) => n + m.count, 0)}; attempts ${i.attempts.used}/${i.attempts.max}${i.blocker ? `; blocked ${i.blocker.reason}` : ''}`);
    for (const b of v.blocked.slice(0, 2)) lines.push(`survival blocked: ${b.routine} ${b.reason} — ${clip(b.detail, 140)}`);
  }
  lines.push(...navigationStatusLines(s.route, extra));
  return lines;
}

/** Ordinary manual route/locator status also works without a supervisor. */
export function navigationStatusLines(route: AutonomyStatus['route'], extra: { locator?: LocatorHint | null; admission?: { anchor: { x: number; y: number; z: number }; radius: number } | null } = {}): string[] {
  const lines: string[] = [];
  if (route) {
    const r = route;
    lines.push(`route: ${r.state} (${r.destinations.join('/')}); legs ${r.legsUsed}/${r.maxLegs}; moved ${Math.round(r.distanceUsed)}/${r.maxTotalDistance} blocks (corrections ${r.distanceSources.correctionCount}); ${Math.round(r.remainingMs / 1000)}s left${r.blocker ? `; blocker ${r.blocker.reason}` : ''}${extra.admission ? `; admission anchor ${Math.round(extra.admission.anchor.x)},${Math.round(extra.admission.anchor.y)},${Math.round(extra.admission.anchor.z)} r${extra.admission.radius} (unchanged)` : ''}`);
  }
  if (extra.locator) {
    const h = extra.locator;
    lines.push(`locator: owner ${h.actionable ? `${h.direction ?? '?'} ${h.distanceBand}, ${h.elevation}` : `not actionable (${h.reason})`}${h.ageMs !== null ? `, ${Math.round(h.ageMs / 1000)}s old` : ''} (coarse hint, not visibility)`);
  }
  return lines;
}

export function autonomyStatusChat(s: AutonomyStatus): string {
  const intent = s.ownerIntent && s.ownerIntent.state !== 'active' ? `, your instruction ${s.ownerIntent.state}` : '';
  const home = s.home ? `, home ${s.home.state}` : '';
  return `automatic: ${s.mode}${s.latch.paused ? ' (paused)' : ''}${intent}${home}`;
}
