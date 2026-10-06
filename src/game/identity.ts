// Owner admission for Minecraft chat. Identity comes from the player-chat
// packet's server-asserted sender UUID, never from rendered chat text, so
// `/tellraw`, console `/say`, plugins, or players imitating "<Owner> ..." in
// their message body cannot issue instructions.
import { createHash } from 'node:crypto';
import type { ChunkbotConfig } from '../config/schema.ts';
import { normalizeUuid } from '../config/schema.ts';
import type { ChatEnvelope } from '../contracts/index.ts';

export type OwnerPolicy =
  | { mode: 'uuid'; ownerUuid: string; requireSignedChat: boolean }
  | { mode: 'offline_name'; ownerName: string };

export const CHAT_REJECTIONS = [
  'system_message', // server/system text such as /tellraw
  'profileless_message', // unsigned server text such as console /say
  'missing_sender',
  'self',
  'not_owner',
  'unsigned', // owner policy requires library-verified signatures
  'server_offline_mode', // UUID identity is unverifiable on an offline-mode server
] as const;
export type ChatRejection = (typeof CHAT_REJECTIONS)[number];

export type AdmissionDecision = { admitted: true } | { admitted: false; reason: ChatRejection };

export interface AdmissionContext {
  /** The bot's own UUID on this connection. */
  selfUuid: string | undefined;
  /** Whether the server performed online-mode (session-verified) login for this connection. */
  serverOnlineMode: boolean;
}

/** Minecraft's offline-mode UUID: v3 (MD5) of "OfflinePlayer:<name>". */
export function offlinePlayerUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x30;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return normalizeUuid(bytes.toString('hex'));
}

export function ownerPolicyFromConfig(config: ChunkbotConfig): OwnerPolicy {
  if (config.bot.auth === 'offline') {
    // Config validation guarantees owner.name, trustedOfflineFixture, and a loopback host.
    return { mode: 'offline_name', ownerName: config.owner.name ?? '' };
  }
  return { mode: 'uuid', ownerUuid: config.owner.uuid ?? '', requireSignedChat: config.chat.requireSignedChat };
}

export function evaluateOwner(policy: OwnerPolicy, envelope: ChatEnvelope, ctx: AdmissionContext): AdmissionDecision {
  if (envelope.kind === 'system') return { admitted: false, reason: 'system_message' };
  if (envelope.kind === 'profileless') return { admitted: false, reason: 'profileless_message' };
  if (!envelope.senderUuid) return { admitted: false, reason: 'missing_sender' };
  const sender = normalizeUuid(envelope.senderUuid);
  if (ctx.selfUuid && sender === normalizeUuid(ctx.selfUuid)) return { admitted: false, reason: 'self' };

  if (policy.mode === 'uuid') {
    if (!ctx.serverOnlineMode) return { admitted: false, reason: 'server_offline_mode' };
    if (sender !== normalizeUuid(policy.ownerUuid)) return { admitted: false, reason: 'not_owner' };
    if (policy.requireSignedChat && !envelope.signatureVerified) return { admitted: false, reason: 'unsigned' };
    return { admitted: true };
  }

  // Trusted loopback offline fixture: exact player-list name AND the name-derived offline UUID.
  if (envelope.senderListName !== policy.ownerName) return { admitted: false, reason: 'not_owner' };
  if (sender !== offlinePlayerUuid(policy.ownerName)) return { admitted: false, reason: 'not_owner' };
  return { admitted: true };
}

/**
 * Whether an observed PLAYER entity is the owner, by the same rule as chat
 * admission: UUID mode needs the server-asserted UUID AND a verified online-mode
 * connection (no display-name fallback); the trusted offline fixture needs the
 * exact name AND that name's derived offline UUID.
 */
export function isOwnerPlayer(policy: OwnerPolicy, player: { username?: string; uuid?: string }, ctx: Pick<AdmissionContext, 'serverOnlineMode'>): boolean {
  if (!player.uuid) return false;
  const uuid = normalizeUuid(player.uuid);
  if (policy.mode === 'uuid') return ctx.serverOnlineMode && policy.ownerUuid !== '' && uuid === normalizeUuid(policy.ownerUuid);
  return policy.ownerName !== '' && player.username === policy.ownerName && uuid === offlinePlayerUuid(policy.ownerName);
}
