// Credential-free command/packet replay through the actual ordinary harness methods.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { Harness, LAYOUT, fixtureBlockTest, fixtureEntityTest, type OrdinaryHarnessIO } from '../scripts/ordinary-goal-live-check.ts';
import { SETTLED_STEP, foreignVisibleAfterResponse, freshFarCue, postReleaseMotion, serverHeldGear } from '../scripts/lib/ordinary-safety-oracles.ts';

type Actor = { tag: string; key: string; nbt: string; uuid: string; at: { x: number; y: number; z: number }; id: number };
const owned: Actor = { tag: 'og_test', key: 'minecraft:zombie', nbt: '[I; 1, 2, 3, 4]', uuid: '00000001-0000-0002-0000-000300000004', at: { x: 208, y: -60, z: 205.5 }, id: 8 };
const foreign: Actor = { tag: '', key: 'minecraft:area_effect_cloud', nbt: '[I; 5, 6, 7, 8]', uuid: '00000005-0000-0006-0000-000700000008', at: { x: 215, y: -60, z: 205 }, id: 9 };
const countReply = (n: number) => n ? `Test passed. Count: ${n}` : 'Test failed';

class Replay implements OrdinaryHarnessIO {
  time = 10_000;
  calls: string[] = [];
  actors: Actor[] = [];
  blocks = new Map<string, string>();
  bot = { x: 205.5, y: -60, z: 205.5 };
  spawned = false;
  grounded = () => true;
  onSleep: (() => void) | undefined;
  override: ((c: string) => string | undefined) | undefined;
  now() { return this.time; }
  async sleep(ms: number) { this.time += ms; this.onSleep?.(); }
  block(x: number, y: number, z: number) { return this.blocks.get(`${x},${y},${z}`) ?? (y === -61 ? 'grass_block' : y < -61 ? 'dirt' : 'air'); }
  selected(c: string): Actor[] {
    const uuid = /nbt=\{UUID:(\[I;[^\]]+\])\}/.exec(c)?.[1];
    const exclude = [...c.matchAll(/nbt=!\{UUID:(\[I;[^\]]+\])\}/g)].map((m) => m[1]);
    const tag = /(?:\[|,)tag=([^,\]]+)/.exec(c)?.[1];
    const type = /(?:\[|,)type=([^!,\]]+)/.exec(c)?.[1];
    const negativeTypes = [...c.matchAll(/type=!([^,\]]+)/g)].map((m) => m[1]);
    const bounded = c.includes('x=196,y=-64,z=190,dx=28,dy=40,dz=34');
    let actors = this.actors.filter((a) => (!uuid || uuid === a.nbt) && !exclude.includes(a.nbt) && (!tag || tag === a.tag) && (!type || `minecraft:${type.replace('minecraft:', '')}` === a.key) && !negativeTypes.includes(a.key.replace('minecraft:', '')) && (!bounded || (a.at.x >= 196 && a.at.x <= 225 && a.at.y >= -64 && a.at.y <= -23 && a.at.z >= 190 && a.at.z <= 225)));
    if (c.includes('limit=1')) actors = actors.slice(0, 1);
    return actors;
  }
  async command(c: string): Promise<string> {
    this.calls.push(c);
    const override = this.override?.(c);
    if (override !== undefined) return override;
    if (c === 'gamerule spawn_mobs') return `Gamerule spawn_mobs is currently set to: ${this.spawned}`;
    if (c === 'difficulty') return 'The difficulty is normal';
    if (c.startsWith('execute if loaded ') && !c.includes(' if block ')) return 'Test passed';
    if (c.includes('if block ')) {
      const m = /if block (-?\d+) (-?\d+) (-?\d+) (?:minecraft:)?([a-z_]+)/.exec(c)!;
      return this.block(Number(m[1]), Number(m[2]), Number(m[3])) === m[4] ? 'Test passed' : 'Test failed';
    }
    if (c.startsWith('execute if entity @a')) return countReply(c.includes('OnGround') ? Number(this.grounded()) : 1);
    if (c.startsWith('execute if entity @e')) return countReply(this.selected(c).length);
    if (c.startsWith('data get entity @e')) {
      const a = this.selected(c)[0];
      if (!a) return 'No entity was found';
      const label = a.key.replace('minecraft:', '');
      const value = c.endsWith(' UUID') ? a.nbt : c.endsWith(' Pos') ? `[${a.at.x}d, ${a.at.y}d, ${a.at.z}d]` : c.endsWith(' Tags') ? `[${a.tag ? `"${a.tag}"` : ''}]` : c.endsWith(' Health') ? '20.0f' : c.endsWith(' IsBaby') ? '0b' : `{UUID: ${a.nbt}, Pos: [${a.at.x}d, ${a.at.y}d, ${a.at.z}d], Tags: ["${a.tag}"]}`;
      return `${label} has the following entity data: ${value}`;
    }
    if (c === 'data get entity Chunkbot Pos') return `Chunkbot has the following entity data: [${this.bot.x}d, ${this.bot.y}d, ${this.bot.z}d]`;
    if (c === 'data get entity Chunkbot Health') return 'Chunkbot has the following entity data: 18.0f';
    if (c === 'data get entity Chunkbot playerGameType') return 'Chunkbot has the following entity data: 0';
    // ACTUAL installed 26.1.2/26.2 player NBT (R16 readbacks; server jars): armour is in `equipment`.
    if (c === 'data get entity Chunkbot Inventory') return 'Chunkbot has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:iron_sword"}]';
    if (c === 'data get entity Chunkbot equipment') return 'Chunkbot has the following entity data: {head: {count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}';
    if (c === 'data get entity Chunkbot SelectedItemSlot') return 'Chunkbot has the following entity data: 0';
    if (c.startsWith('kill @e')) { const a = this.selected(c); this.actors = this.actors.filter((b) => !a.includes(b)); return a.length ? 'Killed Zombie' : 'No entity was found'; }
    if (/^(fill|setblock) /.test(c)) {
      const a = c.split(' '), fill = a[0] === 'fill';
      const [x1, y1, z1] = a.slice(1, 4).map(Number) as [number, number, number];
      const [x2, y2, z2] = fill ? a.slice(4, 7).map(Number) as [number, number, number] : [x1, y1, z1];
      const key = a[fill ? 7 : 4]!;
      for (let x=x1;x<=x2;x++) for (let y=y1;y<=y2;y++) for (let z=z1;z<=z2;z++) this.blocks.set(`${x},${y},${z}`, key);
      return fill ? 'Successfully filled 1 block(s)' : `Changed the block at ${x1}, ${y1}, ${z1}`;
    }
    if (c.startsWith('forceload add ')) return 'No chunks were marked for force loading';
    if (c.startsWith('tp ')) { const a=c.split(' '); return `Teleported ${a[1]} to ${a[2]}, ${a[3]}, ${a[4]}`; }
    if (c.startsWith('clear ')) return `No items were found on player ${c.slice(6)}`;
    if (c.startsWith('give ')) return 'Gave 8 [Bread] to Chunkbot';
    if (c.startsWith('effect clear ')) return 'Target has no effects to remove';
    if (c.startsWith('effect give ')) return 'Applied effect Slow Falling to Chunkbot';
    if (c.startsWith('gamemode ')) return '';
    return 'Unknown command';
  }
}
const make = () => { const io = new Replay(); const h = new Harness('/offline-no-fixture-access', io); h.forceloadBefore = new Set(['12,12']); return { h, io }; };
const mutations = (io: Replay) => io.calls.filter((c) => /^(fill|setblock|kill|tp|effect|clear|give|gamemode|forceload|summon|item) /.test(c));

it('vanilla bare loaded/block success is distinct from counted entity truth and unknown never passes', async () => {
  for (const r of ['Test passed', 'Test passed.']) assert.equal(fixtureBlockTest(r), true);
  assert.equal(fixtureEntityTest('Test passed'), null);
  for (const r of ['', 'Test passed. Count: 1', 'Unknown block', 'Error: Test passed', 'Test passed\nUnknown command']) assert.equal(fixtureBlockTest(r), null);
  const { h, io }=make(); await h.waterScene(); await h.verifyWaterGeometry();
  assert.equal(h.readbacks.filter((r) => r.command.includes(' if block ')).length, 33);
  io.override = (c) => c.includes(' if block ') ? 'Unknown command' : undefined;
  await assert.rejects(h.verifyWaterGeometry(), /unverified/);
  await assert.rejects(h.verifyDryMobGeometry(), /unverified/);
  await assert.rejects(h.blockIs({ x: 205, y: -61, z: 205 }, 'minecraft:grass_block'), /unknown block/);
});

it('actual extended preparation deliberately rebuilds water then dry then water on one retained harness/history', async () => {
  const { h, io }=make();
  for (const [id, kind] of [['O7P','water'], ['O8C','dry'], ['O7R','water']] as const) {
    h.scenario = id; h.beginExtendedSafetyCase(id);
    await h.prepareExtendedSafetyGeometry(kind);
    assert.equal(io.block(207,-60,206), kind === 'water' ? 'water' : 'air');
  }
  assert.deepEqual(h.extendedSafetyReport().attemptedCases, ['O7P','O8C','O7R']);
  assert.deepEqual(h.extendedSafetyReport().executedCases, []);
  assert.equal(h.extendedSafetyReport().historyAcceptance, 'not_exercised');
  assert.equal(h.runs.length, 0, 'geometry never creates/restarts a CLI or safety service');
  for (const c of mutations(io).filter((c) => /^(fill|setblock) /.test(c))) {
    const a=c.split(' '), values=a.slice(1,a[0] === 'fill' ? 7 : 4).map(Number);
    for (let i=0;i<values.length;i+=3) { assert.ok(values[i]!>=196 && values[i]!<=224); assert.ok(values[i+1]!>=-63 && values[i+1]!<=-50); assert.ok(values[i+2]!>=190 && values[i+2]!<=224); }
  }
  assert.ok(io.calls.every((c) => !/^gamerule .* (true|false)$/.test(c)));
  await assert.rejects(h.prepareExtendedSafetyGeometry('water'), /single case attempt/);
});

it('spawn suppression is a read-only declared precondition, never a rule/settings change or an ambient removal', async () => {
  for (const reply of ['Gamerule spawn_mobs is currently set to: true', 'Unknown gamerule', '', 'Gamerule another_rule is currently set to: false', 'Gamerule do_mob_spawning is currently set to: false', 'Incorrect argument for commandgamerule do_mob_spawning<--[HERE]']) {
    const { h, io }=make(); h.scenario='O7P'; h.beginExtendedSafetyCase('O7P');
    io.override=(c) => c === 'gamerule spawn_mobs' ? reply : undefined;
    await assert.rejects(h.prepareExtendedSafetyGeometry('water'), /coordinator must record/);
    assert.deepEqual(mutations(io), []);
    assert.deepEqual(h.extendedSafetyReport().stagedCases, []);
  }
});

it('an unloaded interior chunk cannot become scene absence or block-reset credit', async () => {
  const {h,io}=make(); h.sceneActors.set(owned.tag,owned);
  io.override=(c) => c === 'execute if loaded 208 -60 208' ? 'Test failed' : undefined;
  await assert.rejects(h.resetScene(), /must be loaded/);
  await assert.rejects(h.removeKnownSceneActors(), /must be loaded/);
  assert.equal(h.actorDiagnostics[0]!.complete,false); assert.equal(h.actorRemovals[0]!.absent,false);
  assert.deepEqual(mutations(io),[]);
});

it('exact ambient cloud UUID/body is captured before any mutation; tag reuse cannot hide a foreign body', async () => {
  const { h, io }=make(); io.actors=[{...owned}, {...foreign}]; h.sceneActors.set(owned.tag, owned);
  await assert.rejects(h.resetScene(), /foreign\/ambient\/group\/cloud/);
  assert.deepEqual(mutations(io), []);
  assert.equal(h.actorDiagnostics[0]!.complete, true);
  assert.deepEqual(h.actorDiagnostics[0]!.actors.map((a: Record<string, unknown>) => a.uuid), [owned.uuid, foreign.uuid]);
  assert.equal(h.actorDiagnostics[0]!.actors[1].key, null, 'NBT label alone is not species proof');
  io.actors[1]!.tag=owned.tag;
  await assert.rejects(h.noForeignSceneActors(), /shares a tag/);
  assert.deepEqual(mutations(io), []);
});

it('known actor cleanup succeeds independently while distinct foreign body still refuses all block/drop reset', async () => {
  const { h, io }=make(); io.actors=[{...owned}, {...foreign}]; h.sceneActors.set(owned.tag, owned);
  await h.captureSceneActors(); await h.removeKnownSceneActors();
  assert.deepEqual(io.actors.map((a) => a.uuid), [foreign.uuid]);
  assert.equal(h.actorRemovals[0]!.removed, true); assert.equal(h.actorRemovals[0]!.absent, true);
  await assert.rejects(h.removeSceneActors(), /foreign\/ambient/);
  await assert.rejects(h.resetScene(), /foreign\/ambient/);
  const writes=mutations(io); assert.equal(writes.length,1);
  assert.match(writes[0]!, /^kill @e\[tag=og_test,nbt=\{UUID:\[I; 1, 2, 3, 4\]\},x=196,y=-64,z=190,dx=28,dy=40,dz=34\]$/);
  assert.equal(h.actorDiagnostics.at(-1)!.actors[0].uuid, foreign.uuid);
});

it('escaped, missing-tag, changed UUID, duplicate-tag and unknown current proof each prohibit an owned kill', async () => {
  for (const kind of ['escaped','tag','uuid','duplicate','unknown','unloaded'] as const) {
    const { h, io }=make(); io.actors=[structuredClone(owned)]; h.sceneActors.set(owned.tag, owned);
    if (kind === 'escaped') io.actors[0]!.at.x=240;
    if (kind === 'tag') io.actors[0]!.tag='lost_tag';
    if (kind === 'uuid') io.actors=[{...foreign,tag:owned.tag}];
    if (kind === 'duplicate') io.actors.push({...foreign,tag:owned.tag});
    if (kind === 'unknown') io.override=(c) => c.startsWith('execute if entity ') ? 'Unknown entity predicate' : undefined;
    if (kind === 'unloaded') io.override=(c) => c.startsWith('execute if loaded ') ? 'Test failed' : undefined;
    if (kind === 'unloaded') { await assert.rejects(h.resetScene(), /incomplete identity/); }
    else if (kind === 'uuid') {
      // Old UUID is genuinely absent: it is never replaced by a tag-only kill.
      await h.removeKnownSceneActors(); await assert.rejects(h.resetScene(), /foreign\/ambient/);
    } else await assert.rejects(h.removeKnownSceneActors(), /incomplete/);
    assert.deepEqual(mutations(io), []);
  }
});

it('malformed/changing/oversized census cannot authorize staging; cleanup of another proven actor still proceeds', async () => {
  for (const reply of ['Unknown command','Test passed','Test passed. Count: 0','Test passed. Count: 17']) {
    const { h, io }=make(); io.override=(c) => c.includes('type=!player,type=!item,type=!experience_orb') ? reply : undefined;
    await assert.rejects(h.resetScene(), /incomplete identity/); assert.deepEqual(mutations(io), []);
    assert.equal(h.actorDiagnostics[0]!.complete, false);
  }
  const changed=make(); changed.io.actors=[{...foreign}]; let reads=0;
  changed.io.override=(c) => c === 'execute if entity @e[type=!player,type=!item,type=!experience_orb,x=196,y=-64,z=190,dx=28,dy=40,dz=34]' ? countReply(++reads===1 ? 1 : 2) : undefined;
  await assert.rejects(changed.h.resetScene(), /incomplete identity/);
  assert.match(changed.h.actorDiagnostics[0]!.error, /census changed/); assert.deepEqual(mutations(changed.io), []);
  const { h, io }=make(); const escaped={...foreign,tag:'og_escaped',at:{...foreign.at,x:240}};
  io.actors=[escaped,{...owned}]; h.sceneActors.set(escaped.tag,escaped); h.sceneActors.set(owned.tag,owned);
  await assert.rejects(h.removeKnownSceneActors(), /og_escaped/);
  assert.deepEqual(io.actors.map((a) => a.uuid), [escaped.uuid]);
  assert.deepEqual(h.actorRemovals.map((a) => a.absent), [false,true]);
});

it('installed exact-release command language agrees with counted and bare oracles and bounded forceload replies', async () => {
  const {readFileSync}=await import('node:fs');
  for (const v of ['26.1','26.2']) {
    const language=JSON.parse(readFileSync(new URL(`../node_modules/minecraft-data/minecraft-data/data/pc/${v}/language.json`,import.meta.url),'utf8')) as Record<string,string>;
    assert.equal(language['commands.execute.conditional.pass'],'Test passed');
    assert.equal(language['commands.execute.conditional.pass_count'],'Test passed. Count: %s');
    assert.equal(language['commands.gamerule.query'],'Gamerule %s is currently set to: %s');
    assert.equal(language['commands.forceload.added.multiple'],'Marked %s chunks in %s from %s to %s to be force loaded');
    assert.equal(language['commands.forceload.removed.single'],'Unmarked chunk %s in %s for force loading');
  }
  const {h,io}=make();
  for (const [command,reply] of [['forceload add 196 190 224 224','Marked 4 chunks in minecraft:overworld from [12, 11] to [14, 14] to be force loaded'],['forceload add 196 190 224 224','Marked chunk [12, 12] in minecraft:overworld to be force loaded'],['forceload remove 192 192','Unmarked chunk [12, 12] in minecraft:overworld for force loading']] as const) {
    io.override=() => reply; await h.setup(command);
    await assert.rejects(h.setup(command.startsWith('forceload add') ? 'forceload remove 192 192' : 'forceload add 196 190 224 224'), /unknown mutation/);
  }
  io.override=() => 'Unknown command: Marked chunk';
  await assert.rejects(h.setup('forceload add 196 190 224 224'), /unknown mutation/);
});

it('real mutation/test replies are strict, including empty gamemode feedback with a separate positive proof', async () => {
  const { h, io }=make();
  await h.setup('gamemode survival Chunkbot');
  for (const c of ['fill 200 -60 200 201 -60 201 dirt','setblock 205 -60 205 air','tp Chunkbot 205.5 -60 205.5','kill @e[type=item,x=196,y=-64,z=190,dx=28,dy=40,dz=34]']) {
    io.override=(q) => q === c ? 'Unknown command: Test passed' : undefined;
    await assert.rejects(h.setup(c), /unknown mutation reply/);
  }
  io.override=(q) => q.endsWith('playerGameType') ? 'Found no elements matching playerGameType' : undefined;
  await assert.rejects(h.setup('gamemode survival Chunkbot'), /must be proved/);
  for (const r of ['Unknown command', 'The difficulty is peaceful', 'not peaceful']) { io.override=(q) => q === 'difficulty' ? r : undefined; await assert.rejects(h.requireNonPeaceful(), /must be readable/); }
});

it('staging failure is never executed history; executed-but-failed and verified cases remain distinct', async () => {
  const { h, io }=make(); h.quiesce=async () => {}; h.dashboard=() => ({}) as ReturnType<Harness['dashboard']>;
  await h.scenarioRun('O7P','unready',undefined,async () => { io.override=(c) => c.includes(' if block ') ? 'Test failed' : undefined; await h.prepareExtendedSafetyGeometry('water'); });
  await h.scenarioRun('O7R','real control failure',undefined,async () => { io.override=undefined; await h.prepareExtendedSafetyGeometry('water'); h.markExtendedSafetyStaged(); h.markExtendedSafetyExecuted('goal-current'); throw new Error('actual response failed'); });
  await h.scenarioRun('O8N','verified',undefined,async () => { await h.prepareExtendedSafetyGeometry('dry'); h.markExtendedSafetyStaged(); h.markExtendedSafetyExecuted('goal-next'); });
  const report=h.extendedSafetyReport();
  assert.deepEqual(report.attemptedCases,['O7P','O7R','O8N']); assert.deepEqual(report.stagedCases,['O7R','O8N']); assert.deepEqual(report.executedCases,['O7R','O8N']); assert.deepEqual(report.verifiedCases,['O8N']);
  assert.deepEqual(h.results.map((r) => r.status),['fail','fail','pass']);
  assert.throws(() => h.beginExtendedSafetyCase('O7P'), /never reset\/retried/);
});

function meleeReplay() {
  const { h, io }=make(); const packets=new EventEmitter();
  const observer={_client:packets,entities:{8:{id:8,uuid:owned.uuid,name:'zombie',position:owned.at}},players:{Chunkbot:{entity:{id:4}}}};
  h.owner=observer as unknown as NonNullable<Harness['owner']>; h.scenario='O8D';
  h.observe=async () => ({equipment:{hand:'minecraft:iron_sword',head:'minecraft:iron_helmet',torso:'minecraft:iron_chestplate'},entities:[{key:owned.key,at:owned.at}]} as ReturnType<Harness['dashboard']>);
  h.dashboard=() => ({directive:{mode:'idle',pause:{paused:true},safety:{authority:'none',state:'no_authority'}}});
  const summon=async () => { io.actors=[structuredClone(owned)]; h.sceneActors.set(owned.tag,owned); packets.emit('damage_event',{entityId:4,sourceCauseId:9}); };
  return {h,io,packets,summon};
}

it('actual defense staging waits through knockback, then proves repeated grounded dry support and current same-UUID melee gear', async () => {
  const {h,io,packets,summon}=meleeReplay(); io.grounded=() => io.time>=10_600; const evidence:string[]=[];
  await h.stageMeleeEngagement(owned.tag,summon,evidence);
  assert.ok(io.time>=11_000 && io.time<16_000);
  const proofs=h.safetySamples.filter((r) => r.defenseStaging);
  assert.ok(proofs.length>=3); assert.ok(proofs.at(-1)!.defenseStaging.settledMs>=250);
  assert.equal(proofs.at(-1)!.defenseStaging.uuid,owned.uuid); assert.equal(proofs.at(-1)!.defenseStaging.onGround,true);
  assert.ok(h.readbacks.some((r) => r.command.includes('OnGround:1b'))); assert.ok(h.readbacks.some((r) => r.command.endsWith(' IsBaby')));
  assert.match(evidence[0]!, /grounded dry support settled/); assert.deepEqual(mutations(io),[]);
  assert.equal(packets.listenerCount('damage_event'),0);
});

it('new damage resets grounded settlement; stationary fresh evidence then succeeds without extending original wait', async () => {
  const {h,io,packets,summon}=meleeReplay(); let sent=false;
  io.onSleep=() => { if (!sent && io.time>=10_400) {sent=true; packets.emit('damage_event',{entityId:4,sourceCauseId:9});} };
  await h.stageMeleeEngagement(owned.tag,summon,[]);
  assert.equal(h.safetySamples.filter((r) => r.defenseStaging).at(-1)!.defenseStaging.hitAtMs,10_400);
  assert.ok(io.time>=10_800 && io.time<=20_000);
});

it('a published cancelled historical goal is not mistaken for active authority during grounded staging', async () => {
  const {h,summon}=meleeReplay();
  h.dashboard=() => ({directive:{mode:'idle',goal:{id:'old',phase:'cancelled',terminal:{reason:'owner_stop'}},pause:{paused:true},safety:{authority:'none',state:'no_authority'}}});
  await h.stageMeleeEngagement(owned.tag,summon,[]);
});

it('airborne, expired/unattributed damage, missing gear, unknown ground, baby, unsupported floor and active authority fail before admission', async () => {
  for (const kind of ['airborne','expired','foreign_damage','gear','ground_unknown','baby','floor','authority'] as const) {
    const {h,io,packets,summon}=meleeReplay();
    if (kind === 'airborne') io.grounded=() => false;
    if (kind === 'expired') io.grounded=() => io.time>=16_200;
    if (kind === 'foreign_damage') io.onSleep=() => packets.emit('damage_event',{entityId:4,sourceCauseId:10});
    if (kind === 'gear') h.observe=async () => ({equipment:{},entities:[{key:owned.key,at:owned.at}]});
    if (kind === 'ground_unknown') io.override=(c) => c.includes('OnGround') ? 'Unknown command' : undefined;
    if (kind === 'baby') io.override=(c) => c.endsWith(' IsBaby') ? 'Zombie has the following entity data: 1b' : undefined;
    if (kind === 'floor') io.blocks.set('205,-61,205','water');
    if (kind === 'authority') h.dashboard=() => ({directive:{goal:{id:'old'},pause:{paused:true},safety:{authority:'owner_goal',state:'responding'}}});
    const trigger=kind === 'foreign_damage' ? async () => {await summon(); io.time+=6_001;} : summon;
    await assert.rejects(h.stageMeleeEngagement(owned.tag,trigger,[]));
    assert.ok(io.time<=26_001); assert.deepEqual(mutations(io),[]); assert.equal(packets.listenerCount('damage_event'),0);
  }
});

// ---------------------------------------------------------------- P-SAFETY-R16 (actual R16 artifacts)
// Replies, samples, events and snapshots below are copied from the immutable R16
// reports 261 (2026-10-09T01-03-25-688Z) and 262 (2026-10-09T01-03-25-641Z)
// unless a line says "synthetic"/"reconstructed".
const t = (ms: number) => new Date(ms).toISOString();
const R16_INVENTORY = 'Chunkbot has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:iron_sword"}]';
const R16_EQUIPMENT = 'Chunkbot has the following entity data: {head: {count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}';

it('R16 O8D: worn armour is read from the installed `equipment` compound and the held sword from SelectedItemSlot', async () => {
  assert.deepEqual(serverHeldGear(R16_INVENTORY, R16_EQUIPMENT, 'Chunkbot has the following entity data: 0'), { mainHand: 'minecraft:iron_sword', head: 'minecraft:iron_helmet', chest: 'minecraft:iron_chestplate', selectedSlot: 0 });
  // Retained dashboard-check format (head + offhand) parses; offhand is not chest armour.
  assert.deepEqual(serverHeldGear(R16_INVENTORY, 'DashProbe has the following entity data: {head: {count: 1, id: "minecraft:iron_helmet"}, offhand: {count: 1, id: "minecraft:shield"}}', 'X has the following entity data: 0')?.chest, null);
  for (const [inv, eq, sel, why] of [
    [R16_INVENTORY, 'Chunkbot has the following entity data: {}', '0', 'actual R16 Inventory alone is no armour proof'],
    ['Chunkbot has the following entity data: [{Slot: 0b, id: "minecraft:iron_sword", count: 1}, {Slot: 103b, id: "minecraft:iron_helmet", count: 1}, {Slot: 102b, id: "minecraft:iron_chestplate", count: 1}]', 'Chunkbot has the following entity data: {}', '0', 'legacy armour slots are not installed worn gear'],
    [R16_INVENTORY, 'Found no elements matching equipment', '0', 'unreadable equipment'],
    [R16_INVENTORY, R16_EQUIPMENT, 'Found no elements matching SelectedItemSlot', 'unreadable held slot'],
    [R16_INVENTORY, R16_EQUIPMENT, '4', 'sword not in the selected hotbar slot'],
    [R16_INVENTORY, 'Chunkbot has the following entity data: {head: {count: 1, id: "minecraft:iron_helmet"}}', '0', 'missing chestplate'],
    [R16_INVENTORY, 'Chunkbot has the following entity data: {head: {components: {"minecraft:damage": 3}, count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}}', '0', 'unparsed component body fails closed'],
  ] as const) {
    const g = serverHeldGear(inv, eq, sel.includes(' ') ? sel : `Chunkbot has the following entity data: ${sel}`);
    assert.ok(!g || g.mainHand !== 'minecraft:iron_sword' || g.head !== 'minecraft:iron_helmet' || g.chest !== 'minecraft:iron_chestplate', why);
  }
  for (const kind of ['legacy', 'chest', 'selected'] as const) {
    const { h, io, summon } = meleeReplay();
    io.override = (c) => kind === 'legacy' && c === 'data get entity Chunkbot equipment' ? 'Chunkbot has the following entity data: {}'
      : kind === 'chest' && c === 'data get entity Chunkbot equipment' ? 'Chunkbot has the following entity data: {head: {count: 1, id: "minecraft:iron_helmet"}}'
      : kind === 'selected' && c === 'data get entity Chunkbot SelectedItemSlot' ? 'Chunkbot has the following entity data: 3' : undefined;
    await assert.rejects(h.stageMeleeEngagement(owned.tag, summon, []), /current server gear missing\/unknown/, kind);
    assert.deepEqual(mutations(io), []);
  }
  const { h, summon } = meleeReplay(); const ev: string[] = [];
  await h.stageMeleeEngagement(owned.tag, summon, ev);
  assert.ok(['Inventory', 'equipment', 'SelectedItemSlot'].every((f) => h.readbacks.some((r) => r.command === `data get entity Chunkbot ${f}`)));
  assert.match(ev[0]!, /current server gear \{"mainHand":"minecraft:iron_sword","head":"minecraft:iron_helmet","chest":"minecraft:iron_chestplate","selectedSlot":0\}/);
  assert.equal(h.safetySamples.filter((r) => r.defenseStaging).at(-1)!.defenseStaging.serverEquipment, R16_EQUIPMENT);
});

// Actual 261 O7P release/resume events (goal-408d1d4a6689, epoch 1).
const O7P_GOAL = 'goal-408d1d4a6689';
const o7pEnd: Record<string, any> = { type: 'safety_episode_ended', t: t(1791507900844), episodeId: 'se-0513f935f8b3', grantId: 'sg-e78b4695b131', outcome: 'resolved' };
const o7pEvents: Array<Record<string, any>> = [
  { type: 'lease_acquired', t: t(1791507896457), leaseId: 1, owner: 'safety:sg-e78b4695b131' },
  { type: 'skill_started', t: t(1791507896458), actionId: 'act-23ddb3973160', capability: 'escape_water', owner: 'safety', leaseId: 1 },
  { type: 'skill_outcome', t: t(1791507900832), actionId: 'act-23ddb3973160', owner: 'safety', capability: 'escape_water', status: 'succeeded' },
  { type: 'lease_revoked', t: t(1791507900834), leaseId: 1, reason: 'completed', clearedShared: true },
  o7pEnd,
  { type: 'task_choice', t: t(1791507904627), goalId: O7P_GOAL, goalEpoch: 1, candidateId: 'act-10d1ebc4774f', capability: 'follow_entity' },
  { type: 'lease_acquired', t: t(1791507904647), leaseId: 2, owner: 'goal:1' },
  { type: 'skill_started', t: t(1791507904647), actionId: 'act-10d1ebc4774f', capability: 'follow_entity', owner: 'goal', leaseId: 2 },
  { type: 'skill_outcome', t: t(1791507905454), actionId: 'act-10d1ebc4774f', owner: 'goal', capability: 'follow_entity', status: 'cancelled' },
];
// Samples 1-3 actual; sample 4 reconstructed inside its recorded block 212,205 (the old harness never retained it).
const o7pSamples = [
  { startedAtMs: 1791507904383, atMs: 1791507904384, p: { x: 211.37076253738886, y: -56, z: 206.5 } },
  { startedAtMs: 1791507904636, atMs: 1791507904637, p: { x: 211.37076253738886, y: -56, z: 206.5 } },
  { startedAtMs: 1791507904890, atMs: 1791507904892, p: { x: 211.83992512456828, y: -56, z: 206.0841895500323 } },
  { startedAtMs: 1791507905145, atMs: 1791507905147, p: { x: 212.45, y: -56, z: 205.55 } },
];
const o7pCtx = { goalId: O7P_GOAL, goalEpoch: 1, episodeEnd: o7pEnd, excludedLeaseIds: [] as number[], capabilities: ['follow_entity', 'move_near', 'seek_owner'] };

it('R16 O7P/O7R: post-release motion is accepted only under the fresh goal-owned follow lease, never as drift', () => {
  const steps = postReleaseMotion(o7pSamples, o7pEvents, o7pCtx);
  assert.deepEqual(steps.map((s) => s.actionId), [null, null, 'act-10d1ebc4774f']);
  assert.ok(steps[2]!.displacement >= SETTLED_STEP, 'the actual failing step really moved');
  const without = (pred: (e: Record<string, any>) => boolean) => o7pEvents.filter((e) => !pred(e));
  const replace = (actionId: string, fields: Record<string, unknown>) => o7pEvents.map((e) => (e as Record<string, unknown>).actionId === actionId || (e as Record<string, unknown>).candidateId === actionId ? { ...e, ...fields } : e);
  for (const [events, ctx, why] of [
    [without((e) => e.actionId === 'act-10d1ebc4774f'), o7pCtx, 'no goal action: drift'],
    [without((e) => e.type === 'task_choice'), o7pCtx, 'not dispatched through the ordinary task pipeline'],
    [o7pEvents.map((e) => e.type === 'lease_acquired' && e.leaseId === 2 ? { ...e, owner: 'goal:3' } : e), o7pCtx, 'lease of another epoch'],
    [o7pEvents.map((e) => e.type === 'lease_acquired' && e.leaseId === 2 ? { ...e, owner: 'safety:sg-other' } : e), o7pCtx, 'a safety lease is never ordinary work'],
    [replace('act-10d1ebc4774f', { t: t(1791507900000) }), o7pCtx, 'started before the release'],
    [replace('act-10d1ebc4774f', { capability: 'attack_entity' }), o7pCtx, 'not a movement capability'],
    [o7pEvents.map((e) => e.type === 'task_choice' ? { ...e, goalId: 'goal-other' } : e), o7pCtx, 'another goal'],
    [o7pEvents.map((e) => e.type === 'skill_outcome' && e.actionId === 'act-10d1ebc4774f' ? { ...e, t: t(1791507904700) } : e), o7pCtx, 'action ended before the moving interval'],
    [o7pEvents, { ...o7pCtx, excludedLeaseIds: [2] }, 'the preempted lease never resumes'],
  ] as const) assert.throws(() => postReleaseMotion(o7pSamples, events, ctx), /stays settled/, why);
  const teleported = o7pSamples.map((s, i) => i === 3 ? { ...s, p: { x: 216.5, y: -56, z: 202.5 } } : s);
  assert.throws(() => postReleaseMotion(teleported, o7pEvents, o7pCtx), /exceeds ordinary grounded movement/);
  assert.throws(() => postReleaseMotion(o7pSamples, o7pEvents, { ...o7pCtx, episodeEnd: { ...o7pEnd, type: 'safety_episode_started' } }), /actual episode release/);
});

async function settleReplay(positions: Array<{ x: number; z: number }>, opts: { feetWaterAt?: number; airborneAt?: number } = {}) {
  const { h, io } = make(); await h.waterScene(); io.time = 1791507904383; // actual first-sample time
  let call = 0;
  io.override = (c) => {
    if (c === 'data get entity Chunkbot Pos') { const p = positions[Math.min(call++, positions.length - 1)]!; return `Chunkbot has the following entity data: [${p.x}d, -56.0d, ${p.z}d]`; }
    if (c === 'data get entity Chunkbot Air') return 'Chunkbot has the following entity data: 300s';
    if (c.includes('OnGround')) return call - 1 === opts.airborneAt ? 'Test failed' : 'Test passed. Count: 1';
    if (opts.feetWaterAt !== undefined && call - 1 === opts.feetWaterAt && / -56 \d+ minecraft:air$/.test(c)) return 'Test failed';
    return undefined;
  };
  h.events = () => o7pEvents;
  h.health = async () => 20;
  return { h, io };
}

it('R16 O7P/O7R: actual harness settle keeps the 3 s dry-support proof; O7W stays strictly stationary on the same data', async () => {
  const path = [...o7pSamples.map((s) => s.p)]; // after sample 4 the actual follow was cancelled: synthetic settled tail
  const ordinary = { goalId: O7P_GOAL, goalEpoch: 1, episodeEnd: o7pEnd, excludedLeaseIds: [] as number[] };
  { const { h, io } = await settleReplay(path); const ev: string[] = [];
    await h.waterExitSettled(ev, ordinary);
    assert.ok(io.time - 1791507904383 >= 3_000);
    assert.match(ev.join('\n'), /moved only under fresh goal-owned act-10d1ebc4774f/);
    assert.ok(h.safetySamples.filter((r) => r.settleSample).length >= 4); }
  { const { h } = await settleReplay(path); const ev: string[] = [];
    await assert.rejects(h.waterExitSettled(ev), /stays settled after controls release/, 'O7W/O7F strict mode remains binding');
    assert.equal(h.safetySamples.filter((r) => r.settleSample).length, 4, 'the failing sample is now retained');
    assert.match(ev.at(-1)!, /212\.45/); }
  { const { h } = await settleReplay(path); h.events = () => o7pEvents.filter((e) => e.actionId !== 'act-10d1ebc4774f');
    await assert.rejects(h.waterExitSettled([], ordinary), /no current goal-owned movement/); }
  { const { h } = await settleReplay(path, { feetWaterAt: 3 });
    await assert.rejects(h.waterExitSettled([], ordinary), /dry stable support/, 'water re-entry is never ordinary movement'); }
  { const { h } = await settleReplay(path, { airborneAt: 2 });
    await assert.rejects(h.waterExitSettled([], ordinary), /dry stable support/, 'ungrounded samples fail'); }
  { const { h } = await settleReplay([...path.slice(0, 3), { x: 207.5, z: 206.5 }]);
    await assert.rejects(h.waterExitSettled([], ordinary), /before reaching a dry bank/, 'pool position fails even under a goal action'); }
});

it('R16 O7F: a cue/observation predating the owned teleport is waiting, never staging or a privacy pass', () => {
  const far = LAYOUT.safety.farOwner, tp = 1791507930358;
  const change = { type: 'locator_owner_state', t: t(1791507930359), state: 'tracked:chunk', cause: 'owner_track' };
  const old = { type: 'locator_owner_state', t: t(1791507891135), state: 'tracked:vec3i', cause: 'owner_track' };
  const staleDash = { publisher: { publishedAtMs: 1791507930027 }, directive: { autonomy: { locator: { actionable: true, direction: 'north', distanceBand: 'close', ageMs: 459 } } } };
  const staleSnap = { takenAtMs: 1791507930363, self: { at: { x: 218.5, y: -56, z: 200.5 } }, owner: { visible: true, at: { x: 218.5, y: -56, z: 198.5 }, distance: 2 }, entities: [{ key: 'minecraft:player', at: { x: 218.5, y: -56, z: 198.5 } }], perception: { travel: { anchor: { x: 218.5, y: -56, z: 200.5 }, radius: 128 } } };
  assert.equal(freshFarCue([old, change], staleDash, staleSnap, tp, far), 'waiting', 'actual R16 inputs');
  const freshDash = { publisher: { publishedAtMs: 1791507930527 }, directive: { autonomy: { locator: { actionable: true, direction: 'east', distanceBand: 'far', ageMs: 160 } } } };
  // synthetic post-processing observation: bot coordinates/anchor and a relative direction remain; owner hidden.
  const hidden = { ...staleSnap, takenAtMs: 1791507930600, owner: { visible: false }, entities: [] };
  assert.equal(freshFarCue([old, change], freshDash, hidden, tp, far), 'ready');
  assert.equal(freshFarCue([old], freshDash, hidden, tp, far), 'waiting', 'an earlier statement is not post-teleport');
  assert.equal(freshFarCue([old, change], { ...freshDash, publisher: { publishedAtMs: 1791507930300 } }, hidden, tp, far), 'waiting', 'dashboard published before the change');
  assert.equal(freshFarCue([old, change], { ...freshDash, directive: { autonomy: { locator: { ...freshDash.directive.autonomy.locator, direction: 'north' } } } }, hidden, tp, far), 'waiting');
  assert.equal(freshFarCue([old, change], freshDash, { ...hidden, takenAtMs: 1791507930300 }, tp, far), 'waiting', 'observation before the change');
  assert.equal(freshFarCue([old, change], freshDash, staleSnap, tp, far), 'waiting', 'client not yet updated');
  assert.throws(() => freshFarCue([old, change], freshDash, { ...hidden, owner: { visible: false, distance: 132 } }, tp, far), /coordinates\/distance must be absent/);
  assert.throws(() => freshFarCue([old, change], freshDash, { ...hidden, owner: { visible: false, at: far } }, tp, far), /must be absent|far-owner point/);
  for (const leak of [{ ...staleSnap, owner: { visible: true, at: far, distance: 132 } }, { ...hidden, nested: { rounded: { x: 350, y: -60, z: 198 } } }]) {
    assert.throws(() => freshFarCue([old], staleDash, leak, tp, far), /far-owner point/, 'far point fails even while waiting');
  }
});

it('R16 O8N: every reset lifts the owner before any fill and grounds it after; natural full health is awaited, never forced', async () => {
  const { h, io } = make(); h.scenario = 'O8C';
  await h.resetScene();
  const fill = io.calls.indexOf('fill 196 -60 190 224 -50 224 air');
  const lift = io.calls.indexOf('tp FixtureOwner 202.5 -30 209.5');
  const slow = io.calls.indexOf('effect give FixtureOwner slow_falling 5 0 true');
  const ground = io.calls.indexOf('tp FixtureOwner 202.5 -60 209.5 0 0');
  const clearFx = io.calls.indexOf('effect clear FixtureOwner');
  assert.ok(lift > 0 && slow > lift && fill > slow && ground > fill && clearFx > ground, io.calls.join('\n'));
  for (const c of mutations(io)) assert.ok(!/instant_health|regeneration|saturation|absorption|^give FixtureOwner|^effect give FixtureOwner (?!slow_falling 5 0 true$)/.test(c), c);
  // Natural regeneration wait: owner 19 (actual R16 261) -> 20, stable over >= 1 s.
  const readings: Record<string, number[]> = { Chunkbot: [20, 20, 20, 20, 20, 20], FixtureOwner: [19, 19, 20, 20, 20, 20] };
  const w = make(); const ev: string[] = []; const before = mutations(w.io).length;
  w.h.health = async (name: string) => readings[name]!.shift() ?? 20;
  await w.h.fullStableHealth(['Chunkbot', 'FixtureOwner'], ev);
  assert.match(ev[0]!, /full stable health .* \(natural; never healed\/fed\)/);
  assert.equal(mutations(w.io).length, before, 'awaiting health never mutates the world or players');
  assert.ok(w.h.readbacks.some((r) => r.command === 'data get entity FixtureOwner foodLevel'), 'diagnostic hunger readback while below full');
  const stuck = make(); stuck.h.health = async (name: string) => name === 'FixtureOwner' ? 19 : 20;
  await assert.rejects(stuck.h.fullStableHealth(['Chunkbot', 'FixtureOwner'], []), /full stable control-player health required.*"FixtureOwner":19/);
  const flicker = make(); let n = 0; flicker.h.health = async () => (n++ % 3 === 2 ? 19 : 20);
  await assert.rejects(flicker.h.fullStableHealth(['Chunkbot'], []), /full stable/, 'a dip resets the stability window');
  const unread = make(); unread.h.health = async () => Number.NaN;
  await assert.rejects(unread.h.fullStableHealth(['Chunkbot'], []), /full stable/);
});

// Actual 262 O8C post-retreat snapshot (taken 1791507933424) and episode.
const o8cEpisode = [
  { type: 'safety_episode_started', t: t(1791507931390), episodeId: 'se-ab58bf42a15d', response: 'retreat', hazards: ['creeper'], defense: { admitted: false, target: { entityId: 11434, key: 'minecraft:creeper', distance: 5 } } },
  { type: 'safety_episode_ended', t: t(1791507933298), episodeId: 'se-ab58bf42a15d', response: 'retreat', outcome: 'resolved', hazardsBefore: ['creeper'], hazardsAfter: [] },
];
const o8cHorse = { handle: 'ent-282', key: 'minecraft:zombie_horse', at: { x: 168.1, y: -60, z: 201.1 }, distance: 29.7, inReach: false };

it('R16 O8C: an out-of-scene foreign zombie_horse made visible by the retreat is recorded; involvement or in-scene presence still fails', async () => {
  const ctx = { sinceMs: 1791507931386, allowedHazards: ['creeper'], allowedTargetIds: [11434] };
  assert.deepEqual(foreignVisibleAfterResponse([o8cHorse], o8cEpisode, ctx), [{ key: 'minecraft:zombie_horse', at: o8cHorse.at, distance: 29.7 }]);
  assert.throws(() => foreignVisibleAfterResponse([{ ...o8cHorse, at: { x: 200.5, y: -60, z: 201.1 } }], o8cEpisode, ctx), /inside the declared scene/);
  assert.throws(() => foreignVisibleAfterResponse([{ ...o8cHorse, at: undefined }], o8cEpisode, ctx), /without a position/);
  assert.throws(() => foreignVisibleAfterResponse([o8cHorse], [{ ...o8cEpisode[0]!, hazards: ['creeper', 'zombie_horse'] }], ctx), /unexpected safety hazard zombie_horse/);
  assert.throws(() => foreignVisibleAfterResponse([o8cHorse], [{ ...o8cEpisode[0]!, defense: { target: { entityId: 11999 } } }], ctx), /unrecorded entity/);
  assert.throws(() => foreignVisibleAfterResponse([], [o8cEpisode[0]!], { ...ctx, allowedHazards: [] }), /unexpected safety hazard creeper/, 'O8N: any episode hazard fails');
  // Through the actual harness identity check.
  const creeper = { tag: 'og_o8c', key: 'minecraft:creeper', nbt: '[I; -2083512439, 25446551, -1712917670, 389622150]', uuid: '83d01f89-0184-4897-99e6-f35a17392986', at: { x: 207.7745921081097, y: -60, z: 205.50000599211262 }, id: 11434 };
  const run = async (snapshotEntities: Array<Record<string, unknown>>, after?: typeof ctx) => {
    const { h, io } = make(); io.actors = [creeper]; h.sceneActors.set(creeper.tag, creeper); h.scenario = 'O8C';
    h.owner = { entities: { 11434: { id: 11434, uuid: creeper.uuid, name: 'creeper', position: creeper.at } } } as unknown as NonNullable<Harness['owner']>;
    h.observe = async () => ({ entities: snapshotEntities });
    h.events = () => o8cEpisode;
    return h.mobIdentity(creeper.tag, creeper.key, after);
  };
  const actual = [{ key: 'minecraft:player', at: { x: 202.5, y: -60, z: 209.5 } }, { key: 'minecraft:creeper', at: { x: 208.2, y: -60, z: 205.5 } }, o8cHorse];
  await assert.rejects(run(actual), /staging_unready: unexpected visible nonplayer group/, 'staging readiness stays strict');
  assert.deepEqual((await run(actual, ctx)).foreignVisible.map((f) => f.key), ['minecraft:zombie_horse']);
  await assert.rejects(run([...actual.slice(0, 2), { ...o8cHorse, at: { x: 214.5, y: -60, z: 205.5 } }], ctx), /inside the declared scene/);
  await assert.rejects(run([{ key: 'minecraft:player', at: { x: 202.5, y: -60, z: 209.5 } }, o8cHorse], ctx), /actual CLI LOS\/visible target correlation missing/, 'same visible creeper still required');
});
