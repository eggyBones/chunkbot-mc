// Privileged bridge target only; ordinary game chat never routes here. The
// bridge proves the server UUID. This boundary independently checks scope,
// control session, freshness, schema and duplicate/ordering fences.
import { ServerControlRequestSchema, type Clock, type ManagedScope, type ReleaseManagerPort, type ServerControlReceipt, type ServerControlRequest, type ServerControlTargetPort } from '../contracts/index.ts';

export function serverControlTarget(options: {
  manager: ReleaseManagerPort;
  scope: ManagedScope;
  controlSessionId: string;
  clock: Clock;
}): ServerControlTargetPort {
  const scope = structuredClone(options.scope);
  let latest = -1;
  let latestAction: ServerControlRequest['action'] | undefined;
  const seen = new Map<string, { signature: string; expiry: number; receipt: Promise<ServerControlReceipt> }>();
  const rejected = (request: ServerControlRequest, detail: string): ServerControlReceipt => ({ requestId: request.requestId, generation: request.generation, status: 'rejected', detail, manager: options.manager.status() });
  return {
    async handle(raw) {
      const parsed = ServerControlRequestSchema.safeParse(raw);
      if (!parsed.success) return { requestId: 'invalid', generation: 0, status: 'rejected', detail: 'invalid control request', manager: options.manager.status() };
      const request = parsed.data;
      const now = options.clock.now();
      if (request.controlSessionId !== options.controlSessionId || Object.entries(scope).some(([key, value]) => request.scope[key as keyof ManagedScope] !== value)) return rejected(request, 'control session or verified owner/world/bot scope mismatch');
      if (request.issuedAtMs > now || request.expiresAtMs <= now) return rejected(request, 'control request is not current');
      for (const [id, entry] of seen) if (entry.expiry <= now) seen.delete(id);
      const signature = JSON.stringify(request);
      const previous = seen.get(request.requestId);
      if (previous) {
        if (previous.signature !== signature) return rejected(request, 'request identity reused with different contents');
        const result = await previous.receipt;
        return { ...result, status: result.status === 'applied' ? 'duplicate' : result.status, manager: options.manager.status() };
      }
      // Keep in-flight idempotence bounded; refusal cannot start an extra child.
      if (seen.size >= 128) return rejected(request, 'control request window is full');
      if (request.action !== 'status') {
        if (request.generation < latest || (request.generation === latest && !(request.action === 'off' && latestAction === 'on'))) return rejected(request, 'stale or conflicting control generation');
        latest = request.generation;
        latestAction = request.action;
      }
      const receipt = (async (): Promise<ServerControlReceipt> => {
        try {
          const manager = request.action === 'on' ? await options.manager.start() : request.action === 'off' ? await options.manager.logout() : options.manager.status();
          if (request.action !== 'status' && (request.generation !== latest || request.action !== latestAction)) return rejected(request, 'superseded by a newer control request');
          return { requestId: request.requestId, generation: request.generation, status: 'applied', detail: manager.detail, manager };
        } catch {
          return rejected(request, 'manager could not apply the control request');
        }
      })();
      seen.set(request.requestId, { signature, expiry: request.expiresAtMs, receipt });
      return receipt;
    },
  };
}
