// Mineflayer-backed GamePort. This is the only foundation module that touches
// Minecraft library objects; everything it emits is plain contract data.
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';
import pathfinderPlugin from 'mineflayer-pathfinder';
import type {
  ChatEnvelope,
  ConnectionEndReason,
  ConnectionState,
  GameLifecycleEvent,
  GamePort,
  ReadyInfo,
  Unsubscribe,
} from '../contracts/index.ts';
import { resolveVersionProfile } from '../config/versions.ts';
import { IdentityConflictError, MicrosoftSignInRequiredError, hasMicrosoftTokenCache, resolveCachedBotProfile } from './auth.ts';
import { normalizeUuid } from '../config/schema.ts';
import { statusPing, type PingResult } from './ping.ts';
import { ServerEvidence, tapClientPredictions } from './server-evidence.ts';
import { CodecAudit, clientboundPacketNames, codecSummary, type CodecHealth } from './codec-audit.ts';

type Bot = ReturnType<typeof mineflayer.createBot>;

/**
 * The live game objects for one ready connection epoch. Only approved
 * perception/knowledge/skill modules receive this; model-facing ports get plain
 * data. Consumers must re-check `connectionEpoch` after every await.
 */
export interface GameSession {
  readonly bot: Bot;
  readonly connectionEpoch: number;
  readonly evidence: ServerEvidence;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  version: string;
  auth: 'microsoft' | 'offline';
  /** offline: in-game name; microsoft: token cache label. */
  username: string;
  authDir: string;
  joinTimeoutMs: number;
  ownerUuid?: string;
  ownerName?: string;
  replyMode: 'whisper' | 'public';
  log: (line: string) => void;
  /** Test seams. */
  createBot?: (options: mineflayer.BotOptions) => Bot;
  ping?: (options: { host: string; port: number; timeoutMs: number; signal: AbortSignal }) => Promise<PingResult>;
  resolveProfile?: typeof resolveCachedBotProfile;
  hasTokenCache?: typeof hasMicrosoftTokenCache;
}

class ConnectionEnded extends Error {
  readonly reason: ConnectionEndReason;
  constructor(reason: ConnectionEndReason, detail: string) {
    super(detail);
    this.name = 'ConnectionEnded';
    this.reason = reason;
  }
}

export function isConnectionEnded(error: unknown): error is ConnectionEnded {
  return error instanceof ConnectionEnded;
}

/** Converts a kick/disconnect reason (string or chat component) to bounded plain text. */
export function reasonText(reason: unknown): string {
  if (typeof reason === 'string') {
    try {
      return reasonText(JSON.parse(reason));
    } catch {
      return reason.slice(0, 300);
    }
  }
  if (reason && typeof reason === 'object') {
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') parts.push(node);
      else if (node && typeof node === 'object') {
        const n = node as Record<string, unknown>;
        if (typeof n['text'] === 'string') parts.push(n['text']);
        if (typeof n['translate'] === 'string' && !n['text']) parts.push(n['translate']);
        if (Array.isArray(n['with'])) n['with'].forEach(walk);
        if (Array.isArray(n['extra'])) n['extra'].forEach(walk);
        if (n['value'] !== undefined) walk(n['value']);
      }
    };
    walk(reason);
    return parts.join('').slice(0, 300) || 'unknown';
  }
  return 'unknown';
}


export class MineflayerConnection implements GamePort {
  private readonly options: ConnectionOptions;
  private readonly events = new EventEmitter();
  private bot: Bot | undefined;
  private stateValue: ConnectionState = 'disconnected';
  private epochValue = 0;
  private serverOnlineMode = false;
  private selfUuidValue: string | undefined;
  private lastDimension: string | undefined;
  private pendingEnd: { reason: ConnectionEndReason; detail: string } | undefined;
  private endedPromise: Promise<void> | undefined;
  private resolveEnded: (() => void) | undefined;
  private replyQueue: string[] = [];
  private replyTimer: NodeJS.Timeout | undefined;
  private teardownFor: { epoch: number; done: Promise<void> } | undefined;
  /** Version/protocol the server reported in its status ping for this connection. */
  private serverReported: { version: string; protocol: number } | undefined;
  private evidence: ServerEvidence | undefined;
  /** Codec health of the current (or most recent) connection epoch. */
  private codec: CodecAudit | undefined;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get connectionEpoch(): number {
    return this.epochValue;
  }

  admissionContext(): { selfUuid: string | undefined; serverOnlineMode: boolean } {
    return { selfUuid: this.selfUuidValue, serverOnlineMode: this.serverOnlineMode };
  }

  onLifecycle(listener: (event: GameLifecycleEvent) => void): Unsubscribe {
    this.events.on('lifecycle', listener);
    return () => this.events.off('lifecycle', listener);
  }

  onChat(listener: (envelope: ChatEnvelope) => void): Unsubscribe {
    this.events.on('chat', listener);
    return () => this.events.off('chat', listener);
  }

  private emitLifecycle(event: GameLifecycleEvent): void {
    this.events.emit('lifecycle', event);
  }

  statusInfo(): { dimension?: string; position?: { x: number; y: number; z: number }; health?: number; serverVersion?: string } {
    const bot = this.bot;
    if (!bot || this.stateValue !== 'ready') return {};
    const out: { dimension?: string; position?: { x: number; y: number; z: number }; health?: number; serverVersion?: string } = {};
    if (bot.game?.dimension) out.dimension = String(bot.game.dimension);
    const p = bot.entity?.position;
    if (p) out.position = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
    if (typeof bot.health === 'number') out.health = bot.health;
    out.serverVersion = this.serverReported?.version ?? bot.version;
    return out;
  }

  /**
   * Network codec health for the current or most recent connection: packets
   * decoded, packets with unread trailing bytes, and packets that failed to
   * decode (MB-SERVER-001). Plain data; never contains packet contents.
   */
  codecHealth(): CodecHealth | undefined {
    return this.codec?.health();
  }

  /** Live session for approved game modules, only while this connection is ready. */
  session(): GameSession | undefined {
    const bot = this.bot;
    if (!bot || this.stateValue !== 'ready' || !this.evidence) return undefined;
    return { bot, connectionEpoch: this.epochValue, evidence: this.evidence };
  }

  /** Name currently listed for a UUID in the server's player list. */
  playerListName(uuid: string): string | undefined {
    const bot = this.bot;
    if (!bot) return undefined;
    const target = normalizeUuid(uuid);
    for (const player of Object.values(bot.players ?? {})) {
      if (player?.uuid && normalizeUuid(player.uuid) === target) return player.username;
    }
    return undefined;
  }

  async connect(signal: AbortSignal): Promise<ReadyInfo> {
    if (this.stateValue === 'joining' || this.stateValue === 'ready') throw new Error(`already ${this.stateValue}`);
    this.epochValue += 1;
    const epoch = this.epochValue;
    this.stateValue = 'joining';
    this.serverOnlineMode = false;
    this.selfUuidValue = undefined;
    this.lastDimension = undefined;
    this.pendingEnd = undefined;
    this.serverReported = undefined;
    this.endedPromise = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
    this.emitLifecycle({ type: 'joining', connectionEpoch: epoch });

    const endedForThisJoin = this.endedPromise;
    const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<ReadyInfo>();
    ready.catch(() => undefined);
    let settled = false;
    const fail = (reason: ConnectionEndReason, detail: string): void => {
      if (this.epochValue !== epoch) return;
      settled = true;
      this.pendingEnd ??= { reason, detail };
      rejectReady(new ConnectionEnded(this.pendingEnd.reason, this.pendingEnd.detail));
      void this.teardown(epoch);
    };
    /** True only while this join attempt still owns the connection (not timed out, stopped, or replaced). */
    const ownsJoin = (): boolean => !settled && !signal.aborted && this.epochValue === epoch && this.stateValue === 'joining';
    /**
     * Settles as soon as the join ends (timeout/stop/abort), without waiting for
     * `work` — e.g. an unabortable auth lookup. Its late result is discarded.
     */
    const guarded = <T>(work: Promise<T>): Promise<T> => {
      work.catch(() => undefined);
      return Promise.race([work, ready.then(() => never())]);
    };

    const onAbort = (): void => fail('operator_stop', 'join cancelled by operator');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => fail('join_timeout', `no valid spawn within ${this.options.joinTimeoutMs}ms`), this.options.joinTimeoutMs);

    try {
      if (signal.aborted) throw new ConnectionEnded('operator_stop', 'join cancelled by operator');
      const expected = resolveVersionProfile(this.options.version);
      if (!expected) throw new ConnectionEnded('connect_error', `unsupported configured version ${this.options.version}`);
      // Without a cached bot session, fail before any network contact (no device-code request).
      const hasCache = this.options.hasTokenCache ?? hasMicrosoftTokenCache;
      if (this.options.auth === 'microsoft' && !hasCache(this.options.username, this.options.authDir)) {
        throw new ConnectionEnded('auth_required', new MicrosoftSignInRequiredError().message);
      }

      // 1. Server list ping: confirm the server's actual version/protocol before logging in.
      const ping = this.options.ping ?? statusPing;
      const pingAbort = new AbortController();
      const stopPing = () => pingAbort.abort();
      ready.catch(stopPing);
      const server = await guarded(
        ping({ host: this.options.host, port: this.options.port, timeoutMs: Math.min(this.options.joinTimeoutMs, 10_000), signal: pingAbort.signal }),
      )
        .finally(stopPing)
        .catch((error: unknown) => {
          if (error instanceof ConnectionEnded) throw error;
          throw new ConnectionEnded('connect_error', `server ping failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      if (!ownsJoin()) throw this.endedError();
      if (server.protocol !== expected.protocolVersion) {
        throw new ConnectionEnded(
          'connect_error',
          `server reports ${server.version} (protocol ${server.protocol}); configured ${this.options.version} uses protocol ${expected.protocolVersion}`,
        );
      }
      this.options.log(`server reports ${server.version} (protocol ${server.protocol})`);
      this.serverReported = server;

      // 2. Microsoft: cached session only. Never starts device-code sign-in, never downgrades.
      if (this.options.auth === 'microsoft') {
        const resolveProfile = this.options.resolveProfile ?? resolveCachedBotProfile;
        try {
          const profile = await guarded(resolveProfile(this.options.username, this.options.authDir, this.options.ownerUuid));
          if (!ownsJoin()) throw this.endedError();
          this.options.log(`bot Microsoft profile resolved (${profile.name})`);
        } catch (error) {
          if (error instanceof ConnectionEnded) throw error;
          if (error instanceof MicrosoftSignInRequiredError) throw new ConnectionEnded('auth_required', error.message);
          if (error instanceof IdentityConflictError) throw new ConnectionEnded('identity_conflict', error.message);
          throw new ConnectionEnded('auth_failed', error instanceof Error ? error.message : String(error));
        }
      }

      // 3. Join as the bot's own player — only if this attempt still owns the connection.
      if (!ownsJoin()) throw this.endedError();
      const create = this.options.createBot ?? mineflayer.createBot;
      const bot = create({
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        auth: this.options.auth, // validated explicit mode; never omitted (the library default is offline)
        version: this.options.version,
        profilesFolder: this.options.authDir,
        onMsaCode: () => {
          throw new MicrosoftSignInRequiredError();
        },
        hideErrors: true,
        logErrors: false,
        respawn: true,
        checkTimeoutInterval: 30_000,
      });
      this.bot = bot;
      // Codec audit: installed before login so every decoded packet of this epoch is counted.
      this.codec?.detach();
      this.codec = undefined;
      if (bot._client) {
        const protocol = minecraftData(this.options.version)?.protocol;
        this.codec = new CodecAudit(bot._client as unknown as ConstructorParameters<typeof CodecAudit>[0], clientboundPacketNames(protocol));
        this.codec.attach();
      }
      // Server-packet evidence journal: installed before login so every effect is recorded.
      this.evidence?.detach();
      this.evidence = undefined;
      const installEvidence = (): void => {
        const registry = (bot as unknown as { registry?: ConstructorParameters<typeof ServerEvidence>[1] }).registry;
        if (this.evidence || !registry || !bot._client || this.epochValue !== epoch) return;
        this.evidence = new ServerEvidence(bot._client as unknown as EventEmitter, registry);
        this.evidence.attach();
      };
      installEvidence();
      if (!this.evidence && typeof bot.once === 'function') bot.once('inject_allowed', installEvidence);
      // Local client-model predictions are marked so the authoritative world view treats them as unknown.
      tapClientPredictions(bot, () => (this.epochValue === epoch ? this.evidence : undefined));
      // Navigation plugin; its movement policy is configured (no dig/place/scaffold) by the skill layer.
      if (typeof (bot as { loadPlugin?: unknown }).loadPlugin === 'function') bot.loadPlugin(pathfinderPlugin.pathfinder);
      this.attach(bot, epoch, resolveReady, fail, ownsJoin);
      return await ready;
    } catch (error) {
      if (error instanceof ConnectionEnded) fail(error.reason, error.message);
      else fail('connect_error', error instanceof Error ? error.message : String(error));
      // Bounded: teardown force-destroys the socket after 2s if a clean close never arrives.
      await endedForThisJoin;
      throw this.endedError(epoch);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private endedError(epoch = this.epochValue): ConnectionEnded {
    if (epoch !== this.epochValue) return new ConnectionEnded('operator_stop', 'superseded by a newer connection attempt');
    const end = this.pendingEnd ?? { reason: 'connect_error' as const, detail: 'connection ended' };
    return new ConnectionEnded(end.reason, end.detail);
  }

  private attach(
    bot: Bot,
    epoch: number,
    resolveReady: (info: ReadyInfo) => void,
    fail: (reason: ConnectionEndReason, detail: string) => void,
    ownsJoin: () => boolean,
  ): void {
    const client = bot._client as unknown as EventEmitter & { uuid?: string; protocolVersion?: number };

    client.once('encryption_begin', () => {
      this.serverOnlineMode = true;
    });

    client.on('playerChat', (data: { sender?: string; plainMessage?: string; verified?: boolean; formattedMessage?: string }) => {
      if (this.epochValue !== epoch) return;
      const receivedAtMs = Date.now();
      if (!data.sender) {
        this.events.emit('chat', { kind: 'profileless', text: reasonText(data.formattedMessage ?? ''), signatureVerified: false, receivedAtMs } satisfies ChatEnvelope);
        return;
      }
      const envelope: ChatEnvelope = {
        kind: 'player',
        senderUuid: data.sender,
        text: typeof data.plainMessage === 'string' ? data.plainMessage : '',
        signatureVerified: data.verified === true,
        receivedAtMs,
      };
      const listName = this.playerListName(data.sender);
      if (listName) envelope.senderListName = listName;
      this.events.emit('chat', envelope);
    });

    client.on('systemChat', (data: { formattedMessage?: string; positionId?: number }) => {
      if (this.epochValue !== epoch || data.positionId === 2) return; // ignore action bar
      this.events.emit('chat', { kind: 'system', text: reasonText(data.formattedMessage ?? ''), signatureVerified: false, receivedAtMs: Date.now() } satisfies ChatEnvelope);
    });

    bot.once('login', () => {
      this.selfUuidValue = client.uuid;
      // Offline fixture: refuse to act as the owner's player identity.
      if (this.options.ownerName && bot.username?.toLowerCase() === this.options.ownerName.toLowerCase()) {
        fail('identity_conflict', "bot joined with the owner's player name");
      }
      if (this.options.ownerUuid && client.uuid && normalizeUuid(client.uuid) === normalizeUuid(this.options.ownerUuid)) {
        fail('identity_conflict', "bot joined with the owner's UUID");
      }
    });

    bot.once('spawn', () => {
      void (async () => {
        // Valid world state: dimension known, finite position, nearby chunks loaded.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && ownsJoin()) {
          const p = bot.entity?.position;
          if (bot.game?.dimension && p && Number.isFinite(p.x + p.y + p.z)) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        try {
          await Promise.race([bot.waitForChunksToLoad(), new Promise((r) => setTimeout(r, 5_000))]);
        } catch {
          // chunk wait is best effort; position/dimension checks above are required
        }
        // A join that timed out or was stopped while waiting must never become ready.
        if (!ownsJoin()) return;
        const p = bot.entity?.position;
        if (!bot.game?.dimension || !p || !Number.isFinite(p.x + p.y + p.z)) {
          fail('connect_error', 'spawned without a valid dimension/position');
          return;
        }
        this.stateValue = 'ready';
        this.lastDimension = String(bot.game.dimension);
        const info: ReadyInfo = {
          serverVersion: this.serverReported?.version ?? bot.version,
          protocolVersion: client.protocolVersion ?? this.serverReported?.protocol ?? -1,
          dimension: this.lastDimension,
          position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
          gameMode: String(bot.game.gameMode ?? 'unknown'),
          serverOnlineMode: this.serverOnlineMode,
        };
        this.emitLifecycle({ type: 'ready', connectionEpoch: epoch, info });
        resolveReady(info);

        let awaitingRespawn = false;
        bot.on('death', () => {
          if (this.epochValue !== epoch) return;
          awaitingRespawn = true;
          this.emitLifecycle({ type: 'death', connectionEpoch: epoch });
        });
        bot.on('spawn', () => {
          if (this.epochValue !== epoch || !awaitingRespawn) return;
          awaitingRespawn = false;
          this.emitLifecycle({ type: 'respawn', connectionEpoch: epoch, dimension: String(bot.game?.dimension ?? 'unknown') });
        });
        bot.on('game', () => {
          if (this.epochValue !== epoch || this.stateValue !== 'ready') return;
          const now = bot.game?.dimension ? String(bot.game.dimension) : undefined;
          if (now && this.lastDimension && now !== this.lastDimension) {
            const from = this.lastDimension;
            this.lastDimension = now;
            this.emitLifecycle({ type: 'dimension_change', connectionEpoch: epoch, from, to: now });
          }
        });
      })();
    });

    bot.on('kicked', (reason: unknown) => {
      this.pendingEnd ??= { reason: 'kicked', detail: reasonText(reason) };
    });

    bot.on('error', (error: Error) => {
      if (error instanceof MicrosoftSignInRequiredError) {
        this.pendingEnd ??= { reason: 'auth_required', detail: error.message };
      } else {
        this.pendingEnd ??= { reason: this.stateValue === 'joining' ? 'connect_error' : 'disconnected', detail: error.message.slice(0, 300) };
      }
      if (this.stateValue === 'joining') fail(this.pendingEnd.reason, this.pendingEnd.detail);
    });

    bot.on('end', (reason: string) => {
      this.pendingEnd ??= { reason: 'disconnected', detail: reasonText(reason) };
      if (this.stateValue === 'joining') fail(this.pendingEnd.reason, this.pendingEnd.detail);
      this.markEnded(epoch);
    });
  }

  private markEnded(epoch: number): void {
    if (this.epochValue !== epoch || this.stateValue === 'ended' || this.stateValue === 'disconnected') return;
    this.stateValue = 'ended';
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.replyTimer = undefined;
    this.replyQueue = [];
    // Stale handlers are neutralized by epoch checks; the library's own `end`
    // listeners must still run so its timers are released.
    this.bot = undefined;
    this.evidence?.detach();
    this.evidence = undefined;
    // Keep the ended epoch's counts readable (connect-check, evidence); stop counting.
    this.codec?.detach();
    if (this.codec) this.options.log(`connection ${epoch} ended; ${codecSummary(this.codec.health())}`);
    const end = this.pendingEnd ?? { reason: 'disconnected' as const, detail: 'connection ended' };
    this.emitLifecycle({ type: 'ended', connectionEpoch: epoch, reason: end.reason, detail: end.detail });
    this.resolveEnded?.();
  }

  /** Ends the socket for `epoch` once, waiting briefly for a clean close before destroying it. */
  private teardown(epoch: number): Promise<void> {
    if (this.teardownFor?.epoch === epoch) return this.teardownFor.done;
    const done = this.teardownOnce(epoch);
    this.teardownFor = { epoch, done };
    return done;
  }

  private async teardownOnce(epoch: number): Promise<void> {
    if (this.epochValue !== epoch || this.stateValue === 'ended') return;
    const bot = this.bot;
    if (!bot) {
      this.markEnded(epoch);
      return;
    }
    const client = bot._client as unknown as { socket?: { destroy(): void; destroyed?: boolean }; end(reason?: string): void };
    try {
      client.end('disconnect.quitting');
    } catch {
      // fall through to socket destroy
    }
    const closed = await Promise.race([
      this.endedPromise?.then(() => true) ?? Promise.resolve(true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
    ]);
    if (!closed) {
      client.socket?.destroy();
      this.markEnded(epoch);
    }
  }

  async disconnect(reason: ConnectionEndReason, detail = reason): Promise<void> {
    const epoch = this.epochValue;
    if (this.stateValue === 'disconnected' || this.stateValue === 'ended') return;
    this.pendingEnd ??= { reason, detail };
    await this.teardown(epoch);
    await this.endedPromise;
  }

  replyToOwner(text: string): void {
    if (this.stateValue !== 'ready' || !this.bot) return;
    const clean = text.replace(/[\r\n]+/g, ' ').replace(/^[/!]+/, '').trim().slice(0, 240);
    if (!clean) return;
    this.replyQueue.push(clean);
    if (this.replyQueue.length > 8) this.replyQueue.splice(0, this.replyQueue.length - 8);
    this.pumpReplies();
  }

  private pumpReplies(): void {
    if (this.replyTimer || this.replyQueue.length === 0) return;
    const bot = this.bot;
    const text = this.replyQueue.shift();
    if (!bot || !text || this.stateValue !== 'ready') return;
    const ownerName = this.options.ownerName ?? (this.options.ownerUuid ? this.playerListName(this.options.ownerUuid) : undefined);
    try {
      if (this.options.replyMode === 'whisper' && ownerName) bot.whisper(ownerName, text);
      else if (this.options.replyMode === 'public') bot.chat(text);
    } catch {
      // replies are best effort; the terminal always shows the same notice
    }
    this.replyTimer = setTimeout(() => {
      this.replyTimer = undefined;
      this.pumpReplies();
    }, 400);
    this.replyTimer.unref?.();
  }
}

function never(): never {
  throw new Error('unreachable');
}
