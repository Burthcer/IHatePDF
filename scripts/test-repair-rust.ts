/**
 * Repair: how many pages (with their text) each engine recovers from damaged files.
 * Makes damaged copies of real PDFs (truncated, bad startxref, junk before the header, flipped bytes,
 * a zeroed block, a broken catalog), runs the TypeScript repair and the Rust (PDFium) one on each,
 * and checks the results with MuPDF.
 *   cd crates/ihp-core && cargo build --release
 *   PY=<python> npx tsx scripts/test-repair-rust.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repairPdf } from '../src/features/repair/repair.worker';

const OUT = resolve('test-fixtures/repair-rust');
mkdirSync(OUT, { recursive: true });
const CLI = resolve('crates/ihp-core/target/release/ihp-repair.exe');
const DLL = resolve('src-tauri/resources/pdfium.dll');
const PY = process.env.PY ?? 'python';

const sources: Record<string, string> = {
  complex: 'test-fixtures/complex/complex.pdf',
  journal: 'test-fixtures/scans/journal_10p.pdf',
  scan: 'test-fixtures/scans/scan_10MB.pdf',
  word: 'test-fixtures/quality/q_word.pdf',
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const damage: Record<string, (b: Buffer) => Buffer> = {
  truncate97: (b) => b.subarray(0, Math.floor(b.length * 0.97)),
  truncate80: (b) => b.subarray(0, Math.floor(b.length * 0.8)),
  truncate50: (b) => b.subarray(0, Math.floor(b.length * 0.5)),
  badStartxref: (b) => Buffer.from(b.toString('latin1').replace(/startxref\s+\d+/g, 'startxref\n999999999'), 'latin1'),
  noTrailer: (b) => Buffer.from(b.toString('latin1').replace(/trailer[\s\S]*$/, ''), 'latin1'),
  junkPrefix: (b) => Buffer.concat([Buffer.alloc(1000, 0x41), b]),
  flipBytes: (b) => {
    const r = rng(7);
    const c = Buffer.from(b);
    for (let i = 0; i < 200; i++) c[Math.floor(b.length * 0.2 + r() * b.length * 0.6)] ^= 0xff;
    return c;
  },
  zeroBlock: (b) => {
    const c = Buffer.from(b);
    c.fill(0, Math.floor(b.length / 2), Math.min(b.length, Math.floor(b.length / 2) + 4096));
    return c;
  },
  brokenCatalog: (b) => Buffer.from(b.toString('latin1').replace(/\/Type\s*\/Catalog/g, '/Type /Cataloq'), 'latin1'),
};

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const rows: Array<{ file: string; ts: number; rust: number }> = [];
const pairs: string[] = [];
for (const [sname, spath] of Object.entries(sources)) {
  const src = readFileSync(resolve(spath));
  for (const [dname, fn] of Object.entries(damage)) {
    const name = `${sname}__${dname}`;
    const damaged = resolve(OUT, `${name}.pdf`);
    writeFileSync(damaged, fn(src));
    let ts = 0;
    try {
      const r = await repairPdf({ fileBuffer: ab(readFileSync(damaged)), fileName: 'x.pdf' });
      writeFileSync(resolve(OUT, `ts_${name}.pdf`), Buffer.from(r.buffer!));
      ts = r.pageCount ?? 0;
    } catch {
      ts = 0;
    }
    const rs = resolve(OUT, `rs_${name}.pdf`);
    const run = spawnSync(CLI, [DLL, damaged, rs], { encoding: 'utf8' });
    const rust = run.status === 0 ? Number(run.stdout.trim().split(' ')[1]) : 0;
    rows.push({ file: name, ts, rust });
    if (rust) pairs.push(rs);
  }
}
console.table(rows);
const better = rows.filter((r) => r.rust > r.ts).length;
const worse = rows.filter((r) => r.rust < r.ts).length;
console.log(`Rust recovers more pages in ${better} case(s), fewer in ${worse}, the same in ${rows.length - better - worse}.`);
const check = spawnSync(PY, ['-c', `
import sys, pymupdf
bad = 0
for p in sys.argv[1:]:
    try:
        d = pymupdf.open(p)
        n = len(d); chars = sum(len(d[i].get_text()) for i in range(min(n, 3)))
        w = pymupdf.TOOLS.mupdf_warnings()
        if n == 0 or w: print('WARN', p.split(chr(92))[-1], n, 'pages', w.replace(chr(10), ' | ')[:100]); bad += 1
    except Exception as e:
        print('UNREADABLE', p.split(chr(92))[-1], e); bad += 1
print('Rust outputs checked with MuPDF:', len(sys.argv) - 1, 'files,', bad, 'with warnings or unreadable')
`, ...pairs], { encoding: 'utf8' });
console.log(check.stdout + check.stderr);
