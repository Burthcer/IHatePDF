/**
 * PDF content-stream lexer and serializer.
 *
 * Splits a decoded content stream into operations (operands + operator) and
 * remembers each operation's byte range, so an edit can replace exactly the
 * bytes of the operations it changes and copy everything else through
 * untouched.
 */

export type Operand =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array; hex: boolean }
  | { t: 'arr'; v: Operand[] }
  | { t: 'dict'; v: Map<string, Operand> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' };

export interface ContentOp {
  op: string;
  args: Operand[];
  /** Byte offset where the first operand (or the operator) starts. */
  start: number;
  /** Byte offset just past the operator (past `EI` for inline images). */
  end: number;
}

const WHITESPACE = new Uint8Array(256);
[0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].forEach((c) => (WHITESPACE[c] = 1));
const DELIMITER = new Uint8Array(256);
[0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].forEach((c) => (DELIMITER[c] = 1));

const isRegular = (c: number) => !WHITESPACE[c] && !DELIMITER[c];

class Lexer {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}

  skipWs(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WHITESPACE[c]) {
        this.pos++;
      } else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  /** Reads one object or keyword. Returns a keyword as `{ kw }`. */
  read(): Operand | { kw: string } | null {
    this.skipWs();
    const b = this.b;
    if (this.pos >= b.length) return null;
    const c = b[this.pos];

    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteral();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) return this.readDict();
      return this.readHex();
    }
    if (c === 0x5b) {
      this.pos++;
      const items: Operand[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) break;
        if (b[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        const item = this.read();
        if (!item) break;
        if ('kw' in item) continue; // stray keyword inside array — ignore
        items.push(item);
      }
      return { t: 'arr', v: items };
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      // Unbalanced delimiter — skip it rather than stall.
      this.pos++;
      return { kw: '' };
    }

    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    let token = '';
    for (let i = start; i < this.pos; i++) token += String.fromCharCode(b[i]);
    if (token.length === 0) {
      this.pos++;
      return { kw: '' };
    }
    const first = token.charCodeAt(0);
    if ((first >= 0x30 && first <= 0x39) || first === 0x2b || first === 0x2d || first === 0x2e) {
      const num = parseNumber(token);
      if (num !== null) return { t: 'num', v: num };
    }
    if (token === 'true') return { t: 'bool', v: true };
    if (token === 'false') return { t: 'bool', v: false };
    if (token === 'null') return { t: 'null' };
    return { kw: token };
  }

  private readName(): Operand {
    const b = this.b;
    this.pos++;
    let name = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && this.pos + 2 < b.length) {
        const hex = String.fromCharCode(b[this.pos + 1], b[this.pos + 2]);
        const v = parseInt(hex, 16);
        if (!Number.isNaN(v)) {
          name += String.fromCharCode(v);
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(c);
      this.pos++;
    }
    return { t: 'name', v: name };
  }

  private readLiteral(): Operand {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(v & 0xff);
            } else if (n !== undefined) {
              out.push(n);
            }
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
      }
      out.push(c);
    }
    return { t: 'str', v: new Uint8Array(out), hex: false };
  }

  private readHex(): Operand {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return { t: 'str', v: new Uint8Array(out), hex: true };
  }

  private readDict(): Operand {
    const b = this.b;
    this.pos += 2;
    const map = new Map<string, Operand>();
    for (;;) {
      this.skipWs();
      if (this.pos >= b.length) break;
      if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.read();
      if (!key) break;
      if ('kw' in key || key.t !== 'name') continue;
      const value = this.read();
      if (!value) break;
      if ('kw' in value) continue;
      map.set(key.v, value);
    }
    return { t: 'dict', v: map };
  }

  /** After `ID`, skip the binary inline-image data through the closing `EI`. */
  skipInlineImageData(dict: Map<string, Operand>): void {
    const b = this.b;
    // exactly one whitespace byte follows ID
    if (WHITESPACE[b[this.pos]]) this.pos++;
    const lenOp = dict.get('L') ?? dict.get('Length');
    if (lenOp && lenOp.t === 'num' && lenOp.v > 0) {
      const target = this.pos + lenOp.v;
      const after = findEI(b, target);
      if (after >= 0 && after - target < 16) {
        this.pos = after;
        return;
      }
    }
    const after = findEI(b, this.pos);
    this.pos = after >= 0 ? after : b.length;
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/** Finds "EI" surrounded by whitespace at or after `from`; returns the offset just past it. */
function findEI(b: Uint8Array, from: number): number {
  for (let i = Math.max(from, 1); i < b.length - 1; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && WHITESPACE[b[i - 1]] && (i + 2 >= b.length || WHITESPACE[b[i + 2]] || DELIMITER[b[i + 2]])) {
      return i + 2;
    }
  }
  return -1;
}

function parseNumber(token: string): number | null {
  // Tolerate producer quirks like "--5" or "1.2.3" the way viewers do.
  let t = token.replace(/^([+-])[+-]+/, '$1');
  const second = t.indexOf('.', t.indexOf('.') + 1);
  if (second > 0) t = t.slice(0, second);
  const v = Number(t);
  if (Number.isFinite(v)) return v;
  const f = parseFloat(t);
  return Number.isFinite(f) ? f : t === '-' || t === '+' || t === '.' ? 0 : null;
}

export function parseContent(bytes: Uint8Array): ContentOp[] {
  const lx = new Lexer(bytes);
  const ops: ContentOp[] = [];
  let args: Operand[] = [];
  let argStart = -1;

  for (;;) {
    lx.skipWs();
    const tokenStart = lx.pos;
    const tok = lx.read();
    if (!tok) break;
    if (!('kw' in tok)) {
      if (args.length === 0) argStart = tokenStart;
      args.push(tok);
      if (args.length > 64) {
        // Runaway operand list (corrupt stream) — drop the oldest to bound memory.
        args.shift();
      }
      continue;
    }
    if (tok.kw === '') continue;

    const start = args.length > 0 ? argStart : tokenStart;
    if (tok.kw === 'BI') {
      const dict = new Map<string, Operand>();
      for (;;) {
        const k = lx.read();
        if (!k) break;
        if ('kw' in k) {
          if (k.kw === 'ID') break;
          continue;
        }
        if (k.t !== 'name') continue;
        const v = lx.read();
        if (!v) break;
        if ('kw' in v) {
          if (v.kw === 'ID') break;
          continue;
        }
        dict.set(k.v, v);
      }
      lx.skipInlineImageData(dict);
      ops.push({ op: 'BI', args: [{ t: 'dict', v: dict }], start, end: lx.pos });
    } else {
      ops.push({ op: tok.kw, args, start, end: lx.pos });
    }
    args = [];
    argStart = -1;
  }
  return ops;
}

// ---------------------------------------------------------------- writing

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function formatName(name: string): string {
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x23 || DELIMITER[c]) {
      out += '#' + c.toString(16).padStart(2, '0');
    } else {
      out += name[i];
    }
  }
  return out;
}

export function formatHex(bytes: Uint8Array): string {
  let s = '<';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s + '>';
}

export function formatOperand(o: Operand): string {
  switch (o.t) {
    case 'num': return formatNumber(o.v);
    case 'name': return formatName(o.v);
    case 'str': return formatHex(o.v);
    case 'arr': return '[' + o.v.map(formatOperand).join(' ') + ']';
    case 'dict': {
      let s = '<<';
      o.v.forEach((v, k) => (s += formatName(k) + ' ' + formatOperand(v) + ' '));
      return s + '>>';
    }
    case 'bool': return o.v ? 'true' : 'false';
    case 'null': return 'null';
  }
}

export const latin1 = {
  encode(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  },
  decode(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i += 8192) {
      s += String.fromCharCode(...b.subarray(i, i + 8192));
    }
    return s;
  },
};
