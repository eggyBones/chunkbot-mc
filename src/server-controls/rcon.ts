import { createConnection } from 'node:net';
import { TextDecoder } from 'node:util';
import { bindingArgs, decodeStorageReply, macroCommand, uuidWords } from './protocol.ts';
import { BridgeBindingSchema, BridgeSampleSchema, HEARTBEAT_TICKS, type BridgeBinding, type BridgeDisplay, type BridgeIntentReceipt, type BridgeManagerStatus, type BridgeTransport } from './types.ts';

export interface PrivateRconOptions {
  /** Deliberately loopback only. Coordinator establishes any private tunnel. */
  host: '127.0.0.1' | '::1';
  port: number;
  /** Injected from external operator environment; never serialized or logged. */
  password: string;
  timeoutMs?: number;
}
const SAMPLE_COMMAND = 'data get storage chunkbot_control:bridge state';
const FENCE_COMMAND = 'data get storage chunkbot_control:bridge state.protocol';

function packet(id: number, type: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(bytes.length + 14);
  out.writeInt32LE(bytes.length + 10, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8);
  bytes.copy(out, 12);
  return out;
}

/** One bounded connection/command with a fixed namespace-owned read fence.
 * This channel is private to the adapter, not an arbitrary-command public API. */
function execute(options: PrivateRconOptions, command: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('bridge RCON cancelled')); return; }
    const socket = createConnection({ host: options.host, port: options.port });
    let buffer = Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let authenticated = false;
    let settled = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else {
        try { resolve(decoder.decode(Buffer.concat(chunks))); } catch { reject(new Error('bridge RCON encoding')); }
      }
    };
    const abort = () => finish(new Error('bridge RCON cancelled'));
    const timer = setTimeout(() => finish(new Error('bridge RCON timeout')), options.timeoutMs ?? 1000);
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new Error('bridge RCON unavailable')));
    socket.on('close', () => { if (!settled) finish(new Error('bridge RCON incomplete')); });
    socket.on('connect', () => socket.write(packet(1, 3, options.password)));
    socket.on('data', (data: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 16_384) { finish(new Error('bridge RCON frame bound')); return; }
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (size < 10 || size > 4096) { finish(new Error('bridge RCON frame')); return; }
        if (buffer.length < size + 4) return;
        const frame = buffer.subarray(0, size + 4); buffer = buffer.subarray(size + 4);
        const id = frame.readInt32LE(4), type = frame.readInt32LE(8);
        if (frame.at(-1) !== 0 || frame.at(-2) !== 0) { finish(new Error('bridge RCON terminator')); return; }
        const body = frame.subarray(12, frame.length - 2);
        if (!authenticated) {
          if (id === 1 && type === 0 && body.length === 0) continue;
          if (id !== 1 || type !== 2 || body.length !== 0) { finish(new Error('bridge RCON authentication')); return; }
          authenticated = true;
          socket.write(Buffer.concat([packet(2, 2, command), packet(3, 2, FENCE_COMMAND)]));
        } else if (type === 0 && id === 2) {
          bytes += body.length;
          if (bytes > 8192) { finish(new Error('bridge RCON response bound')); return; }
          chunks.push(Buffer.from(body));
        } else if (type === 0 && id === 3) {
          if (chunks.length === 0 || buffer.length > 0) { finish(new Error('bridge RCON response correlation')); return; }
          finish(); return;
        } else { finish(new Error('bridge RCON response correlation')); return; }
      }
    });
  });
}

const displayCode: Record<BridgeDisplay, number> = { unavailable: 0, offline: 1, joining: 2, online: 3, logging_out: 4, blocked: 5 };
const blockerCode: Record<BridgeManagerStatus['blocker'], number> = { none: 0, auth_required: 1, whitelist: 2, version: 3, unreachable: 4, identity: 5, cleanup: 6, manager_unavailable: 7 };

/** No auto-install, reconnect loop, sign-in, command escape or gameplay read. */
export function createPrivateRconTransport(input: PrivateRconOptions): BridgeTransport {
  const options = { ...input }; // A later config mutation cannot redirect this privileged channel.
  if ((options.host !== '127.0.0.1' && options.host !== '::1') || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !options.password || Buffer.byteLength(options.password) > 1024 || /[\u0000\r\n]/.test(options.password) || (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10 || options.timeoutMs > 1000))) throw new Error('invalid private bridge channel');
  const read = async (signal: AbortSignal) => BridgeSampleSchema.parse(decodeStorageReply(await execute(options, SAMPLE_COMMAND, signal)));
  const call = async (name: 'open' | 'ack' | 'pulse' | 'close', args: Record<string, string | number>, signal: AbortSignal) => {
    // Function command's prose is not a receipt. Its effects are read back.
    await execute(options, macroCommand(name, args), signal);
  };
  return {
    sample: read,
    async open(input, session, signal) {
      const binding = BridgeBindingSchema.parse(input);
      const before = await read(signal);
      assertBinding(before, binding);
      if (before.session !== 'closed' && before.heartbeat > 0) throw new Error('binding');
      await call('open', { ...bindingArgs(binding), session }, signal);
      const after = await read(signal);
      assertBinding(after, binding);
      if (after.session !== session || after.request.action !== 0 || after.generation !== 0 || after.acknowledged !== 0) throw new Error('bridge open unconfirmed');
    },
    async acknowledge(session, generation, disposition: BridgeIntentReceipt['disposition'], signal) {
      await call('ack', { session, generation, disposition: disposition === 'queued' ? 1 : disposition === 'noop' ? 2 : 3 }, signal);
      const after = await read(signal);
      if (after.session !== session || (after.acknowledged < generation && after.request.generation <= generation)) throw new Error('bridge acknowledgment unconfirmed');
      // A newer off may have overtaken an older on ack; never erase or retry it.
    },
    async heartbeat(session, display, blocker, managerGeneration, signal) {
      await call('pulse', { session, display: displayCode[display], blocker: blockerCode[blocker], manager_generation: managerGeneration, ticks: HEARTBEAT_TICKS }, signal);
      const after = await read(signal);
      if (after.session !== session || after.heartbeat <= 0 || after.display !== displayCode[display] || after.blocker !== blockerCode[blocker] || after.managerGeneration !== managerGeneration) throw new Error('bridge heartbeat unconfirmed');
    },
    async close(session, signal) {
      await call('close', { session }, signal);
      const after = await read(signal);
      if (after.session === session && after.heartbeat > 0) throw new Error('bridge close unconfirmed');
    },
  };
}

function assertBinding(sample: ReturnType<typeof BridgeSampleSchema.parse>, binding: BridgeBinding): void {
  if (sample.protocol !== binding.protocol || sample.installation !== binding.installation || sample.world !== binding.world || sample.bot !== binding.bot || sample.version !== binding.version || sample.owner.some((n, i) => n !== uuidWords(binding.ownerUuid)[i])) throw new Error('binding');
}
