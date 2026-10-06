// Entity family: direct interaction (right-click with an item, e.g. shears on a
// sheep or a bucket on a cow) and attacks. Evidence:
//   - interaction: server entity metadata flags (watched), server item spawns
//     near the entity, server inventory resync diff;
//   - attack: server damage_event naming the target after each hit, and death
//     only from the server entity status 3 (death) for that entity. An entity
//     leaving view or being destroyed is NOT reported as defeated.
import { z } from 'zod';
import type { JsonValue } from '../contracts/index.ts';
import { countsDiff } from '../execution/ledger.ts';
import { ENTITY_REACH, eyeOf } from '../perception/perception.ts';
import { admittedParameters, confirmInventory, ensureInHand, liveEntity, matchesHints, mk, namedTargetUnavailable, targetScope } from './common.ts';
import { failed, precondition, type CandidateDraft, type SkillDefinition, type Unavailable } from './definition.ts';
import { HandleRefSchema, ItemKeySchema } from './refs.ts';

/** Distance from the eye to the nearest point of an entity's box (approximate reach check). */
function reachDistance(eye: { x: number; y: number; z: number }, at: { x: number; y: number; z: number }, height: number, width = 0.6): number {
  const cx = Math.max(at.x - width / 2, Math.min(eye.x, at.x + width / 2));
  const cy = Math.max(at.y, Math.min(eye.y, at.y + height));
  const cz = Math.max(at.z - width / 2, Math.min(eye.z, at.z + width / 2));
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz);
}

const DEATH_STATUS = 3;

export const interactEntity: SkillDefinition<{ target: { snapshotId: string; handle: string }; withItem?: string | null | undefined }> = {
  descriptor: {
    id: 'interact_entity',
    family: 'entity',
    purpose: 'Right-click a visible entity within reach, optionally holding an item first (e.g. shears on a sheep, a bucket on a cow, food on an animal).',
    parameters: [
      { name: 'target', type: 'handle', description: '{snapshotId, handle} of a visible ent-* entity', required: true },
      { name: 'withItem', type: 'registry_key', description: 'item to hold while interacting', required: false },
    ],
    targets: ['entity'],
    preconditions: [`entity visible and within ${ENTITY_REACH} blocks`],
    effects: ['whatever the game does: entity state change, dropped items, inventory change'],
    supportedPredicates: ['entity_outcome', 'inventory_amount'],
    timeoutMs: 15_000,
    cancellation: 'stop prevents the interaction packet if not yet sent',
    limitations: ['reports no_observed_effect when the server shows no change', 'does not attack players or the owner'],
    evidence: ['server entity metadata flags', 'server item spawns near the entity', 'server inventory resync diff'],
  },
  params: z.object({ target: HandleRefSchema, withItem: ItemKeySchema.nullable().optional() }).strict(),
  resolve(ctx) {
    const { snapshot, hints } = ctx;
    const scope = targetScope(ctx);
    const item = admittedParameters(ctx, interactEntity.params).values['withItem'] as string | undefined;
    const drafts: CandidateDraft[] = snapshot.entities
      .filter((e) => e.label !== 'owner' && e.label !== 'player' && (scope.named ? scope.allows(e.handle) : hints.keys.length > 0 && matchesHints(e.key, hints, ctx.services)))
      .filter((e) => e.inReach)
      .slice(0, 4)
      .map((e) => ({ parameters: { target: { snapshotId: snapshot.id, handle: e.handle }, ...(item ? { withItem: item } : {}) }, description: `interact with ${e.key} ${e.handle}${item ? ` holding ${item}` : ''}` }));
    return { drafts, unavailable: drafts.length ? [] : [scope.named && ![...snapshot.entities].some((e) => scope.allows(e.handle)) ? namedTargetUnavailable(scope, 'entity') : { reason: 'no_entity_in_reach', detail: 'no matching visible entity within reach' }] };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    if (bot.currentWindow) return precondition('interface_open', 'another interface is open');
    const live = liveEntity(services, session, params.target.snapshotId, params.target.handle);
    if ('error' in live) return precondition(live.error, live.detail);
    if (live.record.target.kind !== 'entity') return precondition('wrong_target_kind', 'target is not an entity');
    if (!services.perception.entityVisibleNow(live.entityId)) return precondition('not_visible', `${live.name} is not visible`);
    const reach = reachDistance(eyeOf(bot), live.position, live.height);
    if (reach > ENTITY_REACH) return precondition('out_of_reach', `${live.name} is ${reach.toFixed(1)} blocks away (reach ${ENTITY_REACH})`, { distance: Math.round(reach * 10) / 10 });
    if (params.withItem) {
      const held = await ensureInHand(act, services, mk(params.withItem));
      if (!held.ok) return precondition('item_not_in_inventory', held.detail);
    }
    const before = await confirmInventory(act, services);
    session.evidence.watch(live.entityId);
    const startSeq = session.evidence.seq;
    await act.useOnEntity(live.entityId, { x: live.position.x, y: live.position.y + live.height * 0.6, z: live.position.z });
    await act.sleep(800);
    const flags = session.evidence.since(startSeq, 'entity_flags', (e) => e.entityId === live.entityId);
    const pos = bot.entities[live.entityId]?.position ?? live.position;
    const spawns = session.evidence.since(startSeq, 'item_spawn', (e) => Math.hypot(e.x - pos.x, e.z - pos.z) < 3);
    const spawned = spawns.map((s) => session.evidence.latest('item_stack', (x) => x.entityId === s.entityId)?.stack).filter(Boolean);
    const after = await confirmInventory(act, services);
    const diff = before && after ? countsDiff(before.counts, after.counts) : {};
    const evidence: Record<string, JsonValue> = {
      entity: mk(live.name),
      entityId: live.entityId,
      withItem: params.withItem ?? null,
      metadataChanges: flags.slice(0, 8).map((f) => ({ key: f.key, value: f.value })),
      droppedNearEntity: spawned as unknown as JsonValue,
      inventoryChange: diff,
    };
    if (flags.length === 0 && spawns.length === 0 && Object.keys(diff).length === 0) {
      return failed('no_observed_effect', `interacted with ${mk(live.name)} but the server reported no change`, evidence, 'none');
    }
    return { status: 'succeeded', effect: `interacted with ${mk(live.name)}: inventory ${JSON.stringify(diff)}, ${spawns.length} item(s) dropped nearby, ${flags.length} metadata change(s)`, confirmation: 'server_packet', evidence };
  },
};

export const attackEntity: SkillDefinition<{ target: { snapshotId: string; handle: string }; maxHits: number }> = {
  descriptor: {
    id: 'attack_entity',
    family: 'entity',
    purpose: 'Attack a visible non-player entity within reach with the held item, up to a bounded number of hits, respecting attack cooldown.',
    parameters: [
      { name: 'target', type: 'handle', description: '{snapshotId, handle} of a visible ent-* entity', required: true },
      { name: 'maxHits', type: 'integer', description: 'maximum hits this action may deliver', required: false, minimum: 1, maximum: 10 },
    ],
    targets: ['entity'],
    preconditions: [`entity visible and within ${ENTITY_REACH} blocks`, 'never players or the owner'],
    effects: ['entity damaged; possibly defeated (server-confirmed)'],
    supportedPredicates: ['entity_outcome'],
    timeoutMs: 20_000,
    cancellation: 'stop prevents further hits immediately',
    limitations: ['does not chase a target that is knocked out of reach', 'defeat is claimed only from the server death status, never from disappearance'],
    evidence: ['server damage_event per hit', 'server entity status 3 (death)'],
  },
  params: z.object({ target: HandleRefSchema, maxHits: z.number().int().min(1).max(10).default(3) }).strict(),
  resolve(ctx) {
    const { snapshot, hints } = ctx;
    const scope = targetScope(ctx);
    const maxHits = (admittedParameters(ctx, attackEntity.params).values['maxHits'] as number | undefined) ?? 3;
    const candidates = snapshot.entities.filter((e) => e.label !== 'owner' && e.label !== 'player' && e.key !== 'minecraft:player' && (scope.named ? scope.allows(e.handle) : hints.keys.length > 0 && matchesHints(e.key, hints, ctx.services)));
    if (scope.named && candidates.length === 0) return { drafts: [], unavailable: [namedTargetUnavailable(scope, 'entity to attack')] };
    const drafts: CandidateDraft[] = candidates.filter((e) => e.inReach).slice(0, 4).map((e) => ({ parameters: { target: { snapshotId: snapshot.id, handle: e.handle }, maxHits }, description: `attack ${e.key} ${e.handle}` }));
    const unavailable: Unavailable[] = [];
    if (drafts.length === 0) {
      const near = candidates[0];
      unavailable.push(near ? { reason: 'out_of_reach', detail: `${near.key} is ${near.distance} blocks away`, evidence: { handle: near.handle, distance: near.distance } } : { reason: 'no_visible_target', detail: 'no matching visible non-player entity' });
    }
    return { drafts, unavailable };
  },
  async execute(ctx, params) {
    const { act, services, session } = ctx;
    const bot = session.bot;
    const live = liveEntity(services, session, params.target.snapshotId, params.target.handle);
    if ('error' in live) return precondition(live.error, live.detail);
    if (live.record.target.kind !== 'entity' || live.name === 'player' || live.record.target.isOwner) return precondition('refused_target', 'attacking players or the owner is not supported');
    const id = live.entityId;
    session.evidence.watch(id);
    const startSeq = session.evidence.seq;
    let hits = 0;
    let damage = 0;
    let defeated = false;
    for (let i = 0; i < params.maxHits; i += 1) {
      const e = bot.entities[id];
      if (!e?.position) break;
      if (!services.perception.entityVisibleNow(id)) return failed('not_visible', `${live.name} is no longer visible`, { hits, damageConfirmed: damage });
      const reach = reachDistance(eyeOf(bot), e.position, live.height);
      if (reach > ENTITY_REACH) {
        if (hits === 0) return precondition('out_of_reach', `${live.name} is ${reach.toFixed(1)} blocks away`, { distance: Math.round(reach * 10) / 10 });
        break;
      }
      const hitSeq = session.evidence.seq;
      await act.attackEntity(id, { x: e.position.x, y: e.position.y + live.height * 0.6, z: e.position.z });
      hits += 1;
      const dmg = await act.waitServer('damage', (d) => d.entityId === id, hitSeq, 800);
      if (dmg) damage += 1;
      ctx.progress({ hits, damageConfirmed: damage }, damage > 0 ? 'server_packet' : 'local');
      if (session.evidence.since(startSeq, 'entity_status', (s) => s.entityId === id && s.status === DEATH_STATUS).length > 0) {
        defeated = true;
        break;
      }
      await act.sleep(700); // attack cooldown (conservative for swords/axes/hand)
      if (session.evidence.since(startSeq, 'entity_status', (s) => s.entityId === id && s.status === DEATH_STATUS).length > 0) {
        defeated = true;
        break;
      }
    }
    const destroyed = session.evidence.since(startSeq, 'entity_destroy', (d) => d.entityIds.includes(id)).length > 0;
    const evidence: Record<string, JsonValue> = { entity: mk(live.name), entityId: id, hitsSent: hits, damageConfirmed: damage, defeatedByServerStatus: defeated, destroyedAfter: destroyed };
    if (defeated) {
      services.ledger.add({ kind: 'entity_defeated', entityId: id, entity: mk(live.name), atMs: services.clock.now() });
      return { status: 'succeeded', effect: `defeated ${mk(live.name)} (server death status) after ${hits} hit(s), ${damage} confirmed`, confirmation: 'server_packet', evidence };
    }
    if (damage > 0) return { status: 'partial', reason: 'not_defeated', effect: `${damage}/${hits} hits confirmed on ${mk(live.name)}; not defeated${destroyed ? ' (entity removed without a death status: not counted as defeated)' : ''}`, confirmation: 'server_packet', evidence };
    return failed('no_damage_confirmed', `no server damage event for ${mk(live.name)} after ${hits} hit(s)`, evidence);
  },
};
