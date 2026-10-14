import { z } from 'zod';

const token = z.string().regex(/^[a-f0-9]{32}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const uuid = z.string().regex(/^[a-f0-9]{32}$/);
const counter = z.number().int().min(0).max(2_000_000_000);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const BRIDGE_PROTOCOL = 1;
export const HEARTBEAT_TICKS = 100;
export const REQUEST_TTL_TICKS = 60;

/** External installation evidence, never inferred from a player's name or prose. */
export const BridgeBindingSchema = z.strictObject({
  protocol: z.literal(BRIDGE_PROTOCOL),
  installation: token,
  world: id,
  bot: id,
  ownerUuid: uuid,
  botUuid: uuid,
  version: z.enum(['26.1.2', '26.2']),
  authority: z.enum(['verified-online', 'trusted-offline-fixture']),
}).refine((b) => b.ownerUuid !== b.botUuid, 'owner and bot must differ');
export type BridgeBinding = z.infer<typeof BridgeBindingSchema>;

/** Proposed integration boundary: the one existing manager owns all processes. */
export interface BridgeIntentRequest {
  source: 'vanilla-trigger';
  action: 'on' | 'off';
  binding: BridgeBinding;
  bridgeSession: string;
  generation: number;
  ownerSession: number;
  expiresAtMs: number;
  expectedManagerInstance: string;
  expectedIntentGeneration: number;
}
export const BridgeIntentReceiptSchema = z.strictObject({
  bridgeSession: token,
  generation: counter,
  managerInstance: token,
  intentGeneration: counter,
  disposition: z.enum(['queued', 'noop', 'rejected']),
  reason: z.enum(['none', 'stale', 'blocked', 'busy']),
});
export type BridgeIntentReceipt = z.infer<typeof BridgeIntentReceiptSchema>;

export const BridgeManagerStatusSchema = z.strictObject({
  managerInstance: token,
  intentGeneration: counter,
  observedAtMs: time,
  world: id,
  bot: id,
  desired: z.enum(['on', 'off']),
  state: z.enum(['offline', 'joining', 'online', 'logging_out', 'blocked']),
  child: z.enum(['absent', 'owned', 'unknown']),
  connection: z.enum(['absent', 'joining', 'spawn_verified', 'unknown']),
  connectionEpoch: counter.nullable(),
  botUuid: uuid.nullable(),
  blocker: z.enum(['none', 'auth_required', 'whitelist', 'version', 'unreachable', 'identity', 'cleanup', 'manager_unavailable']),
});
export type BridgeManagerStatus = z.infer<typeof BridgeManagerStatusSchema>;
export interface BridgeManagerPort {
  /** Admit quickly, not after startup. New off must revoke older on/update synchronously.
   * Validate instance/generation/expiry against the SAME local logout authority.
   * A replay cannot allocate a child or a fresh budget; abort is not rollback. */
  submitIntent(request: BridgeIntentRequest, signal: AbortSignal): Promise<BridgeIntentReceipt>;
  /** Current evidence from the shared manager, never a cached success claim. */
  readStatus(signal: AbortSignal): Promise<BridgeManagerStatus>;
}

export const UuidWordsSchema = z.tuple([z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647), z.number().int().min(-2147483648).max(2147483647)]);
export type UuidWords = z.infer<typeof UuidWordsSchema>;
export const BridgeSampleSchema = z.strictObject({
  protocol: z.literal(BRIDGE_PROTOCOL), installation: token, world: id, bot: id,
  owner: UuidWordsSchema, version: z.enum(['26.1.2', '26.2']),
  session: z.union([token, z.literal('closed')]),
  clock: counter, heartbeat: z.number().int().min(0).max(HEARTBEAT_TICKS), generation: counter, acknowledged: counter,
  display: z.number().int().min(0).max(5), blocker: z.number().int().min(0).max(7),
  managerGeneration: counter,
  ownerSession: counter, ownerPresent: z.union([z.literal(0), z.literal(1)]),
  request: z.strictObject({ generation: counter, tick: counter, action: z.union([z.literal(0), z.literal(1), z.literal(2)]), owner: UuidWordsSchema, ownerSession: counter, managerGeneration: counter }),
});
export type BridgeSample = z.infer<typeof BridgeSampleSchema>;
export type BridgeDisplay = 'offline' | 'joining' | 'online' | 'logging_out' | 'blocked' | 'unavailable';
export interface BridgeTransport {
  /** Reset all pending flags in the pre-installed, matching binding; never install. */
  open(binding: BridgeBinding, session: string, signal: AbortSignal): Promise<void>;
  sample(signal: AbortSignal): Promise<unknown>;
  acknowledge(session: string, generation: number, disposition: BridgeIntentReceipt['disposition'], signal: AbortSignal): Promise<void>;
  heartbeat(session: string, display: BridgeDisplay, blocker: BridgeManagerStatus['blocker'], managerGeneration: number, signal: AbortSignal): Promise<void>;
  /** Session-fenced; cannot close a replacement bridge's mailbox. */
  close(session: string, signal: AbortSignal): Promise<void>;
}
