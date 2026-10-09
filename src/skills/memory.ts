// Memory family (MB-MEM-001): bounded, registered capabilities over the
// durable memory service. They are created bound to an installed, enabled
// MemoryService (memorySkills(service)); a disabled memory registers nothing.
//
//   remember_location  owner designation of a CODE-GROUNDED location (bot
//                      position, visible owner, observed handle, shown anchor,
//                      or owner-typed coordinates). Trusted only when the label
//                      is in the owner's own words; otherwise an unverified note.
//   forget_memory      owner-grounded tombstone of one remembered fact.
//   note_memory        an UNVERIFIED note (never trusted, never a target).
//   go_to_memory       bounded travel to a request-bound memory ref; arrival is
//                      client physics at a REMEMBERED place (presence of
//                      anything there is not verified).
//
// Memory writes have no world effect: outcomes report confirmation `none` with
// `evidence.memory.confirmation = "local_memory_store"` and the durable store
// revision, never a server packet. Completion uses the code-evaluated
// `memory_state` predicate (or near_target with a memory_ref for travel).
import { z } from 'zod';
import { OWNER_DESIGNATION_CATEGORIES, MemoryFactIdSchema, MemoryRefIdSchema, type MemoryLocation } from '../contracts/memory.ts';
import type { JsonValue } from '../contracts/index.ts';
import { matchesOwnerCoordinate, parseOwnerCoordinates } from '../goals/owner-coordinates.ts';
import type { MemoryService, MemoryWriteOutcome } from '../memory/service.ts';
import { admittedParameters, json, pos3, targetScope } from './common.ts';
import { failed, precondition, type AnySkill, type CandidateDraft, type ExecuteContext, type ResolveContext, type SkillDefinition, type SkillResult, type TaskHints, type Unavailable } from './definition.ts';
import { GoalBesideBlock, distanceTo, goals, navigate } from './navigation.ts';
import { MoveTargetSchema, type MoveTarget } from './refs.ts';

const LabelSchema = z.string().trim().min(1).max(60);
const CATEGORY = z.enum(OWNER_DESIGNATION_CATEGORIES);

/** Memory refs named by the task's selectors (TaskHints.memoryRefs once the writer installs the selector). */
export function memoryRefsOf(hints: TaskHints): string[] {
  return [...new Set((hints as TaskHints & { memoryRefs?: string[] }).memoryRefs ?? [])];
}

function goalIdOf(ctx: ExecuteContext): string | undefined {
  return ctx.owner.kind === 'goal' && ctx.owner.goalId ? ctx.owner.goalId : undefined;
}

function memoryResult(r: MemoryWriteOutcome, what: string): SkillResult {
  if (!r.ok) return r.reason === 'memory_write_failed' ? failed(r.reason, r.detail) : precondition(r.reason, r.detail);
  const evidence: Record<string, JsonValue> = {
    memory: json({ confirmation: 'local_memory_store', factId: r.fact.id, label: r.fact.label, category: r.fact.category, source: r.fact.source, trust: r.trusted ? 'trusted' : 'untrusted', change: r.change, storeRevision: r.storeRevision, affected: r.affected }),
  };
  if (r.downgraded) {
    return { status: 'partial', reason: 'not_owner_grounded', effect: `${what}: ${r.detail} (memory store revision ${r.storeRevision}; local memory write, not a world effect)`, confirmation: 'none', evidence };
  }
  return { status: 'succeeded', effect: `${what}: ${r.detail} (durable memory store revision ${r.storeRevision}; local memory write, not a world effect)`, confirmation: 'none', evidence };
}

/** Code-grounded location for a designation target (live revalidation at execution). */
function groundLocation(ctx: ExecuteContext, memory: MemoryService, target: MoveTarget | undefined): { location: MemoryLocation; basis: string; key?: string } | SkillResult {
  const { services, session } = ctx;
  const bot = session.bot;
  const dimension = String(bot.game.dimension);
  const now = services.clock.now();
  if (!target) {
    const p = bot.entity.position;
    return { location: { dimension, at: pos3(p) }, basis: `the bot's position ${pos3(p).x},${pos3(p).y},${pos3(p).z} at ${new Date(now).toISOString()} (client physics)` };
  }
  switch (target.kind) {
    case 'handle': {
      const rec = services.perception.resolve(target.snapshotId, target.handle);
      if ('error' in rec) return precondition(rec.error, `target ${target.handle} cannot be resolved (${rec.error})`);
      const t = rec.target;
      if (t.kind === 'block') {
        if (!services.perception.blockVisibleNow(t.x, t.y, t.z)) return precondition('target_not_visible', `${t.name} at ${t.x},${t.y},${t.z} is not visible now`);
        return { location: { dimension, at: { x: t.x, y: t.y, z: t.z } }, basis: `visible block minecraft:${t.name} at ${t.x},${t.y},${t.z} (line of sight now)`, key: `minecraft:${t.name}` };
      }
      if (t.kind === 'frontier') return { location: { dimension, at: pos3(t.at) }, basis: `observed frontier waypoint ${target.handle}` };
      if (t.kind === 'group') return precondition('wrong_target_kind', `${target.handle} is a block group; name one of its blocks`);
      if (!services.perception.entityVisibleNow(t.entityId)) return precondition('target_not_visible', `${target.handle} is not visible now; its position is not used`);
      const e = bot.entities[t.entityId];
      if (!e?.position) return precondition('target_gone', `${target.handle} is no longer present`);
      return { location: { dimension, at: pos3(e.position) }, basis: `visible ${t.kind} ${target.handle} at ${pos3(e.position).x},${pos3(e.position).y},${pos3(e.position).z}` };
    }
    case 'owner': {
      for (const e of Object.values(bot.entities)) {
        if (e && services.perception.isOwnerEntity(bot, e) && services.perception.entityVisibleNow(e.id)) {
          return { location: { dimension, at: pos3(e.position) }, basis: `the owner's visible position ${pos3(e.position).x},${pos3(e.position).y},${pos3(e.position).z} (line of sight now)` };
        }
      }
      return precondition('owner_not_visible', 'the owner is not visible now; stand where the place is or name coordinates');
    }
    case 'anchor': {
      const a = services.perception.anchor(target.anchorId);
      if (!a) return precondition('unknown_anchor', `anchor ${target.anchorId} is not remembered on this connection`);
      if (a.dimension !== dimension) return precondition('dimension_mismatch', `anchor is in ${a.dimension}`);
      return { location: { dimension, at: pos3(a.at) }, basis: `remembered anchor "${a.label}" (${a.source}, observed ${Math.round((now - a.observedAtMs) / 1000)}s ago)` };
    }
    case 'destination': {
      if (target.dimension !== dimension) return precondition('dimension_mismatch', `coordinates are for ${target.dimension}, not ${dimension}`);
      const texts = memory.ownerTexts(goalIdOf(ctx)) ?? [];
      // MB-PLAN-006: only the owner's instruction (there are no clarification answers).
      const typed = texts.slice(0, 1).flatMap((t) => parseOwnerCoordinates(t, 'instruction'));
      const at = { x: target.x, y: target.y, z: target.z };
      if (!matchesOwnerCoordinate(at, typed)) return precondition('coordinates_not_owner_typed', `coordinates ${at.x} ${at.y} ${at.z} were not typed by the owner`);
      return { location: { dimension, at }, basis: `coordinates the owner typed (${at.x} ${at.y} ${at.z}); not observed` };
    }
  }
}

function unavailableMemory(memory: MemoryService): Unavailable | undefined {
  const s = memory.status();
  return s.writable ? undefined : { reason: 'memory_unavailable', detail: `memory is ${s.state}: ${s.detail.slice(0, 160)}` };
}

const RememberParams = z.object({ label: LabelSchema, category: CATEGORY, target: MoveTargetSchema.optional(), note: z.string().max(200).optional() }).strict();
const ForgetParams = z
  .object({ fact: MemoryFactIdSchema.optional(), label: LabelSchema.optional() })
  .strict()
  .refine((v) => v.fact !== undefined || v.label !== undefined, 'name a memory id or label');

export function rememberLocation(memory: MemoryService): SkillDefinition<z.infer<typeof RememberParams>> {
  const params = RememberParams;
  const def: SkillDefinition<z.infer<typeof params>> = {
    descriptor: {
      id: 'remember_location',
      family: 'memory',
      purpose: 'Durably remember a place the owner names (e.g. home, a mine, a farm) for this world profile: the bot position, the visible owner, an observed block, a shown anchor, or owner-typed coordinates.',
      parameters: [
        { name: 'label', type: 'string', description: "the OWNER'S own words for the place (e.g. home); a label the owner never said is stored only as an unverified note", required: true },
        { name: 'category', type: 'string', description: 'kind of place', required: true, enum: [...OWNER_DESIGNATION_CATEGORIES] },
        { name: 'target', type: 'target_selector', description: 'omit for the bot position; {kind:"owner"} | {kind:"handle",snapshotId,handle} | {kind:"anchor",anchorId} | {kind:"destination",dimension,x,y,z} (owner-typed)', required: false },
        { name: 'note', type: 'string', description: 'short owner remark to keep with the place', required: false },
      ],
      targets: ['none', 'owner', 'block', 'remembered_anchor', 'owner_destination'],
      preconditions: ['memory enabled for a configured world profile', 'the location is grounded now (bot position, visible owner/block, shown anchor or owner-typed coordinates)'],
      effects: ['a durable memory fact (owner statement) in the current world profile and dimension; a home replaces the previous home'],
      supportedPredicates: ['memory_state'],
      timeoutMs: 10_000,
      cancellation: 'a write already made durable stays; nothing in the world changes',
      limitations: ['memory is historical: it does not prove the place still exists', 'labels must come from the owner; invented labels become unverified notes'],
      evidence: ['local memory store revision (not a server packet)'],
    },
    params,
    resolve(ctx: ResolveContext) {
      const u = unavailableMemory(memory);
      if (u) return { drafts: [], unavailable: [u] };
      const a = admittedParameters(ctx, params).values as { label?: string; category?: string; target?: MoveTarget; note?: string };
      if (!a.label || !a.category) return { drafts: [], unavailable: [{ reason: 'missing_parameter', detail: 'remember_location needs the owner label and category as task parameters (code never invents a label)' }] };
      const target = a.target;
      const snap = ctx.snapshot;
      if (target?.kind === 'owner' && !snap.owner.visible) return { drafts: [], unavailable: [{ reason: 'owner_not_visible', detail: 'the owner is not visible now' }] };
      if (target?.kind === 'handle' && !targetScope(ctx).current.has(target.handle)) return { drafts: [], unavailable: [{ reason: 'named_target_not_visible', detail: `${target.handle} is not in the current observation` }] };
      if (target?.kind === 'anchor' && !snap.remembered.some((r) => r.anchorId === target.anchorId)) return { drafts: [], unavailable: [{ reason: 'unknown_anchor', detail: `${target.anchorId} is not remembered on this connection` }] };
      if (target?.kind === 'destination' && target.dimension !== snap.dimension) return { drafts: [], unavailable: [{ reason: 'dimension_mismatch', detail: `coordinates are for ${target.dimension}` }] };
      const where = !target ? 'here (bot position)' : target.kind === 'destination' ? `${target.x},${target.y},${target.z}` : target.kind === 'handle' ? target.handle : target.kind;
      const draft: CandidateDraft = {
        parameters: json({ label: a.label, category: a.category, ...(target ? { target } : {}), ...(a.note ? { note: a.note } : {}) }) as Record<string, never>,
        description: `remember "${a.label.slice(0, 40)}" (${a.category}) at ${where}`,
        criteria: ['durable local memory write; no world effect'],
      };
      return { drafts: [draft] };
    },
    async execute(ctx, p) {
      const grounded = groundLocation(ctx, memory, p.target);
      if ('status' in grounded) return grounded;
      const r = await memory.designate({
        ...(goalIdOf(ctx) ? { goalId: goalIdOf(ctx) as string } : {}),
        category: p.category,
        label: p.label,
        location: grounded.location,
        basis: grounded.basis,
        ...(grounded.key ? { key: grounded.key } : {}),
        ...(p.note ? { note: p.note } : {}),
        actionId: ctx.candidate.id,
      });
      const res = memoryResult(r, `remember "${p.label}" (${p.category}) at ${grounded.location.at.x},${grounded.location.at.y},${grounded.location.at.z} in ${grounded.location.dimension}`);
      return { ...res, evidence: { ...(res.evidence ?? {}), basis: grounded.basis.slice(0, 200) } };
    },
  };
  return def;
}

export function forgetMemory(memory: MemoryService): SkillDefinition<z.infer<typeof ForgetParams>> {
  const params = ForgetParams;
  const def: SkillDefinition<z.infer<typeof params>> = {
    descriptor: {
      id: 'forget_memory',
      family: 'memory',
      purpose: 'Forget one remembered fact of this world profile that the owner names, by its memory id (memory.facts[].id) or label. Other worlds, profiles and login data are untouched.',
      parameters: [
        { name: 'fact', type: 'string', description: 'memory id (mf-...) shown in memory', required: false },
        { name: 'label', type: 'string', description: "the owner's words naming the remembered fact", required: false },
      ],
      targets: ['none'],
      preconditions: ['memory enabled and writable', "the forgotten fact's label is in the owner's own words"],
      effects: ['the fact becomes a forgotten tombstone and is no longer retrieved'],
      supportedPredicates: ['memory_state'],
      timeoutMs: 10_000,
      cancellation: 'a durable forget stays; nothing in the world changes',
      limitations: ['refused when the owner did not name the fact (ask instead)'],
      evidence: ['local memory store revision (not a server packet)'],
    },
    params,
    resolve(ctx) {
      const u = unavailableMemory(memory);
      if (u) return { drafts: [], unavailable: [u] };
      const a = admittedParameters(ctx, params).values as { fact?: string; label?: string };
      if (!a.fact && !a.label) return { drafts: [], unavailable: [{ reason: 'missing_parameter', detail: 'forget_memory needs the memory id or the owner label' }] };
      const facts = memory.facts().filter((f) => f.status === 'active' && (a.fact ? f.id === a.fact : true));
      if (facts.length === 0) return { drafts: [], unavailable: [{ reason: 'unknown_memory', detail: `no active memory ${a.fact ?? a.label ?? ''} in this world profile` }] };
      return { drafts: [{ parameters: json(a) as Record<string, never>, description: `forget memory ${a.fact ?? ''}${a.label ? ` "${a.label.slice(0, 40)}"` : ''}` }] };
    },
    async execute(ctx, p) {
      const r = await memory.forget({ ...(goalIdOf(ctx) ? { goalId: goalIdOf(ctx) as string } : {}), ...(p.fact ? { factId: p.fact } : {}), ...(p.label ? { label: p.label } : {}), actionId: ctx.candidate.id });
      return memoryResult(r, `forget ${p.fact ?? ''}${p.label ? ` "${p.label}"` : ''}`.trim());
    },
  };
  return def;
}

export function noteMemory(memory: MemoryService): SkillDefinition<{ label: string; text: string }> {
  const params = z.object({ label: LabelSchema, text: z.string().trim().min(1).max(200) }).strict();
  return {
    descriptor: {
      id: 'note_memory',
      family: 'memory',
      purpose: 'Keep a short UNVERIFIED note for later goals in this world profile (a suggestion or decision note). Notes are never trusted facts and never targets.',
      parameters: [
        { name: 'label', type: 'string', description: 'short label for the note', required: true },
        { name: 'text', type: 'string', description: 'the note (data, not instructions)', required: true },
      ],
      targets: ['none'],
      preconditions: ['memory enabled and writable'],
      effects: ['an unverified note in memory (shown separately as untrusted)'],
      supportedPredicates: ['memory_state'],
      timeoutMs: 10_000,
      cancellation: 'a durable note stays',
      limitations: ['a note never becomes a verified fact or an executable target'],
      evidence: ['local memory store revision (not a server packet)'],
    },
    params,
    resolve(ctx) {
      const u = unavailableMemory(memory);
      if (u) return { drafts: [], unavailable: [u] };
      const a = admittedParameters(ctx, params).values as { label?: string; text?: string };
      if (!a.label || !a.text) return { drafts: [], unavailable: [{ reason: 'missing_parameter', detail: 'note_memory needs label and text parameters' }] };
      return { drafts: [{ parameters: { label: a.label, text: a.text }, description: `note "${a.label.slice(0, 40)}" (unverified)` }] };
    },
    async execute(ctx, p) {
      const r = await memory.note({ ...(goalIdOf(ctx) ? { goalId: goalIdOf(ctx) as string } : {}), label: p.label, text: p.text, actionId: ctx.candidate.id });
      return memoryResult(r, `note "${p.label}"`);
    },
  };
}

const BLOCKISH = /^minecraft:(?!air$)[a-z0-9_]+$/;

export function goToMemory(memory: MemoryService): SkillDefinition<{ ref: string; within: number }> {
  const params = z.object({ ref: MemoryRefIdSchema, within: z.number().min(1).max(32).default(3) }).strict();
  const def: SkillDefinition<z.infer<typeof params>> = {
    descriptor: {
      id: 'go_to_memory',
      family: 'movement',
      purpose: 'Walk to a remembered place named by a memory_ref target selector (e.g. home, a remembered chest or workstation) inside the goal travel radius, then look with fresh observations.',
      parameters: [{ name: 'within', type: 'number', description: 'arrival distance in blocks', required: false, minimum: 1, maximum: 32 }],
      targets: ['memory_ref'],
      preconditions: ['a memory_ref shown in this request (same connection and dimension)', 'inside the goal travel radius', 'a safe walking path exists'],
      effects: ['bot position changes; visited location recorded'],
      supportedPredicates: ['near_target', 'visited_location'],
      timeoutMs: 120_000,
      cancellation: 'stop clears the path goal and movement controls immediately through the actuator lease',
      limitations: ['memory is historical: arrival does not prove the remembered thing is still there', 'never digs, places, pillars or parkours'],
      evidence: ['final distance from the actual bot position'],
    },
    params,
    resolve(ctx) {
      const refs = memoryRefsOf(ctx.hints);
      if (refs.length === 0) return { drafts: [], unavailable: [{ reason: 'no_memory_ref', detail: 'the task names no memory_ref target' }] };
      const within = (admittedParameters(ctx, params).values['within'] as number | undefined) ?? 3;
      const drafts: CandidateDraft[] = [];
      const unavailable: Unavailable[] = [];
      for (const ref of refs.slice(0, 6)) {
        const r = memory.resolveRef(ref, { goalEpoch: ctx.snapshot.goalEpoch, goalId: null, connectionEpoch: ctx.snapshot.connectionEpoch, dimension: ctx.snapshot.dimension });
        if ('error' in r) {
          unavailable.push({ reason: r.error, detail: r.detail.slice(0, 200) });
          continue;
        }
        if (!ctx.services.perception.withinTravel(r.at)) {
          unavailable.push({ reason: 'outside_travel_bounds', detail: `remembered ${r.label} is outside the goal travel radius`, evidence: { at: json(r.at) } });
          continue;
        }
        const d = Math.hypot(r.at.x - ctx.snapshot.self.at.x, r.at.y - ctx.snapshot.self.at.y, r.at.z - ctx.snapshot.self.at.z);
        if (d <= within) {
          unavailable.push({ reason: 'already_there', detail: `already within ${within} of remembered ${r.label}` });
          continue;
        }
        drafts.push({ parameters: { ref, within }, description: `walk to remembered ${r.label.slice(0, 60)} (${Math.round(d)} blocks; ${r.source})`, score: -d });
      }
      return { drafts, unavailable };
    },
    async execute(ctx, p) {
      const bot = ctx.session.bot;
      if (ctx.owner.kind !== 'goal') return precondition('memory_ref_not_owned', 'memory refs belong to an admitted goal; diagnostics cannot use them');
      const r = memory.resolveRef(p.ref, { goalEpoch: ctx.owner.goalEpoch, goalId: ctx.owner.goalId || null, connectionEpoch: ctx.session.connectionEpoch, dimension: String(bot.game.dimension) });
      if ('error' in r) return precondition(r.error, r.detail);
      if (!ctx.services.perception.withinTravel(r.at)) return precondition('outside_travel_bounds', `remembered ${r.label} is outside the travel radius (${ctx.services.limits.travelRadius})`);
      const bounds = ctx.services.perception.travelBounds?.();
      const block = r.key && BLOCKISH.test(r.key) && r.category !== 'home' && r.category !== 'location' ? { x: Math.floor(r.at.x), y: Math.floor(r.at.y), z: Math.floor(r.at.z) } : undefined;
      const target = block ? { x: block.x + 0.5, y: block.y, z: block.z + 0.5 } : r.at;
      const goal = block ? new GoalBesideBlock(block.x, block.y, block.z, Math.max(1, p.within - 0.5)) : new goals.GoalNear(r.at.x, r.at.y, r.at.z, Math.max(1, p.within - 0.5));
      const nav = await navigate(ctx.act, {
        goal,
        arrived: () => distanceTo(bot, target) <= p.within + 0.25,
        distance: () => distanceTo(bot, target),
        timeoutMs: ctx.candidate.timeoutMs,
        searchRadius: Math.min(ctx.services.limits.travelRadius, Math.ceil(distanceTo(bot, target)) + 24),
        inBounds: () => ctx.services.perception.withinTravel(bot.entity.position),
        ...(bounds ? { bounds } : {}),
      });
      ctx.services.perception.recordVisited();
      const age = Math.round((ctx.services.clock.now() - r.lastConfirmedMs) / 1000);
      const evidence: Record<string, JsonValue> = { memoryRef: p.ref, factId: r.factId, remembered: true, rememberedSource: r.source, lastConfirmedAgeS: age, finalDistance: nav.finalDistance, position: pos3(bot.entity.position), elapsedMs: nav.elapsedMs, serverCorrections: nav.corrections };
      if (nav.status === 'arrived') {
        return { status: 'succeeded', effect: `arrived within ${p.within} of remembered ${r.label} (distance ${nav.finalDistance}); remembered ${age}s ago — presence not verified`, confirmation: 'client_only', evidence };
      }
      if (nav.status === 'out_of_bounds') return failed('outside_travel_bounds', `stopped at the travel radius while walking to remembered ${r.label}`, evidence);
      if (nav.status === 'no_path') return failed('no_safe_path', `no safe walking path to remembered ${r.label}; stopped ${nav.finalDistance} blocks away`, evidence);
      return failed(nav.status === 'timeout' ? 'timeout' : 'stuck', `${nav.status} while walking to remembered ${r.label} (${nav.finalDistance} blocks away)`, evidence);
    },
  };
  return def;
}

/** The memory capabilities, bound to an ENABLED service (empty when disabled). */
export function memorySkills(memory: MemoryService | undefined): AnySkill[] {
  if (!memory?.enabled) return [];
  return [rememberLocation(memory), forgetMemory(memory), noteMemory(memory), goToMemory(memory)];
}
