// MB-OPS-002: the vanilla adapter authenticates server UUID/protocol facts.
// The manager is the only start/logout owner. No commands, paths or prompts.
import { z } from 'zod';
import { ManagedScopeSchema } from './releases.ts';
import type { ReleaseManagerStatus } from './releases.ts';

export const ServerControlRequestSchema = z.object({
  controlSessionId: z.string().min(1).max(96),
  requestId: z.string().min(1).max(96),
  scope: ManagedScopeSchema,
  generation: z.number().int().nonnegative(),
  action: z.enum(['on', 'off', 'status']),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  identity: z.literal('verified_server_uuid'),
}).strict().refine((r) => r.expiresAtMs > r.issuedAtMs && r.expiresAtMs - r.issuedAtMs <= 60_000, 'control request lifetime must be 1..60000 ms');
export type ServerControlRequest = z.infer<typeof ServerControlRequestSchema>;
export interface ServerControlReceipt {
  requestId: string;
  generation: number;
  status: 'applied' | 'duplicate' | 'rejected';
  detail: string;
  manager: ReleaseManagerStatus;
}
export interface ServerControlTargetPort {
  handle(request: ServerControlRequest): Promise<ServerControlReceipt>;
}
export interface ServerControlBridgePort {
  /** start never launches a bot or replays persisted trigger flags. */
  start(target: ServerControlTargetPort, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  status(): { state: 'offline' | 'ready' | 'blocked'; detail: string; heartbeatAtMs: number | null };
}
