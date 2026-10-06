// Network codec health for one connection (MB-SERVER-001).
//
// With `hideErrors`, minecraft-protocol's packet parser silently DROPS a packet
// whose fields run past its end (PartialReadError) and never reports a packet
// that leaves bytes unread. Either means the installed protocol definition does
// not match what the server actually sent. This audit wraps the client's
// current deserializer (re-wrapped on every protocol-state change) and counts,
// per packet name: fully decoded packets, packets with unread trailing bytes,
// and packets that failed to decode. It observes only; it never alters,
// drops or re-emits a packet.
import type { EventEmitter } from 'node:events';

export interface CodecHealth {
  /** Packets decoded with every byte consumed. */
  decoded: number;
  /** Packet name -> packets decoded with unread trailing bytes. */
  trailingBytes: Record<string, number>;
  /** Packet name -> packets that failed to decode (dropped by the library or surfaced as errors). */
  parseFailures: Record<string, number>;
  /** First problem seen, bounded, for evidence. */
  firstProblem?: string;
}

interface Parser {
  parsePacketBuffer(buffer: Buffer): { metadata: { size: number }; data: { name?: string } };
}

interface AuditedClient extends EventEmitter {
  deserializer?: Parser;
  state?: string;
}

type PacketNames = (state: string, id: number) => string | undefined;

function readVarInt(buffer: Buffer): number | undefined {
  let value = 0;
  for (let i = 0; i < 5 && i < buffer.length; i++) {
    const byte = buffer[i] as number;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return value;
  }
  return undefined;
}

/**
 * Builds a (state, packet id) -> name lookup for server-to-client packets
 * from a minecraft-data protocol definition.
 */
export function clientboundPacketNames(protocol: unknown): PacketNames {
  const cache = new Map<string, Record<string, string>>();
  return (state, id) => {
    let mappings = cache.get(state);
    if (!mappings) {
      const container = (protocol as Record<string, { toClient?: { types?: { packet?: unknown } } }> | undefined)?.[state]?.toClient?.types?.packet;
      const nameField = Array.isArray(container) ? (container[1] as Array<{ name: string; type: unknown }> | undefined)?.find((f) => f.name === 'name') : undefined;
      const raw = Array.isArray(nameField?.type) ? (nameField.type[1] as { mappings?: Record<string, string> } | undefined)?.mappings : undefined;
      mappings = {};
      for (const [k, v] of Object.entries(raw ?? {})) mappings[String(Number(k))] = v;
      cache.set(state, mappings);
    }
    return mappings[String(id)];
  };
}

export class CodecAudit {
  private decoded = 0;
  private readonly trailing = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private firstProblem: string | undefined;
  private readonly wrapped = new WeakSet<object>();
  private detached = false;
  private readonly client: AuditedClient;
  private readonly names: PacketNames;

  constructor(client: AuditedClient, names: PacketNames) {
    this.client = client;
    this.names = names;
  }

  attach(): void {
    this.wrap();
    this.client.on('state', this.onState);
  }

  detach(): void {
    this.detached = true;
    this.client.off('state', this.onState);
  }

  health(): CodecHealth {
    const out: CodecHealth = {
      decoded: this.decoded,
      trailingBytes: Object.fromEntries(this.trailing),
      parseFailures: Object.fromEntries(this.failures),
    };
    if (this.firstProblem) out.firstProblem = this.firstProblem;
    return out;
  }

  private readonly onState = (): void => {
    this.wrap();
  };

  private nameOf(buffer: Buffer): string {
    const id = readVarInt(buffer);
    const state = this.client.state ?? 'unknown';
    const name = id === undefined ? undefined : this.names(state, id);
    return `${state}.${name ?? `0x${(id ?? -1).toString(16)}`}`;
  }

  private note(map: Map<string, number>, name: string, problem: string): void {
    map.set(name, (map.get(name) ?? 0) + 1);
    this.firstProblem ??= problem.slice(0, 300);
  }

  private wrap(): void {
    const parser = this.client.deserializer;
    if (!parser || this.wrapped.has(parser) || typeof parser.parsePacketBuffer !== 'function') return;
    this.wrapped.add(parser);
    const original = parser.parsePacketBuffer.bind(parser);
    parser.parsePacketBuffer = (buffer: Buffer) => {
      if (this.detached) return original(buffer);
      let packet: ReturnType<Parser['parsePacketBuffer']>;
      try {
        packet = original(buffer);
      } catch (error) {
        const name = this.nameOf(buffer);
        this.note(this.failures, name, `${name}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      if (packet.metadata.size !== buffer.length) {
        const name = this.nameOf(buffer);
        this.note(this.trailing, name, `${name}: read ${packet.metadata.size} of ${buffer.length} bytes`);
      } else {
        this.decoded += 1;
      }
      return packet;
    };
  }
}

/** One-line summary for terminals and connect-check output. */
export function codecSummary(health: CodecHealth | undefined): string {
  if (!health) return 'codec=unavailable';
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  const trailing = sum(health.trailingBytes);
  const failed = sum(health.parseFailures);
  const detail = trailing || failed ? ` first=${JSON.stringify(health.firstProblem ?? '')}` : '';
  return `codec=decoded:${health.decoded},trailing:${trailing},failed:${failed}${detail}`;
}
