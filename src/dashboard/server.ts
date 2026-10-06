// Loopback-only, read-only dashboard viewer service (Node http + SSE, no
// framework). It follows the status snapshot and usage history files written
// by the Chunkbot application, derives the view model, and streams it to a
// bounded number of browser clients. It cannot issue game actions, start a
// model, resync containers or stop Chunkbot: it has no route that writes, and
// the only things it ever starts are the optional coalesced metadata reads.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { APP_CSS, APP_JS, INDEX_HTML } from './assets/page.ts';
import { readHistory } from './history.ts';
import { refreshAll, remoteMetadata, type RemoteSources } from './remote.ts';
import { StatusFollower, buildViewModel, readStatusFile, type ViewModel } from './viewmodel.ts';

export const DEFAULT_DASHBOARD_PORT = 7381;
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

export class DashboardStartError extends Error {
  readonly code: 'port_in_use' | 'not_loopback' | 'listen_failed';
  constructor(code: DashboardStartError['code'], message: string) {
    super(message);
    this.name = 'DashboardStartError';
    this.code = code;
  }
}

export interface ViewerOptions {
  host?: string;
  port?: number;
  statusPath: string;
  historyPath: string;
  now?: () => number;
  pidAlive: (pid: number) => boolean;
  remote?: RemoteSources;
  timeZone: string;
  /** Status file poll interval (default 250 ms: 2 Hz publishing reaches the screen well within 1 s). */
  pollMs?: number;
  historyPollMs?: number;
  maxClients?: number;
  keepAliveMs?: number;
  log?: (line: string) => void;
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const ASSETS: Record<string, { type: string; body: string }> = {
  '/': { type: 'text/html; charset=utf-8', body: INDEX_HTML },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: APP_JS },
  '/app.css': { type: 'text/css; charset=utf-8', body: APP_CSS },
};

export class DashboardViewer {
  private readonly o: ViewerOptions;
  private server: Server | undefined;
  private readonly clients = new Set<ServerResponse>();
  private readonly sockets = new Set<Socket>();
  private readonly follower = new StatusFollower();
  private history: ReturnType<typeof readHistory> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private historyTimer: NodeJS.Timeout | undefined;
  private keepAlive: NodeJS.Timeout | undefined;
  private lastBody = '';
  private lastSignature = '';
  private allowedHosts = new Set<string>();
  /** Requests refused for host/method/limit reasons (evidence). */
  refused = 0;
  /** Status file reads performed (evidence that tabs do not multiply reads). */
  statusReads = 0;
  boundPort = 0;

  constructor(options: ViewerOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<{ url: string; port: number }> {
    const host = this.o.host ?? '127.0.0.1';
    if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) throw new DashboardStartError('not_loopback', `refusing to bind ${host}: the dashboard binds loopback only (127.0.0.1, ::1 or localhost)`);
    const port = this.o.port ?? DEFAULT_DASHBOARD_PORT;
    const server = createServer((req, res) => this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxHeadersCount = 50;
    server.maxConnections = (this.o.maxClients ?? 8) + 16;
    server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE') reject(new DashboardStartError('port_in_use', `port ${port} on ${host} is already in use (another dashboard or program). Choose a free one with --port <number>.`));
        else reject(new DashboardStartError('listen_failed', `cannot listen on ${host}:${port} (${error.code ?? 'error'})`));
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host, port, exclusive: true });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) this.allowedHosts.add(`${h}:${this.boundPort}`);
    this.refresh();
    this.readHistory();
    this.timer = setInterval(() => this.tick(), this.o.pollMs ?? 250);
    this.historyTimer = setInterval(() => this.readHistory(), this.o.historyPollMs ?? 2_000);
    this.keepAlive = setInterval(() => {
      for (const c of this.clients) c.write(': keep-alive\n\n');
    }, this.o.keepAliveMs ?? 15_000);
    const shown = host === '::1' ? `[::1]` : host;
    return { url: `http://${shown}:${this.boundPort}/`, port: this.boundPort };
  }

  private readHistory(): void {
    const h = readHistory(this.o.historyPath);
    this.history = h;
  }

  /** Reads the status file once (shared by every tab). */
  private refresh(): void {
    this.statusReads += 1;
    this.follower.accept(readStatusFile(this.o.statusPath));
  }

  viewModel(): ViewModel {
    const h = this.history;
    return buildViewModel({
      follower: this.follower,
      now: this.now(),
      pidAlive: this.o.pidAlive,
      history: !h ? undefined : h.ok ? h : h.reason === 'missing' ? undefined : { ok: false, detail: h.detail },
      remote: remoteMetadata(this.o.remote ?? {}),
      timeZone: this.o.timeZone,
    });
  }

  private tick(): void {
    this.refresh();
    if (this.clients.size === 0) return;
    if (this.o.remote) refreshAll(this.o.remote);
    this.broadcast(false);
  }

  private broadcast(force: boolean): void {
    const vm = this.viewModel();
    const body = JSON.stringify(vm);
    // Re-send when anything but the generation time changed (liveness changes with time are included).
    const signature = JSON.stringify({ ...vm, generatedAtMs: 0 });
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.lastBody = body;
    for (const c of this.clients) c.write(`event: state\ndata: ${body}\n\n`);
  }

  private headers(type: string, extra: Record<string, string> = {}): Record<string, string> {
    return { ...SECURITY_HEADERS, 'content-type': type, ...extra };
  }

  private refuse(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
    this.refused += 1;
    res.writeHead(status, this.headers('text/plain; charset=utf-8', extra));
    res.end(`${message}\n`);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // DNS-rebinding guard: only loopback Host names with our port.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!this.allowedHosts.has(host)) return this.refuse(res, 421, 'misdirected request: the dashboard answers only on its loopback address');
    const origin = req.headers.origin;
    if (origin && !this.allowedHosts.has(origin.replace(/^https?:\/\//, '').toLowerCase())) return this.refuse(res, 403, 'cross-origin request refused');
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.refuse(res, 405, 'the dashboard is read-only', { allow: 'GET, HEAD' });
    const url = req.url ?? '/';
    if (url.length > 512) return this.refuse(res, 414, 'URL too long');
    const path = url.split('?')[0] ?? '/';
    const asset = ASSETS[path];
    if (asset) {
      res.writeHead(200, this.headers(asset.type));
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    if (path === '/api/state') {
      if (this.clients.size === 0) this.refresh();
      const body = JSON.stringify(this.viewModel());
      res.writeHead(200, this.headers('application/json; charset=utf-8'));
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (path === '/events') {
      if (req.method === 'HEAD') {
        res.writeHead(200, this.headers('text/event-stream'));
        res.end();
        return;
      }
      if (this.clients.size >= (this.o.maxClients ?? 8)) return this.refuse(res, 503, `too many dashboard viewers (limit ${this.o.maxClients ?? 8}); close another tab`, { 'retry-after': '10' });
      res.writeHead(200, this.headers('text/event-stream; charset=utf-8', { connection: 'keep-alive' }));
      res.write('retry: 2000\n\n');
      this.clients.add(res);
      const drop = () => this.clients.delete(res);
      req.on('close', drop);
      res.on('error', drop);
      if (this.o.remote) refreshAll(this.o.remote);
      const body = this.lastBody && this.clients.size > 1 ? this.lastBody : JSON.stringify(this.viewModel());
      res.write(`event: state\ndata: ${body}\n\n`);
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    this.refuse(res, 404, 'not found');
  }

  /** Stops only this viewer: its listener, streams and timers. Never touches Chunkbot. */
  async close(): Promise<void> {
    for (const t of [this.timer, this.historyTimer, this.keepAlive]) if (t) clearInterval(t);
    this.timer = this.historyTimer = this.keepAlive = undefined;
    this.o.remote?.openRouterKey?.close();
    this.o.remote?.codexQuota?.close();
    for (const c of this.clients) c.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const s of this.sockets) s.destroy();
    });
  }
}
