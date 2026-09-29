/**
 * Streaming .zip writer for folders and multi-file shares. Files are stored,
 * not compressed: it's as fast as copying, the size is known up front (so the
 * phone shows real download progress), and phones open it natively. ZIP64
 * kicks in automatically past 4 GB / 65 535 entries.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX32 = 0xffffffff;

const SKIP_REASONS = {
  EACCES: 'no permission',
  EPERM: 'no permission',
  EBUSY: 'in use by another program',
  ELOOP: 'link loop',
  ENOENT: 'no longer there',
  ENOTDIR: 'no longer there',
};

/**
 * Every file and empty folder under `items` (absolute paths), with names as
 * they'll appear in the zip. What can't be read — folders without permission,
 * files locked by another program, broken links, folders that link back into
 * themselves (Windows junction loops) — is skipped and listed in `skipped`
 * instead of failing the whole share.
 */
function collect(items, skipped = []) {
  const entries = [];
  const seenDirs = new Set();
  const skip = (name, err) => skipped.push({ name, reason: SKIP_REASONS[err?.code] ?? 'unreadable' });
  const walk = (abs, name) => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      return skip(name, err);
    }
    if (st.isFile()) {
      try {
        fs.closeSync(fs.openSync(abs, 'r')); // readable now (not locked, allowed)?
      } catch (err) {
        return skip(name, err);
      }
      return entries.push({ abs, name, size: st.size, mtime: st.mtime, dir: false });
    }
    if (!st.isDirectory()) return;
    let real;
    let children;
    try {
      real = fs.realpathSync.native(abs);
      children = fs.readdirSync(abs);
    } catch (err) {
      return skip(`${name}/`, err);
    }
    // A link to a folder we're already inside (or have already added) would repeat forever.
    if (seenDirs.has(real)) return skip(`${name}/`, { code: 'ELOOP' });
    seenDirs.add(real);
    if (!children.length) entries.push({ abs, name: `${name}/`, size: 0, mtime: st.mtime, dir: true });
    for (const child of children) walk(path.join(abs, child), `${name}/${child}`);
  };
  for (const item of items) walk(item, path.basename(item));
  return entries;
}

function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Layout of every entry, computed up front so the total size is known before streaming.
function plan(entries) {
  let offset = 0;
  const planned = entries.map((e) => {
    const name = Buffer.from(e.name, 'utf8');
    const zip64 = e.size >= MAX32 || offset >= MAX32;
    const localLen = 30 + name.length + (zip64 ? 20 : 0);
    const p = { ...e, nameBuf: name, zip64, offset, localLen, descLen: zip64 ? 24 : 16 };
    offset += localLen + e.size + p.descLen;
    return p;
  });
  const cdStart = offset;
  let cdLen = 0;
  for (const p of planned) {
    const extra = (p.size >= MAX32 ? 16 : 0) + (p.offset >= MAX32 ? 8 : 0);
    p.cdExtra = extra ? extra + 4 : 0;
    cdLen += 46 + p.nameBuf.length + p.cdExtra;
  }
  const zip64End = planned.length > 0xffff || cdStart >= MAX32 || cdLen >= MAX32;
  return { planned, cdStart, cdLen, zip64End, total: cdStart + cdLen + (zip64End ? 56 + 20 : 0) + 22 };
}

function localHeader(p) {
  const { time, date } = dosTime(p.mtime);
  const b = Buffer.alloc(p.localLen);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(p.zip64 ? 45 : 20, 4);
  b.writeUInt16LE(0x0808, 6); // sizes/CRC follow in a data descriptor; UTF-8 names
  b.writeUInt16LE(0, 8); // stored
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  // CRC and sizes (bytes 14-25) left 0: they're in the data descriptor.
  if (p.zip64) {
    b.writeUInt32LE(MAX32, 18);
    b.writeUInt32LE(MAX32, 22);
  }
  b.writeUInt16LE(p.nameBuf.length, 26);
  b.writeUInt16LE(p.zip64 ? 20 : 0, 28);
  p.nameBuf.copy(b, 30);
  if (p.zip64) {
    const x = 30 + p.nameBuf.length;
    b.writeUInt16LE(1, x);
    b.writeUInt16LE(16, x + 2);
    b.writeBigUInt64LE(BigInt(p.size), x + 4);
    b.writeBigUInt64LE(BigInt(p.size), x + 12);
  }
  return b;
}

function descriptor(p) {
  const b = Buffer.alloc(p.descLen);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(p.crc, 4);
  if (p.zip64) {
    b.writeBigUInt64LE(BigInt(p.size), 8);
    b.writeBigUInt64LE(BigInt(p.size), 16);
  } else {
    b.writeUInt32LE(p.size, 8);
    b.writeUInt32LE(p.size, 12);
  }
  return b;
}

function centralEntry(p) {
  const { time, date } = dosTime(p.mtime);
  const b = Buffer.alloc(46 + p.nameBuf.length + p.cdExtra);
  const bigSize = p.size >= MAX32;
  const bigOffset = p.offset >= MAX32;
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(45, 4);
  b.writeUInt16LE(p.zip64 || p.cdExtra ? 45 : 20, 6);
  b.writeUInt16LE(0x0808, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(p.crc, 16);
  b.writeUInt32LE(bigSize ? MAX32 : p.size, 20);
  b.writeUInt32LE(bigSize ? MAX32 : p.size, 24);
  b.writeUInt16LE(p.nameBuf.length, 28);
  b.writeUInt16LE(p.cdExtra, 30);
  b.writeUInt32LE(p.dir ? 0x10 : 0, 38);
  b.writeUInt32LE(bigOffset ? MAX32 : p.offset, 42);
  p.nameBuf.copy(b, 46);
  if (p.cdExtra) {
    let x = 46 + p.nameBuf.length;
    b.writeUInt16LE(1, x);
    b.writeUInt16LE(p.cdExtra - 4, x + 2);
    x += 4;
    if (bigSize) {
      b.writeBigUInt64LE(BigInt(p.size), x);
      b.writeBigUInt64LE(BigInt(p.size), x + 8);
      x += 16;
    }
    if (bigOffset) b.writeBigUInt64LE(BigInt(p.offset), x);
  }
  return b;
}

function end({ planned, cdStart, cdLen, zip64End }) {
  const parts = [];
  const count = planned.length;
  if (zip64End) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdLen), 40);
    z.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdStart + cdLen), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(count, 0xffff), 8);
  e.writeUInt16LE(Math.min(count, 0xffff), 10);
  e.writeUInt32LE(Math.min(cdLen, MAX32), 12);
  e.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  parts.push(e);
  return Buffer.concat(parts);
}

/**
 * Zips `items` (files and/or folders). Returns the exact byte size and a
 * `pipe(writable)` that streams the archive and resolves when it's written.
 */
function createZip(items) {
  const layout = plan(collect(items));
  async function pipe(out) {
    const write = (buf) => {
      if (out.destroyed) throw new Error('The download was stopped.');
      if (out.write(buf)) return;
      return new Promise((resolve, reject) => {
        const done = (err) => {
          out.off('drain', done);
          out.off('close', closed);
          if (err) reject(err);
          else resolve();
        };
        const closed = () => done(new Error('The download was stopped.'));
        out.on('drain', done);
        out.on('close', closed);
      });
    };
    for (const p of layout.planned) {
      await write(localHeader(p));
      p.crc = 0;
      if (!p.dir) {
        let seen = 0;
        for await (const chunk of fs.createReadStream(p.abs)) {
          p.crc = zlib.crc32(chunk, p.crc);
          seen += chunk.length;
          await write(chunk);
        }
        if (seen !== p.size) throw new Error(`${p.name} changed while it was being shared.`);
      }
      await write(descriptor(p));
    }
    for (const p of layout.planned) await write(centralEntry(p));
    await write(end(layout));
  }
  return { size: layout.total, files: layout.planned.filter((p) => !p.dir).length, pipe };
}

module.exports = { createZip, collect };
