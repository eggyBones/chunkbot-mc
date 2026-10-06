// Local test fixtures: SEPARATE vanilla Java servers bound to loopback, each
// with its own world, JRE, logs, RCON secret and PID file under the git-ignored
// var/ tree. They never touch the user's Minecraft client, launcher, or worlds.
//
// Profiles (src/app/fixture-layout.ts): the default `26.1.2` fixture
// (127.0.0.1:25566, var/fixture/) and the distinct `26.2` fixture
// (127.0.0.1:25567, var/fixture-26.2/), selected with `--fixture 26.2`.
//
//   npm run fixture -- setup --accept-eula [--fixture 26.2]   download + verify JRE/server, write config
//   npm run fixture -- start  [--fixture 26.2]                start detached; waits until it answers pings
//   npm run fixture -- status [--fixture 26.2]                pid + server ping
//   npm run fixture -- rcon [--fixture 26.2] "<command>"      run a console command (loopback RCON)
//   npm run fixture -- stop   [--fixture 26.2]                graceful stop via RCON, bounded SIGTERM fallback
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import minecraftProtocol from 'minecraft-protocol';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { rconCommand } from './lib/rcon.ts';

const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);

function log(line: string): void {
  process.stdout.write(`[fixture ${FIXTURE_PINS.profile}] ${line}\n`);
}

/** True when anything (not only a Minecraft server) accepts TCP on the loopback port. */
function portInUse(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: FIXTURE_PINS.host, port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function digest(path: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function download(url: string, dest: string, algorithm: 'sha1' | 'sha256', expected: string): Promise<void> {
  if (existsSync(dest) && (await digest(dest, algorithm)) === expected) {
    log(`verified cached ${dest}`);
    return;
  }
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  const actual = await digest(dest, algorithm);
  if (actual !== expected) {
    rmSync(dest, { force: true });
    throw new Error(`checksum mismatch for ${dest}: expected ${algorithm} ${expected}, got ${actual}`);
  }
  log(`verified ${algorithm} ${expected}`);
}

function readProperties(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(fx.properties, 'utf8').split('\n')) {
    const m = /^([^#=][^=]*)=(.*)$/.exec(line.trim());
    if (m?.[1]) map.set(m[1], m[2] ?? '');
  }
  return map;
}

function rconPassword(): string {
  const password = readProperties().get('rcon.password');
  if (!password) throw new Error('fixture server.properties has no rcon.password; run setup');
  return password;
}

function serverProperties(password: string): string {
  return [
    `# Chunkbot local test fixture (profile ${FIXTURE_PINS.profile}). Loopback only; offline auth is for this trusted fixture alone.`,
    `server-ip=${FIXTURE_PINS.host}`,
    `server-port=${FIXTURE_PINS.port}`,
    'online-mode=false',
    'enforce-secure-profile=false',
    `motd=Chunkbot test fixture ${FIXTURE_PINS.minecraftVersion} (loopback only)`,
    'level-name=world',
    'level-type=minecraft\\:flat',
    'generate-structures=false',
    'gamemode=survival',
    'difficulty=peaceful',
    'spawn-protection=0',
    'max-players=8',
    'view-distance=6',
    'simulation-distance=6',
    'allow-nether=true',
    'white-list=false',
    'enable-command-block=false',
    'pause-when-empty-seconds=-1',
    'enable-rcon=true',
    `rcon.port=${FIXTURE_PINS.rconPort}`,
    `rcon.password=${password}`,
    'broadcast-rcon-to-ops=false',
    'broadcast-console-to-ops=false',
    '',
  ].join('\n');
}

function runningPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(fx.pidFile, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    // Guard against PID reuse: the process must be our java running in the fixture server dir.
    const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
    return cmd.includes(fx.serverJar) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function ping(timeoutMs = 3_000): Promise<{ version: string; protocol: number; online: number } | undefined> {
  try {
    const result = (await minecraftProtocol.ping({ host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, closeTimeout: timeoutMs })) as {
      version: { name: string; protocol: number };
      players: { online: number };
    };
    return { version: result.version.name, protocol: result.version.protocol, online: result.players.online };
  } catch {
    return undefined;
  }
}

async function setup(acceptEula: boolean): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('the pinned fixture JRE is macOS/arm64; install a Java 25 runtime manually for other platforms');
  }
  for (const dir of [fx.downloads, fx.jreDir, fx.serverDir]) mkdirSync(dir, { recursive: true });
  const jreArchive = `${fx.downloads}/jre.tar.gz`;
  const jarDownload = `${fx.downloads}/server-${FIXTURE_PINS.minecraftVersion}.jar`;
  if (FIXTURE_PINS.profile !== DEFAULT_FIXTURE_PROFILE && !existsSync(jreArchive)) {
    // Same pinned JRE release: seed from the default fixture's cached archive (read-only copy),
    // re-verified below against the pinned SHA-256 before use. Nothing in var/fixture/ changes.
    const sibling = `${fixturePaths(PROJECT_ROOT, fixturePins(DEFAULT_FIXTURE_PROFILE)).downloads}/jre.tar.gz`;
    if (existsSync(sibling) && (await digest(sibling, 'sha256')) === FIXTURE_PINS.jreSha256) {
      copyFileSync(sibling, jreArchive);
      log(`seeded ${jreArchive} from the verified ${sibling}`);
    }
  }
  await download(FIXTURE_PINS.jreUrl, jreArchive, 'sha256', FIXTURE_PINS.jreSha256);
  await download(FIXTURE_PINS.serverJarUrl, jarDownload, 'sha1', FIXTURE_PINS.serverJarSha1);
  if (!existsSync(fx.java)) {
    const tar = spawnSync('tar', ['xzf', jreArchive, '-C', fx.jreDir], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error(`tar exited ${tar.status}`);
  }
  const version = spawnSync(fx.java, ['-version'], { encoding: 'utf8' });
  log(`java: ${(version.stderr || version.stdout).split('\n')[0] ?? 'unknown'}`);
  copyFileSync(jarDownload, fx.serverJar);
  if (!existsSync(fx.properties)) {
    writeFileSync(fx.properties, serverProperties(randomBytes(18).toString('base64url')), { mode: 0o600 });
    log(`wrote ${fx.properties} (loopback, offline fixture, RCON on ${FIXTURE_PINS.host}:${FIXTURE_PINS.rconPort}; password not shown)`);
  } else {
    log(`kept existing ${fx.properties}`);
  }
  const eula = `${fx.serverDir}/eula.txt`;
  if (acceptEula) {
    writeFileSync(eula, '# Accepted for the Chunkbot local test fixture via `fixture setup --accept-eula`.\n# https://aka.ms/MinecraftEULA\neula=true\n');
    log('EULA accepted for this fixture (https://aka.ms/MinecraftEULA)');
  } else if (!existsSync(eula) || !readFileSync(eula, 'utf8').includes('eula=true')) {
    log('the server will not start until the Minecraft EULA is accepted: re-run with --accept-eula (https://aka.ms/MinecraftEULA)');
  }
  log('setup complete');
}

async function start(): Promise<void> {
  const existing = runningPid();
  if (existing) {
    log(`already running (pid ${existing})`);
    return;
  }
  if (!existsSync(fx.java) || !existsSync(fx.serverJar)) throw new Error('fixture not set up: npm run fixture -- setup --accept-eula');
  if (await ping(1_000)) throw new Error(`something else already answers on ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}`);
  for (const port of [FIXTURE_PINS.port, FIXTURE_PINS.rconPort]) {
    // Never kill or reuse an unrelated listener: refuse to start instead.
    if (await portInUse(port)) throw new Error(`port ${FIXTURE_PINS.host}:${port} is already in use by another process; not starting`);
  }
  const out = openSync(fx.consoleLog, 'a');
  const child = spawn(fx.java, ['-Xms512M', '-Xmx2G', '-jar', fx.serverJar, 'nogui'], {
    cwd: fx.serverDir,
    detached: true,
    stdio: ['ignore', out, out],
  });
  if (!child.pid) throw new Error('failed to start the fixture server');
  writeFileSync(fx.pidFile, `${child.pid}\n`);
  child.unref();
  log(`started java pid ${child.pid}; waiting for the server to answer pings (first start generates the world)…`);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !runningPid()) throw new Error(`server exited early; see ${fx.consoleLog}`);
    const result = await ping();
    if (result) {
      if (result.protocol !== FIXTURE_PINS.protocolVersion) {
        log(`warning: server reports protocol ${result.protocol}; profile pins ${FIXTURE_PINS.protocolVersion}`);
      }
      log(`ready: ${result.version} (protocol ${result.protocol}) on ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}, pid ${child.pid}`);
      return;
    }
    await sleep(2_000);
  }
  throw new Error('server did not become ready within 240s');
}

async function stop(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    log('not running');
    rmSync(fx.pidFile, { force: true });
    return;
  }
  try {
    await rconCommand(FIXTURE_PINS.host, FIXTURE_PINS.rconPort, rconPassword(), 'stop');
    log(`sent stop via RCON to pid ${pid}`);
  } catch (error) {
    log(`RCON stop failed (${error instanceof Error ? error.message : String(error)}); sending SIGTERM to pid ${pid}`);
    process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!runningPid()) {
      rmSync(fx.pidFile, { force: true });
      log(`stopped (pid ${pid})`);
      return;
    }
    await sleep(500);
  }
  log(`pid ${pid} still running after 60s; sending SIGTERM`);
  process.kill(pid, 'SIGTERM');
}

async function status(): Promise<void> {
  const pid = runningPid();
  const result = await ping();
  log(pid ? `process: running (pid ${pid})` : 'process: not running');
  log(result ? `server: ${result.version} (protocol ${result.protocol}), ${result.online} online` : 'server: not answering');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--fixture');
  if (at >= 0) args.splice(at, 2);
  const [command, ...rest] = args;
  switch (command) {
    case 'setup':
      return setup(rest.includes('--accept-eula'));
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'status':
      return status();
    case 'rcon': {
      const reply = await rconCommand(FIXTURE_PINS.host, FIXTURE_PINS.rconPort, rconPassword(), rest.join(' '));
      log(`rcon> ${reply || '(no output)'}`);
      return;
    }
    default:
      process.stderr.write('usage: npm run fixture -- <setup [--accept-eula]|start|stop|status|rcon "<command>"> [--fixture 26.1.2|26.2]\n');
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[fixture ${FIXTURE_PINS.profile}] error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
