// Credential-free command/packet replay through the actual ordinary harness methods.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { Harness, LAYOUT, fixtureBlockTest, fixtureEntityTest, type OrdinaryHarnessIO } from '../scripts/ordinary-goal-live-check.ts';

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
    if (c === 'data get entity Chunkbot Inventory') return 'Chunkbot has the following entity data: [{Slot: 0b, id: "minecraft:iron_sword", count: 1}, {Slot: 103b, id: "minecraft:iron_helmet", count: 1}, {Slot: 102b, id: "minecraft:iron_chestplate", count: 1}]';
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
