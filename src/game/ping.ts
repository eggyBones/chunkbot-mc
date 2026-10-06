// Abortable Java Edition server-list ping (handshake -> status request ->
// JSON response). Used before login to confirm the server's real version and
// protocol. Unlike the library helper it releases its socket immediately when
// the join is cancelled.
import { Socket } from 'node:net';

export interface PingResult {
  version: string;
  protocol: number;
}

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

function readVarint(buf: Buffer, offset: number): { value: number; size: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf[offset + i];
    if (byte === undefined) return undefined;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error('malformed varint in status response');
}

function framed(payload: Buffer): Buffer {
  return Buffer.concat([varint(payload.length), payload]);
}

export function statusPing(options: { host: string; port: number; timeoutMs: number; signal?: AbortSignal }): Promise<PingResult> {
  const { host, port, timeoutMs, signal } = options;
  return new Promise<PingResult>((resolve, reject) => {
    const socket = new Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | undefined, result?: PingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as PingResult);
    };
    const onAbort = (): void => finish(new Error('ping aborted'));
    const timer = setTimeout(() => finish(new Error(`no status response within ${timeoutMs}ms`)), timeoutMs);
    if (signal?.aborted) {
      finish(new Error('ping aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('connection closed before status response')));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const length = readVarint(buffer, 0);
        if (!length || buffer.length < length.size + length.value) return;
        let offset = length.size;
        const id = readVarint(buffer, offset);
        if (!id || id.value !== 0) throw new Error('unexpected status packet');
        offset += id.size;
        const strLen = readVarint(buffer, offset);
        if (!strLen) throw new Error('truncated status response');
        offset += strLen.size;
        const json = JSON.parse(buffer.subarray(offset, offset + strLen.value).toString('utf8')) as {
          version?: { name?: unknown; protocol?: unknown };
        };
        const name = json.version?.name;
        const protocol = json.version?.protocol;
        if (typeof name !== 'string' || typeof protocol !== 'number') throw new Error('status response has no version');
        finish(undefined, { version: name, protocol });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.connect(port, host, () => {
      const hostBytes = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      const handshake = Buffer.concat([varint(0x00), varint(0xffffffff), varint(hostBytes.length), hostBytes, portBuf, varint(1)]);
      socket.write(Buffer.concat([framed(handshake), framed(varint(0x00))]));
    });
  });
}
