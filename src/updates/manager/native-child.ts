import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { sameFence } from './manager.ts';
import {
  ManagerFault, type AcceptedRelease, type CheckpointRef, type ChildDriver,
  type ChildRegistration, type DrainEvidence, type GoneEvidence, type ManagerIntent,
  type FailureCode, type OperationFence, type ReadinessEvidence,
} from './ports.ts';

export interface ProcessIdentity { pid: number; ppid: number; startMs: number; command: string }
export interface ProcessInspector { list(): ProcessIdentity[] }
/** Unlike a bare PID probe, failure to inspect is never interpreted as absence. */
export const nativeProcessInspector: ProcessInspector = {
  list() {
    const result = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' },
    });
    if (result.status !== 0 || result.error || !result.stdout.trim()) throw new ManagerFault('ownership_unproven', 'process table unavailable');
    const rows: ProcessIdentity[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
      if (!match) throw new ManagerFault('ownership_unproven', 'process table identity row unrecognized');
      const startMs = Date.parse(`${match[3]} UTC`);
      if (!Number.isFinite(startMs)) throw new ManagerFault('ownership_unproven', 'process birth unavailable');
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), startMs, command: match[4]! });
    }
    return rows;
  },
};

export interface ManagedRequest {
  version: 1;
  kind: 'chunkbot_manager_request';
  childId: string;
  requestId: string;
  fence: OperationFence;
  operation: 'initialize' | 'drain' | 'readiness' | 'activate' | 'pause' | 'announce';
  payload: unknown;
}
export interface ManagedReply {
  version: 1;
  kind: 'chunkbot_manager_reply';
  childId: string;
  requestId: string;
  fence: OperationFence;
  ok: boolean;
  value?: unknown;
  /** Only these stable failures are transported; no stack/log/secret echo. */
  failure?: 'auth_required' | 'whitelist_denied' | 'server_unavailable' | 'identity_conflict' | 'protocol_mismatch' | 'startup_failed';
}
export interface ManagedChildEvent {
  version: 1;
  kind: 'chunkbot_manager_event';
  childId: string;
  fence: OperationFence;
  reason: 'auth_required' | 'whitelist_denied' | 'server_unavailable' | 'identity_conflict' | 'protocol_mismatch' | 'startup_failed';
}

interface Pending {
  fence: OperationFence;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
interface Registered {
  registration: ChildRegistration;
  process: ChildProcess;
  known: Map<number, ProcessIdentity>;
  rootProven: boolean;
  auditFailed: boolean;
  exited: boolean;
  bornAt: number;
  sampler: NodeJS.Timeout;
  pending: Map<string, Pending>;
  initialized: Promise<void>;
  termination?: Promise<GoneEvidence>;
  notices: Set<string>;
}
export interface NativeChildOptions {
  nodeExecutable: string;
  configPath: string;
  /** Already-scoped inherited environment; never logged or supplied by players. */
  env: NodeJS.ProcessEnv;
  inspector?: ProcessInspector;
  observeMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

/** Real registered local children only; no adoption, arbitrary shell or retries. */
export class NativeChildDriver implements ChildDriver {
  private readonly options: NativeChildOptions;
  private readonly inspector: ProcessInspector;
  private readonly registry = new Map<string, Registered>();
  private occupied: Registered | undefined;
  private readonly lossListeners = new Set<(child: ChildRegistration, reason: FailureCode) => void>();

  onLoss(listener: (child: ChildRegistration, reason: FailureCode) => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  constructor(options: NativeChildOptions) {
    if (!isAbsolute(options.nodeExecutable) || !isAbsolute(options.configPath)) throw new Error('native child paths must be absolute');
    this.options = { ...options, env: { ...options.env } };
    this.inspector = options.inspector ?? nativeProcessInspector;
    for (const value of [options.observeMs ?? 100, options.termGraceMs ?? 1_000, options.killGraceMs ?? 1_000]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) throw new Error('invalid child cleanup bound');
    }
  }

  launch(release: AcceptedRelease, checkpoint: CheckpointRef, intent: ManagerIntent, fence: OperationFence): ChildRegistration {
    if (this.occupied) throw new ManagerFault('ownership_unproven', 'one registered native child already owns the slot');
    const root = realpathSync(release.artifactRoot);
    const entrypoint = realpathSync(release.entrypoint);
    const rel = relative(root, entrypoint);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ManagerFault('artifact_invalid', 'entrypoint escapes accepted artifact');
    const bornAt = Date.now();
    const child = fork(entrypoint, ['run', '--config', this.options.configPath], {
      cwd: root, execPath: this.options.nodeExecutable, execArgv: [], detached: true,
      env: { ...this.options.env, CHUNKBOT_MANAGED_CHILD: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
    });
    if (!child.pid) throw new ManagerFault('startup_failed', 'native child did not register a PID');
    const registration: ChildRegistration = Object.freeze({ id: randomUUID(), pid: child.pid, releaseId: release.id, digest: release.digest, fence: Object.freeze({ ...fence }) });
    const registered: Registered = {
      registration, process: child, known: new Map(), rootProven: false, auditFailed: false,
      exited: false, bornAt, pending: new Map(), initialized: Promise.resolve(),
      sampler: setInterval(() => this.sample(registered), this.options.observeMs ?? 100), notices: new Set(),
    };
    registered.sampler.unref();
    this.registry.set(registration.id, registered);
    this.occupied = registered;
    child.on('message', (message: unknown) => this.reply(registered, message));
    const ended = () => {
      registered.exited = true;
      for (const pending of registered.pending.values()) pending.reject(new ManagerFault('startup_failed', 'registered child exited'));
      registered.pending.clear();
      for (const listener of this.lossListeners) listener(structuredClone(registration), 'startup_failed');
    };
    child.once('exit', ended);
    child.once('error', ended);
    this.sample(registered);
    // Registration exists before initialize waits. Startup must remain gameplay-gated.
    registered.initialized = this.request(registered, fence, 'initialize', { release, checkpoint, intent }, undefined)
      .then(() => undefined);
    registered.initialized.catch(() => undefined);
    return structuredClone(registration);
  }

  async readiness(child: ChildRegistration, fence: OperationFence, signal: AbortSignal): Promise<ReadinessEvidence> {
    const registered = this.get(child);
    await this.withAbort(registered.initialized, signal);
    const result = await this.request(registered, fence, 'readiness', null, signal);
    this.sample(registered);
    if (!registered.rootProven || registered.auditFailed || registered.exited) throw new ManagerFault('ownership_unproven', 'registered process birth/readiness unproven');
    return result as ReadinessEvidence;
  }
  async drain(child: ChildRegistration, fence: OperationFence, signal: AbortSignal): Promise<DrainEvidence> {
    return await this.request(this.get(child), fence, 'drain', null, signal) as DrainEvidence;
  }
  async activate(child: ChildRegistration, intent: ManagerIntent, fence: OperationFence, signal: AbortSignal): Promise<void> {
    await this.request(this.get(child), fence, 'activate', { intent }, signal);
  }
  async pause(child: ChildRegistration, intent: ManagerIntent, signal: AbortSignal): Promise<void> {
    const fence = { ...child.fence, commandGeneration: intent.generation };
    await this.request(this.get(child), fence, 'pause', { intent }, signal);
  }
  async announce(child: ChildRegistration, fence: OperationFence, text: string, signal: AbortSignal): Promise<'sent' | 'unavailable'> {
    const registered = this.get(child);
    const key = `${fence.sessionId}:${fence.deploymentGeneration}`;
    if (registered.notices.has(key)) return 'unavailable';
    registered.notices.add(key); // attempt dedup, including lost ACKs
    const result = await this.request(registered, fence, 'announce', { text: text.slice(0, 240) }, signal);
    return result === 'sent' ? 'sent' : 'unavailable';
  }

  terminate(child: ChildRegistration, signal: AbortSignal): Promise<GoneEvidence> {
    const registered = this.get(child);
    // Keep the real cleanup promise even when a caller stops waiting.
    registered.termination ??= this.cleanup(registered);
    return this.withAbort(registered.termination, signal);
  }
  async proveGone(child: ChildRegistration, signal: AbortSignal): Promise<GoneEvidence> {
    if (signal.aborted) throw new ManagerFault('superseded', 'cleanup inspection cancelled');
    const registered = this.get(child);
    const proof = this.proof(registered);
    this.releaseIfGone(registered, proof);
    return proof;
  }

  private get(child: ChildRegistration): Registered {
    const registered = this.registry.get(child.id);
    if (!registered || child.pid !== registered.registration.pid || child.releaseId !== registered.registration.releaseId
      || child.digest !== registered.registration.digest || !sameFence(child.fence, registered.registration.fence)) {
      throw new ManagerFault('ownership_unproven', 'child is not this driver’s registered process');
    }
    return registered;
  }

  private sample(registered: Registered): ProcessIdentity[] {
    try {
      const rows = this.inspector.list();
      const root = rows.find((row) => row.pid === registered.registration.pid);
      if (!registered.rootProven && root && root.ppid === process.pid
        && root.startMs >= registered.bornAt - 2_000 && root.startMs <= registered.bornAt + 2_000) {
        registered.known.set(root.pid, root);
        registered.rootProven = true;
      }
      const alive = new Set<number>();
      for (const row of rows) if (sameProcess(registered.known.get(row.pid), row)) alive.add(row.pid);
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of rows) {
          if (!alive.has(row.pid) && alive.has(row.ppid) && row.pid !== process.pid) {
            registered.known.set(row.pid, row); alive.add(row.pid); grew = true;
          }
        }
      }
      return rows.filter((row) => alive.has(row.pid));
    } catch { registered.auditFailed = true; return []; }
  }

  private proof(registered: Registered): GoneEvidence {
    const alive = this.sample(registered);
    const inspectionSucceeded = registered.rootProven && !registered.auditFailed;
    const rootGone = registered.exited && !alive.some((row) => row.pid === registered.registration.pid);
    const descendantsGone = alive.length === 0;
    // OS process exit closes its sockets; every retained descendant must also be absent.
    return { childId: registered.registration.id, rootGone, descendantsGone, inspectionSucceeded,
      socketClosed: inspectionSucceeded && rootGone && descendantsGone };
  }

  private async cleanup(registered: Registered): Promise<GoneEvidence> {
    const reject = new ManagerFault('superseded', 'registered child draining/terminating');
    for (const pending of registered.pending.values()) pending.reject(reject);
    registered.pending.clear();
    const signalOwned = (signal: NodeJS.Signals) => {
      for (const identity of this.sample(registered)) {
        // Reinspect each PID immediately before signalling; no PID/group adoption.
        const rows = this.inspector.list();
        const current = rows.find((row) => row.pid === identity.pid);
        if (!sameProcess(identity, current)) continue;
        try { process.kill(identity.pid, signal); } catch { /* reaped between inspection and signal */ }
      }
    };
    const settle = async (ms: number) => {
      const until = Date.now() + ms;
      do {
        const proof = this.proof(registered);
        if (proof.rootGone && proof.descendantsGone && proof.inspectionSucceeded) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < until);
    };
    try {
      signalOwned('SIGTERM');
      await settle(this.options.termGraceMs ?? 1_000);
      const initial = this.proof(registered);
      if (!initial.rootGone || !initial.descendantsGone) {
        signalOwned('SIGKILL');
        await settle(this.options.killGraceMs ?? 1_000);
      }
      const proof = this.proof(registered);
      this.releaseIfGone(registered, proof);
      return proof;
    } catch { throw new ManagerFault('cleanup_unproven', 'registered process cleanup could not be inspected'); }
  }

  private releaseIfGone(registered: Registered, proof: GoneEvidence): void {
    if (proof.rootGone && proof.descendantsGone) clearInterval(registered.sampler);
    if (proof.inspectionSucceeded && proof.rootGone && proof.descendantsGone && proof.socketClosed) {
      if (this.occupied === registered) this.occupied = undefined;
      if (registered.process.connected) registered.process.disconnect();
    }
  }

  private request(registered: Registered, fence: OperationFence, operation: ManagedRequest['operation'], payload: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal?.aborted || registered.exited || !registered.process.connected) return Promise.reject(new ManagerFault('startup_failed', 'registered child IPC unavailable'));
    const requestId = randomUUID();
    const request: ManagedRequest = { version: 1, kind: 'chunkbot_manager_request', childId: registered.registration.id, requestId, fence: { ...fence }, operation, payload };
    return new Promise((resolve, reject) => {
      const finish = (value: unknown, error?: unknown) => {
        signal?.removeEventListener('abort', aborted);
        registered.pending.delete(requestId);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(undefined, new ManagerFault('superseded', 'child IPC request cancelled'));
      registered.pending.set(requestId, { fence, resolve: (value) => finish(value), reject: (error) => finish(undefined, error) });
      signal?.addEventListener('abort', aborted, { once: true });
      registered.process.send(request, (error) => { if (error) finish(undefined, new ManagerFault('startup_failed', 'child IPC send failed')); });
    });
  }

  private reply(registered: Registered, message: unknown): void {
    if (!message || typeof message !== 'object') return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(message)); } catch { return; }
    if (bytes > 32_768) return;
    const reply = message as Partial<ManagedReply>;
    const event = message as Partial<ManagedChildEvent>;
    if (event.version === 1 && event.kind === 'chunkbot_manager_event' && event.childId === registered.registration.id
      && event.fence && event.fence.sessionId === registered.registration.fence.sessionId
      && event.fence.deploymentGeneration >= registered.registration.fence.deploymentGeneration
      && event.fence.commandGeneration >= registered.registration.fence.commandGeneration
      && event.reason && ['auth_required', 'whitelist_denied', 'server_unavailable', 'identity_conflict', 'protocol_mismatch', 'startup_failed'].includes(event.reason)) {
      for (const listener of this.lossListeners) listener(structuredClone(registered.registration), event.reason);
      for (const pending of registered.pending.values()) pending.reject(new ManagerFault(event.reason, 'registered child lost connection readiness'));
      registered.pending.clear();
      return;
    }
    if (reply.version !== 1 || reply.kind !== 'chunkbot_manager_reply' || reply.childId !== registered.registration.id
      || typeof reply.requestId !== 'string' || !reply.fence || typeof reply.ok !== 'boolean') return;
    const pending = registered.pending.get(reply.requestId);
    if (!pending || !sameFence(pending.fence, reply.fence)) return;
    if (reply.ok) pending.resolve(reply.value);
    else {
      const allowed = ['auth_required', 'whitelist_denied', 'server_unavailable', 'identity_conflict', 'protocol_mismatch', 'startup_failed'];
      const code = reply.failure && allowed.includes(reply.failure) ? reply.failure : 'startup_failed';
      pending.reject(new ManagerFault(code, `registered child reported ${code}`));
    }
  }

  private withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new ManagerFault('superseded', 'registered child wait cancelled'));
    return new Promise((resolve, reject) => {
      const abort = () => { reject(new ManagerFault('superseded', 'registered child wait cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}

function sameProcess(a: ProcessIdentity | undefined, b: ProcessIdentity | undefined): boolean {
  return !!a && !!b && a.pid === b.pid && a.startMs === b.startMs && a.command === b.command;
}
