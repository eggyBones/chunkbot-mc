// Live foundation checks against the running LOCAL TEST FIXTURE only.
// Drives the real built CLI (`node dist/cli.js`) as a child process, with:
//   - the terminal control surface over the child's stdin,
//   - separate offline fixture players (FixtureOwner / FixtureGuest) for chat,
//   - loopback RCON for server-originated spoofs and lifecycle events.
// No model inference is performed. Writes a report under var/live-check/.
//
//   npm run build && npm run fixture -- start && npm run live-check
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';

// Fixture profile: default 26.1.2 (unchanged); `--fixture 26.2` selects the distinct 26.2 fixture (MB-SERVER-001).
const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const FIXTURE_SUFFIX = FIXTURE_PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${FIXTURE_PINS.profile}`;
/** Regex-escaped fixture version for expected output lines. */
const FIXTURE_VERSION_RE = FIXTURE_PINS.minecraftVersion.replace(/\./g, '\\.');
import { rconCommand } from './lib/rcon.ts';

type Bot = ReturnType<typeof mineflayer.createBot>;

const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${FIXTURE_SUFFIX}`);
mkdirSync(outDir, { recursive: true });
// Foundation checks run the INFERENCE-FREE profile (planner disabled by explicit configuration);
// doctor still validates the normal fixture configuration with the real planner route.
const FIXTURE_CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.inferenceFreeConfig);
const DOCTOR_CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.config);
const CLI = join(PROJECT_ROOT, 'dist', 'cli.js');

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
}
const results: Result[] = [];

function rconPassword(): string {
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}
const rcon = (command: string) => rconCommand(FIXTURE_PINS.host, FIXTURE_PINS.rconPort, rconPassword(), command);

class CliProcess {
  readonly lines: string[] = [];
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly name: string;
  private cursor = 0;

  constructor(name: string, args: string[]) {
    this.name = name;
    this.child = spawn(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const collect = (stream: NodeJS.ReadableStream | null, prefix: string) => {
      let partial = '';
      stream?.on('data', (chunk: Buffer) => {
        partial += chunk.toString('utf8');
        const parts = partial.split('\n');
        partial = parts.pop() ?? '';
        for (const line of parts) this.lines.push(`${prefix}${line}`);
      });
    };
    collect(this.child.stdout, '');
    collect(this.child.stderr, 'stderr: ');
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal })));
  }

  /** Waits for a line matching `pattern` after the current cursor; advances the cursor past it. */
  async waitFor(pattern: RegExp, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = this.cursor; i < this.lines.length; i += 1) {
        const line = this.lines[i] ?? '';
        if (pattern.test(line)) {
          this.cursor = i + 1;
          return line;
        }
      }
      await sleep(25);
    }
    throw new Error(`${this.name}: timed out waiting for ${pattern}; last lines:\n${this.lines.slice(-8).join('\n')}`);
  }

  /** Asserts no line matching `pattern` appears within `ms`. */
  async expectNone(pattern: RegExp, ms = 1_500): Promise<void> {
    const start = this.lines.length;
    await sleep(ms);
    const hit = this.lines.slice(start).find((l) => pattern.test(l));
    if (hit) throw new Error(`${this.name}: unexpected line: ${hit}`);
  }

  send(line: string): void {
    this.child.stdin?.write(`${line}\n`);
  }

  mark(): void {
    this.cursor = this.lines.length;
  }

  save(): void {
    writeFileSync(join(outDir, `${this.name}.log`), `${this.lines.join('\n')}\n`);
  }
}

async function check(id: string, title: string, fn: (evidence: string[]) => Promise<void>): Promise<void> {
  const evidence: string[] = [];
  try {
    await fn(evidence);
    results.push({ id, title, pass: true, evidence });
    process.stdout.write(`PASS ${id} ${title}\n`);
  } catch (error) {
    evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    results.push({ id, title, pass: false, evidence });
    process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)}\n`);
  }
}

async function fixtureBot(username: string): Promise<{ bot: Bot; messages: string[] }> {
  const bot = mineflayer.createBot({
    host: FIXTURE_PINS.host,
    port: FIXTURE_PINS.port,
    username,
    auth: 'offline',
    version: FIXTURE_PINS.minecraftVersion,
    hideErrors: true,
  });
  const messages: string[] = [];
  bot.on('messagestr', (text: string) => {
    messages.push(text);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${username} did not spawn`)), 20_000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once('end', (reason: string) => reject(new Error(`${username} ended: ${reason}`)));
  });
  return { bot, messages };
}

async function waitMessage(messages: string[], pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = messages.find((m) => pattern.test(m));
    if (hit) return hit;
    await sleep(25);
  }
  throw new Error(`no in-game message matching ${pattern}; got:\n${messages.slice(-6).join('\n')}`);
}

function writeTempConfig(name: string, mutate: (cfg: Record<string, Record<string, unknown>>) => void): string {
  const cfg = JSON.parse(readFileSync(FIXTURE_CONFIG, 'utf8')) as Record<string, Record<string, unknown>>;
  mutate(cfg);
  const dir = join(PROJECT_ROOT, 'var', 'live-check', stamp, 'config');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

async function runOnce(name: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; lines: string[] }> {
  const proc = new CliProcess(name, args);
  proc.child.stdin?.end();
  const timer = setTimeout(() => proc.child.kill('SIGKILL'), timeoutMs);
  const { code } = await proc.exited;
  clearTimeout(timer);
  await sleep(50);
  proc.save();
  return { code, lines: proc.lines };
}

function serverLogLines(pattern: RegExp): string[] {
  try {
    return readFileSync(fx.latestLog, 'utf8').split('\n').filter((l) => pattern.test(l));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  process.stdout.write(`live-check: fixture ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}; report dir ${outDir}\n`);
  const reply = await rcon('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); run npm run fixture -- start`);
  });
  process.stdout.write(`fixture: ${reply}\n`);

  // ---------------------------------------------------------------- L1 doctor
  await check('L1', 'doctor is read-only and passes for the fixture config; invalid config fails', async (ev) => {
    const loginsBefore = serverLogLines(/logged in with entity id/).length;
    const ok = await runOnce('doctor-fixture', ['doctor', '--config', DOCTOR_CONFIG]);
    ev.push(`doctor (fixture) exit=${ok.code}`, ...ok.lines.filter((l) => /^(FAIL|WARN|PASS) +(node|config|auth|fixture|planner)/.test(l)).slice(0, 8));
    if (ok.code !== 0) throw new Error('doctor failed for fixture config');
    const ms = await runOnce('doctor-microsoft', ['doctor', '--config', 'config/examples/microsoft.json']);
    ev.push(`doctor (microsoft example) exit=${ms.code}`, ...ms.lines.filter((l) => /\bauth\b/.test(l)));
    const bad = writeTempConfig('doctor-invalid', (c) => {
      (c['bot'] as Record<string, unknown>)['trustedOfflineFixture'] = false;
    });
    const invalid = await runOnce('doctor-invalid', ['doctor', '--config', bad]);
    ev.push(`doctor (invalid) exit=${invalid.code}`, ...invalid.lines.filter((l) => /^FAIL/.test(l)));
    if (invalid.code !== 1) throw new Error('doctor did not fail for invalid config');
    const loginsAfter = serverLogLines(/logged in with entity id/).length;
    ev.push(`server logins during doctor runs: ${loginsAfter - loginsBefore}`);
    if (loginsAfter !== loginsBefore) throw new Error('doctor caused a server login');
  });

  // ---------------------------------------------------------------- L2 config/auth failures before connecting
  await check('L2', 'invalid config and missing Microsoft sign-in fail before joining, with no auth downgrade', async (ev) => {
    const loginsBefore = serverLogLines(/logged in with entity id/).length;
    const remote = writeTempConfig('offline-remote', (c) => {
      (c['minecraft'] as Record<string, unknown>)['host'] = '192.0.2.10';
    });
    const r1 = await runOnce('config-offline-remote', ['connect-check', '--config', remote]);
    ev.push(`offline + non-loopback host: exit=${r1.code}`, ...r1.lines.filter((l) => /minecraft\.host|No connection/.test(l)));
    if (r1.code !== 1) throw new Error('expected exit 1');
    const msConfig = writeTempConfig('microsoft-no-cache', (c) => {
      c['bot'] = { auth: 'microsoft', username: `live-check-${stamp.slice(0, 10)}` };
      c['owner'] = { uuid: '6f1a3c2e-0d4b-4e1f-9a7b-1c2d3e4f5a6b' };
      c['storage'] = { dataDir: join(outDir, 'ms-data') };
    });
    const r2 = await runOnce('microsoft-no-cache', ['connect-check', '--config', msConfig]);
    ev.push(`microsoft without token cache: exit=${r2.code}`, ...r2.lines.filter((l) => /auth_required|sign-in/.test(l)).slice(0, 3));
    if (r2.code !== 4) throw new Error('expected exit 4 (auth required)');
    const loginsAfter = serverLogLines(/logged in with entity id/).length;
    ev.push(`server logins during these runs: ${loginsAfter - loginsBefore}`);
    if (loginsAfter !== loginsBefore) throw new Error('a failed config/auth run joined the server');
  });

  // ---------------------------------------------------------------- L3 connect-check
  await check('L3', 'connect-check joins as a separate bot, reports version/dimension, exits 0', async (ev) => {
    const r = await runOnce('connect-check', ['connect-check', '--config', FIXTURE_CONFIG]);
    ev.push(`exit=${r.code}`, ...r.lines.filter((l) => /connect-check|server reports|shutdown complete/.test(l)));
    if (r.code !== 0 || !r.lines.some((l) => new RegExp(`\\[connect-check\\] OK version=${FIXTURE_VERSION_RE} protocol=${FIXTURE_PINS.protocolVersion} dimension=overworld`).test(l))) {
      throw new Error('connect-check did not report OK');
    }
    // Codec health (MB-SERVER-001): every packet of the join/spawn/chunk burst decoded with no
    // unread trailing bytes and no dropped (failed) packets.
    const codec = r.lines.map((l) => /codec=decoded:(\d+),trailing:(\d+),failed:(\d+)/.exec(l)).find(Boolean);
    if (!codec || Number(codec[1]) < 50 || codec[2] !== '0' || codec[3] !== '0') throw new Error(`codec health not clean: ${codec?.[0] ?? 'missing'}`);
    ev.push(...r.lines.filter((l) => /codec=/.test(l) && !/connect-check\] OK/.test(l)));
    ev.push(...serverLogLines(/Chunkbot (joined|left) the game/).slice(-2));
  });

  // ---------------------------------------------------------------- main run session
  const chunkbot = new CliProcess('run-main', ['run', '--no-autonomy', '--config', FIXTURE_CONFIG]);
  let owner: { bot: Bot; messages: string[] } | undefined;
  let guest: { bot: Bot; messages: string[] } | undefined;
  try {
    await check('L4', 'run joins the fixture and starts idle', async (ev) => {
      ev.push(await chunkbot.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      owner = await fixtureBot('FixtureOwner');
      guest = await fixtureBot('FixtureGuest');
      ev.push('fixture players FixtureOwner and FixtureGuest joined');
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(new RegExp(`\\[status\\] connection: ready version=${FIXTURE_VERSION_RE}`)));
      ev.push(await chunkbot.waitFor(/\[status\] goal: idle/));
    });

    await check('L5', 'owner chat: arbitrary instructions and the goal alias reach the same intake; planner-not-ready shown', async (ev) => {
      if (!owner) throw new Error('no owner bot');
      const instructions: Array<[string, string]> = [
        ['!chunkbot collect stone', 'collect stone'],
        ['!chunkbot goal get resources and make yourself armor', 'get resources and make yourself armor'],
        ['!chunkbot follow me', 'follow me'],
        ['!chunkbot gather three kinds of flowers, put them in a chest by the door, then wait on the roof', 'gather three kinds of flowers'],
      ];
      for (const [chat, expected] of instructions) {
        chunkbot.mark();
        owner.bot.chat(chat);
        ev.push(await chunkbot.waitFor(new RegExp(`accepted: "${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
        ev.push(await chunkbot.waitFor(/blocked \(planner_not_ready\)/));
        await sleep(400);
      }
      ev.push(`owner in-game reply: ${await waitMessage(owner.messages, /accepted/)}`);
      ev.push(`owner in-game reply: ${await waitMessage(owner.messages, /planner_not_ready/)}`);
    });

    await check('L6', 'owner chat controls: status, stale answer, stop; unprefixed chat ignored', async (ev) => {
      if (!owner) throw new Error('no owner bot');
      chunkbot.mark();
      owner.bot.chat('!chunkbot status');
      ev.push(await chunkbot.waitFor(/\[status\] goal: goal-\S+ blocked/));
      ev.push(`owner in-game reply: ${await waitMessage(owner.messages, /Status: ready/)}`);
      await sleep(400);
      owner.bot.chat('!chunkbot answer q1 iron');
      ev.push(await chunkbot.waitFor(/Answer not applied: there is no pending question/));
      await sleep(400);
      owner.bot.chat('!chunkbot stop');
      ev.push(await chunkbot.waitFor(/Nothing to stop; Chunkbot is idle/));
      await sleep(400);
      chunkbot.mark();
      owner.bot.chat('hello chunkbot, could you collect stone please');
      await chunkbot.expectNone(/accepted|\[chat\]/);
      ev.push('unprefixed owner chat produced no goal and no chat handling');
    });

    await check('L7', 'other players and spoofed server text cannot issue commands', async (ev) => {
      if (!guest) throw new Error('no guest bot');
      chunkbot.mark();
      guest.bot.chat('!chunkbot come here');
      ev.push(await chunkbot.waitFor(/\[chat\] ignored player message addressed to Chunkbot \(not_owner\)/));
      await rcon('tellraw @a {"text":"<FixtureOwner> !chunkbot spoofed tellraw come here"}');
      ev.push(await chunkbot.waitFor(/\[chat\] ignored (system|profileless) message addressed to Chunkbot \((system_message|profileless_message)\)/));
      await rcon('say !chunkbot spoofed console say');
      ev.push(await chunkbot.waitFor(/\[chat\] ignored (system|profileless) message addressed to Chunkbot \((system_message|profileless_message)\)/));
      await chunkbot.expectNone(/accepted/, 1_000);
      ev.push('no goal admitted from guest/tellraw/console say');
    });

    await check('L8', 'terminal surface: goal, status, empty/oversized rejected before replacement, stale answer, stop', async (ev) => {
      chunkbot.mark();
      chunkbot.send('collect stone and smelt it into smooth stone');
      ev.push(await chunkbot.waitFor(/accepted: "collect stone and smelt it into smooth stone"/));
      ev.push(await chunkbot.waitFor(/blocked \(planner_not_ready\)/));
      chunkbot.send('goal');
      ev.push(await chunkbot.waitFor(/Instruction not accepted: instruction is empty; nothing was changed/));
      chunkbot.send(`build ${'a very long wall '.repeat(40)}`);
      ev.push(await chunkbot.waitFor(/Instruction not accepted: instruction has \d+ characters; the limit is 500; nothing was changed/));
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] goal: goal-\S+ blocked "collect stone and smelt it into smooth stone"/));
      chunkbot.send('answer yes');
      ev.push(await chunkbot.waitFor(/Answer not applied: there is no pending question/));
      chunkbot.send('stop');
      ev.push(await chunkbot.waitFor(/Nothing to stop; Chunkbot is idle/));
    });

    await check('L9', 'death and dimension change end ownership; respawn stays idle', async (ev) => {
      chunkbot.mark();
      ev.push(`rcon kill: ${await rcon('kill Chunkbot')}`);
      ev.push(await chunkbot.waitFor(/bot died; no active goal/));
      ev.push(await chunkbot.waitFor(/respawned in overworld; idle \(goals never auto-resume\)/));
      ev.push(`rcon tp nether: ${await rcon('execute in minecraft:the_nether run tp Chunkbot 0 128 0')}`);
      ev.push(await chunkbot.waitFor(/dimension changed overworld -> the_nether; no active goal/));
      ev.push(`rcon tp overworld: ${await rcon('execute in minecraft:overworld run tp Chunkbot 0 -60 0')}`);
      ev.push(await chunkbot.waitFor(/dimension changed the_nether -> overworld/));
    });

    await check('L10', 'kick ends the connection; /reconnect rejoins idle without resuming', async (ev) => {
      chunkbot.mark();
      ev.push(`rcon kick: ${await rcon('kick Chunkbot Live check kick')}`);
      ev.push(await chunkbot.waitFor(/connection ended \(kicked\): .*Live check kick/));
      ev.push(await chunkbot.waitFor(/Use \/reconnect to join again/));
      chunkbot.send('collect stone');
      ev.push(await chunkbot.waitFor(/Instruction not accepted: not connected to the game/));
      chunkbot.send('/reconnect');
      ev.push(await chunkbot.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] connection: ready/));
      ev.push(await chunkbot.waitFor(/\[status\] goal: goal-\S+ blocked/));
      ev.push('previous goal remains terminal; nothing resumed');
    });

    await check('L11', 'SIGINT shuts down cleanly: goal/connection/evidence closed, bot leaves, exit 0', async (ev) => {
      chunkbot.mark();
      chunkbot.child.kill('SIGINT');
      ev.push(await chunkbot.waitFor(/received SIGINT/));
      ev.push(await chunkbot.waitFor(/shutdown complete/));
      const { code, signal } = await chunkbot.exited;
      ev.push(`exit code=${code} signal=${signal}`);
      if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
      await sleep(500);
      ev.push(serverLogLines(/Chunkbot left the game/).at(-1) ?? 'no leave line');
    });
  } finally {
    if (chunkbot.child.exitCode === null) chunkbot.child.kill('SIGKILL');
    chunkbot.save();
  }

  // ---------------------------------------------------------------- restart
  await check('L12', 'restart starts fresh and idle; /quit exits 0', async (ev) => {
    const again = new CliProcess('run-restart', ['run', '--no-autonomy', '--config', FIXTURE_CONFIG]);
    try {
      ev.push(await again.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      again.send('status');
      ev.push(await again.waitFor(/\[status\] goal: idle \(no goal yet\)/));
      again.send('/quit');
      ev.push(await again.waitFor(/shutdown complete/));
      const { code } = await again.exited;
      ev.push(`exit code=${code}`);
      if (code !== 0) throw new Error('expected exit 0');
    } finally {
      if (again.child.exitCode === null) again.child.kill('SIGKILL');
      again.save();
    }
  });

  await check('L16', 'run --no-terminal shuts down cleanly with exit 3 when kicked', async (ev) => {
    const proc = new CliProcess('run-no-terminal', ['run', '--no-terminal', '--no-autonomy', '--config', FIXTURE_CONFIG]);
    try {
      ev.push(await proc.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      ev.push(`rcon kick: ${await rcon('kick Chunkbot No terminal check')}`);
      ev.push(await proc.waitFor(/connection ended \(kicked\): .*No terminal check/));
      ev.push(await proc.waitFor(/no operator terminal, shutting down/));
      ev.push(await proc.waitFor(/shutdown complete/));
      const { code } = await proc.exited;
      ev.push(`exit code=${code}`);
      if (code !== 3) throw new Error('expected exit 3');
    } finally {
      if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
      proc.save();
    }
  });

  // ---------------------------------------------------------------- joining cancellation
  const blackholeSockets = new Set<Socket>();
  let blackholeClosed = 0;
  const blackhole = createServer((socket) => {
    blackholeSockets.add(socket);
    socket.resume();
    socket.on('close', () => {
      blackholeClosed += 1;
      blackholeSockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
  const address = blackhole.address();
  const blackholePort = typeof address === 'object' && address ? address.port : 0;
  const stalled = writeTempConfig('stalled-join', (c) => {
    (c['minecraft'] as Record<string, unknown>)['port'] = blackholePort;
  });
  try {
    await check('L13', 'terminal stop during joining (stalled loopback server) cancels the join and releases the socket', async (ev) => {
      const proc = new CliProcess('join-cancel-stop', ['run', '--no-autonomy', '--config', stalled]);
      try {
        ev.push(await proc.waitFor(/\[chunkbot\] joining 127\.0\.0\.1:\d+/));
        await sleep(500);
        ev.push(`stalled server open sockets before stop: ${blackholeSockets.size}`);
        proc.send('stop');
        ev.push(await proc.waitFor(/stop: cancelling join/));
        ev.push(await proc.waitFor(/connection ended \(operator_stop\): join cancelled by operator/));
        await sleep(300);
        ev.push(`stalled server open sockets after stop: ${blackholeSockets.size} (closed so far: ${blackholeClosed})`);
        if (blackholeSockets.size !== 0) throw new Error('join socket still open after cancellation');
        proc.send('status');
        ev.push(await proc.waitFor(/\[status\] connection: ended/));
        proc.send('/quit');
        const { code } = await proc.exited;
        ev.push(`exit code=${code}`);
        if (code !== 0) throw new Error('expected exit 0');
      } finally {
        if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
        proc.save();
      }
    });

    await check('L14', 'SIGTERM during joining exits cleanly', async (ev) => {
      const proc = new CliProcess('join-cancel-sigterm', ['run', '--no-autonomy', '--config', stalled]);
      try {
        ev.push(await proc.waitFor(/\[chunkbot\] joining 127\.0\.0\.1:\d+/));
        await sleep(300);
        proc.child.kill('SIGTERM');
        ev.push(await proc.waitFor(/received SIGTERM/));
        ev.push(await proc.waitFor(/shutdown complete/));
        const { code } = await proc.exited;
        ev.push(`exit code=${code}`);
        if (code !== 0) throw new Error('expected exit 0');
        await sleep(200);
        if (blackholeSockets.size !== 0) throw new Error('join socket still open after SIGTERM');
        ev.push('stalled server sockets all closed');
      } finally {
        if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
        proc.save();
      }
    });
  } finally {
    blackhole.close();
  }

  await check('L15', 'stop issued immediately on the real fixture during joining', async (ev) => {
    const proc = new CliProcess('join-cancel-real', ['run', '--no-autonomy', '--config', FIXTURE_CONFIG]);
    try {
      ev.push(await proc.waitFor(/\[chunkbot\] joining/));
      proc.send('stop');
      const outcome = await proc.waitFor(/connection ended \(operator_stop\)|Nothing to stop/, 15_000);
      ev.push(outcome);
      ev.push(/operator_stop/.test(outcome) ? 'join cancelled before ready' : 'join completed before stop arrived; stop reported idle (race outcome recorded honestly)');
      proc.send('/quit');
      const { code } = await proc.exited;
      ev.push(`exit code=${code}`);
      if (code !== 0) throw new Error('expected exit 0');
    } finally {
      if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
      proc.save();
    }
  });

  owner?.bot.quit();
  guest?.bot.quit();
  await sleep(500);

  const summary = { stamp, fixture: `${FIXTURE_PINS.host}:${FIXTURE_PINS.port}`, passed: results.filter((r) => r.pass).length, total: results.length, results };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`live-check: ${summary.passed}/${summary.total} passed; report ${join(outDir, 'report.json')}\n`);
  process.exitCode = summary.passed === summary.total ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`live-check error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
