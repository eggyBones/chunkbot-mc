// Harness-only RCON: one absolute deadline covers connect, auth and response.
// On every settlement the socket is destroyed; no hidden cleanup I/O remains.
import { Socket } from 'node:net';

const packet = (id: number, type: number, body: string): Buffer => {
  const bytes = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(bytes.length + 14);
  p.writeInt32LE(bytes.length + 10, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8);
  bytes.copy(p, 12);
  return p;
};

export function trialRcon(host: string, port: number, password: string, command: string, timeoutMs = 2_000): Promise<string> {
  if (host !== '127.0.0.1' && host !== '::1') return Promise.reject(new Error('trial RCON requires loopback'));
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, reply?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(reply ?? '');
    };
    const timer = setTimeout(() => finish(new Error('trial RCON absolute deadline exceeded')), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => { if (!settled) finish(new Error('trial RCON closed before a response')); });
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (!settled && buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (size < 10 || size > 1_000_000) return finish(new Error('invalid trial RCON response size'));
        if (buffer.length < size + 4) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, size + 2).toString('utf8');
        buffer = buffer.subarray(size + 4);
        if (id === -1) return finish(new Error('trial RCON authentication failed'));
        if (!authenticated && id === 1 && type === 2) {
          authenticated = true;
          socket.write(packet(2, 2, command));
        } else if (authenticated && id === 2 && type === 0) finish(undefined, body);
      }
    });
    socket.connect(port, host, () => socket.write(packet(1, 3, password)));
  });
}
