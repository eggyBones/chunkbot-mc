import { BridgeBindingSchema, type BridgeBinding, type UuidWords } from './types.ts';

export function uuidWords(uuid: string): UuidWords {
  if (!/^[a-f0-9]{32}$/.test(uuid)) throw new Error('bridge UUID must be canonical');
  return [0, 8, 16, 24].map((offset) => Number.parseInt(uuid.slice(offset, offset + 8), 16) | 0) as UuidWords;
}
export function wordsUuid(words: UuidWords): string {
  return words.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Fixed namespace and typed data only. Never accepts a player command/string. */
export function macroCommand(name: 'install' | 'open' | 'ack' | 'pulse' | 'close', args: Record<string, string | number>): string {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' ? !/^[a-z0-9_-]{1,64}$/.test(value) : !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      throw new Error('invalid bridge macro argument');
    }
  }
  return `function chunkbot_control:${name} ${JSON.stringify(args)}`;
}
export function bindingArgs(input: BridgeBinding): Record<string, string | number> {
  const b = BridgeBindingSchema.parse(input);
  const [a, c, d, e] = uuidWords(b.ownerUuid);
  return { installation: b.installation, world: b.world, bot: b.bot, version: b.version.replaceAll('.', '_'), a, b: c, c: d, d: e };
}

/** For the coordinator's reviewed installation procedure. The bridge never runs this. */
export function installationCommand(binding: BridgeBinding): string {
  return macroCommand('install', bindingArgs(binding));
}

/** Parse only the bounded SNBT subset our datapack emits. Reject duplicate keys,
 * nesting bombs, arrays other than integer UUID arrays and trailing prose. */
export function decodeStorageReply(reply: string): unknown {
  if (Buffer.byteLength(reply) > 8192) throw new Error('bridge reply too large');
  const prefix = /^chunkbot_control:bridge has the following contents: /;
  if (!prefix.test(reply)) throw new Error('bridge storage reply unavailable');
  const text = reply.replace(prefix, '');
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const expect = (s: string) => { space(); if (!text.startsWith(s, at)) throw new Error('invalid bridge storage'); at += s.length; };
  function value(depth: number): unknown {
    space();
    if (depth > 4) throw new Error('bridge storage nesting');
    if (text[at] === '{') {
      at++;
      const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      space();
      if (text[at] === '}') { at++; return obj; }
      while (true) {
        space();
        const key = /^[a-zA-Z][a-zA-Z0-9_]*/.exec(text.slice(at))?.[0];
        if (!key || Object.hasOwn(obj, key)) throw new Error('invalid bridge storage key');
        at += key.length;
        expect(':'); obj[key] = value(depth + 1); space();
        if (text[at] === '}') { at++; return obj; }
        expect(',');
      }
    }
    if (text.startsWith('[I;', at)) {
      at += 3;
      const nums: number[] = [];
      while (true) {
        const n = value(depth + 1);
        if (typeof n !== 'number' || nums.length >= 4) throw new Error('invalid bridge UUID array');
        nums.push(n); space();
        if (text[at] === ']') { at++; break; }
        expect(',');
      }
      if (nums.length !== 4) throw new Error('invalid bridge UUID length');
      return nums;
    }
    if (text[at] === '"') {
      const match = /^"(?:[^"\\\r\n]|\\["\\])*"/.exec(text.slice(at))?.[0];
      if (!match) throw new Error('invalid bridge storage string');
      at += match.length; return JSON.parse(match) as unknown;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:b)?(?=[\s,}\]])/.exec(text.slice(at))?.[0];
    if (!number) throw new Error('invalid bridge storage scalar');
    at += number.length;
    const n = Number(number.replace(/b$/, ''));
    if (!Number.isSafeInteger(n)) throw new Error('invalid bridge storage number');
    return n;
  }
  const parsed = value(0); space();
  if (at !== text.length) throw new Error('invalid bridge storage trailing data');
  // Macro substitutions use underscore version spelling so they stay injection-free.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['version'] === 'string') obj['version'] = obj['version'].replaceAll('_', '.');
  }
  return parsed;
}
