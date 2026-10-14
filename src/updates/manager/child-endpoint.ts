import { z } from 'zod';
import { ManagerFault, type AcceptedRelease, type CheckpointRef, type DrainEvidence,
  type ManagerIntent, type OperationFence, type ReadinessEvidence } from './ports.ts';
import type { ManagedChildEvent, ManagedReply, ManagedRequest } from './native-child.ts';

const text = z.string().min(1).max(1_024);
const fenceSchema = z.strictObject({ sessionId: text, deploymentGeneration: z.number().int().nonnegative(), commandGeneration: z.number().int().nonnegative() });
const intentSchema = z.strictObject({ sessionId: text, generation: z.number().int().nonnegative(), online: z.boolean(), paused: z.boolean() });
const checkpointSchema = z.strictObject({ id: text, sessionId: text, schema: z.number().int().positive() });
const releaseSchema = z.strictObject({ id: text, digest: z.string().regex(/^[a-f0-9]{64}$/), summary: z.string().max(240),
  profile: z.strictObject({ worldProfile: text, botProfile: text, ownerProfile: text, serverVersion: text, protocol: z.number().int().positive() }),
  checkpointSchema: z.number().int().positive(), artifactRoot: text, entrypoint: text });
const requestSchema = z.strictObject({ version: z.literal(1), kind: z.literal('chunkbot_manager_request'),
  childId: text, requestId: text, fence: fenceSchema,
  operation: z.enum(['initialize', 'drain', 'readiness', 'activate', 'pause', 'announce']), payload: z.unknown() });

export interface ManagedChildServices {
  /** Integration must join with gameplay admission CLOSED and restore accounting first. */
  initialize(context: { release: AcceptedRelease; checkpoint: CheckpointRef; intent: ManagerIntent }, fence: OperationFence, signal: AbortSignal): Promise<void>;
  /** Values derived independently from the loaded artifact and current server evidence. */
  readiness(fence: OperationFence, signal: AbortSignal): Promise<Omit<ReadinessEvidence, 'childId' | 'fence'>>;
  /** Real shutdown/engine/control/interface/provider cleanup, plus durable freeze. */
  drain(fence: OperationFence, signal: AbortSignal): Promise<Omit<DrainEvidence, 'childId' | 'fence'>>;
  activate(intent: ManagerIntent, fence: OperationFence, signal: AbortSignal): Promise<void>;
  pause(intent: ManagerIntent, fence: OperationFence, signal: AbortSignal): Promise<void>;
  /** Preserve existing whisper/public reply mode; never public-fallback a whisper. */
  announce(text: string, fence: OperationFence, signal: AbortSignal): Promise<'sent' | 'unavailable'>;
}

export interface ChildIpc {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  send(reply: ManagedReply | ManagedChildEvent): unknown;
}

/** Owned child entry point; callers bind existing application services before joining. */
export function attachManagedChild(services: ManagedChildServices, ipc: ChildIpc): { close(): Promise<void>; reportLoss(reason: ManagedChildEvent['reason']): void } {
  let identity: { childId: string; sessionId: string; deploymentGeneration: number } | undefined;
  let latestCommand = -1;
  let initialized = false;
  let initializationStarted = false;
  let activated = false;
  let draining = false;
  let closed = false;
  let lastIntent: ManagerIntent | undefined;
  const requests = new Set<string>();
  const notices = new Set<number>();
  const active = new Map<string, { controller: AbortController; work: Promise<void> }>();

  const send = (request: ManagedRequest, value: unknown, error?: unknown) => {
    if (closed) return;
    const allowed = ['auth_required', 'whitelist_denied', 'server_unavailable', 'identity_conflict', 'protocol_mismatch', 'startup_failed'];
    const failure = error instanceof ManagerFault && allowed.includes(error.code) ? error.code as NonNullable<ManagedReply['failure']> : 'startup_failed';
    try { ipc.send({ version: 1, kind: 'chunkbot_manager_reply', childId: request.childId, requestId: request.requestId,
      fence: request.fence, ok: !error, ...(error ? { failure } : { value }) }); } catch { /* parent exited; no retry or new action */ }
  };
  const listener = (message: unknown) => {
    if (closed) return;
    try { if (Buffer.byteLength(JSON.stringify(message)) > 32_768) return; } catch { return; }
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) return;
    const request = parsed.data as ManagedRequest;
    if (requests.has(request.requestId)) return;
    if (!identity) {
      if (request.operation !== 'initialize') return;
      identity = { childId: request.childId, sessionId: request.fence.sessionId, deploymentGeneration: request.fence.deploymentGeneration };
    }
    if (identity.childId !== request.childId || identity.sessionId !== request.fence.sessionId
      || request.fence.deploymentGeneration < identity.deploymentGeneration || request.fence.commandGeneration < latestCommand) return;
    if (active.size >= 8) { send(request, undefined, new ManagerFault('startup_failed', 'managed IPC capacity exceeded')); return; }
    if (request.operation === 'initialize') {
      if (initializationStarted) { send(request, undefined, new ManagerFault('startup_failed', 'managed initialization already registered')); return; }
      initializationStarted = true;
    }
    requests.add(request.requestId);
    if (requests.size > 128) requests.delete(requests.values().next().value!);
    const superseding = request.operation === 'drain' || request.operation === 'pause';
    if (superseding) {
      if (request.operation === 'drain') draining = true;
      for (const pending of active.values()) pending.controller.abort();
    }
    latestCommand = Math.max(latestCommand, request.fence.commandGeneration);
    const tails = [...active.values()].map((pending) => pending.work);
    const controller = new AbortController();
    const work = Promise.resolve().then(async () => {
      if (superseding) await Promise.allSettled(tails); // real settlement, including ignored cancellation
      if (closed || controller.signal.aborted || request.fence.commandGeneration < latestCommand) throw new ManagerFault('superseded', 'newer managed child intent won');
      let value: unknown = null;
      switch (request.operation) {
        case 'initialize': {
          if (initialized || draining) throw new ManagerFault('startup_failed', 'managed initialization refused');
          const context = z.strictObject({ release: releaseSchema, checkpoint: checkpointSchema, intent: intentSchema }).parse(request.payload);
          if (context.intent.sessionId !== identity!.sessionId || context.checkpoint.sessionId !== identity!.sessionId
            || context.intent.generation !== request.fence.commandGeneration || !context.intent.online
            || context.checkpoint.schema !== context.release.checkpointSchema) throw new ManagerFault('startup_failed', 'managed startup scope mismatch');
          lastIntent = context.intent;
          await services.initialize(context, request.fence, controller.signal);
          if (controller.signal.aborted || draining) throw new ManagerFault('superseded', 'startup drained');
          initialized = true;
          break;
        }
        case 'readiness':
          if (!initialized || draining) throw new ManagerFault('startup_failed', 'managed child not initialized');
          value = { ...await services.readiness(request.fence, controller.signal), childId: request.childId, fence: request.fence };
          break;
        case 'drain':
          value = { ...await services.drain(request.fence, controller.signal), childId: request.childId, fence: request.fence };
          break;
        case 'activate':
        case 'pause': {
          const { intent } = z.strictObject({ intent: intentSchema }).parse(request.payload);
          if (intent.sessionId !== identity!.sessionId || intent.generation !== request.fence.commandGeneration) throw new ManagerFault('startup_failed', 'managed intent scope mismatch');
          if (!initialized || draining || !intent.online) throw new ManagerFault('startup_failed', 'managed admission closed');
          lastIntent = intent;
          if (request.operation === 'activate' && !activated) {
            activated = true;
            await services.activate(intent, request.fence, controller.signal);
          }
          else if (request.operation === 'activate') break;
          else await services.pause(intent, request.fence, controller.signal);
          break;
        }
        case 'announce': {
          if (!initialized || draining || !lastIntent?.online) throw new ManagerFault('startup_failed', 'managed notice unavailable');
          if (notices.has(request.fence.deploymentGeneration)) { value = 'unavailable'; break; }
          notices.add(request.fence.deploymentGeneration);
          const { text: notice } = z.strictObject({ text: z.string().min(1).max(240).refine((value) => !/[\r\n]/.test(value)) }).parse(request.payload);
          value = await services.announce(notice, request.fence, controller.signal);
          break;
        }
      }
      if (controller.signal.aborted || request.fence.commandGeneration < latestCommand) throw new ManagerFault('superseded', 'late managed result discarded');
      send(request, value);
    }).catch((error: unknown) => send(request, undefined, error)).finally(() => active.delete(request.requestId));
    active.set(request.requestId, { controller, work });
  };
  ipc.on('message', listener);
  return {
    reportLoss(reason) {
      if (closed || !identity) return;
      draining = true;
      for (const pending of active.values()) pending.controller.abort();
      try { ipc.send({ version: 1, kind: 'chunkbot_manager_event', childId: identity.childId,
        fence: { sessionId: identity.sessionId, deploymentGeneration: identity.deploymentGeneration, commandGeneration: latestCommand }, reason }); } catch { /* parent already gone */ }
    },
    async close() {
      closed = true; draining = true; ipc.off('message', listener);
      for (const pending of active.values()) pending.controller.abort();
      await Promise.allSettled([...active.values()].map((pending) => pending.work));
    },
  };
}
