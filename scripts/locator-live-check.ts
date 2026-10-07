// MB-LOC-001 locator gate harness against the LOCAL loopback test fixtures only.
//
// PRE-INTEGRATION harness: until the designated writer installs the locator
// hooks (H1 packet tap, H2 perception route bounds, H3 composition), this
// script composes the REAL connection, SkillRuntime (perception, knowledge,
// ledger, single actuator lease), the registered skills plus seek_owner /
// route_travel, the LocatorService (attached to the connection's client right
// after ready: "late" attach, reported) and the RouteController, wiring exactly
// the proposed hooks. No model is called: the harness is the owner (a separate
// offline fixture player "FixtureOwner" it controls) and a fixed decision.
//
// Gates (official-source expectations from the static 26.x class inspection
// recorded in docs/reviews/mb-loc-001-locator.md):
//   G1  variants/attribution/hiding: block precision while the owner's chunk is
//       in view distance, chunk precision beyond it, azimuth beyond 332 blocks;
//       a second player is never the owner; crouch / invisibility / head item /
//       logout / dimension change withdraw the owner (untrack) and restore.
//   G2  (needs --approve-rules <id>) locator_bar gamerule off/on and the
//       waypoint_transmit_range attribute; originals restored in finally.
//   G3  route: owner 300 blocks away beyond the 128 admission radius; seek_owner
//       through counted legs, reunion verified by SERVER positions (RCON).
//   G5  (needs --approve-scene <id>) negative route scenes inside the declared
//       footprint (lava / wall / drop), restored in finally.
//
// Safety: importing this module runs nothing. main() refuses (exit 2) before
// any fixture password read, RCON command, join or output setup unless
// --fixture-lease <granted id> is given. Rule/attribute changes and scene
// fills need their own explicit approval ids. Every RCON command is recorded
// in the report. Reports carry coarse cues, counts, offsets and distances —
// never raw waypoint coordinates.
//
//   npm run build   (source/build frozen for the run)
//   node scripts/locator-live-check.ts --fixture-lease <id> --fixture 26.2 [--gates g1,g2,g3,g5] [--approve-rules <id>] [--approve-scene <id>]
//   node scripts/locator-live-check.ts --fixture-lease <id> --gates g1   (26.1.2 broadcast sanity)
//
// Footprint (declared; request before running G3/G5): players are teleported
// within x 1000..1420, z 960..1060 at the flat-world standing level y=-60
// (G3: no block writes). G5 fills ONLY x 1000..1040, z 1100..1140, y -64..-50
// and restores grass/air there afterwards.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEmitter } from 'node:events';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Result {
  id: string;
  title: string;
  pass: boolean | 'skipped';
  evidence: string[];
}

export const LOCATOR_FOOTPRINT = {
  players: { x1: 1000, x2: 1420, z1: 960, z2: 1060, y: -60 },
  scene: { x1: 1000, x2: 1040, z1: 1100, z2: 1140, y1: -64, y2: -50 },
} as const;

const BASE = { x: 1000.5, y: -60, z: 1000.5 };
const SCENE_BASE = { x: 1004.5, y: -60, z: 1120.5 };

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const SECTORS = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'];
const sectorOf = (dx: number, dz: number) => SECTORS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8] as string;

async function run(argv: readonly string[], lease: string): Promise<number> {
  // Heavy imports only after the lease check (import safety and no side effects).
  const { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } = await import('../src/app/fixture-layout.ts');
  const { SkillRuntime } = await import('../src/app/skill-runtime.ts');
  const { loadConfigFile } = await import('../src/config/load.ts');
  const { randomIds, systemClock } = await import('../src/contracts/index.ts');
  const { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema } = await import('../src/contracts/locator.ts');
  const { SkillExecutorImpl } = await import('../src/execution/executor.ts');
  const { TaskCandidateGenerator } = await import('../src/execution/candidates.ts');
  const { SkillRegistry } = await import('../src/execution/registry.ts');
  const { MineflayerConnection } = await import('../src/game/connection.ts');
  const { ownerPolicyFromConfig, offlinePlayerUuid } = await import('../src/game/identity.ts');
  const { LocatorService } = await import('../src/locator/service.ts');
  const { RouteController } = await import('../src/locator/routes.ts');
  const { allSkills } = await import('../src/skills/index.ts');
  const { locatorSkills } = await import('../src/skills/locator.ts');
  const { MemoryRunStore } = await import('../src/telemetry/run-store.ts');
  const { rconCommand } = await import('./lib/rcon.ts');
  const mineflayer = (await import('mineflayer')).default;

  const PINS = fixturePins(fixtureProfileFromArgv(argv));
  const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
  const gates = new Set((argOf(argv, '--gates') ?? (PINS.profile === '26.2' ? 'g1,g3' : 'g1')).split(','));
  const approveRules = argOf(argv, '--approve-rules');
  const approveScene = argOf(argv, '--approve-scene');
  if (approveRules !== undefined && !ID_RE.test(approveRules)) throw new Error('invalid --approve-rules id');
  if (approveScene !== undefined && !ID_RE.test(approveScene)) throw new Error('invalid --approve-scene id');
  const fx = fixturePaths(PROJECT_ROOT, PINS);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-locator`);
  mkdirSync(outDir, { recursive: true });
  const props = readFileSync(fx.properties, 'utf8').split('\n');
  const password = props.find((l) => l.startsWith('rcon.password='))?.slice('rcon.password='.length).trim();
  assert(password, 'fixture RCON password missing');
  const viewDistance = Number(props.find((l) => l.startsWith('view-distance='))?.split('=')[1] ?? '10');

  const setupLog: Array<{ atMs: number; command: string; reply: string }> = [];
  let rconQueue: Promise<unknown> = Promise.resolve();
  const rcon = async (command: string, record = true): Promise<string> => {
    const job = rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, password, command));
    rconQueue = job.catch(() => undefined);
    const reply = await job;
    if (record) setupLog.push({ atMs: Date.now(), command, reply: reply.slice(0, 200) });
    return reply;
  };
  const serverPos = async (name: string) => {
    const r = await rcon(`data get entity ${name} Pos`, false);
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
    assert(m, `cannot read ${name} position`);
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };

  const results: Result[] = [];
  const check = async (id: string, title: string, fn: (ev: string[]) => Promise<void>) => {
    const evidence: string[] = [];
    try {
      await fn(evidence);
      results.push({ id, title, pass: true, evidence });
      process.stdout.write(`PASS ${id} ${title}\n`);
    } catch (error) {
      evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ id, title, pass: false, evidence });
      process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 400)}\n`);
    }
  };
  const skip = (id: string, title: string, why: string) => {
    results.push({ id, title, pass: 'skipped', evidence: [why] });
    process.stdout.write(`SKIP ${id} ${title}: ${why}\n`);
  };

  // ------------------------------------------------------------ composition (proposed hooks)
  const loaded = loadConfigFile(join(PROJECT_ROOT, PINS.inferenceFreeConfig));
  const config = loaded.config;
  const OWNER = config.owner.name ?? 'FixtureOwner';
  const OWNER_UUID = offlinePlayerUuid(OWNER);
  const BOT = config.bot.username;
  const store = new MemoryRunStore();
  const game = new MineflayerConnection({ host: config.minecraft.host, port: config.minecraft.port, version: config.minecraft.version, auth: config.bot.auth, username: BOT, authDir: loaded.authDir, joinTimeoutMs: config.minecraft.joinTimeoutMs, replyMode: config.chat.replyMode, log: () => undefined, ownerName: OWNER });
  let epoch = 0;
  const runtime = new SkillRuntime({ config, session: () => game.session(), connectionEpoch: () => game.connectionEpoch, goalEpoch: () => epoch, diagnosticCurrent: () => false, admission: () => game.admissionContext(), store, clock: systemClock, ids: randomIds });
  const locator = new LocatorService({ config: DEFAULT_LOCATOR_CONFIG, version: config.minecraft.version, ownerPolicy: ownerPolicyFromConfig(config), admission: () => game.admissionContext(), session: () => game.session(), clock: systemClock, record: (e) => store.record(e) });
  const routes = new RouteController({ policy: RoutePolicySchema.parse({}), clock: systemClock, record: (e) => store.record(e) });
  game.onLifecycle((event) => {
    locator.onLifecycle(event); // proposed H3
    if (event.type === 'death' || event.type === 'respawn' || event.type === 'dimension_change' || event.type === 'ended') routes.revoke(`lifecycle_${event.type}`);
    runtime.onLifecycle(event);
  });
  const registry = new SkillRegistry([...allSkills(), ...locatorSkills({ locator, routes })]);
  const executor = new SkillExecutorImpl({ registry, leases: runtime.leases, session: () => game.session(), services: runtime.services, goalEpoch: () => epoch, store });
  const candidates = new TaskCandidateGenerator({ registry, services: runtime.services, session: () => game.session(), ids: randomIds });

  // Bounded packet evidence: operation, variant, attribution class (never coordinates).
  const packets: Array<{ t: number; op: string; variant: string; who: string }> = [];
  let guestUuid: string | undefined;
  const tapPackets = (client: EventEmitter) =>
    client.on('tracked_waypoint', (d: { operation?: unknown; waypoint?: { hasUUID?: boolean; uuid?: string; type?: unknown } }) => {
      const uuid = d.waypoint?.hasUUID ? String(d.waypoint.uuid ?? '').toLowerCase() : undefined;
      const who = uuid === undefined ? 'string_id' : uuid === OWNER_UUID ? 'owner_uuid' : uuid === guestUuid ? 'guest' : 'other_uuid';
      if (packets.length < 2_000) packets.push({ t: Date.now(), op: String(d.operation), variant: String(d.waypoint?.type), who });
    });
  const sinceOwner = (t0: number) => packets.filter((p) => p.t >= t0 && p.who === 'owner_uuid');
  const waitOwner = async (t0: number, test: (p: { op: string; variant: string }) => boolean, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = sinceOwner(t0).find(test);
      if (hit) return hit;
      await sleep(100);
    }
    return undefined;
  };

  const fixturePlayer = async (username: string) => {
    const bot = mineflayer.createBot({ host: PINS.host, port: PINS.port, username, auth: 'offline', version: PINS.minecraftVersion, hideErrors: true });
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${username} did not spawn`)), 20_000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        res();
      });
      bot.once('end', (reason: string) => rej(new Error(`${username} ended: ${reason}`)));
    });
    return bot;
  };

  const restores: Array<{ label: string; fn: () => Promise<unknown> }> = [];
  let owner: Awaited<ReturnType<typeof fixturePlayer>> | undefined;
  let guest: Awaited<ReturnType<typeof fixturePlayer>> | undefined;
  const ownerAt = async (dx: number, dy: number, dz: number) => {
    await rcon(`tp ${OWNER} ${BASE.x + dx} ${BASE.y + dy} ${BASE.z + dz}`);
  };
  const hint = () => locator.ownerHint();

  try {
    process.stdout.write(`locator live check (${PINS.profile}, lease ${lease}) -> ${outDir}\n`);
    // Join Chunkbot, then attach the locator to its client (pre-H1 late attach).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 40_000);
    try {
      await game.connect(abort.signal);
    } finally {
      clearTimeout(timer);
    }
    const session = game.session();
    assert(session, 'Chunkbot not ready');
    const client = (session.bot as unknown as { _client: EventEmitter })._client;
    locator.attach(client, session.connectionEpoch, true);
    tapPackets(client);
    routes.attachMovement(session, () => epoch);
    await rcon(`tp ${BOT} ${BASE.x} ${BASE.y} ${BASE.z} -90 0`);
    owner = await fixturePlayer(OWNER);
    restores.push({ label: 'owner effects/head/sneak cleared', fn: async () => { owner?.setControlState('sneak', false); await rcon(`effect clear ${OWNER}`); await rcon(`item replace entity ${OWNER} armor.head with air`); } });
    await sleep(1_500);
    await ownerAt(24, 0, 0);
    await sleep(1_500);

    if (gates.has('g1')) {
      await check('G1-1', 'owner attribution: verified owner UUID + exact listed name; codec gate', async (ev) => {
        const st = locator.status();
        ev.push(`support ${st.support}, codec ${st.codecVersion}, late attach ${locator.attachedLate}`);
        assert(st.support === 'available', 'locator available');
        const h = hint();
        ev.push(`hint ${h.reason} ${h.direction ?? '-'} ${h.distanceBand} ${h.elevation} ${h.precision}`);
        assert(h.actionable, `owner hint actionable (${h.note})`);
      });

      for (const [label, dx, dz, expect] of [
        ['east 40 (owner chunk in view distance)', 40, 0, 'vec3i'],
        [`south 200 (beyond view distance ${viewDistance})`, 0, 200, 'chunk'],
        ['west 400 (beyond 332)', -400, 0, 'azimuth'],
        ['north_east 60', 42, -42, 'vec3i'],
      ] as const) {
        await check(`G1-${label.split(' ')[0]}-${expect}`, `variant and coarse cue for owner offset ${label}`, async (ev) => {
          const t0 = Date.now();
          await ownerAt(dx, 0, dz);
          const p = await waitOwner(t0, (x) => x.variant === expect);
          ev.push(`owner statements since move: ${sinceOwner(t0).map((x) => `${x.op}:${x.variant}`).join(', ') || 'none'}`);
          assert(p, `a ${expect} statement for the owner`);
          await sleep(300);
          const h = hint();
          const want = sectorOf(dx, dz);
          ev.push(`cue ${h.direction} ${h.distanceBand} ${h.elevation} (${h.precision}); expected sector ${want}`);
          assert(h.actionable && h.direction === want, 'cue sector matches the true relative direction');
          if (expect === 'azimuth') assert(h.distanceBand === 'unknown' && h.elevation === 'unknown', 'azimuth: no distance/height');
          if (expect === 'chunk') assert(h.elevation === 'unknown', 'chunk: no height');
        });
      }

      await check('G1-above', 'block precision states height (owner above, slow falling)', async (ev) => {
        const t0 = Date.now();
        await rcon(`effect give ${OWNER} slow_falling 10 0 true`);
        await ownerAt(30, 14, 0);
        await waitOwner(t0, (x) => x.variant === 'vec3i');
        await sleep(300);
        const h = hint();
        ev.push(`cue ${h.direction} ${h.elevation}`);
        assert(h.elevation === 'above', 'above');
        await rcon(`effect clear ${OWNER}`);
        await ownerAt(30, 0, 0);
      });

      await check('G1-guest', 'a second player is tracked but never the owner', async (ev) => {
        guest = await fixturePlayer('FixtureGuest');
        guestUuid = offlinePlayerUuid('FixtureGuest');
        await rcon(`tp FixtureGuest ${BASE.x - 30} ${BASE.y} ${BASE.z}`);
        await sleep(1_500);
        const st = locator.status();
        ev.push(`others tracked ${st.counters.otherTracked}; guest statements ${packets.filter((p) => p.who === 'guest').length}`);
        assert(packets.some((p) => p.who === 'guest'), 'guest waypoint received');
        assert(hint().direction === 'east', 'owner cue unaffected by the guest (west)');
      });

      for (const [id, title, hide, show] of [
        ['G1-crouch', 'crouching withdraws the owner; standing restores', async () => owner!.setControlState('sneak', true), async () => owner!.setControlState('sneak', false)],
        ['G1-invisible', 'invisibility withdraws the owner; clearing restores', async () => void (await rcon(`effect give ${OWNER} invisibility 30 0 true`)), async () => void (await rcon(`effect clear ${OWNER} invisibility`))],
        ['G1-head', 'a carved pumpkin on the head withdraws the owner; removing restores', async () => void (await rcon(`item replace entity ${OWNER} armor.head with carved_pumpkin`)), async () => void (await rcon(`item replace entity ${OWNER} armor.head with air`))],
      ] as const) {
        await check(id, title, async (ev) => {
          const t0 = Date.now();
          await hide();
          const u = await waitOwner(t0, (x) => x.op === 'untrack');
          await sleep(200);
          ev.push(`after hide: ${u ? 'untrack received' : 'no untrack'}; hint ${hint().reason}`);
          assert(u && !hint().actionable && hint().reason === 'untracked', 'withdrawn, no direction');
          const t1 = Date.now();
          await show();
          const t = await waitOwner(t1, (x) => x.op === 'track');
          await sleep(200);
          ev.push(`after show: ${t ? `track ${t.variant}` : 'no track'}; hint ${hint().reason} ${hint().direction}`);
          assert(t && hint().actionable, 'restored');
        });
      }

      await check('G1-logout', 'owner logout withdraws the owner; rejoin needs a fresh broadcast', async (ev) => {
        const t0 = Date.now();
        owner!.quit();
        const u = await waitOwner(t0, (x) => x.op === 'untrack');
        await sleep(300);
        ev.push(`after logout: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
        assert(!hint().actionable, 'no direction after logout');
        owner = await fixturePlayer(OWNER);
        await ownerAt(24, 0, 0);
        const t = await waitOwner(t0, (x) => x.op === 'track', 6_000);
        await sleep(300);
        ev.push(`after rejoin: ${t ? `track ${t.variant}` : 'none'}; hint ${hint().reason}`);
        assert(hint().actionable, 'fresh broadcast after rejoin');
      });

      await check('G1-dimension', 'owner dimension change withdraws; Chunkbot dimension change voids statements', async (ev) => {
        const t0 = Date.now();
        await rcon(`execute in minecraft:the_nether run tp ${OWNER} 0 80 0`);
        const u = await waitOwner(t0, (x) => x.op === 'untrack', 6_000);
        await sleep(300);
        ev.push(`owner to nether: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
        assert(!hint().actionable, 'withdrawn');
        await rcon(`execute in minecraft:overworld run tp ${OWNER} ${BASE.x + 24} ${BASE.y} ${BASE.z}`);
        await waitOwner(t0, (x) => x.op === 'track', 6_000);
        await sleep(500);
        assert(hint().actionable, 'restored in the overworld');
        await rcon(`execute in minecraft:the_nether run tp ${BOT} 0 80 0`);
        await sleep(3_000);
        ev.push(`Chunkbot in ${game.session()?.bot.game.dimension}: hint ${hint().reason}`);
        assert(!hint().actionable, 'no overworld cue in the nether');
        await rcon(`execute in minecraft:overworld run tp ${BOT} ${BASE.x} ${BASE.y} ${BASE.z}`);
        await sleep(3_000);
        await ownerAt(26, 0, 0);
        await sleep(1_000);
        ev.push(`back in the overworld: hint ${hint().reason}`);
      });
    }

    if (gates.has('g2')) {
      if (!approveRules) skip('G2', 'locator_bar gamerule and waypoint range attribute', 'not run: requires --approve-rules <coordinator approval id>');
      else {
        const original = /(true|false)/.exec(await rcon('gamerule locator_bar'))?.[1] ?? 'true';
        restores.push({ label: `gamerule locator_bar restored to ${original}`, fn: () => rcon(`gamerule locator_bar ${original}`) });
        restores.push({ label: 'owner/bot waypoint range attributes reset', fn: async () => { await rcon(`attribute ${OWNER} minecraft:waypoint_transmit_range base reset`); await rcon(`attribute ${BOT} minecraft:waypoint_receive_range base reset`); } });
        await check('G2-gamerule', 'locator_bar false withdraws every waypoint; true restores', async (ev) => {
          const t0 = Date.now();
          await rcon('gamerule locator_bar false');
          const u = await waitOwner(t0, (x) => x.op === 'untrack');
          await sleep(300);
          ev.push(`rule off: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
          assert(u && !hint().actionable, 'withdrawn when disabled');
          const t1 = Date.now();
          await rcon(`gamerule locator_bar ${original}`);
          await ownerAt(28, 0, 0);
          const t = await waitOwner(t1, (x) => x.op === 'track', 6_000);
          ev.push(`rule restored: ${t ? 'track' : 'none'}`);
          assert(t, 'restored');
        });
        await check('G2-range', 'transmit range below the distance withdraws (range-limited); reset restores', async (ev) => {
          await ownerAt(60, 0, 0);
          await sleep(500);
          const t0 = Date.now();
          await rcon(`attribute ${OWNER} minecraft:waypoint_transmit_range base set 30`);
          await ownerAt(61, 0, 0);
          const u = await waitOwner(t0, (x) => x.op === 'untrack', 6_000);
          await sleep(300);
          ev.push(`range 30 at 60: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
          assert(!hint().actionable, 'range-limited: no direction');
          const t1 = Date.now();
          await rcon(`attribute ${OWNER} minecraft:waypoint_transmit_range base reset`);
          await ownerAt(62, 0, 0);
          assert(await waitOwner(t1, (x) => x.op === 'track', 6_000), 'restored');
        });
      }
    }

    if (gates.has('g3')) {
      await check('G3-route', 'owner 300 blocks away: seek_owner through counted legs, reunion by server positions', async (ev) => {
        await rcon(`tp ${BOT} ${BASE.x} ${BASE.y} ${BASE.z}`);
        await ownerAt(300, 0, 40);
        await sleep(2_000);
        epoch += 1;
        const goalId = `goal-loc${epoch}`;
        runtime.onGoalAdmitted({ goalId, epoch, admittedAtMs: Date.now() });
        const bounds = runtime.perception.travelBounds();
        assert(bounds, 'admission anchor');
        const s = game.session()!;
        const auth = routes.admit({ goalId, goalEpoch: epoch, admittedAtMs: Date.now(), source: 'owner', goalDeadlineMs: Date.now() + config.limits.goalDeadlineMs, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension), admissionAnchor: bounds.anchor, admissionRadius: bounds.radius, ownerCoordinates: [] });
        assert(auth, 'route authorized');
        const task = { objective: 'Rejoin the owner.', decisionInstruction: 'Seek the owner.', allowedCapabilities: ['seek_owner'], targetSelectors: [{ kind: 'owner' as const }], parameters: {}, completion: { predicate: 'near_target' as const, target: { kind: 'owner' as const }, within: 3 } };
        let reached = false;
        for (let window = 0; window < 14 && !reached; window += 1) {
          const snap = runtime.perception.take(epoch);
          assert(snap, 'observation');
          const set = candidates.generate(task, snap);
          const c = set.candidates.find((x) => x.capability === 'seek_owner');
          if (!c) {
            ev.push(`window ${window}: no option (${set.unavailable.map((u) => `${u.capability}:${u.reason}`).join(', ')})`);
            break;
          }
          const o = await executor.execute(c, new AbortController().signal, { kind: 'goal', goalEpoch: epoch, goalId, taskId: randomIds.next('task') });
          const r = (o.evidence['route'] ?? {}) as Json;
          ev.push(`window ${window}: ${o.status}${o.reason ? ` (${o.reason})` : ''}; legs ${r['legsUsed'] ?? 0}/${r['maxLegs'] ?? '-'}, route blocks ${r['distanceUsed'] ?? 0}`);
          if (o.status === 'succeeded') reached = true;
          else if (!(o.status === 'partial' && o.reason === 'route_window_elapsed')) break;
        }
        const [b, w] = [await serverPos(BOT), await serverPos(OWNER)];
        const d = Math.hypot(b.x - w.x, b.y - w.y, b.z - w.z);
        const st = routes.status(epoch)!;
        ev.push(`server distance bot-owner ${d.toFixed(1)}; route ${st.state}, legs ${st.legsUsed}/${st.maxLegs}, distance ${st.distanceUsed}/${st.maxTotalDistance} (corrections ${st.distanceSources.correctionCount}); admission anchor unchanged ${JSON.stringify(routes.legBounds({ goalEpoch: epoch, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) })?.admissionAnchor) === JSON.stringify(bounds.anchor)}`);
        assert(reached && d <= 4.5, 'reunion verified by server positions');
        assert(st.legsUsed >= 2, 'legs were needed beyond the admission radius');
        routes.revoke('goal_terminal', epoch);
      });
    }

    if (gates.has('g5')) {
      if (!approveScene) skip('G5', 'negative route scenes (lava/wall/drop)', 'not run: requires --approve-scene <coordinator approval id> for the declared footprint');
      else {
        const sc = LOCATOR_FOOTPRINT.scene;
        restores.push({ label: 'G5 scene restored', fn: async () => { await rcon(`fill ${sc.x1} ${sc.y1 + 3} ${sc.z1} ${sc.x2} ${sc.y2} ${sc.z2} air`); await rcon(`fill ${sc.x1} -61 ${sc.z1} ${sc.x2} -61 ${sc.z2} grass_block`); } });
        const scenario = async (id: string, title: string, setup: string[], expect: string) =>
          check(id, title, async (ev) => {
            await rcon(`fill ${sc.x1} ${sc.y1 + 3} ${sc.z1} ${sc.x2} ${sc.y2} ${sc.z2} air`);
            await rcon(`fill ${sc.x1} -61 ${sc.z1} ${sc.x2} -61 ${sc.z2} grass_block`);
            for (const cmd of setup) await rcon(cmd);
            await rcon(`tp ${BOT} ${SCENE_BASE.x} ${SCENE_BASE.y} ${SCENE_BASE.z}`);
            await rcon(`tp ${OWNER} ${SCENE_BASE.x + 34} ${SCENE_BASE.y} ${SCENE_BASE.z}`);
            await sleep(2_000);
            epoch += 1;
            const goalId = `goal-locn${epoch}`;
            runtime.onGoalAdmitted({ goalId, epoch, admittedAtMs: Date.now() });
            const snap = runtime.perception.take(epoch)!;
            const set = candidates.generate({ objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['seek_owner'], targetSelectors: [{ kind: 'owner' }], parameters: {}, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } }, snap);
            const c = set.candidates.find((x) => x.capability === 'seek_owner');
            assert(c, `seek option (${set.unavailable.map((u) => u.reason).join(', ')})`);
            const o = await executor.execute(c, new AbortController().signal, { kind: 'goal', goalEpoch: epoch, goalId, taskId: randomIds.next('task') });
            const p = await serverPos(BOT);
            ev.push(`${o.status} (${o.reason}): ${o.effect.slice(0, 160)}; bot x offset ${(p.x - SCENE_BASE.x).toFixed(1)}`);
            assert(o.status === 'failed' && o.reason === expect, `specific blocker ${expect}`);
          });
        await scenario('G5-lava', 'lava band across the cue', [`fill ${sc.x1 + 3} -61 ${sc.z1} ${sc.x1 + 12} -61 ${sc.z2} lava`], 'hazard_lava');
        await scenario('G5-wall', 'wall higher than one block across the cue', [`fill ${sc.x1 + 3} -60 ${sc.z1} ${sc.x1 + 4} -54 ${sc.z2} stone`], 'wall');
        await scenario('G5-drop', 'drop deeper than 3 blocks across the cue', [`fill ${sc.x1 + 3} -64 ${sc.z1} ${sc.x2} -61 ${sc.z2} air`], 'cliff_drop');
      }
    }
  } finally {
    for (const r of restores.reverse()) {
      try {
        await r.fn();
        setupLog.push({ atMs: Date.now(), command: `RESTORE: ${r.label}`, reply: 'ok' });
      } catch (error) {
        setupLog.push({ atMs: Date.now(), command: `RESTORE FAILED: ${r.label}`, reply: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    }
    owner?.quit();
    guest?.quit();
    await game.disconnect('operator_stop').catch(() => undefined);
  }

  const counted = results.filter((r) => r.pass !== 'skipped');
  const pass = counted.length > 0 && counted.every((r) => r.pass === true);
  const locatorEvents = store.events.filter((e) => String(e.type).startsWith('locator_') || String(e.type).startsWith('route_')).slice(-200);
  writeFileSync(
    join(outDir, 'report.json'),
    `${JSON.stringify({ check: 'MB-LOC-001 locator live gates (pre-integration harness)', fixture: PINS.profile, lease, approvals: { rules: approveRules ?? null, scene: approveScene ?? null }, footprint: LOCATOR_FOOTPRINT, viewDistance, pass, results, setup: setupLog, packetEvidence: { count: packets.length, sample: packets.slice(0, 400).map((p) => ({ dtMs: p.t - (packets[0]?.t ?? p.t), op: p.op, variant: p.variant, who: p.who })) }, locatorEvents }, null, 2)}\n`,
  );
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} locator live check: ${counted.filter((r) => r.pass === true).length}/${counted.length} (${results.length - counted.length} skipped) — ${outDir}\n`);
  return pass ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  // Shared fixtures are leased: nothing (no RCON, no password read, no join, no output) without an explicit lease id.
  const lease = argOf(argv, '--fixture-lease');
  if (!lease || !ID_RE.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  return run(argv, lease);
}

/** Import safety: importing this module never runs anything; main() starts only as the process entry point. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(resolve(argv1)).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
