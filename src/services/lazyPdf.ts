/**
 * Opens a PDF as an index instead of loading it: the cross-reference table
 * says where every object lives, dictionaries are parsed from small reads,
 * and stream data (images, page contents, fonts) stays on disk as
 * `LazyRawStream`s that read their bytes only when something asks for them.
 * A 1 GB scan opens in a few MB; tools that only rearrange pages or add
 * overlays never touch most of the file, and saving copies the untouched
 * data straight from the source in chunks (see pdfStreamSave.ts).
 *
 * Anything unusual — encryption, a damaged or missing cross-reference table,
 * objects not where the table says — returns null, and the caller falls back
 * to pdf-lib's full, repairing parser.
 */

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectParser,
  PDFRawStream,
  PDFRef,
  type PDFObjectParser as ParserType,
} from 'pdf-lib';
import type { ByteSource } from './byteSource';
import { streamBytes } from '../features/editPdf/engine/pdfObjects';

// ------------------------------------------------------------------ lazy streams

/** Rewrites a stream's bytes on the way out (encryption); `size` must be exact. */
export interface StreamTransform {
  size(length: number): number;
  apply(bytes: Uint8Array): Promise<Uint8Array>;
}

const EMPTY = new Uint8Array(0);
// PDFRawStream's constructor is private in the typings but a normal constructor at runtime.
const RawStreamBase = PDFRawStream as unknown as new (dict: PDFDict, contents: Uint8Array) => PDFRawStream;

export class LazyRawStream extends RawStreamBase {
  declare readonly source: ByteSource;
  declare readonly start: number;
  declare readonly length: number;
  declare transform?: StreamTransform;
  /** Bytes assigned after creation (then this behaves like a normal raw stream). */
  declare override?: Uint8Array;

  constructor(dict: PDFDict, source: ByteSource, start: number, length: number, transform?: StreamTransform) {
    super(dict, EMPTY);
    Object.assign(this, { source, start, length, transform });
  }

  /** True while the bytes still live only in the source file. */
  get isLazy(): boolean {
    return !this.override;
  }

  readSource(): Uint8Array {
    return this.source.read(this.start, this.length);
  }

  getContentsSize(): number {
    if (this.override) return this.override.length;
    return this.transform ? this.transform.size(this.length) : this.length;
  }

  clone(context?: PDFContext): PDFRawStream {
    if (this.override) return PDFRawStream.of(this.dict.clone(context), this.override.slice());
    return new LazyRawStream(this.dict.clone(context), this.source, this.start, this.length, this.transform);
  }
}

// `contents` is a plain field on PDFRawStream; make it read through to the source.
Object.defineProperty(LazyRawStream.prototype, 'contents', {
  configurable: true,
  get(this: LazyRawStream) {
    if (this.override) return this.override;
    if (this.transform) throw new Error('This stream is transformed on save; its bytes are not available.');
    return this.readSource();
  },
  set(this: LazyRawStream, value: Uint8Array) {
    // PDFRawStream's constructor assigns the placeholder; later assignments are real contents.
    if (value && value !== EMPTY) this.override = value;
  },
});

export const isLazyStream = (o: unknown): o is LazyRawStream => o instanceof LazyRawStream && o.isLazy;

// ------------------------------------------------------------------ byte helpers

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x4000) s += String.fromCharCode(...b.subarray(i, i + 0x4000));
  return s;
};

function startsWith(b: Uint8Array, at: number, word: string): boolean {
  if (at + word.length > b.length) return false;
  for (let i = 0; i < word.length; i++) if (b[at + i] !== word.charCodeAt(i)) return false;
  return true;
}

function skipWs(b: Uint8Array, i: number): number {
  for (;;) {
    while (i < b.length && WS.has(b[i])) i++;
    if (b[i] === 0x25) {
      // comment
      while (i < b.length && b[i] !== 0x0a && b[i] !== 0x0d) i++;
      continue;
    }
    return i;
  }
}

type Entry = { type: 'free' } | { type: 'offset'; offset: number; gen: number } | { type: 'compressed'; stm: number; index: number };

class NotLazy extends Error {}
const fail = (why: string): never => {
  throw new NotLazy(why);
};

// ------------------------------------------------------------------ loader

interface Pending {
  ref: PDFRef;
  dict: PDFDict;
  dataStart: number;
  length: PDFObject | undefined;
}

class LazyLoader {
  private readonly context = PDFContext.create();
  private readonly entries = new Map<number, Entry>();
  private trailer: PDFDict | null = null;
  private readonly pending: Pending[] = [];

  constructor(private readonly src: ByteSource) {}

  load(): PDFDocument {
    const head = this.src.read(0, 1024);
    if (latin1(head).indexOf('%PDF-') !== 0) fail('header not at offset 0');
    const tailLen = Math.min(this.src.size, 4096);
    const tail = latin1(this.src.read(this.src.size - tailLen, tailLen));
    const at = tail.lastIndexOf('startxref');
    if (at < 0) fail('no startxref');
    const m = /startxref\s+(\d+)/.exec(tail.slice(at));
    if (!m) fail('bad startxref');
    this.readXrefChain(Number(m![1]));
    if (!this.trailer) fail('no trailer');
    if (this.trailer!.get(PDFName.of('Encrypt'))) fail('encrypted');

    // Objects stored directly in the file.
    // In file order: each read lands next to the previous one (fast on hard disks too).
    const direct: Array<[number, { offset: number; gen: number }]> = [];
    for (const [num, e] of this.entries) if (e.type === 'offset' && num !== 0) direct.push([num, e]);
    direct.sort((a, b) => a[1].offset - b[1].offset);
    for (const [num, e] of direct) this.loadDirect(num, e.offset, e.gen);
    // Streams need /Length, which may be an indirect object loaded above.
    this.pending.sort((a, b) => a.dataStart - b.dataStart);
    for (const p of this.pending) this.finishStream(p);
    // Objects packed inside object streams.
    const byStream = new Map<number, Array<{ num: number; index: number }>>();
    for (const [num, e] of this.entries) {
      if (e.type !== 'compressed') continue;
      if (!byStream.has(e.stm)) byStream.set(e.stm, []);
      byStream.get(e.stm)!.push({ num, index: e.index });
    }
    for (const [stm, wanted] of byStream) this.loadFromObjectStream(stm, wanted);

    const t = this.trailer!;
    this.context.trailerInfo = {
      Root: t.get(PDFName.of('Root')),
      Encrypt: undefined,
      Info: t.get(PDFName.of('Info')),
      ID: t.get(PDFName.of('ID')),
    };
    const Doc = PDFDocument as unknown as new (context: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;
    const doc = new Doc(this.context, true, false);
    if (!(doc.catalog.lookup(PDFName.of('Pages')) instanceof PDFDict)) fail('no page tree');
    if (doc.getPageCount() < 1) fail('no pages');
    return doc;
  }

  // -------------------------------------------------------------- xref

  private readXrefChain(first: number) {
    const seen = new Set<number>();
    let offset: number | undefined = first;
    while (offset !== undefined) {
      if (seen.has(offset) || offset <= 0 || offset >= this.src.size) fail('bad xref offset');
      seen.add(offset);
      const b = this.src.read(offset, 64);
      const trailer: PDFDict = startsWith(b, skipWs(b, 0), 'xref') ? this.readXrefTable(offset) : this.readXrefStream(offset);
      if (!this.trailer) this.trailer = trailer;
      const hybrid = trailer.get(PDFName.of('XRefStm'));
      if (hybrid instanceof PDFNumber) this.readXrefStream(hybrid.asNumber());
      const prev: PDFObject | undefined = trailer.get(PDFName.of('Prev'));
      offset = prev instanceof PDFNumber ? prev.asNumber() : undefined;
    }
  }

  /** Newer sections are read first; they win. */
  private addEntry(num: number, e: Entry) {
    if (!this.entries.has(num)) this.entries.set(num, e);
  }

  private readXrefTable(offset: number): PDFDict {
    // Read enough to cover the table and trailer; grow if needed.
    for (let win = 64 * 1024; ; win *= 4) {
      const b = this.src.read(offset, win);
      const text = latin1(b);
      const t = text.indexOf('trailer');
      const dictStart = t < 0 ? -1 : text.indexOf('<<', t);
      if (dictStart < 0 || text.indexOf('>>', dictStart) < 0) {
        if (offset + win >= this.src.size) fail('xref table without trailer');
        continue;
      }
      const tokens = text.slice(text.indexOf('xref') + 4, t).trim().split(/\s+/);
      let i = 0;
      while (i + 1 < tokens.length) {
        const start = Number(tokens[i++]);
        const count = Number(tokens[i++]);
        if (!Number.isInteger(start) || !Number.isInteger(count)) fail('bad xref subsection');
        for (let k = 0; k < count; k++) {
          const off = Number(tokens[i++]);
          const gen = Number(tokens[i++]);
          const kind = tokens[i++];
          if (kind === 'n') this.addEntry(start + k, { type: 'offset', offset: off, gen });
          else if (kind === 'f') this.addEntry(start + k, { type: 'free' });
          else fail('bad xref entry');
        }
      }
      try {
        const parser = PDFObjectParser.forBytes(b.subarray(dictStart), this.context);
        const dict = parser.parseObject();
        if (!(dict instanceof PDFDict)) fail('bad trailer');
        return dict as PDFDict;
      } catch (e) {
        if (e instanceof NotLazy || offset + win >= this.src.size) throw e;
      }
    }
  }

  private readXrefStream(offset: number): PDFDict {
    const { dict, dataStart, length } = this.parseStreamHeader(offset);
    if (dict.get(PDFName.of('Type')) !== PDFName.of('XRef')) fail('not an xref stream');
    const len = length instanceof PDFNumber ? length.asNumber() : fail('xref stream length');
    const raw = PDFRawStream.of(dict, this.src.read(dataStart, len as number).slice());
    const data = streamBytes(raw) ?? fail('undecodable xref stream');
    const W = dict.lookup(PDFName.of('W'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    const size = (dict.lookup(PDFName.of('Size'), PDFNumber) as PDFNumber).asNumber();
    const indexArr = dict.lookup(PDFName.of('Index'));
    const index = indexArr instanceof PDFArray ? indexArr.asArray().map((n) => (n as PDFNumber).asNumber()) : [0, size];
    const rowLen = W[0] + W[1] + W[2];
    let pos = 0;
    const field = (width: number, dflt: number) => {
      if (width === 0) return dflt;
      let v = 0;
      for (let k = 0; k < width; k++) v = v * 256 + (data as Uint8Array)[pos++];
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let k = 0; k < index[s + 1]; k++) {
        if (pos + rowLen > (data as Uint8Array).length) fail('short xref stream');
        const type = field(W[0], 1);
        const f2 = field(W[1], 0);
        const f3 = field(W[2], 0);
        const num = index[s] + k;
        if (type === 0) this.addEntry(num, { type: 'free' });
        else if (type === 1) this.addEntry(num, { type: 'offset', offset: f2, gen: f3 });
        else if (type === 2) this.addEntry(num, { type: 'compressed', stm: f2, index: f3 });
      }
    }
    return dict;
  }

  // -------------------------------------------------------------- objects

  /** Parses "N G obj <dict> stream" at `offset`, returning where the data starts. */
  private parseStreamHeader(offset: number): { num: number; gen: number; dict: PDFDict; dataStart: number; length: PDFObject | undefined } {
    const r = this.parseAt(offset);
    if (!r.stream) fail('expected a stream');
    return { num: r.num, gen: r.gen, dict: r.value as PDFDict, dataStart: r.dataStart!, length: (r.value as PDFDict).get(PDFName.of('Length')) };
  }

  /**
   * Parses the indirect object at `offset`. Non-stream objects are fully
   * parsed; for streams only the dictionary is, and `dataStart` says where
   * the data begins.
   */
  private parseAt(offset: number): { num: number; gen: number; value: PDFObject; stream: boolean; dataStart?: number } {
    for (let win = 16 * 1024; ; win *= 4) {
      const avail = Math.min(win, this.src.size - offset);
      const b = this.src.read(offset, avail);
      const complete = offset + avail >= this.src.size;
      const head = /^\s*(\d+)\s+(\d+)\s+obj/.exec(latin1(b.subarray(0, 64)));
      if (!head) fail(`no object at ${offset}`);
      let i = skipWs(b, head![0].length);
      try {
        const parser = PDFObjectParser.forBytes(b, this.context) as ParserType & {
          bytes: { moveTo(n: number): void; offset(): number };
          parseDict(): PDFDict;
        };
        parser.bytes.moveTo(i);
        if (b[i] === 0x3c && b[i + 1] === 0x3c) {
          const dict = parser.parseDict();
          i = skipWs(b, parser.bytes.offset());
          if (startsWith(b, i, 'stream')) {
            i += 6;
            if (b[i] === 0x0d) i++;
            if (b[i] === 0x0a) i++;
            return { num: Number(head![1]), gen: Number(head![2]), value: dict, stream: true, dataStart: offset + i };
          }
          if (!startsWith(b, i, 'endobj') && !complete) throw new Error('window');
          return { num: Number(head![1]), gen: Number(head![2]), value: dict, stream: false };
        }
        const value = parser.parseObject();
        i = skipWs(b, parser.bytes.offset());
        if (!startsWith(b, i, 'endobj') && !complete) throw new Error('window');
        return { num: Number(head![1]), gen: Number(head![2]), value, stream: false };
      } catch (e) {
        if (e instanceof NotLazy) throw e;
        if (complete || win > 64 * 1024 * 1024) fail(`unparsable object at ${offset}`);
      }
    }
  }

  private loadDirect(num: number, offset: number, gen: number) {
    const r = this.parseAt(offset);
    if (r.num !== num || r.gen !== gen) fail(`object ${num} not at its xref offset`);
    const ref = PDFRef.of(num, gen);
    if (r.stream) {
      const dict = r.value as PDFDict;
      const type = dict.get(PDFName.of('Type'));
      if (type === PDFName.of('XRef')) return; // cross-reference data, rebuilt on save
      this.pending.push({ ref, dict, dataStart: r.dataStart!, length: dict.get(PDFName.of('Length')) });
    } else {
      this.context.assign(ref, r.value);
    }
  }

  private resolveLength(length: PDFObject | undefined): number | null {
    if (length instanceof PDFNumber) return length.asNumber();
    if (length instanceof PDFRef) {
      const v = this.context.lookup(length);
      if (v instanceof PDFNumber) return v.asNumber();
    }
    return null;
  }

  private finishStream(p: Pending) {
    let len = this.resolveLength(p.length);
    if (len === null || !this.endsWithEndstream(p.dataStart + len)) len = this.scanForEndstream(p.dataStart);
    const stream = new LazyRawStream(p.dict, this.src, p.dataStart, len);
    if (p.dict.get(PDFName.of('Type')) === PDFName.of('ObjStm')) {
      this.objectStreams.set(p.ref.objectNumber, stream);
      return; // unpacked below; pdf-lib's writer builds its own
    }
    this.context.assign(p.ref, stream);
  }

  private readonly objectStreams = new Map<number, LazyRawStream>();

  private endsWithEndstream(at: number): boolean {
    const b = this.src.read(at, 32);
    return startsWith(b, skipWs(b, 0), 'endstream');
  }

  /** For a wrong or missing /Length: find "endstream" (bounded). */
  private scanForEndstream(from: number): number {
    const CHUNK = 1024 * 1024;
    for (let pos = from; pos < this.src.size && pos - from < 256 * 1024 * 1024; pos += CHUNK - 16) {
      const text = latin1(this.src.read(pos, CHUNK));
      const i = text.indexOf('endstream');
      if (i >= 0) {
        let end = pos + i;
        const before = this.src.read(Math.max(from, end - 2), Math.min(2, end - from));
        for (let k = before.length - 1; k >= 0 && (before[k] === 0x0a || before[k] === 0x0d); k--) end--;
        return end - from;
      }
    }
    return fail('stream without endstream');
  }

  private loadFromObjectStream(stm: number, wanted: Array<{ num: number; index: number }>) {
    const stream = this.objectStreams.get(stm) ?? fail(`missing object stream ${stm}`);
    const data = streamBytes(stream as LazyRawStream) ?? fail('undecodable object stream');
    const n = (stream.dict.lookup(PDFName.of('N'), PDFNumber) as PDFNumber).asNumber();
    const first = (stream.dict.lookup(PDFName.of('First'), PDFNumber) as PDFNumber).asNumber();
    const header = latin1((data as Uint8Array).subarray(0, first)).trim().split(/\s+/).map(Number);
    const offsets: number[] = [];
    for (let k = 0; k < n; k++) offsets.push(header[k * 2 + 1]);
    for (const { num, index } of wanted) {
      if (index >= n || header[index * 2] !== num) fail(`object ${num} not in its object stream`);
      const parser = PDFObjectParser.forBytes(data as Uint8Array, this.context) as ParserType & { bytes: { moveTo(n: number): void } };
      parser.bytes.moveTo(first + offsets[index]);
      this.context.assign(PDFRef.of(num, 0), parser.parseObject());
    }
  }
}

/** Opens `src` lazily, or returns null if the caller should load it fully. */
export function loadLazyPdf(src: ByteSource): PDFDocument | null {
  try {
    return new LazyLoader(src).load();
  } catch (e) {
    if (typeof process !== 'undefined' && process.env?.IHP_DEBUG_LAZY) console.warn('lazy load fell back:', e instanceof Error ? e.message : e);
    return null;
  }
}
