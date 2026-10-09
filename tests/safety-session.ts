// Shared module-level rig for safety skill tests: a Mineflayer-shaped bot on
// the installed 26.1.2 registry, the INSTALLED prismarine-physics stepping it
// every 50 ms from the controls actually set, the real Lease/ActuatorLeases/
// Actuator and a minimal executor seam in SkillExecutorImpl order. Never wired
// into the real CLI; no network, no credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { ActionCandidate, ExecutionOwner, SkillOutcome } from '../src/contracts/index.ts';
import { SkillOutcomeSchema } from '../src/contracts/index.ts';
import { sequentialIds } from '../src/contracts/ids.ts';
import type { SafetyAuthority, SafetyConfigInput, SafetyExecutionOwner } from '../src/contracts/safety.ts';
import { Actuator } from '../src/execution/actuator.ts';
import { ActuatorLeases, LeaseRevokedError } from '../src/execution/lease.ts';
import { SkillExecutorImpl } from '../src/execution/executor.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { createSafetyRuntime } from '../src/safety/wiring.ts';
import type { ExecuteContext } from '../src/skills/definition.ts';
import { safetySkills } from '../src/skills/safety.ts';
import { inTag } from './safety-helpers.ts';
import { REGISTRY_26_1_2, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

void assert;
const require = createRequire(import.meta.url);
const { Physics, PlayerState } = require('prismarine-physics') as {
  Physics: (mcData: unknown, world: unknown) => { simulatePlayer(state: unknown, world: unknown): unknown };
  PlayerState: new (bot: unknown, control: Record<string, boolean>) => { apply(bot: unknown): void };
};

export const intervals: Array<ReturnType<typeof setInterval>> = [];
export const stopPhysics = () => intervals.splice(0).forEach(clearInterval);

/** 4-deep pool (x,z in -3..3, water y 0..3) in dirt ground whose top is y=4; optional ceiling. */
export function scene(opts: { ceiling?: boolean; pool?: boolean } = {}) {
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { at: { x: 0.5, y: 0, z: 0.5 }, dimension: 'overworld' });
  fake.fill(-20, -2, -20, 20, -1, 20, 'stone');
  fake.fill(-20, 0, -20, 20, 3, 20, 'dirt');
  if (opts.pool !== false) fake.fill(-3, 0, -3, 3, 3, 3, 'water');
  else fake.fill(-20, 0, -20, 20, 3, 20, 'air');
  if (opts.ceiling) fake.fill(-3, 3, -3, 3, 3, 3, 'stone');
  const bot = fake.bot as unknown as Record<string, unknown> & { entity: Record<string, unknown> & { position: { x: number; y: number; z: number; clone(): unknown } } };
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  Object.assign(bot.entity, { velocity: (bot.entity.position as unknown as { clone(): unknown }).clone(), onGround: true, isInWater: true, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, attributes: {}, yaw: 0, pitch: 0, effects: {} });
  (bot.entity.velocity as { x: number; y: number; z: number }).x = 0;
  (bot.entity.velocity as { y: number }).y = 0;
  (bot.entity.velocity as { z: number }).z = 0;
  Object.assign(bot, {
    version: '26.1.2',
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    setControlState: (c: string, on: boolean) => void (controls[c] = on),
    getControlState: (c: string) => controls[c] ?? false,
    clearControlStates: () => Object.keys(controls).forEach((k) => (controls[k] = false)),
    look: async (yaw: number, pitch: number) => {
      bot.entity['yaw'] = yaw;
      bot.entity['pitch'] = pitch;
    },
    lookAt: async () => undefined,
    pathfinder: { setGoal: () => undefined },
  });
  const mcData = require('minecraft-data')('26.1.2');
  const world = { getBlock: (p: { x: number; y: number; z: number }) => (bot['blockAt'] as (p: unknown) => unknown)(p) };
  const physics = Physics(mcData, world);
  const ticks = { n: 0 };
  intervals.push(
    setInterval(() => {
      const s = new PlayerState(bot, { ...controls });
      physics.simulatePlayer(s, world);
      s.apply(bot);
      ticks.n += 1;
    }, 50),
  );
  const evidence = new ServerEvidence(client, { items: REGISTRY_26_1_2.items, entitiesByName: REGISTRY_26_1_2.entitiesByName });
  evidence.attach();
  const session = { bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  return { client, session, bot, controls, ticks, fake };
}

export const clock = { now: () => Date.now() };

export function runtime(session: GameSession, authority: () => SafetyAuthority, config: SafetyConfigInput = { tickMs: 200 }, opts: { travel?: { anchor: { x: number; y: number; z: number }; radius: number } } = {}) {
  const leases = new ActuatorLeases({
    clock,
    ownerCurrent: (o) => ((o as ExecutionOwner | SafetyExecutionOwner).kind === 'safety' ? rt.service.grantCurrent((o as unknown as SafetyExecutionOwner).grantId) : true),
    connectionEpoch: () => 1,
    clearShared: () => {
      (session.bot as unknown as { clearControlStates(): void }).clearControlStates();
      return { steps: ['controls_cleared'], errors: [] };
    },
  });
  const skills = new Map<string, ReturnType<typeof safetySkills>[number]>();
  const services = {
    perception: {
      travelBounds: () => opts.travel,
      travelAnchorGoalEpoch: () => authority().goal?.goalEpoch,
      withinTravel: (p: { x: number; z: number }) => (opts.travel ? Math.hypot(p.x - opts.travel.anchor.x, p.z - opts.travel.anchor.z) <= opts.travel.radius : true),
      isOwnerEntity: () => false,
    },
    clock,
    ledger: { add: () => undefined },
    limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 10_000 },
  } as unknown as ExecuteContext['services'];
  const executorKind = SkillOutcomeSchema.safeParse({ actionId: 'act-0001', owner: 'safety', connectionEpoch: 1, goalEpoch: 0, status: 'succeeded', elapsedMs: 0, effect: 'probe' }).success ? 'real' : 'stand_in';
  let realExecutor: SkillExecutorImpl;
  /** Minimal executor seam: same order as SkillExecutorImpl (acquire, abort->revoke, run, release). */
  const execute = async (candidate: ActionCandidate, signal: AbortSignal, owner: ExecutionOwner | SafetyExecutionOwner): Promise<SkillOutcome & { commands: number }> => {
    if (executorKind === 'real') {
      const r = await realExecutor.execute(candidate, signal, owner as ExecutionOwner);
      return { ...r, commands: typeof r.evidence['commandsIssued'] === 'number' ? r.evidence['commandsIssued'] : 0 };
    }
    const def = skills.get(candidate.capability)!;
    const lease = leases.acquire(owner as ExecutionOwner);
    const act = new Actuator(session, lease, clock);
    const onAbort = () => leases.revoke(lease, 'owner_stop');
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await def.execute({ act, session, services, candidate, owner: owner as ExecutionOwner, progress: () => undefined }, def.params.parse(candidate.parameters));
      lease.fence();
      return { actionId: candidate.id, owner: 'goal', connectionEpoch: 1, goalEpoch: 0, status: r.status, effect: r.effect, ...(r.reason ? { reason: r.reason } : {}), confirmation: r.confirmation, evidence: r.evidence ?? {}, elapsedMs: 0, commands: act.issued } as SkillOutcome & { commands: number };
    } catch (error) {
      if (error instanceof LeaseRevokedError || lease.revocation) return { actionId: candidate.id, owner: 'goal', connectionEpoch: 1, goalEpoch: 0, status: 'cancelled', effect: 'cancelled', reason: lease.revocation ?? 'cancelled', confirmation: 'none', evidence: {}, elapsedMs: 0, commands: act.issued } as SkillOutcome & { commands: number };
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      leases.revoke(lease, 'completed');
    }
  };
  const rt = createSafetyRuntime({
    config,
    session: () => session,
    perception: { isOwnerEntity: () => false },
    inTag,
    authority,
    actuation: {
      preemptCurrent: (reason) => {
        const cur = leases.current;
        if (!cur || (cur.owner as { kind: string }).kind === 'safety') return { revoked: false, holder: null, clearMs: null };
        const r = leases.revoke(cur, reason);
        return { revoked: Boolean(r), holder: cur.owner.kind, clearMs: r?.clearMs ?? null };
      },
      execute: (c, s, o) => execute(c, s, o),
    },
    clock,
    ids: sequentialIds(),
    record: () => undefined,
  });
  for (const s of safetySkills(rt.service)) skills.set(s.descriptor.id, s);
  realExecutor = new SkillExecutorImpl({ registry: new SkillRegistry([...skills.values()]), leases, session: () => session, services, goalEpoch: () => authority().goal?.goalEpoch ?? 0, store: new MemoryRunStore(), settleMs: 0 });
  return { ...rt, leases, execute, skills, services, executorKind };
}

export const ownerAuthority = (): SafetyAuthority => ({ basis: 'owner_goal', detail: 'test owner goal', connection: { ready: true, connectionEpoch: 1, dimension: 'overworld' }, alive: true, goal: { goalId: 'goal-0001', goalEpoch: 2, source: 'owner' }, travel: null });

export const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
};
