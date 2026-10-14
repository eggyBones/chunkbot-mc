// Application-side release IPC target. Reuses the real ChunkbotApp/GoalEngine;
// it owns neither process launch policy nor durable checkpoint/accounting stores.
import type { ChildReadiness, DeploymentFence, ManagedChildAppPort, ManagedScope } from '../contracts/index.ts';
import type { ChunkbotApp } from './app.ts';

export interface ManagedAppContext {
  fence: DeploymentFence;
  scope: ManagedScope;
  /** Real read-only runtime probe; must recheck epoch/currentness after awaits. */
  probeReadiness(): Promise<Omit<ChildReadiness, 'fence' | 'scope' | 'ready' | 'detail'>>;
}

export function managedAppPort(app: ChunkbotApp, context: ManagedAppContext): ManagedChildAppPort {
  const fence = structuredClone(context.fence);
  const scope = structuredClone(context.scope);
  let readyEpoch: number | undefined;
  let announced = false;
  return {
    async readiness() {
      readyEpoch = undefined;
      const facts = await context.probeReadiness();
      const ready = app.connectionState === 'ready' && !app.isDrainingForUpdate && facts.connectionEpoch === app.connectionEpoch &&
        facts.serverVersion === app.lastReady?.serverVersion && facts.protocolVersion === app.lastReady?.protocolVersion &&
        facts.ownerVerified && facts.botUuid !== null && facts.botUuid.toLowerCase() !== scope.ownerUuid.toLowerCase() &&
        facts.spawned && facts.inventoryFresh && facts.observationFresh && facts.planner.ready && facts.decision.ready && facts.catalogVersion.length > 0;
      if (ready) readyEpoch = facts.connectionEpoch;
      return { ...facts, fence: structuredClone(fence), scope: structuredClone(scope), ready, detail: ready ? 'fresh connection evidence and registered providers ready; no inference probe' : 'readiness is incomplete; no success notice is authorized' };
    },
    async drain() {
      readyEpoch = undefined;
      const result = await app.drainForUpdate();
      return { ...result, fence: structuredClone(fence) };
    },
    stop: () => app.stop({ surface: 'terminal', principal: 'operator' }),
    async logout() { readyEpoch = undefined; await app.shutdown('operator_quit'); },
    async announce(summary) {
      if (announced) return { sent: false, detail: 'this release was already announced' };
      if (readyEpoch === undefined || readyEpoch !== app.connectionEpoch) return { sent: false, detail: 'fresh readiness is required before announcement' };
      const result = app.announceUpdate(summary);
      if (result.sent) announced = true;
      return result;
    },
  };
}
