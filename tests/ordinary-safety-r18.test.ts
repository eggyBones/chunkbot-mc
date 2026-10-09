// P-SAFETY-R18 O8N controls from the actual R18 reports.
//   261 (2026-10-09T01-45-54-344Z): staging passed, then after the follow window the
//       natural (AI) wolf had wandered to 218.33,-60,194.70 and the post-window
//       identity failed "actual CLI LOS/visible target correlation missing".
//   262 (2026-10-09T01-45-54-736Z): FixtureOwner Health 19.0f with foodLevel 17 on
//       every read for 12 s; vanilla natural regeneration needs food >= 18.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type ObservationSnapshot } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { Harness, type OrdinaryHarnessIO } from '../scripts/ordinary-goal-live-check.ts';
import { SCENE } from '../scripts/lib/scene.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';

const t0 = 1_791_510_517_392;

class IO implements OrdinaryHarnessIO {
  time = t0; calls: string[] = []; reply: (c: string) => string;
  constructor(reply: (c: string) => string) { this.reply = reply; }
  now() { return this.time; }
  async sleep(ms: number) { this.time += ms; }
  async command(c: string) { this.calls.push(c); return this.reply(c); }
}

describe('P-SAFETY-R18 O8N actual controls', () => {
  it('262: owner health 19 with food 17 cannot regenerate naturally; readiness refuses at once with the reason (never heals/feeds)', async () => {
    const io = new IO((c) => c === 'data get entity Chunkbot Health' ? 'Chunkbot has the following entity data: 20.0f'
      : c === 'data get entity FixtureOwner Health' ? 'FixtureOwner has the following entity data: 19.0f'
      : c === 'data get entity FixtureOwner foodLevel' ? 'FixtureOwner has the following entity data: 17' : 'Unknown command');
    const h = new Harness('/offline-no-fixture-access', io); h.scenario = 'O8N';
    await assert.rejects(h.fullStableHealth(['Chunkbot', 'FixtureOwner'], []), /full stable control-player health required.*FixtureOwner food 17 < 18 makes natural regeneration impossible/);
    assert.ok(io.time - t0 < 1_000, 'no futile 12 s wait');
    assert.ok(io.calls.every((c) => /^data get entity /.test(c)), 'read-only');
  });

  it('food >= 18 still allows the bounded natural wait; full stable equality is unchanged', async () => {
    let n = 0;
    const io = new IO((c) => c.endsWith(' foodLevel') ? 'FixtureOwner has the following entity data: 18' : c === 'data get entity FixtureOwner Health' ? `FixtureOwner has the following entity data: ${n++ < 2 ? '19.0' : '20.0'}f` : 'Chunkbot has the following entity data: 20.0f');
    const h = new Harness('/offline-no-fixture-access', io); const ev: string[] = [];
    await h.fullStableHealth(['Chunkbot', 'FixtureOwner'], ev);
    assert.match(ev[0]!, /full stable health \{"Chunkbot":20,"FixtureOwner":20\}/);
  });

  it('261: the scene oak trunk occludes the wandered natural wolf from the bot (real perception), while the original and cow positions are visible', () => {
    const client = fakeClient();
    const fake = fakeMineflayerBot(client, { loaded: 400, at: { x: 205.5, y: -60, z: 205.5 } });
    fake.fill(180, -61, 180, 240, -61, 240, 'grass_block');
    for (const l of SCENE.logs) fake.setBlock(l.x, l.y, l.z, 'oak_log');
    const wolf = fake.addEntity({ id: 4246, type: 'mob', name: 'wolf', at: { x: 218.32857847138928, y: -60, z: 194.69861819645 }, height: 0.85 });
    fake.addEntity({ id: 4245, type: 'mob', name: 'cow', at: { x: 200.8161804811172, y: -60, z: 200.76111801838763 }, height: 1.4 });
    const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never); evidence.attach();
    const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
    const p = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 32, travelRadius: 128 });
    const keys = () => (p.take(1) as ObservationSnapshot).entities.map((e) => e.key).sort();
    assert.deepEqual(keys(), ['minecraft:cow'], 'wandered wolf genuinely occluded (as in the actual post-window snapshot)');
    wolf.position.x = 203.5; wolf.position.z = 205.5;
    assert.deepEqual(keys(), ['minecraft:cow', 'minecraft:wolf'], 'staged position visible');
  });

  it('post-window identity re-observes on fresh facts for a bounded time; never-visible and other identity failures still fail', async () => {
    const make = () => { const h = new Harness('/offline-no-fixture-access', new IO(() => 'Unknown command')); h.scenario = 'O8N'; return h; };
    const after = { sinceMs: 0, allowedHazards: [], allowedTargetIds: [] };
    const ok = make(); let tries = 0;
    ok.mobIdentity = (async () => { tries += 1; if (tries < 3) throw new Error('staging_unready: actual CLI LOS/visible target correlation missing'); return { uuid: 'u', entityId: 1, position: { x: 0, y: 0, z: 0 }, health: 8, foreignVisible: [] }; }) as Harness['mobIdentity'];
    assert.equal((await ok.currentMobIdentity('og_o8n_wolf', 'minecraft:wolf', after)).health, 8);
    assert.equal(tries, 3);
    assert.equal(ok.safetySamples.filter((s) => s.awaitingVisibility).length, 2);
    const never = make(); never.mobIdentity = (async () => { throw new Error('staging_unready: actual CLI LOS/visible target correlation missing'); }) as Harness['mobIdentity'];
    await assert.rejects(never.currentMobIdentity('og_o8n_wolf', 'minecraft:wolf', after), /LOS\/visible target correlation missing/);
    const other = make(); let n = 0; other.mobIdentity = (async () => { n += 1; throw new Error('staging_unready: current tagged UUID changed'); }) as Harness['mobIdentity'];
    await assert.rejects(other.currentMobIdentity('og_o8n_wolf', 'minecraft:wolf', after), /UUID changed/);
    assert.equal(n, 1, 'no retry for identity/health/hazard failures');
  });

  it('harness wiring: recorded actors never outlive their bot; O7F starts at the far-route start; O8N post-window uses the bounded fresh identity', () => {
    const src = readFileSync(new URL('../scripts/ordinary-goal-live-check.ts', import.meta.url), 'utf8');
    const fresh = src.slice(src.indexOf('const freshCli = async'), src.indexOf('const startFollowing'));
    assert.ok(fresh.indexOf('await h.removeKnownSceneActors();') > 0 && fresh.indexOf('await h.removeKnownSceneActors();') < fresh.indexOf('await h.quit();'));
    const o7f = src.slice(src.indexOf("scenarioRun('O7F'"), src.indexOf("scenarioRun('O8C'"));
    assert.ok(o7f.indexOf('h.triggerTeleport(BOT, LAYOUT.safety.farStart') > 0 && o7f.indexOf('h.triggerTeleport(BOT, LAYOUT.safety.farStart') < o7f.indexOf('h.triggerTeleport(OWNER, LAYOUT.safety.farOwner'));
    assert.ok(o7f.indexOf("h.ownedMotion(goal.goalId, origin, since, ['seek_owner'])") > 0, 'actual active seek_owner motion stays required');
    assert.ok(!/route\?\.state === 'leg_active' && route\.legsUsed >= 1/.test(o7f));
    const o8n = src.slice(src.indexOf("scenarioRun('O8N'"), src.indexOf("scenarioRun('RC1'"));
    assert.match(o8n, /const cow = await h\.mobIdentity\('og_o8n_cow', 'minecraft:cow'\), wolf = await h\.mobIdentity\('og_o8n_wolf', 'minecraft:wolf'\);/, 'staging stays a single strict identity');
    assert.match(o8n, /nowWolf = await h\.currentMobIdentity\('og_o8n_wolf', 'minecraft:wolf', after\)/);
    assert.ok(!/NoAI/.test(o8n), 'neutral controls keep natural AI');
  });
});
