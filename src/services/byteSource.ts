/**
 * Random-access, synchronous reads of a PDF that may be far larger than we
 * want in memory. In the app's workers a picked file is a disk-backed Blob:
 * `FileReaderSync` (workers only) reads just the slice asked for, so a 2 GB
 * PDF costs no more memory than the parts actually touched.
 */

export interface ByteSource {
  readonly size: number;
  /** Returns `length` bytes starting at `offset` (fewer at the end of the file). */
  read(offset: number, length: number): Uint8Array;
}

/** An in-memory PDF. */
export class BufferSource implements ByteSource {
  readonly size: number;
  constructor(private readonly bytes: Uint8Array) {
    this.size = bytes.length;
  }
  read(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, Math.min(this.size, offset + length));
  }
}

const BLOCK = 256 * 1024;
const MAX_CACHED_BLOCKS = 32; // ≤ 8 MB of cache

/**
 * A Blob read on demand. Small reads (object dictionaries while parsing) go
 * through a small LRU block cache; large reads (image and page data) bypass it.
 */
export class BlobSource implements ByteSource {
  readonly size: number;
  private readonly reader: { readAsArrayBuffer(blob: Blob): ArrayBuffer };
  private readonly cache = new Map<number, Uint8Array>();

  constructor(private readonly blob: Blob) {
    this.size = blob.size;
    const Sync = (globalThis as unknown as { FileReaderSync?: new () => { readAsArrayBuffer(blob: Blob): ArrayBuffer } }).FileReaderSync;
    if (!Sync) throw new Error('BlobSource needs FileReaderSync (a worker).');
    this.reader = new Sync();
  }

  private direct(offset: number, end: number): Uint8Array {
    return new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(offset, end)));
  }

  private block(index: number): Uint8Array {
    let b = this.cache.get(index);
    if (b) {
      this.cache.delete(index);
      this.cache.set(index, b);
      return b;
    }
    b = this.direct(index * BLOCK, Math.min(this.size, (index + 1) * BLOCK));
    this.cache.set(index, b);
    if (this.cache.size > MAX_CACHED_BLOCKS) this.cache.delete(this.cache.keys().next().value as number);
    return b;
  }

  read(offset: number, length: number): Uint8Array {
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    if (end - offset >= BLOCK) return this.direct(offset, end);
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    if (first === last) return this.block(first).subarray(offset - first * BLOCK, end - first * BLOCK);
    const out = new Uint8Array(end - offset);
    let pos = 0;
    for (let i = first; i <= last; i++) {
      const b = this.block(i);
      const from = Math.max(0, offset - i * BLOCK);
      const to = Math.min(b.length, end - i * BLOCK);
      out.set(b.subarray(from, to), pos);
      pos += to - from;
    }
    return out;
  }
}

/** Whether this runtime can read Blobs synchronously (dedicated workers). */
export const canReadBlobsSync = () => typeof (globalThis as { FileReaderSync?: unknown }).FileReaderSync === 'function';
