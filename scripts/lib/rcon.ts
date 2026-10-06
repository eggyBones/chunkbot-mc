// Minimal Source-RCON client for the loopback test fixture (console commands
// such as /say, /tellraw, /kick, /kill, /tp). The password is read from the
// fixture's git-ignored server.properties and is never printed.
import { Socket } from 'node:net';

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt16LE(0, 12 + payload.length);
  return buf;
}

export async function rconCommand(host: string, port: number, password: string, command: string, timeoutMs = 5_000): Promise<string> {
  const socket = new Socket();
  let buffer = Buffer.alloc(0);
  const responses: Array<{ id: number; body: string }> = [];
  let wake: (() => void) | undefined;
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readInt32LE(0);
      if (buffer.length < len + 4) break;
      const id = buffer.readInt32LE(4);
      const body = buffer.subarray(12, 4 + len - 2).toString('utf8');
      responses.push({ id, body });
      buffer = buffer.subarray(len + 4);
    }
    wake?.();
  });
  const next = async (): Promise<{ id: number; body: string }> => {
    const deadline = Date.now() + timeoutMs;
    while (responses.length === 0) {
      if (Date.now() > deadline) throw new Error('RCON timeout');
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
    }
    return responses.shift() as { id: number; body: string };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, host, () => resolve());
    });
    socket.write(packet(1, TYPE_AUTH, password));
    const auth = await next();
    if (auth.id === -1) throw new Error('RCON authentication failed');
    socket.write(packet(2, TYPE_COMMAND, command));
    const reply = await next();
    return reply.body;
  } finally {
    socket.destroy();
  }
}
