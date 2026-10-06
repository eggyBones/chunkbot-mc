// Minimal Java class-file reader used only by scripts/extract-version-data.ts to
// recover vanilla fuel burn times from the official (unobfuscated) 26.1.x server
// jar. It decodes the constant pool and walks method bytecode; it never executes
// anything from the jar.

export type Constant =
  | { tag: 'utf8'; value: string }
  | { tag: 'int'; value: number }
  | { tag: 'float' | 'long' | 'double'; value: number }
  | { tag: 'class'; name: number }
  | { tag: 'string'; value: number }
  | { tag: 'ref'; kind: 'field' | 'method' | 'imethod'; cls: number; nat: number }
  | { tag: 'nat'; name: number; desc: number }
  | { tag: 'other' }
  | undefined;

export interface Instruction {
  offset: number;
  opcode: number;
  /** Decoded operand: constant-pool index, immediate integer, or undefined. */
  operand?: number;
}

export interface MethodCode {
  name: string;
  descriptor: string;
  instructions: Instruction[];
}

export interface ClassFile {
  pool: Constant[];
  methods: MethodCode[];
  utf8(index: number): string;
  /** Resolves a field/method ref to `Owner.name:desc`. */
  ref(index: number): { owner: string; name: string; desc: string } | undefined;
}

export const OP = {
  iconst_m1: 0x02,
  iconst_5: 0x08,
  bipush: 0x10,
  sipush: 0x11,
  ldc: 0x12,
  ldc_w: 0x13,
  getstatic: 0xb2,
  invokevirtual: 0xb6,
  invokestatic: 0xb8,
  invokeinterface: 0xb9,
} as const;

/** Operand byte lengths for fixed-size opcodes (variable ones handled specially). */
function operandLength(op: number): number {
  if (op === 0x10 || op === 0x12 || (op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a) || op === 0xa9 || op === 0xbc) return 1;
  if (op === 0x11 || op === 0x13 || op === 0x14 || op === 0x84 || (op >= 0x99 && op <= 0xa8) || (op >= 0xb2 && op <= 0xb8) || op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1 || op === 0xc6 || op === 0xc7) return 2;
  if (op === 0xc5) return 3;
  if (op === 0xb9 || op === 0xba || op === 0xc8 || op === 0xc9) return 4;
  return 0;
}

export function parseClass(buf: Buffer): ClassFile {
  let p = 0;
  const u1 = () => buf.readUInt8(p++);
  const u2 = () => {
    const v = buf.readUInt16BE(p);
    p += 2;
    return v;
  };
  const u4 = () => {
    const v = buf.readUInt32BE(p);
    p += 4;
    return v;
  };
  if (u4() !== 0xcafebabe) throw new Error('not a class file');
  u2();
  u2();
  const count = u2();
  const pool: Constant[] = [undefined];
  for (let i = 1; i < count; i += 1) {
    const tag = u1();
    switch (tag) {
      case 1: {
        const len = u2();
        pool.push({ tag: 'utf8', value: buf.toString('utf8', p, p + len) });
        p += len;
        break;
      }
      case 3:
        pool.push({ tag: 'int', value: buf.readInt32BE(p) });
        p += 4;
        break;
      case 4:
        pool.push({ tag: 'float', value: buf.readFloatBE(p) });
        p += 4;
        break;
      case 5:
      case 6:
        pool.push({ tag: tag === 5 ? 'long' : 'double', value: 0 }, undefined);
        p += 8;
        i += 1;
        break;
      case 7:
        pool.push({ tag: 'class', name: u2() });
        break;
      case 8:
        pool.push({ tag: 'string', value: u2() });
        break;
      case 9:
      case 10:
      case 11:
        pool.push({ tag: 'ref', kind: tag === 9 ? 'field' : tag === 10 ? 'method' : 'imethod', cls: u2(), nat: u2() });
        break;
      case 12:
        pool.push({ tag: 'nat', name: u2(), desc: u2() });
        break;
      case 15:
        p += 3;
        pool.push({ tag: 'other' });
        break;
      case 16:
      case 19:
      case 20:
        p += 2;
        pool.push({ tag: 'other' });
        break;
      case 17:
      case 18:
        p += 4;
        pool.push({ tag: 'other' });
        break;
      default:
        throw new Error(`unknown constant tag ${tag} at ${p}`);
    }
  }
  const utf8 = (index: number): string => {
    const c = pool[index];
    return c?.tag === 'utf8' ? c.value : '';
  };
  const skipAttributes = () => {
    const n = u2();
    for (let i = 0; i < n; i += 1) {
      u2();
      const len = u4();
      p += len;
    }
  };
  u2(); // access
  u2(); // this
  u2(); // super
  const interfaces = u2();
  p += interfaces * 2;
  const fields = u2();
  for (let i = 0; i < fields; i += 1) {
    p += 6;
    skipAttributes();
  }
  const methods: MethodCode[] = [];
  const methodCount = u2();
  for (let i = 0; i < methodCount; i += 1) {
    u2();
    const name = utf8(u2());
    const descriptor = utf8(u2());
    const attrs = u2();
    const instructions: Instruction[] = [];
    for (let a = 0; a < attrs; a += 1) {
      const attrName = utf8(u2());
      const len = u4();
      const end = p + len;
      if (attrName === 'Code') {
        p += 4; // max_stack, max_locals
        const codeLen = u4();
        const start = p;
        while (p < start + codeLen) {
          const offset = p - start;
          const opcode = u1();
          let operand: number | undefined;
          if (opcode === 0xaa || opcode === 0xab) {
            // tableswitch / lookupswitch: pad to 4-byte boundary then skip tables
            p += (4 - ((p - start) % 4)) % 4;
            if (opcode === 0xaa) {
              p += 4;
              const low = buf.readInt32BE(p);
              const high = buf.readInt32BE(p + 4);
              p += 8 + (high - low + 1) * 4;
            } else {
              p += 4;
              const pairs = buf.readInt32BE(p);
              p += 4 + pairs * 8;
            }
          } else if (opcode === 0xc4) {
            const inner = u1();
            p += inner === 0x84 ? 4 : 2;
          } else {
            const n = operandLength(opcode);
            if (opcode === OP.bipush) operand = buf.readInt8(p);
            else if (opcode === OP.sipush) operand = buf.readInt16BE(p);
            else if (opcode === OP.ldc) operand = buf.readUInt8(p);
            else if (n >= 2 && opcode !== 0x84 && !(opcode >= 0x99 && opcode <= 0xa8)) operand = buf.readUInt16BE(p);
            p += n;
          }
          instructions.push(operand === undefined ? { offset, opcode } : { offset, opcode, operand });
        }
        p = end;
      } else {
        p = end;
      }
    }
    methods.push({ name, descriptor, instructions });
  }
  const ref = (index: number) => {
    const c = pool[index];
    if (c?.tag !== 'ref') return undefined;
    const cls = pool[c.cls];
    const nat = pool[c.nat];
    if (cls?.tag !== 'class' || nat?.tag !== 'nat') return undefined;
    return { owner: utf8(cls.name), name: utf8(nat.name), desc: utf8(nat.desc) };
  };
  return { pool, methods, utf8, ref };
}

/** Integer pushed by an instruction, if it is a constant-int push. */
export function pushedInt(cls: ClassFile, ins: Instruction): number | undefined {
  if (ins.opcode >= OP.iconst_m1 && ins.opcode <= OP.iconst_5) return ins.opcode - 0x03;
  if (ins.opcode === OP.bipush || ins.opcode === OP.sipush) return ins.operand;
  if ((ins.opcode === OP.ldc || ins.opcode === OP.ldc_w) && ins.operand !== undefined) {
    const c = cls.pool[ins.operand];
    if (c?.tag === 'int') return c.value;
  }
  return undefined;
}
