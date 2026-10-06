// MB-UI-001 live dashboard check (gate D-G1, milestones D2/D4/D5) against the
// running LOCAL TEST FIXTURE only, under a coordinator-granted fixture lease.
//
// Composes the REAL connection adapter (MineflayerConnection, offline fixture
// identity `DashProbe`), the REAL dashboard runtime (publisher + usage history)
// and the REAL viewer service with SSE clients. No model, planner, Jev or goal
// engine is involved. Server truth is set and read over loopback RCON (every
// command is recorded; the RCON password is never printed). Checks:
//   - health / max health (attribute) / food / XP level+progress / slot
//     inventory incl. armor and off hand match the server within 1 s;
//   - death invalidates the inventory until the server restates it;
//   - kick -> disconnected + historical; reconnect -> new epoch, old readings
//     never live; graceful stop -> stopped;
//   - viewing/refreshing with several tabs sends NO interaction packets.
//
//   node scripts/dashboard-live-check.ts [--fixture 26.2] [--read-only]
//   --read-only: join as DashProbe and compare against `data get` only (no RCON writes).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { supportLevel } from '../src/config/versions.ts';
import { DashboardStatusSchema, type DashboardStatus } from '../src/contracts/dashboard.ts';
import { createDashboardRuntime } from '../src/dashboard/runtime.ts';
import { DashboardViewer } from '../src/dashboard/server.ts';
import { pidAlive } from '../src/dashboard/history.ts';
import { MineflayerConnection } from '../src/game/connection.ts';
import { rconCommand } from './lib/rcon.ts';

const PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
const fx = fixturePaths(PROJECT_ROOT, PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-dashboard${process.argv.includes('--read-only') ? '-readonly' : ''}`);
const dataDir = join(outDir, 'data');
mkdirSync(dataDir, { recursive: true });
const BOT = 'DashProbe';
/** `--read-only`: no RCON writes at all (only `data get`); no damage/give/kill/kick/attribute/xp changes. */
const READ_ONLY = process.argv.includes('--read-only');
const LATENCY_BOUND_MS = 1_000;

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
}
const results: Result[] = [];
const setupLog: Array<{ atMs: number; command: string; reply: string }> = [];
const log = (line: string) => process.stdout.write(`${line}\n`);

function rconPassword(): string {
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}
const password = rconPassword();
let rconQueue: Promise<unknown> = Promise.resolve();
async function rcon(command: string): Promise<string> {
  const run = rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, password, command));
  rconQueue = run.catch(() => undefined);
  const reply = await run;
  setupLog.push({ atMs: Date.now(), command, reply: reply.slice(0, 400) });
  return reply;
}

function check(id: string, title: string, pass: boolean, evidence: string[]): void {
  results.push({ id, title, pass, evidence });
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${title}${pass ? '' : ` — ${evidence.join('; ')}`}`);
}

// ------------------------------------------------------------------ server truth (RCON)

async function serverNumber(path: string): Promise<number | undefined> {
  const r = await rcon(`data get entity ${BOT} ${path}`);
  const m = /has the following entity data: (-?[\d.]+)[a-zA-Z]?/.exec(r);
  return m ? Number(m[1]) : undefined;
}

interface TruthSlot {
  slot: number;
  item: string;
  count: number;
}
/** Window-0 slot numbers from the server's NBT (Inventory: 0-8 hotbar, 9-35 main; equipment compound). */
async function serverInventory(): Promise<TruthSlot[]> {
  const out: TruthSlot[] = [];
  const inv = await rcon(`data get entity ${BOT} Inventory`);
  for (const m of inv.matchAll(/\{([^{}]*?(?:\{[^{}]*\}[^{}]*?)*)\}/g)) {
    const body = m[1] ?? '';
    const slot = /Slot: (\d+)b/.exec(body)?.[1];
    const id = /id: "([^"]+)"/.exec(body)?.[1];
    const count = /count: (\d+)/.exec(body)?.[1];
    if (slot === undefined || !id) continue;
    const s = Number(slot);
    out.push({ slot: s <= 8 ? 36 + s : s, item: id, count: count ? Number(count) : 1 });
  }
  const eq = await rcon(`data get entity ${BOT} equipment`);
  const map: Record<string, number> = { head: 5, chest: 6, legs: 7, feet: 8, offhand: 45 };
  for (const [name, slot] of Object.entries(map)) {
    const m = new RegExp(`${name}: \\{([^{}]*)\\}`).exec(eq);
    if (!m) continue;
    const id = /id: "([^"]+)"/.exec(m[1] ?? '')?.[1];
    const count = /count: (\d+)/.exec(m[1] ?? '')?.[1];
    if (id) out.push({ slot, item: id, count: count ? Number(count) : 1 });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

// ------------------------------------------------------------------ dashboard observation

const statusFile = join(dataDir, 'dashboard', 'status.json');
function status(): DashboardStatus | undefined {
  try {
    return DashboardStatusSchema.parse(JSON.parse(readFileSync(statusFile, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Polls the published file until `pred` holds; returns elapsed ms or undefined on timeout. */
async function published(pred: (s: DashboardStatus) => boolean, timeoutMs = 3_000): Promise<{ ms: number; at: number; s: DashboardStatus } | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = status();
    if (s && pred(s)) return { ms: Date.now() - start, at: Date.now(), s };
    await sleep(20);
  }
  return undefined;
}

/** SSE client collecting view-model frames with arrival times. */
function sse(port: number) {
  const frames: Array<{ atMs: number; vm: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let buf = '';
  const req = request({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
    res.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i = buf.indexOf('\n\n');
      while (i >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (frame.includes('event: state') && data) frames.push({ atMs: Date.now(), vm: JSON.parse(data.slice(6)) });
        i = buf.indexOf('\n\n');
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return { frames, close: () => req.destroy() };
}

async function viewed(client: ReturnType<typeof sse>, since: number, pred: (vm: Record<string, any>) => boolean, timeoutMs = 3_000): Promise<number | undefined> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const f = client.frames.find((x) => x.atMs >= since && pred(x.vm));
    if (f) return f.atMs - since;
    await sleep(15);
  }
  return undefined;
}

const slotsOf = (s: DashboardStatus) => (s.inventory.contents.known ? s.inventory.contents.value.slots.map((x) => `${x.slot}:${x.item}x${x.count}`) : []);

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const runId = `run-dashlive${Date.now().toString(36).slice(-6)}`;
  const game = new MineflayerConnection({
    host: PINS.host,
    port: PINS.port,
    version: PINS.minecraftVersion,
    auth: 'offline',
    username: BOT,
    authDir: join(dataDir, 'auth-unused'),
    joinTimeoutMs: 30_000,
    replyMode: 'whisper',
    log: (line) => log(`[game] ${line}`),
  });
  const runtime = createDashboardRuntime({ dataDir, runId, now: () => Date.now(), game, profile: { version: PINS.minecraftVersion, supportLevel: supportLevel(PINS.minecraftVersion) ?? 'unsupported' }, log });
  runtime.start();
  const viewer = new DashboardViewer({ host: '127.0.0.1', port: 0, statusPath: runtime.paths.status, historyPath: runtime.paths.history, pidAlive, timeZone: 'UTC' });
  const { port, url } = await viewer.start();
  log(`viewer ${url}`);
  const tabA = sse(port);
  const tabB = sse(port);

  // Count interaction packets the client sends while only the dashboard observes.
  const sent = new Map<string, number>();
  const tapWrites = () => {
    const client = (game.session()?.bot as unknown as { _client?: { write: (name: string, data: unknown) => unknown } } | undefined)?._client;
    if (!client || (client as { __dashTap?: boolean }).__dashTap) return;
    const original = client.write.bind(client);
    client.write = (name: string, data: unknown) => {
      sent.set(name, (sent.get(name) ?? 0) + 1);
      return original(name, data);
    };
    (client as { __dashTap?: boolean }).__dashTap = true;
  };

  try {
    // ---- join
    const info = await game.connect(new AbortController().signal);
    tapWrites();
    if (!READ_ONLY) {
      await rcon(`clear ${BOT}`);
      await rcon(`effect clear ${BOT}`);
      await rcon(`attribute ${BOT} minecraft:max_health base reset`);
      await rcon(`xp set ${BOT} 0 levels`);
      await rcon(`xp set ${BOT} 0 points`);
      await rcon(`gamemode survival ${BOT}`);
    }
    const first = await published((s) => s.connection.state === 'ready' && s.vitals.health.known && s.vitals.epoch === s.connection.epoch, 10_000);
    check('G1-join', 'joined; status published with own bot name, dimension and server-backed health', Boolean(first && first.s.connection.botName.known && first.s.connection.botName.value === BOT), [
      `server ${info.serverVersion}/${info.protocolVersion}, dimension ${info.dimension}`,
      first ? `botName=${JSON.stringify(first.s.connection.botName)}, health=${JSON.stringify(first.s.vitals.health)}` : 'no ready status within 10 s',
    ]);
    const mh0 = status()?.vitals.maxHealth;
    check('G1-maxhealth-initial', 'max health provenance at join (attribute packet)', true, [`maxHealth=${JSON.stringify(mh0)} (unknown is acceptable evidence: the server did not send max_health)`]);

    // ---- own position vs the server's entity data (client model, labeled)
    await sleep(500);
    const posReply = await rcon(`data get entity ${BOT} Pos`);
    const pm = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(posReply);
    const sp = status()?.connection.position;
    const close = pm && sp?.known ? Math.hypot(sp.value.x - Number(pm[1]), sp.value.y - Number(pm[2]), sp.value.z - Number(pm[3])) : undefined;
    check('G1-position', "own position (client model, labeled) is within 0.6 blocks of the server's entity position", close !== undefined && close <= 0.6, [`server Pos ${pm ? pm.slice(1).join(' ') : 'unparsed'}`, `dashboard ${JSON.stringify(sp)}`, `serverPosition ${JSON.stringify(status()?.connection.serverPosition)}`]);

    const noActions = async () => {
      const before = new Map(sent);
      const tabs = [sse(port), sse(port), sse(port)];
      for (let i = 0; i < 10; i += 1) {
        await new Promise<void>((r) => request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `127.0.0.1:${port}` } }, (res) => res.resume().on('end', () => r())).end());
        await sleep(100);
      }
      for (const t of tabs) t.close();
      const interactions = ['window_click', 'close_window', 'held_item_slot', 'use_item', 'block_dig', 'block_place', 'chat_message', 'chat_command', 'client_command', 'set_creative_slot', 'entity_action', 'use_entity'];
      const delta = interactions.map((n) => [n, (sent.get(n) ?? 0) - (before.get(n) ?? 0)] as const).filter(([, d]) => d > 0);
      check('D5-no-actions', 'viewing with 5 tabs and 10 refreshes sends no interaction packets', delta.length === 0, [`interaction packets during viewing: ${JSON.stringify(delta)}`, `all client packets seen: ${JSON.stringify(Object.fromEntries(sent))}`]);
    };

    if (READ_ONLY) {
      // Server truth via `data get` only; the dashboard must already agree (no world changes).
      const h = await serverNumber('Health');
      const f = await serverNumber('foodLevel');
      const l = await serverNumber('XpLevel');
      const xpp = await serverNumber('XpP');
      const truth = await serverInventory();
      const want = truth.map((x) => `${x.slot}:${x.item}x${x.count}`);
      const agree = await published((s) => s.vitals.health.known && h !== undefined && Math.abs(s.vitals.health.value - h) < 0.01 && s.vitals.food.known && s.vitals.food.value === f && s.vitals.xp.known && s.vitals.xp.value.level === l && xpp !== undefined && Math.abs(s.vitals.xp.value.progress - xpp) < 0.01 && JSON.stringify(slotsOf(s)) === JSON.stringify(want), 5_000);
      check('G1-readonly-truth', 'health, hunger, XP and slot inventory equal the server entity data (no world changes)', Boolean(agree), [`server Health=${h} foodLevel=${f} XpLevel=${l} XpP=${xpp}`, `server inventory ${JSON.stringify(want)}`, `dashboard vitals ${JSON.stringify(status()?.vitals)}`.slice(0, 600), `dashboard inventory ${JSON.stringify(status() ? slotsOf(status()!) : [])}`]);
      await noActions();
    } else {
    // ---- hunger (a real food change) and a regeneration-free health baseline: natural regeneration
    // heals ~0.8 HP every 0.5 s at full food, so damage is applied only after food is below 18.
    await rcon(`effect give ${BOT} minecraft:hunger 10 255 true`);
    let foodNow = await serverNumber('foodLevel');
    for (let i = 0; i < 40 && (foodNow === undefined || foodNow >= 17); i += 1) {
      await sleep(150);
      foodNow = await serverNumber('foodLevel');
    }
    await rcon(`effect clear ${BOT} minecraft:hunger`);
    await sleep(300);
    const tFood = Date.now();
    const food = await serverNumber('foodLevel');
    const fd = await published((s) => s.vitals.food.known && s.vitals.food.value === food);
    check('D2-food', 'hunger change matches the server', Boolean(fd && food !== undefined && food < 20), [`server foodLevel=${food} (after a Hunger effect)`, `dashboard ${JSON.stringify(status()?.vitals.food)} ${fd ? fd.at - tFood : 'timeout'} ms after the truth read`]);

    // ---- health
    let t0 = Date.now();
    await rcon(`damage ${BOT} 3 minecraft:generic`);
    const truthHealth = await serverNumber('Health');
    const hp = await published((s) => s.vitals.health.known && truthHealth !== undefined && Math.abs(s.vitals.health.value - truthHealth) < 0.01);
    const hpView = await viewed(tabA, t0, (vm) => truthHealth !== undefined && String(vm.world.health.text).startsWith(String(Number.isInteger(truthHealth) ? truthHealth : truthHealth.toFixed(1))));
    const hpMs = hp ? hp.at - t0 : undefined;
    check('D2-health', `health matches the server within ${LATENCY_BOUND_MS} ms of the command (file and screen; includes the RCON round trip)`, Boolean(hpMs !== undefined && hpMs <= LATENCY_BOUND_MS && hpView !== undefined && hpView <= LATENCY_BOUND_MS), [
      `server Health=${truthHealth}`,
      `published ${hpMs ?? 'timeout'} ms after the command; viewer frame ${hpView ?? 'timeout'} ms after the command`,
    ]);

    // ---- max health via attribute
    t0 = Date.now();
    await rcon(`attribute ${BOT} minecraft:max_health base set 24`);
    const mh = await published((s) => s.vitals.maxHealth.known && s.vitals.maxHealth.value === 24);
    const mhView = await viewed(tabB, t0, (vm) => / \/ 24$/.test(String(vm.world.health.text)) && vm.world.health.pips?.length === 12);
    const mhMs = mh ? mh.at - t0 : undefined;
    check('D2-maxhealth', 'max health follows the server attribute (hearts = actual maximum)', Boolean(mhMs !== undefined && mhMs <= LATENCY_BOUND_MS && mhView !== undefined && mhView <= LATENCY_BOUND_MS), [`published ${mhMs ?? 'timeout'} ms after the command; viewer ${mhView ?? 'timeout'} ms`, `maxHealth=${JSON.stringify(status()?.vitals.maxHealth)}`]);
    await rcon(`attribute ${BOT} minecraft:max_health base reset`);

    // ---- XP
    await rcon(`xp set ${BOT} 7 levels`);
    await rcon(`xp set ${BOT} 9 points`);
    const tXp = Date.now();
    const lvl = await serverNumber('XpLevel');
    const prog = await serverNumber('XpP');
    const xp = await published((s) => s.vitals.xp.known && s.vitals.xp.value.level === lvl && prog !== undefined && Math.abs(s.vitals.xp.value.progress - prog) < 0.01);
    check('D2-xp', 'XP level and progress match the server', Boolean(xp && xp.at - tXp <= LATENCY_BOUND_MS + 400), [`server XpLevel=${lvl} XpP=${prog}`, `dashboard ${JSON.stringify(status()?.vitals.xp)} ${xp ? xp.at - tXp : 'timeout'} ms after the last command (includes two truth reads)`]);


    // ---- inventory incl. armor/off hand
    t0 = Date.now();
    await rcon(`give ${BOT} minecraft:oak_log 13`);
    await rcon(`give ${BOT} minecraft:cobblestone 70`);
    await rcon(`item replace entity ${BOT} hotbar.4 with minecraft:bread 5`);
    await rcon(`item replace entity ${BOT} armor.head with minecraft:iron_helmet`);
    await rcon(`item replace entity ${BOT} weapon.offhand with minecraft:shield`);
    const tLast = Date.now();
    const offhandSeen = await published((s) => s.inventory.contents.known && s.inventory.contents.value.slots.some((x) => x.slot === 45 && x.item === 'minecraft:shield'));
    const truth = await serverInventory();
    const want = truth.map((x) => `${x.slot}:${x.item}x${x.count}`);
    const inv = await published((s) => JSON.stringify(slotsOf(s)) === JSON.stringify(want));
    const invView = await viewed(tabA, t0, (vm) => vm.world.inventory.offhand.key === 'minecraft:shield' && vm.world.inventory.armor[0].key === 'minecraft:iron_helmet');
    check('D2-inventory', 'slot inventory (main, hotbar, armor, off hand) equals the server NBT', Boolean(inv && offhandSeen && offhandSeen.at - tLast <= LATENCY_BOUND_MS && invView !== undefined), [`server ${JSON.stringify(want)}`, `dashboard ${JSON.stringify(slotsOf(status()!))}`, `last change published ${offhandSeen ? offhandSeen.at - tLast : 'timeout'} ms after its command; full match confirmed; viewer ${invView ?? 'timeout'} ms after the first command`, `source ${(() => { const c = status()?.inventory.contents; return c?.known ? c.source : 'unknown'; })()}`]);

    // ---- no interaction packets while viewing (several tabs, refreshes)
    await noActions();

    // ---- death
    await rcon(`kill ${BOT}`);
    const dead = await published((s) => !s.inventory.contents.known || (s.inventory.contents.known && s.inventory.contents.value.slots.length === 0) || (s.vitals.health.known && s.vitals.health.value === 0), 3_000);
    const restated = await published((s) => s.vitals.health.known && s.vitals.health.value > 0 && s.inventory.contents.known && slotsOf(s).length === 0, 8_000);
    check('D4-death', 'death invalidates the old inventory; after respawn the server-restated (empty) inventory is shown', Boolean(dead && restated), [`after death: ${dead ? JSON.stringify(dead.s.inventory.contents).slice(0, 200) : 'timeout'}`, `after respawn: ${restated ? `${JSON.stringify(restated.s.vitals.health)} slots=${slotsOf(restated.s).length}` : 'timeout'}`]);

    // ---- kick -> disconnected/historical, reconnect -> new epoch
    await rcon(`give ${BOT} minecraft:oak_log 3`);
    await published((s) => slotsOf(s).length > 0);
    const epoch1 = game.connectionEpoch;
    await rcon(`kick ${BOT} dashboard live check`);
    const disc = await published((s) => s.connection.state === 'ended', 5_000);
    const discView = await viewed(tabA, Date.now() - 5_000, (vm) => vm.banner.state === 'disconnected' && vm.world.historical === true, 3_000);
    check('D4-disconnect', 'kick shows disconnected and world readings as historical', Boolean(disc && discView !== undefined), [`lastEnd ${JSON.stringify(disc?.s.connection.lastEnd)}`]);
    await game.connect(new AbortController().signal);
    tapWrites();
    const reconnect = await published((s) => s.connection.state === 'ready' && s.connection.epoch === epoch1 + 1, 10_000);
    const oldHistorical = reconnect ? reconnect.s.vitals.epoch === epoch1 || reconnect.s.vitals.epoch === epoch1 + 1 : false;
    const fresh = await published((s) => s.vitals.epoch === s.connection.epoch && s.inventory.epoch === s.connection.epoch && s.inventory.contents.known, 8_000);
    const liveAgain = await viewed(tabB, Date.now() - 8_000, (vm) => vm.banner.state === 'live' && vm.world.historical === false, 3_000);
    check('D4-rejoin', 'rejoin starts a new epoch; readings become live only after the new connection reports', Boolean(reconnect && oldHistorical && fresh && liveAgain !== undefined), [
      `epoch ${epoch1} -> ${reconnect?.s.connection.epoch}`,
      `fresh epoch-${fresh?.s.vitals.epoch} readings: slots=${fresh ? JSON.stringify(slotsOf(fresh.s)) : 'timeout'}`,
    ]);
    }

    // ---- graceful stop of the publisher (the bot stays connected)
    runtime.stop('dashboard live check complete');
    const stopped = await viewed(tabA, Date.now() - 1_000, (vm) => vm.banner.state === 'stopped', 3_000);
    check('D4-stopped', 'graceful stop is shown as stopped (not live, not crashed)', stopped !== undefined, [`viewer stopped frame ${stopped ?? 'timeout'} ms`]);
  } catch (error) {
    check('harness', 'harness completed', false, [error instanceof Error ? error.message : String(error)]);
  } finally {
    tabA.close();
    tabB.close();
    try {
      if (!READ_ONLY) {
        await rcon(`clear ${BOT}`);
        await rcon(`attribute ${BOT} minecraft:max_health base reset`);
        await rcon(`xp set ${BOT} 0 levels`);
        await rcon(`xp set ${BOT} 0 points`);
      }
    } catch {
      // the bot may be offline already
    }
    runtime.stop('harness exit');
    await game.disconnect('operator_stop');
    await viewer.close();
  }
  const pass = results.every((r) => r.pass);
  const report = { kind: 'dashboard-live-check', mode: READ_ONLY ? 'read-only' : 'mutating', fixture: PINS.profile, server: `${PINS.host}:${PINS.port}`, at: new Date().toISOString(), pass, results, setupCommands: setupLog };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'report.md'),
    `# Dashboard live check (${PINS.profile}) — ${pass ? 'PASS' : 'FAIL'}\n\n${results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} **${r.id}** ${r.title}\n${r.evidence.map((e) => `  - ${e}`).join('\n')}`).join('\n')}\n\nRCON setup commands: ${setupLog.length} (see report.json).\n`,
  );
  log(`report: ${outDir}`);
  return pass ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2_000).unref();
  },
  (error: unknown) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
