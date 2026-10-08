// Private application guidance for the existing client-only stall receipt.
// Every destination is verified by the one route controller; this grants no
// action, route, predicate result, inventory/effect evidence or allowance.
import type { ActionCandidate, AdmittedTask, CapabilityDescriptor } from '../contracts/index.ts';
import type { OwnedMotionSample } from '../execution/executor.ts';
import type { RouteController } from '../locator/routes.ts';
import type { LocatorService } from '../locator/service.ts';
import type { PerceptionService } from '../perception/perception.ts';

export interface MotionGuidanceDeps {
  descriptor(capability: string): CapabilityDescriptor | undefined;
  routes: Pick<RouteController, 'authorization' | 'status' | 'legBounds' | 'verifyDestination' | 'frozenOwnDeath'>;
  locator: Pick<LocatorService, 'steering'>;
  admissionBounds(): ReturnType<PerceptionService['admissionBounds']>;
  goalEpoch(): number;
  connectionEpoch(): number;
  held(): boolean;
}

export function currentMotionGuidance(deps: MotionGuidanceDeps, task: AdmittedTask, candidate: ActionCandidate, sample: OwnedMotionSample): { authorityId: string; bearingRad: number } | undefined {
  const descriptor = deps.descriptor(candidate.capability);
  if (descriptor?.family !== 'movement' || task.goalEpoch !== deps.goalEpoch() || sample.connectionEpoch !== deps.connectionEpoch() || deps.held()) return undefined;
  const ctx = { goalEpoch: task.goalEpoch, connectionEpoch: sample.connectionEpoch, dimension: sample.dimension };
  const auth = deps.routes.authorization(ctx), status = deps.routes.status(task.goalEpoch);
  if (!auth || auth.goalId !== task.goalId || !status || status.goalId !== task.goalId || status.routeId !== auth.routeId || (status.state !== 'authorized' && status.state !== 'leg_active') || status.remainingMs <= 0 || status.distanceUsed >= status.maxTotalDistance || status.legsUsed > status.maxLegs) return undefined;
  const bounds = status.state === 'leg_active' ? deps.routes.legBounds(ctx) : deps.admissionBounds();
  if (!bounds || bounds.goalEpoch !== task.goalEpoch || bounds.connectionEpoch !== sample.connectionEpoch || bounds.dimension !== sample.dimension || Math.hypot(sample.self.x - bounds.anchor.x, sample.self.z - bounds.anchor.z) > bounds.radius) return undefined;

  if (descriptor.targets?.includes('owner') && (task.requiresOwnerDirection || task.spec.targetSelectors.some((s) => s.kind === 'owner'))) {
    const cue = deps.locator.steering();
    return auth.destinations.includes('owner') && cue?.connectionEpoch === sample.connectionEpoch ? { authorityId: auth.routeId, bearingRad: cue.bearingRad } : undefined;
  }

  if (!descriptor.targets?.includes('owner_destination')) return undefined;
  // Declared, admitted destination parameters, not instruction words or a
  // capability ID. The executor has already fenced the actual action sample.
  if (candidate.parameters['destination'] !== undefined) {
    if (candidate.parameters['destination'] !== 'own_death' || task.spec.parameters['destination'] !== 'own_death' || candidate.parameters['target'] !== undefined || !descriptor.parameters.some((p) => p.name === 'destination' && p.enum?.includes('own_death'))) return undefined;
    const verified = deps.routes.verifyDestination(ctx, 'own_death');
    // The real route executor freezes this complete incident before dispatch.
    // Never use a merely available provider value as execution progress.
    if (!verified.ok || verified.kind !== 'own_death' || !deps.routes.frozenOwnDeath(ctx)) return undefined;
    const identity = verified.identity;
    return {
      authorityId: JSON.stringify([auth.routeId, 'own_death', identity.destinationId, identity.dimension, identity.at.x, identity.at.y, identity.at.z, identity.recordedAtMs]),
      bearingRad: Math.atan2(verified.at.z - sample.self.z, verified.at.x - sample.self.x),
    };
  }
  if (task.spec.parameters['destination'] !== undefined) return undefined;
  const target = candidate.parameters['target'];
  if (!target || typeof target !== 'object' || Array.isArray(target) || target['kind'] !== 'destination' || typeof target['dimension'] !== 'string' || typeof target['x'] !== 'number' || typeof target['y'] !== 'number' || typeof target['z'] !== 'number' || ![target['x'], target['y'], target['z']].every(Number.isFinite)) return undefined;
  if (!descriptor.parameters.some((p) => p.name === 'target' && p.type === 'target_selector')) return undefined;
  const at = { x: target['x'], y: target['y'], z: target['z'] };
  const verified = deps.routes.verifyDestination(ctx, 'owner_destination', at, target['dimension']);
  return verified.ok ? {
    authorityId: JSON.stringify([auth.routeId, 'owner_destination', target['dimension'], at.x, at.y, at.z]),
    bearingRad: Math.atan2(verified.at.z - sample.self.z, verified.at.x - sample.self.x),
  } : undefined;
}
