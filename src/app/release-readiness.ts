// The real composition's release readiness probe. It calls no model, login,
// diagnostic skill or movement. Inventory is a correlated read-only resync.
import type { ChildReadiness, DecisionPort, ManagedScope } from '../contracts/index.ts';
import type { ChunkbotConfig } from '../config/schema.ts';
import type { MineflayerConnection } from '../game/connection.ts';
import { isOwnerPlayer, ownerPolicyFromConfig } from '../game/identity.ts';
import type { ChunkbotApp } from './app.ts';
import type { SkillRuntime } from './skill-runtime.ts';
import { resolveAutonomyScope } from '../autonomy/scope.ts';

export async function inspectReleaseReadiness(input: {
  app: ChunkbotApp;
  game: MineflayerConnection;
  runtime: SkillRuntime;
  config: ChunkbotConfig;
  scope: ManagedScope;
  decision: Pick<DecisionPort, 'readiness'>;
}): Promise<Omit<ChildReadiness, 'fence' | 'scope' | 'ready' | 'detail'>> {
  const { app, game, runtime, config, scope } = input;
  const epoch = game.connectionEpoch;
  const session = game.session();
  const ready = app.lastReady;
  const policy = ownerPolicyFromConfig(config);
  const identity = game.admissionContext();
  const configured = resolveAutonomyScope(config.autonomy?.scope, config.memory);
  const scopeMatches = !configured.conflict && (!configured.scope || (configured.scope.worldProfile === scope.worldProfile && configured.scope.worldRevision === scope.worldRevision && configured.scope.botProfile === scope.botProfile));
  let inventoryFresh = false;
  let observationFresh = false;
  if (session && ready && !app.isDrainingForUpdate) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2_500);
    try {
      const since = Date.now();
      const inventory = await runtime.predicates.captureBaseline(abort.signal);
      const snapshot = await runtime.perception.snapshot(app.engine.currentEpoch);
      const current = game.session();
      const same = current?.bot === session.bot && current?.connectionEpoch === epoch && snapshot?.connectionEpoch === epoch && game.state === 'ready' && snapshot?.dimension === String(session.bot.game.dimension);
      inventoryFresh = same && !abort.signal.aborted && inventory.counts !== null && inventory.connectionEpoch === epoch && inventory.capturedAtMs >= since;
      observationFresh = same && !abort.signal.aborted && snapshot !== null && snapshot.takenAtMs >= since;
    } finally { clearTimeout(timer); }
  }
  return {
    connectionEpoch: epoch,
    serverVersion: ready?.serverVersion ?? 'unknown',
    protocolVersion: ready?.protocolVersion ?? -1,
    botUuid: identity.selfUuid ?? null,
    ownerVerified: scopeMatches && game.connectionEpoch === epoch && Object.values(game.session()?.bot.players ?? {}).some((p) => p.uuid?.toLowerCase() === scope.ownerUuid.toLowerCase() && isOwnerPlayer(policy, p, game.admissionContext())),
    spawned: game.state === 'ready' && ready !== undefined && (game.statusInfo().health ?? 0) > 0,
    inventoryFresh,
    observationFresh,
    catalogVersion: runtime.registry.catalog().catalogVersion,
    planner: app.engine.status().readiness.planner,
    decision: input.decision.readiness(),
  };
}
