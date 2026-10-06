import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';
import { statusPing } from '../src/game/ping.ts';
import { until } from './helpers.ts';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

async function listen(onSocket: (s: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onSocket);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port };
}

describe('abortable status ping', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  it('reads the version and protocol from a status response', async () => {
    const { server, port } = await listen((socket) => {
      socket.once('data', () => {
        const json = Buffer.from(JSON.stringify({ version: { name: '26.1.2', protocol: 775 }, players: { max: 8, online: 0 } }));
        const payload = Buffer.concat([varint(0), varint(json.length), json]);
        socket.write(Buffer.concat([varint(payload.length), payload]));
      });
    });
    servers.push(server);
    assert.deepEqual(await statusPing({ host: '127.0.0.1', port, timeoutMs: 2_000 }), { version: '26.1.2', protocol: 775 });
  });

  it('releases the socket immediately when aborted against a silent server', async () => {
    let closed = false;
    const { server, port } = await listen((socket) => {
      socket.resume(); // read (and discard) so the server observes the client's close
      socket.on('close', () => (closed = true));
    });
    servers.push(server);
    const abort = new AbortController();
    const pending = statusPing({ host: '127.0.0.1', port, timeoutMs: 10_000, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    abort.abort();
    await assert.rejects(pending, /ping aborted/);
    await until(() => closed, 1_000);
    assert.ok(Date.now() - started < 1_000);
  });

  it('times out and reports refused connections', async () => {
    const { server, port } = await listen(() => undefined);
    servers.push(server);
    await assert.rejects(statusPing({ host: '127.0.0.1', port, timeoutMs: 50 }), /no status response within 50ms/);
    const closedServer = await listen(() => undefined);
    closedServer.server.close();
    await assert.rejects(statusPing({ host: '127.0.0.1', port: closedServer.port, timeoutMs: 500 }), /ECONNREFUSED/);
  });
});
