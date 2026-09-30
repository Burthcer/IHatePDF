/**
 * Saves a pdf-lib document as a stream of chunks instead of one big buffer.
 *
 * pdf-lib's writers first plan the file (every object's size and offset,
 * the cross-reference table or stream) and then copy everything into a
 * single Uint8Array. We reuse the planning step and write each object out
 * on its own, so the output never exists in memory as a whole — and
 * streams still sitting in the source file (LazyRawStream) are copied
 * across in chunks without ever being loaded.
 */

import { PDFDocument, PDFName, PDFNumber, PDFStreamWriter, PDFWriter, CharCodes, type PDFDict, type PDFObject, type PDFRef } from 'pdf-lib';
import { LazyRawStream } from './lazyPdf';
import { memoryCheckpoint } from './workerMemory';

export interface ChunkSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

export interface StreamSaveOptions {
  useObjectStreams?: boolean;
  addDefaultPage?: boolean;
  updateFieldAppearances?: boolean;
  objectsPerTick?: number;
  /** Skip save()'s preparation (flush etc.) — for documents already prepared (encryption). */
  prepared?: boolean;
}

const CHUNK = 4 * 1024 * 1024;
const enc = new TextEncoder();

/**
 * Buffers small writes into ~4 MB chunks. The buffer starts small and grows
 * as needed, so saving thousands of tiny files (Split) stays cheap.
 */
class ChunkedOut {
  private buf = new Uint8Array(64 * 1024);
  private used = 0;
  written = 0;
  constructor(private readonly sink: ChunkSink) {}

  async put(bytes: Uint8Array) {
    this.written += bytes.length;
    if (bytes.length >= CHUNK) {
      await this.flush();
      await this.sink.write(bytes);
      return;
    }
    if (this.used + bytes.length > CHUNK) await this.flush();
    if (this.used + bytes.length > this.buf.length) {
      const grown = new Uint8Array(Math.min(CHUNK, Math.max(this.buf.length * 2, this.used + bytes.length)));
      grown.set(this.buf.subarray(0, this.used));
      this.buf = grown;
    }
    this.buf.set(bytes, this.used);
    this.used += bytes.length;
  }

  putString(s: string) {
    return this.put(enc.encode(s));
  }

  async flush() {
    if (!this.used) return;
    const out = this.buf.slice(0, this.used);
    this.used = 0;
    await this.sink.write(out);
    // A chunk is written: pause here while memory is over the budget.
    await memoryCheckpoint();
  }
}

const STREAM_START = enc.encode('\nstream\n');
const STREAM_END = enc.encode('\nendstream');

async function writeObject(out: ChunkedOut, object: PDFObject) {
  if (object instanceof LazyRawStream && object.isLazy) {
    // Same bytes PDFStream.copyBytesInto would produce, with the data pulled from the source file.
    object.dict.set(PDFName.of('Length'), PDFNumber.of(object.getContentsSize()));
    const d = new Uint8Array(object.dict.sizeInBytes());
    object.dict.copyBytesInto(d, 0);
    await out.put(d);
    await out.put(STREAM_START);
    if (object.transform) {
      const data = await object.transform.apply(object.readSource());
      if (data.length !== object.getContentsSize()) throw new Error('Stream transform changed size unexpectedly.');
      await out.put(data);
    } else {
      for (let pos = 0; pos < object.length; pos += CHUNK) {
        await out.put(object.source.read(object.start + pos, Math.min(CHUNK, object.length - pos)));
      }
    }
    await out.put(STREAM_END);
    return;
  }
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  await out.put(bytes);
}

interface WritePlan {
  size: number;
  header: PDFObject;
  indirectObjects: Array<[PDFRef, PDFObject]>;
  xref?: PDFObject;
  trailerDict?: PDFObject;
  trailer: PDFObject;
}

async function planSave(doc: PDFDocument, options: StreamSaveOptions): Promise<WritePlan> {
  const { useObjectStreams = true, addDefaultPage = true, updateFieldAppearances = true, objectsPerTick = 50, prepared = false } = options;
  if (!prepared) {
    // Mirrors PDFDocument.save().
    if (addDefaultPage && doc.getPageCount() === 0) doc.addPage();
    if (updateFieldAppearances) {
      const form = (doc as unknown as { formCache: { getValue(): { updateFieldAppearances(): void } | undefined } }).formCache.getValue();
      form?.updateFieldAppearances();
    }
    await doc.flush();
  }
  const writer = (useObjectStreams ? PDFStreamWriter : PDFWriter).forContext(doc.context, objectsPerTick) as unknown as {
    computeBufferSize(): Promise<WritePlan>;
  };
  return writer.computeBufferSize();
}

/** The size `doc` would have when saved, without writing anything. */
export async function measurePdf(doc: PDFDocument, options: StreamSaveOptions = {}): Promise<number> {
  return (await planSave(doc, options)).size;
}

/** Streams `doc` to `sink`; returns the number of bytes written. */
export async function saveToSink(doc: PDFDocument, sink: ChunkSink, options: StreamSaveOptions = {}): Promise<number> {
  const plan = await planSave(doc, options);
  const out = new ChunkedOut(sink);
  await writeObject(out, plan.header);
  await out.put(new Uint8Array([CharCodes.Newline, CharCodes.Newline]));
  let n = 0;
  for (const [ref, object] of plan.indirectObjects) {
    await out.putString(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    await writeObject(out, object);
    await out.putString('\nendobj\n\n');
    if (++n % 500 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (plan.xref) {
    await writeObject(out, plan.xref);
    await out.put(new Uint8Array([CharCodes.Newline]));
  }
  if (plan.trailerDict) {
    await writeObject(out, plan.trailerDict);
    await out.put(new Uint8Array([CharCodes.Newline, CharCodes.Newline]));
  }
  await writeObject(out, plan.trailer);
  await out.flush();
  if (out.written !== plan.size) throw new Error(`PDF writer size mismatch (${out.written} ≠ ${plan.size}).`);
  return out.written;
}

/** A stream whose bytes are produced only when the writer gets to it. */
export interface DeferredStream {
  /** Called once, when this object is written; returns its dictionary entries and bytes. */
  produce(): Promise<{ dict: PDFDict; bytes: Uint8Array }>;
}

/**
 * Writes `doc` front to back with a classic cross-reference table, so no
 * object's size has to be known in advance: objects in `deferred` (reserved
 * with doc.context.nextRef()) are produced one at a time as the writer reaches
 * them, written, and dropped. Redact uses it so thousands of page images
 * never exist at once.
 */
export async function saveSequential(doc: PDFDocument, sink: ChunkSink, deferred: Map<PDFRef, DeferredStream>): Promise<number> {
  if (doc.getPageCount() === 0) doc.addPage();
  await doc.flush();
  const context = doc.context;
  const out = new ChunkedOut(sink);
  const header = new Uint8Array(context.header.sizeInBytes());
  context.header.copyBytesInto(header, 0);
  await out.put(header);
  await out.put(new Uint8Array([CharCodes.Newline, CharCodes.Newline]));

  const objects = new Map<number, [PDFRef, PDFObject | DeferredStream]>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) objects.set(ref.objectNumber, [ref, obj]);
  for (const [ref, d] of deferred) objects.set(ref.objectNumber, [ref, d]);
  const numbers = [...objects.keys()].sort((a, b) => a - b);
  const offsets = new Map<number, { offset: number; gen: number }>();
  let n = 0;
  for (const num of numbers) {
    const [ref, obj] = objects.get(num)!;
    offsets.set(num, { offset: out.written, gen: ref.generationNumber });
    await out.putString(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    if (deferred.has(ref)) {
      const { dict, bytes } = await (obj as DeferredStream).produce();
      dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
      const d = new Uint8Array(dict.sizeInBytes());
      dict.copyBytesInto(d, 0);
      await out.put(d);
      await out.put(STREAM_START);
      await out.put(bytes);
      await out.put(STREAM_END);
    } else {
      await writeObject(out, obj as PDFObject);
    }
    await out.putString('\nendobj\n\n');
    if (++n % 500 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const size = (numbers[numbers.length - 1] ?? 0) + 1;
  const xrefOffset = out.written;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    const o = offsets.get(i);
    xref += o ? `${String(o.offset).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n` : '0000000000 00000 f \n';
    if (xref.length > 1 << 20) {
      await out.putString(xref);
      xref = '';
    }
  }
  await out.putString(xref);
  const info = context.trailerInfo;
  const trailer = context.obj({ Size: size });
  if (info.Root) trailer.set(PDFName.of('Root'), info.Root);
  if (info.Info) trailer.set(PDFName.of('Info'), info.Info as PDFObject);
  if (info.ID) trailer.set(PDFName.of('ID'), info.ID as PDFObject);
  const t = new Uint8Array(trailer.sizeInBytes());
  trailer.copyBytesInto(t, 0);
  await out.putString('trailer\n');
  await out.put(t);
  await out.putString(`\nstartxref\n${xrefOffset}\n%%EOF`);
  await out.flush();
  return out.written;
}

/** Collects a streamed save into one buffer (tests, small outputs). */
export async function saveToBuffer(doc: PDFDocument, options: StreamSaveOptions = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const size = await saveToSink(doc, { write: (c) => void parts.push(c) }, options);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
