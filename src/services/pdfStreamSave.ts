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

import { PDFDocument, PDFName, PDFNumber, PDFStreamWriter, PDFWriter, CharCodes, type PDFObject, type PDFRef } from 'pdf-lib';
import { LazyRawStream } from './lazyPdf';

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
