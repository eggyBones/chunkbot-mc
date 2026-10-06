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
//   --hunger-trial: also run the authorized temporary-difficulty food-change trial (restored in finally).
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
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-dashboard${process.argv.includes('--read-only') ? '-readonly' : process.argv.includes('--hunger-trial') ? '-hunger' : ''}`);
const dataDir = join(outDir, 'data');
mkdirSync(dataDir, { recursive: true });
const BOT = 'DashProbe';
/** `--read-only`: no RCON writes at all (only `data get`); no damage/give/kill/kick/attribute/xp changes. */
const READ_ONLY = process.argv.includes('--read-only');
/**
 * `--hunger-trial` (coordinator-authorized, this fixture only): briefly switch the fixture difficulty from its
 * recorded original (peaceful) to normal so food can actually change, then restore the exact original in a
 * finally path and verify it over RCON. Skipped (reported) when any other player is online.
 */
const HUNGER_TRIAL = process.argv.includes('--hunger-trial') && !READ_ONLY;
let difficultyToRestore: string | undefined;
async function restoreDifficulty(): Promise<string> {
  if (!difficultyToRestore) return 'not changed';
  const want = difficultyToRestore;
  await rcon(`difficulty ${want}`);
  const now = await rcon('difficulty');
  const ok = new RegExp(`\\b${want}\\b`, 'i').test(now);
  if (ok) difficultyToRestore = undefined;
  return `${ok ? 'restored' : 'NOT RESTORED'}: ${now}`;
}
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
    // ---- hunger: the fixture runs difficulty=peaceful (food cannot change there and is not reconfigured
    // by this harness), so this is a static equality check with the server's foodLevel.
    const food = await serverNumber('foodLevel');
    const fd = await published((s) => s.vitals.food.known && s.vitals.food.value === food);
    check('D2-food', 'hunger equals the server foodLevel (static: peaceful fixture)', Boolean(fd), [`server foodLevel=${food}`, `dashboard ${JSON.stringify(status()?.vitals.food)}`]);

    if (HUNGER_TRIAL) {
      const before = await rcon('difficulty');
      const original = /difficulty is (\w+)/i.exec(before)?.[1]?.toLowerCase();
      const online = await rcon('list');
      const names = (online.split(':')[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
      const others = names.filter((n) => n !== BOT);
      if (!original) {
        check('D2-food-change', 'food change reaches the dashboard (temporary normal difficulty)', false, [`could not read the original difficulty: ${before}`]);
      } else if (others.length > 0) {
        check('D2-food-change', 'food change reaches the dashboard (temporary normal difficulty)', false, [`skipped: other players online (${others.length}); difficulty not changed`]);
      } else {
        const evidence: string[] = [`original difficulty: ${before}`, `players online: ${names.join(', ') || 'none'}`];
        const tChange = Date.now();
        try {
          difficultyToRestore = original;
          await rcon('difficulty normal');
          await rcon(`effect give ${BOT} minecraft:hunger 10 99 true`);
          let f = await serverNumber('foodLevel');
          while ((f === undefined || f >= 18) && Date.now() - tChange < 8_000) {
            await sleep(100);
            f = await serverNumber('foodLevel');
          }
          await rcon(`effect clear ${BOT} minecraft:hunger`);
          evidence.push(`server foodLevel reached ${f} ${Date.now() - tChange} ms after the change began`);
          await sleep(200);
          const tTruth = Date.now();
          const truthFood = await serverNumber('foodLevel');
          const seen = await published((s) => s.vitals.food.known && s.vitals.food.value === truthFood, 2_000);
          const view = await viewed(tabB, tChange, (vm) => truthFood !== undefined && String(vm.world.food.text).startsWith(`${truthFood} /`), 2_000);
          evidence.push(`server foodLevel=${truthFood}; dashboard ${JSON.stringify(status()?.vitals.food)} ${seen ? seen.at - tTruth : 'timeout'} ms after the truth read; viewer frame ${view === undefined ? 'timeout' : 'seen'}`);
          const changed = truthFood !== undefined && truthFood < 20;
          check('D2-food-change', 'a real food change (below 20) reaches the file and screen and equals the server', Boolean(changed && seen && seen.at - tTruth <= LATENCY_BOUND_MS && view !== undefined), evidence);
        } finally {
          const r = await restoreDifficulty();
          evidence.push(`difficulty ${r} ${Date.now() - tChange} ms after it was changed`);
          check('D2-difficulty-restored', 'fixture difficulty restored to its exact original and verified over RCON', r.startsWith('restored'), [r]);
        }
      }
    }

    // ---- health (MB-UI-001-C8). The publisher writes the LATEST server health packet once per tick
    // (default 500 ms), and on Peaceful the server regenerates (1 HP / 20 ticks, plus saturation healing at
    // full food), so a small drop can be partly healed before the next tick. The check therefore uses an
    // established baseline, a damage large enough that regeneration cannot return to the baseline within the
    // latency bound (never lethal), the server's own value read immediately after the command, and recorded
    // file/SSE samples. Pass requires a REAL lower-than-baseline sample in BOTH the file and the SSE stream
    // within the bound, and that sample within the regeneration tolerance of the server's post-damage value.
    const REGEN_TOLERANCE_HP = 2; // one Peaceful regen step (1 HP) + one saturation heal step (<= 1 HP)
    let baseline = await serverNumber('Health');
    const baselineWaitStart = Date.now();
    while ((baseline === undefined || baseline < 15) && Date.now() - baselineWaitStart < 8_000) {
      await sleep(500);
      baseline = await serverNumber('Health');
    }
    const baseSeen = baseline === undefined ? undefined : await published((s) => s.vitals.health.known && Math.abs(s.vitals.health.value - baseline!) < 0.01, 3_000);
    const damage = baseline === undefined ? 0 : Math.min(10, Math.floor(baseline) - 5);
    const healthEvidence: string[] = [`baseline: server Health=${baseline} (waited ${Date.now() - baselineWaitStart} ms); dashboard ${baseSeen ? `${baseSeen.s.vitals.health.known ? baseSeen.s.vitals.health.value : '?'} (matches)` : 'never matched the baseline'}`];
    let t0 = Date.now();
    let healthPass = false;
    if (baseline === undefined || !baseSeen || damage < 4) {
      healthEvidence.push(`not attempted: baseline unusable (damage would be ${damage} HP)`);
    } else {
      t0 = Date.now();
      const reply = await rcon(`damage ${BOT} ${damage} minecraft:generic`);
      const afterCmd = Date.now() - t0;
      const serverAfter = await serverNumber('Health');
      const serverAfterAt = Date.now() - t0;
      healthEvidence.push(`command: damage ${damage} -> "${reply.slice(0, 80)}" (reply after ${afterCmd} ms); server Health read immediately after = ${serverAfter} at +${serverAfterAt} ms`);
      // Record every distinct published value for 1.5 s (file polled every 20 ms).
      const fileSamples: Array<{ atMs: number; value: number | null; observedAtMs: number | null }> = [];
      while (Date.now() - t0 < 1_500) {
        const h = status()?.vitals.health;
        const v = h?.known ? h.value : null;
        if (fileSamples.length === 0 || fileSamples[fileSamples.length - 1]!.value !== v) fileSamples.push({ atMs: Date.now() - t0, value: v, observedAtMs: h?.known ? h.observedAtMs - t0 : null });
        await sleep(20);
      }
      const parseHealth = (text: unknown) => {
        const m = /^(\d+(?:\.\d+)?)/.exec(String(text));
        return m ? Number(m[1]) : null;
      };
      const sseSamples = tabA.frames.filter((f) => f.atMs >= t0 && f.atMs - t0 <= 1_500).map((f) => ({ atMs: f.atMs - t0, value: parseHealth(f.vm.world.health.text), text: String(f.vm.world.health.text) }));
      const lower = (v: number | null) => v !== null && v < baseline - 0.5;
      const firstFile = fileSamples.find((x) => lower(x.value));
      const firstSse = sseSamples.find((x) => lower(x.value));
      const diff = firstFile && serverAfter !== undefined ? Math.abs((firstFile.value as number) - serverAfter) : undefined;
      healthPass = Boolean(firstFile && firstFile.atMs <= LATENCY_BOUND_MS && firstSse && firstSse.atMs <= LATENCY_BOUND_MS && diff !== undefined && diff <= REGEN_TOLERANCE_HP);
      healthEvidence.push(
        `file samples (ms after command: value [packet observed at]): ${fileSamples.slice(0, 30).map((x) => `+${x.atMs}: ${x.value === null ? 'unknown' : Math.round(x.value * 100) / 100} [${x.observedAtMs === null ? '-' : `+${x.observedAtMs}`}]`).join(', ')}`,
        `SSE frames: ${sseSamples.slice(0, 30).map((x) => `+${x.atMs}: "${x.text}"`).join(', ') || 'none'}`,
        `first lower-than-baseline: file ${firstFile ? `${Math.round((firstFile.value as number) * 100) / 100} at +${firstFile.atMs} ms` : 'NEVER'}; screen ${firstSse ? `"${firstSse.text}" at +${firstSse.atMs} ms` : 'NEVER'}; |file - server after| = ${diff === undefined ? 'n/a' : Math.round(diff * 100) / 100} (tolerance ${REGEN_TOLERANCE_HP} HP)`,
      );
      const later = await serverNumber('Health');
      healthEvidence.push(`informational: server Health at +${Date.now() - t0} ms = ${later}; dashboard ${JSON.stringify(status()?.vitals.health)}`);
    }
    check('D2-health', `a real drop below the baseline reaches the file and screen within ${LATENCY_BOUND_MS} ms of the command and matches the server within the regeneration tolerance`, healthPass, healthEvidence);

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
    if (difficultyToRestore) {
      try {
        const r = await restoreDifficulty();
        check('D2-difficulty-restored', 'fixture difficulty restored (outer finally)', r.startsWith('restored'), [r]);
      } catch (error) {
        check('D2-difficulty-restored', 'fixture difficulty restored (outer finally)', false, [error instanceof Error ? error.message : String(error)]);
      }
    }
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
  const report = { kind: 'dashboard-live-check', mode: READ_ONLY ? 'read-only' : HUNGER_TRIAL ? 'mutating+hunger-trial' : 'mutating', fixture: PINS.profile, server: `${PINS.host}:${PINS.port}`, at: new Date().toISOString(), pass, results, setupCommands: setupLog };
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
