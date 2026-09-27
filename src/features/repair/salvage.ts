/**
 * Byte-level salvage for PDFs pdf-lib refuses to parse.
 *
 * The usual damage is a truncated download: the file stops in the middle of
 * its last object, which in modern PDFs is often a compressed object stream
 * holding the page dictionaries. Losing that stream loses every page, so:
 *  - a truncated Flate object stream is partially inflated and rewritten as
 *    an uncompressed stream containing only the objects that arrived whole;
 *  - any other object pdf-lib chokes on is blanked out (offsets preserved)
 *    or, when it runs to the end of the file, cut off.
 * pdf-lib recovers a missing trailer by locating the /Catalog itself.
 */

import { Inflate, Z_SYNC_FLUSH } from 'pako';

const latin1 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const toBytes = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function partialInflate(data: Uint8Array): Uint8Array {
  const inf = new Inflate();
  inf.push(data, Z_SYNC_FLUSH);
  const chunks = (inf as unknown as { chunks: Uint8Array[] }).chunks ?? [];
  return inf.result instanceof Uint8Array && inf.result.length ? inf.result : concat(chunks);
}

/** Rebuilds a truncated object stream from whatever inflates; null when nothing usable arrived. */
function rebuildObjectStream(header: string, body: Uint8Array, objNum: string, gen: string): string | null {
  if (!/\/Type\s*\/ObjStm/.test(header) || !/\/FlateDecode/.test(header) || /\/DecodeParms/.test(header)) return null;
  const first = Number(/\/First\s+(\d+)/.exec(header)?.[1]);
  if (!Number.isFinite(first)) return null;
  const data = latin1(partialInflate(body));
  if (data.length <= first) return null;
  const nums = data.slice(0, first).trim().split(/\s+/).map(Number);
  const entries: Array<{ num: number; off: number }> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) entries.push({ num: nums[i], off: nums[i + 1] });
  // Keep objects whose successor starts inside the recovered data (so they're complete).
  const whole = entries.filter((e, i) => {
    const end = i + 1 < entries.length ? entries[i + 1].off : Infinity;
    return first + end <= data.length;
  });
  if (!whole.length) return null;
  const last = entries.indexOf(whole[whole.length - 1]);
  const bodyEnd = last + 1 < entries.length ? first + entries[last + 1].off : data.length;
  const table = whole.map((e) => `${e.num} ${e.off}`).join(' ') + ' ';
  const objects = data.slice(first, bodyEnd);
  const content = table + objects;
  return `${objNum} ${gen} obj\n<< /Type /ObjStm /N ${whole.length} /First ${table.length} /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
}

/** One salvage pass. `failOffset` (from pdf-lib's error) points at the object it couldn't read. */
export function salvagePdfBytes(bytes: Uint8Array, failOffset?: number): Uint8Array | null {
  const text = latin1(bytes);
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let start = -1;
  let m: RegExpExecArray | null;
  let match: RegExpExecArray | null = null;
  if (failOffset !== undefined) {
    objRe.lastIndex = Math.max(0, failOffset - 2);
    match = objRe.exec(text);
    if (match && match.index - failOffset > 32) match = null;
  }
  if (!match) {
    // No usable offset: take the last object that has no endobj.
    const lastEnd = text.lastIndexOf('endobj');
    objRe.lastIndex = lastEnd < 0 ? 0 : lastEnd;
    while ((m = objRe.exec(text))) match = m;
  }
  if (!match) return null;
  start = match.index;
  const end = text.indexOf('endobj', start);
  if (end >= 0) {
    // Mid-file corruption: blank the object out, keeping every other offset valid.
    const out = bytes.slice();
    out.fill(0x20, start, end + 6);
    return out;
  }
  // Truncated at the end of the file.
  const streamAt = text.indexOf('stream', start);
  let replacement = '';
  if (streamAt > 0) {
    let dataStart = streamAt + 6;
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;
    replacement = rebuildObjectStream(text.slice(start, streamAt), bytes.subarray(dataStart), match[1], match[2]) ?? '';
  }
  return concat([bytes.subarray(0, start), toBytes(replacement + '\n%%EOF\n')]);
}
