/**
 * Minimal ZIP archive writer (STORED / no compression)
 * IHatePDF - 100% Client-Side Architecture
 *
 * PDF page streams are already internally compressed, so re-compressing
 * (DEFLATE) would burn CPU for negligible size savings. STORED entries let
 * this stay dependency-free (no jszip) while producing a spec-valid ZIP any
 * OS or archive tool can open.
 */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): { time: number; date: number } {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

/**
 * Builds a STORED-method ZIP archive from a set of named byte buffers.
 */
export function createZip(entries: ZipEntryInput[]): Uint8Array {
  const { time, date } = dosDateTime();
  const encoder = new TextEncoder();

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true); // version needed
    localHeader.setUint16(6, 0, true); // flags
    localHeader.setUint16(8, 0, true); // method: stored
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, date, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, size, true); // compressed size
    localHeader.setUint32(22, size, true); // uncompressed size
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true); // extra field length

    localParts.push(new Uint8Array(localHeader.buffer), nameBytes, entry.data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true); // version made by
    centralHeader.setUint16(6, 20, true); // version needed
    centralHeader.setUint16(8, 0, true); // flags
    centralHeader.setUint16(10, 0, true); // method: stored
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, date, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, size, true);
    centralHeader.setUint32(24, size, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true); // extra field length
    centralHeader.setUint16(32, 0, true); // comment length
    centralHeader.setUint16(34, 0, true); // disk number start
    centralHeader.setUint16(36, 0, true); // internal attrs
    centralHeader.setUint32(38, 0, true); // external attrs
    centralHeader.setUint32(42, offset, true); // local header offset

    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += localHeader.byteLength + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  const totalSize = offset + centralSize + eocd.byteLength;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, new Uint8Array(eocd.buffer)]) {
    out.set(part, pos);
    pos += part.length;
  }

  return out;
}

// ------------------------------------------------------------------ streaming

interface ByteSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

/**
 * Writes a STORED ZIP entry by entry to a sink, with each entry's data also
 * streamed (CRC and sizes follow the data in a descriptor), so neither the
 * archive nor any single entry has to be held in memory.
 */
export class ZipStreamWriter {
  private readonly central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  private readonly encoder = new TextEncoder();
  private readonly stamp = dosDateTime();

  constructor(private readonly sink: ByteSink) {}

  private async put(b: Uint8Array) {
    this.offset += b.length;
    if (this.offset > 0xffffffff) throw new Error('This ZIP would be larger than 4 GB. Split into fewer, smaller groups.');
    await this.sink.write(b);
  }

  /** Adds an entry whose data is produced by `writeData` through the given sink. */
  async addEntry(name: string, writeData: (sink: ByteSink) => Promise<void>) {
    const nameBytes = this.encoder.encode(name);
    const start = this.offset;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0808, true); // data descriptor + UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint16(10, this.stamp.time, true);
    local.setUint16(12, this.stamp.date, true);
    local.setUint16(26, nameBytes.length, true);
    await this.put(new Uint8Array(local.buffer));
    // A copy: sinks may take ownership of what they're given, and the name is needed again below.
    await this.put(nameBytes.slice());
    const table = getCrcTable();
    let crc = 0xffffffff;
    let size = 0;
    await writeData({
      write: async (chunk) => {
        for (let i = 0; i < chunk.length; i++) crc = table[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
        size += chunk.length;
        await this.put(chunk);
      },
    });
    crc = (crc ^ 0xffffffff) >>> 0;
    const desc = new DataView(new ArrayBuffer(16));
    desc.setUint32(0, 0x08074b50, true);
    desc.setUint32(4, crc, true);
    desc.setUint32(8, size, true);
    desc.setUint32(12, size, true);
    await this.put(new Uint8Array(desc.buffer));
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0808, true);
    c.setUint16(12, this.stamp.time, true);
    c.setUint16(14, this.stamp.date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, start, true);
    this.central.push(new Uint8Array(c.buffer), nameBytes);
    this.count++;
  }

  async finish() {
    const cdStart = this.offset;
    for (const part of this.central) await this.put(part);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, Math.min(this.count, 0xffff), true);
    e.setUint16(10, Math.min(this.count, 0xffff), true);
    e.setUint32(12, this.offset - cdStart, true);
    e.setUint32(16, cdStart, true);
    await this.put(new Uint8Array(e.buffer));
  }
}
