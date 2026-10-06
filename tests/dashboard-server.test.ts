// MB-UI-001 viewer service over real loopback HTTP: binding, occupied port,
// DNS-rebinding/origin/method refusal, bounded SSE clients, shared status
// reads (tabs do not multiply work), live update latency, malformed status,
// secret hygiene and shutdown that touches nothing but the viewer.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DashboardStatusPublisher } from '../src/dashboard/publisher.ts';
import { CoalescedSource, openRouterKeyFetcher } from '../src/dashboard/remote.ts';
import { DashboardStartError, DashboardViewer } from '../src/dashboard/server.ts';
import type { EngineStatus } from '../src/goals/goal-engine.ts';
import { FakeConnection, stack, window0 } from './dashboard-fakes.ts';

let dir: string;
let viewers: DashboardViewer[] = [];
const statusPath = () => join(dir, 'status.json');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dash-srv-'));
  viewers = [];
});
afterEach(async () => {
  for (const v of viewers) await v.close();
  rmSync(dir, { recursive: true, force: true });
});

async function viewer(extra: Partial<ConstructorParameters<typeof DashboardViewer>[0]> = {}) {
  const v = new DashboardViewer({ host: '127.0.0.1', port: 0, statusPath: statusPath(), historyPath: join(dir, 'usage-history.json'), pidAlive: () => true, timeZone: 'UTC', pollMs: 20, ...extra });
  viewers.push(v);
  const { port, url } = await v.start();
  return { v, port, url };
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens an SSE stream; collects `state` events. */
function sse(port: number) {
  const events: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let status = 0;
  let buf = '';
  const req = request({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' } }, (res) => {
    status = res.statusCode ?? 0;
    res.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i = buf.indexOf('\n\n');
      while (i >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (frame.includes('event: state') && data) events.push(JSON.parse(data.slice(6)));
        i = buf.indexOf('\n\n');
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return { events, status: () => status, close: () => req.destroy() };
}

const until = async (f: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function livePublisher(engine?: EngineStatus) {
  const clock = { t: Date.now() };
  const game = new FakeConnection(clock);
  const pub = new DashboardStatusPublisher({ statusPath: statusPath(), runId: 'run-srv00001', pid: process.pid, now: () => Date.now(), game, profile: { version: '26.1.2', supportLevel: 'upstream-tested' }, ...(engine ? { engine: () => engine } : {}) });
  pub.start();
  game.join();
  game.ready();
  return { pub, game, clock };
}

describe('dashboard viewer service', () => {
  it('binds loopback only and refuses other hosts', async () => {
    await assert.rejects(new DashboardViewer({ host: '0.0.0.0', port: 0, statusPath: statusPath(), historyPath: 'x', pidAlive: () => true, timeZone: 'UTC' }).start(), (e: unknown) => e instanceof DashboardStartError && e.code === 'not_loopback');
    const { url } = await viewer();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('gives a usable error when the port is occupied', async () => {
    const { port } = await viewer();
    await assert.rejects(viewer({ port }), (e: unknown) => e instanceof DashboardStartError && e.code === 'port_in_use' && /--port/.test(e.message));
  });

  it('serves the page with a strict CSP and refuses rebinding hosts, foreign origins and writes', async () => {
    const { port } = await viewer();
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'.*script-src 'self'/);
    assert.match(page.body, /<script src="\/app.js"/);
    assert.equal((await get(port, '/app.js')).status, 200);
    assert.equal((await get(port, '/', { host: 'evil.example:80' })).status, 421);
    assert.equal((await get(port, '/api/state', { origin: 'http://evil.example' })).status, 403);
    const post = await get(port, '/api/state', {}, 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers['allow'], 'GET, HEAD');
    assert.equal((await get(port, '/../var/runs')).status, 404);
  });

  it('with no Chunkbot session shows the empty state, not invented values', async () => {
    const { port } = await viewer();
    const vm = JSON.parse((await get(port, '/api/state')).body);
    assert.equal(vm.banner.state, 'no_session');
    assert.equal(vm.world.health.text, 'unknown');
  });

  it('streams live changes within a second to every tab, with one shared status read per tick', async () => {
    const { pub, game } = livePublisher();
    const { v, port } = await viewer();
    const a = sse(port);
    const b = sse(port);
    await until(() => a.events.length > 0 && b.events.length > 0);
    const readsBefore = v.statusReads;
    const started = Date.now();
    game.health(6, 20);
    game.windowItems(0, window0({ 36: stack(5, 3) }));
    pub.publish();
    await until(() => a.events.some((e) => e.world.health.text.startsWith('6')) && b.events.some((e) => e.world.inventory.hotbar[0].count === 3));
    const latency = Date.now() - started;
    assert.ok(latency < 1_000, `update reached the tabs in ${latency} ms`);
    await new Promise((r) => setTimeout(r, 200));
    const ticks = v.statusReads - readsBefore;
    assert.ok(ticks <= Math.ceil((Date.now() - started) / 20) + 3, `status reads (${ticks}) follow the poll interval, not the tab count`);
    a.close();
    b.close();
    pub.stop('test');
  });

  it('bounds the number of streams', async () => {
    const { v, port } = await viewer({ maxClients: 2 });
    const a = sse(port);
    const b = sse(port);
    await until(() => v.clientCount === 2);
    const c = sse(port);
    await until(() => c.status() !== 0);
    assert.equal(c.status(), 503);
    a.close();
    await until(() => v.clientCount === 1);
    b.close();
  });

  it('reports a malformed status file without crashing and recovers on the next valid write', async () => {
    writeFileSync(statusPath(), '{"schema":"chunkbot.dashboard.status","version":1,"publisher":');
    const { port } = await viewer();
    let vm = JSON.parse((await get(port, '/api/state')).body);
    assert.equal(vm.banner.state, 'error');
    const { pub } = livePublisher();
    await new Promise((r) => setTimeout(r, 60));
    vm = JSON.parse((await get(port, '/api/state')).body);
    assert.equal(vm.banner.state, 'live');
    pub.stop('test');
  });

  it('never serves secrets: redacted text and normalized key metadata only', async () => {
    const SECRET = 'sk-or-v1-verysecretkeymaterial0123456789';
    const engine = { goal: { id: 'goal-abcd', epoch: 1, instruction: `please use ${SECRET}`, origin: { surface: 'chat', principal: 'owner' }, state: 'planning', admittedAtMs: 1, updatedAtMs: 1, plannerTurns: 0, progress: '' }, readiness: { planner: { ready: true, detail: 'ok' }, knowledge: { ready: true, detail: 'ok' }, observation: { ready: true, detail: 'ok' }, executor: { ready: true, detail: 'ok' }, capabilityCount: 1, catalogVersion: 'x', tasks: { ready: true, detail: 'ok' } } } as unknown as EngineStatus;
    const { pub } = livePublisher(engine);
    const key = new CoalescedSource({
      name: 'k',
      now: () => Date.now(),
      fetch: openRouterKeyFetcher({ apiKeyEnv: 'OPENROUTER_API_KEY', env: () => ({ OPENROUTER_API_KEY: SECRET }), now: () => Date.now(), fetch: (async () => new Response(JSON.stringify({ data: { label: 'sk-or-v1-ab…xyz', usage: 0.5, usage_daily: 0.01, limit: null, is_free_tier: false } }), { status: 200 })) as unknown as typeof fetch }),
    });
    const { port } = await viewer({ remote: { openRouterKey: key } });
    const s = sse(port);
    await until(() => s.events.some((e) => e.remote.openRouterKey.length > 0));
    const body = (await get(port, '/api/state')).body;
    assert.doesNotMatch(body, /verysecretkeymaterial/);
    assert.doesNotMatch(body, /sk-or-v1-ab/, 'key label is never served');
    assert.match(body, /no key cap reported/);
    s.close();
    pub.stop('test');
  });

  it('closing the viewer ends only its streams; the published status is untouched', async () => {
    const { pub } = livePublisher();
    const { v, port } = await viewer();
    const s = sse(port);
    await until(() => s.events.length > 0);
    const before = statSync(statusPath()).mtimeMs;
    pub.stop('keep');
    const after = statSync(statusPath()).mtimeMs;
    await v.close();
    viewers = [];
    assert.equal(statSync(statusPath()).mtimeMs, after, 'the viewer never writes the status');
    assert.ok(after >= before);
    await assert.rejects(get(port, '/'));
  });
});
