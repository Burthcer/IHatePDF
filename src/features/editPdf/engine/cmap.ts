/**
 * Minimal CMap parser: enough of the PostScript-ish CMap syntax to read
 * ToUnicode maps (bfchar / bfrange) and embedded encoding CMaps
 * (codespacerange / cidchar / cidrange) as PDFs actually use them.
 */

export interface CodespaceRange {
  bytes: number;
  low: number;
  high: number;
}

export interface ParsedCMap {
  codespaces: CodespaceRange[];
  /** code → unicode string (ToUnicode) */
  unicode: Map<number, string>;
  /** code → CID (encoding CMaps) */
  cids: Map<number, number>;
  cidRanges: Array<{ low: number; high: number; cid: number; bytes: number }>;
  vertical: boolean;
  useCMap?: string;
}

type Tok = { k: 'hex'; v: number[] } | { k: 'num'; v: number } | { k: 'word'; v: string } | { k: 'open' } | { k: 'close' };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '%') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (c === '<') {
      if (text[i + 1] === '<') {
        i += 2;
        continue;
      }
      const end = text.indexOf('>', i);
      const hex = text.slice(i + 1, end < 0 ? n : end).replace(/[^0-9a-fA-F]/g, '');
      const bytes: number[] = [];
      for (let j = 0; j < hex.length; j += 2) bytes.push(parseInt(hex.slice(j, j + 2).padEnd(2, '0'), 16));
      out.push({ k: 'hex', v: bytes });
      i = end < 0 ? n : end + 1;
    } else if (c === '>') {
      i++;
    } else if (c === '[') {
      out.push({ k: 'open' });
      i++;
    } else if (c === ']') {
      out.push({ k: 'close' });
      i++;
    } else if (c === '(') {
      // literal strings only appear in header fields we don't need
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (text[i] === '\\') i++;
        else if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < n && !/[\s<>[\]()%]/.test(text[j])) j++;
      const word = text.slice(i, j);
      const num = Number(word);
      out.push(word !== '' && Number.isFinite(num) ? { k: 'num', v: num } : { k: 'word', v: word });
      i = j === i ? i + 1 : j;
    }
  }
  return out;
}

const toInt = (bytes: number[]) => bytes.reduce((acc, b) => acc * 256 + b, 0);

function utf16beToString(bytes: number[]): string {
  if (bytes.length === 1) return String.fromCharCode(bytes[0]);
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

function incrementUnicode(bytes: number[], delta: number): number[] {
  const out = bytes.slice();
  let carry = delta;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const v = out[i] + carry;
    out[i] = v & 0xff;
    carry = v >> 8;
  }
  return out;
}

export function parseCMap(text: string): ParsedCMap {
  const toks = tokenize(text);
  const cmap: ParsedCMap = { codespaces: [], unicode: new Map(), cids: new Map(), cidRanges: [], vertical: false };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'word') continue;
    switch (t.v) {
      case 'begincodespacerange': {
        i++;
        while (i + 1 < toks.length && toks[i].k === 'hex') {
          const lo = toks[i] as { k: 'hex'; v: number[] };
          const hi = toks[i + 1] as { k: 'hex'; v: number[] };
          cmap.codespaces.push({ bytes: lo.v.length, low: toInt(lo.v), high: toInt(hi.v) });
          i += 2;
        }
        i--;
        break;
      }
      case 'beginbfchar': {
        i++;
        while (i + 1 < toks.length && toks[i].k === 'hex') {
          const src = toks[i] as { k: 'hex'; v: number[] };
          const dst = toks[i + 1];
          if (dst.k === 'hex') cmap.unicode.set(toInt(src.v), utf16beToString(dst.v));
          else if (dst.k === 'word' && dst.v.startsWith('/')) cmap.unicode.set(toInt(src.v), dst.v.slice(1));
          i += 2;
        }
        i--;
        break;
      }
      case 'beginbfrange': {
        i++;
        while (i + 2 < toks.length && toks[i].k === 'hex') {
          const lo = toInt((toks[i] as { k: 'hex'; v: number[] }).v);
          const hi = toInt((toks[i + 1] as { k: 'hex'; v: number[] }).v);
          const dst = toks[i + 2];
          if (dst.k === 'hex') {
            for (let code = lo; code <= hi && code - lo < 65536; code++) {
              cmap.unicode.set(code, utf16beToString(incrementUnicode(dst.v, code - lo)));
            }
            i += 3;
          } else if (dst.k === 'open') {
            let j = i + 3;
            let code = lo;
            while (j < toks.length && toks[j].k !== 'close') {
              const d = toks[j];
              if (d.k === 'hex' && code <= hi) cmap.unicode.set(code, utf16beToString(d.v));
              code++;
              j++;
            }
            i = j + 1;
          } else {
            i += 3;
          }
        }
        i--;
        break;
      }
      case 'begincidchar': {
        i++;
        while (i + 1 < toks.length && toks[i].k === 'hex' && toks[i + 1].k === 'num') {
          cmap.cids.set(toInt((toks[i] as { k: 'hex'; v: number[] }).v), (toks[i + 1] as { k: 'num'; v: number }).v);
          i += 2;
        }
        i--;
        break;
      }
      case 'begincidrange': {
        i++;
        while (i + 2 < toks.length && toks[i].k === 'hex' && toks[i + 1].k === 'hex' && toks[i + 2].k === 'num') {
          const lo = toks[i] as { k: 'hex'; v: number[] };
          cmap.cidRanges.push({
            low: toInt(lo.v),
            high: toInt((toks[i + 1] as { k: 'hex'; v: number[] }).v),
            cid: (toks[i + 2] as { k: 'num'; v: number }).v,
            bytes: lo.v.length,
          });
          i += 3;
        }
        i--;
        break;
      }
      case '/WMode': {
        const next = toks[i + 1];
        if (next && next.k === 'num') cmap.vertical = next.v === 1;
        break;
      }
      case 'usecmap': {
        const prev = toks[i - 1];
        if (prev && prev.k === 'word' && prev.v.startsWith('/')) cmap.useCMap = prev.v.slice(1);
        break;
      }
    }
  }
  return cmap;
}

export function lookupCid(cmap: ParsedCMap, code: number): number | undefined {
  const direct = cmap.cids.get(code);
  if (direct !== undefined) return direct;
  for (const r of cmap.cidRanges) {
    if (code >= r.low && code <= r.high) return r.cid + (code - r.low);
  }
  return undefined;
}

/**
 * Splits `bytes` into character codes using codespace ranges. Falls back to
 * a fixed width when the ranges don't match (or there are none).
 */
export function splitCodes(
  bytes: Uint8Array,
  codespaces: CodespaceRange[],
  fallbackWidth: number
): Array<{ code: number; start: number; len: number }> {
  const out: Array<{ code: number; start: number; len: number }> = [];
  let i = 0;
  while (i < bytes.length) {
    let matched = 0;
    let code = 0;
    if (codespaces.length > 0) {
      let acc = 0;
      for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
        acc = acc * 256 + bytes[i + n - 1];
        if (codespaces.some((cs) => cs.bytes === n && acc >= cs.low && acc <= cs.high)) {
          matched = n;
          code = acc;
          break;
        }
      }
    }
    if (!matched) {
      const n = Math.min(fallbackWidth, bytes.length - i);
      code = 0;
      for (let k = 0; k < n; k++) code = code * 256 + bytes[i + k];
      matched = n;
    }
    out.push({ code, start: i, len: matched });
    i += matched;
  }
  return out;
}
