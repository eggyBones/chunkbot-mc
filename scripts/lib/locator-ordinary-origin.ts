// Dedicated ordinary locator origin/restoration evidence. No world or app I/O.
import { parseOwnerServerRead, type OwnerIdentity, type Point } from './locator-ordinary-oracles.ts';

export const POSITION_SETTLE = Object.freeze({ timeoutMs: 10_000, intervalMs: 250, stableMs: 1_000, minReads: 3, maxReadMs: 1_500, maxGapMs: 1_000, epsilon: 0.000001 });
export interface PositionScope { runId: string; connectionEpoch: number }
export interface PlayerPositionRead {
  scopeBefore: PositionScope; scopeAfter: PositionScope; fromMs: number; toMs: number;
  replies: { positionBefore: string; positionAfter: string; dimensionBefore: string; dimensionAfter: string; uuid: string; onGround: string };
}
export interface StationaryPositionProof {
  identity: OwnerIdentity; scope: PositionScope; at: Point; dimension: string;
  fromMs: number; toMs: number; reads: PlayerPositionRead[];
}
export interface PositionTarget { at: Point; dimension: string }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const sameScope = (a: PositionScope, b: PositionScope) => a.runId === b.runId && a.connectionEpoch === b.connectionEpoch;
const validPoint = (at: Point) => ['x', 'y', 'z'].every((k) => Number.isFinite(at[k as keyof Point]));
const checkTarget = (target: PositionTarget | undefined) => {
  if (target && (!validPoint(target.at) || !/^minecraft:[a-z_]+$/.test(target.dimension))) throw new Error('invalid original position target');
};

/** Bracket position AND dimension; a falling/moving read is valid evidence, never a baseline. */
export function parsePlayerPositionRead(read: PlayerPositionRead, identity: OwnerIdentity, scope: PositionScope) {
  if (!scope.runId || !Number.isInteger(scope.connectionEpoch) || scope.connectionEpoch < 1 || !sameScope(read.scopeBefore, scope) || !sameScope(read.scopeAfter, scope)) throw new Error('player position read lost run/connection ownership');
  if (!Number.isFinite(read.fromMs) || !Number.isFinite(read.toMs) || read.toMs < read.fromMs || read.toMs - read.fromMs > POSITION_SETTLE.maxReadMs) throw new Error('player position read is unbounded or has invalid time');
  const before = parseOwnerServerRead(identity.name, { position: read.replies.positionBefore, dimension: read.replies.dimensionBefore, uuid: read.replies.uuid }, read.fromMs, read.toMs);
  const after = parseOwnerServerRead(identity.name, { position: read.replies.positionAfter, dimension: read.replies.dimensionAfter, uuid: read.replies.uuid }, read.fromMs, read.toMs);
  if (before.uuid !== identity.uuid || after.uuid !== identity.uuid) throw new Error('player position read has wrong UUID');
  const prefix = `${identity.name} has the following entity data: `;
  if (!read.replies.onGround.startsWith(prefix) || !/^[01]b$/.test(read.replies.onGround.slice(prefix.length).trim())) throw new Error('player grounding was not stated by the named server entity');
  return { at: after.at, dimension: `minecraft:${after.dimension}`, grounded: read.replies.onGround.slice(prefix.length).trim() === '1b', unchanged: before.dimension === after.dimension && distance(before.at, after.at) <= POSITION_SETTLE.epsilon };
}

/** Every read in the interval must agree; neither a teleport reply nor a last sample proves settling. */
export function stationaryPositionProof(reads: readonly PlayerPositionRead[], identity: OwnerIdentity, scope: PositionScope, target?: PositionTarget): StationaryPositionProof {
  checkTarget(target);
  if (reads.length < POSITION_SETTLE.minReads) throw new Error('too few stationary server reads');
  const first = reads[0]!, last = reads.at(-1)!;
  if (last.fromMs - first.toMs < POSITION_SETTLE.stableMs || last.toMs - first.fromMs > POSITION_SETTLE.timeoutMs) throw new Error('stationary interval is too short or unbounded');
  const base = parsePlayerPositionRead(first, identity, scope);
  for (let i = 0; i < reads.length; i++) {
    const read = reads[i]!, at = parsePlayerPositionRead(read, identity, scope);
    if (i && (read.fromMs < reads[i - 1]!.toMs || read.fromMs - reads[i - 1]!.toMs > POSITION_SETTLE.maxGapMs)) throw new Error('stationary read interval is unordered or has a gap');
    if (!at.grounded || !at.unchanged || at.dimension !== base.dimension || distance(at.at, base.at) > POSITION_SETTLE.epsilon) throw new Error('player is airborne, moving or changed dimension');
    if (target && (at.dimension !== target.dimension || distance(at.at, target.at) > POSITION_SETTLE.epsilon)) throw new Error('stationary player is not at the exact original position/dimension');
  }
  // Detached evidence: caller changes cannot silently alter the selected origin.
  return structuredClone({ identity, scope, at: base.at, dimension: base.dimension, fromMs: first.fromMs, toMs: last.toMs, reads: [...reads] });
}

/** Revalidate the original proof before using its sole out-of-scene restoration exception. */
export function originalPositionTarget(proof: StationaryPositionProof): PositionTarget {
  const verified = stationaryPositionProof(proof.reads, proof.identity, proof.scope);
  if (!validPoint(proof.at) || proof.dimension !== verified.dimension || distance(proof.at, verified.at) > POSITION_SETTLE.epsilon || proof.fromMs !== verified.fromMs || proof.toMs !== verified.toMs) throw new Error('original position does not match its retained server proof');
  return { at: verified.at, dimension: verified.dimension };
}

/** Bounded read-only settling; failed/falling attempts remain in record(), never force movement. */
export async function captureStationaryPosition(io: { now: () => number; read: (deadlineMs: number) => Promise<PlayerPositionRead>; record: (read: PlayerPositionRead) => void; wait: (ms: number) => Promise<void> }, identity: OwnerIdentity, scope: PositionScope, target?: PositionTarget): Promise<StationaryPositionProof> {
  checkTarget(target);
  const started = io.now(), deadline = started + POSITION_SETTLE.timeoutMs;
  let window: PlayerPositionRead[] = [], previousToMs = started, reason = 'no stationary grounded server interval';
  while (io.now() < deadline) {
    const read = await io.read(deadline);
    io.record(read); // retain before parsing/verification, including malformed/failed proof
    const at = parsePlayerPositionRead(read, identity, scope), now = io.now();
    if (read.fromMs < previousToMs || read.toMs > now || now >= deadline) throw new Error('player position capture exceeded its deadline or has invalid chronology');
    previousToMs = read.toMs;
    const prior = window.at(-1), priorAt = prior ? parsePlayerPositionRead(prior, identity, scope) : undefined;
    if (!at.grounded || !at.unchanged || (target && (at.dimension !== target.dimension || distance(at.at, target.at) > POSITION_SETTLE.epsilon))) {
      window = [];
      reason = target ? 'original position/dimension not grounded and stationary' : 'origin is still airborne or moving';
    } else {
      if (prior && (read.fromMs - prior.toMs > POSITION_SETTLE.maxGapMs || at.dimension !== priorAt!.dimension || distance(at.at, priorAt!.at) > POSITION_SETTLE.epsilon)) window = [];
      window.push(read);
      if (window.length >= POSITION_SETTLE.minReads && read.fromMs - window[0]!.toMs >= POSITION_SETTLE.stableMs) return stationaryPositionProof(window, identity, scope, target);
    }
    await io.wait(Math.min(POSITION_SETTLE.intervalMs, Math.max(0, deadline - io.now())));
  }
  throw new Error(`player position did not settle within ${POSITION_SETTLE.timeoutMs}ms: ${reason}`);
}
