/**
 * Low-memory PDF I/O: opens PDFs as an index (lazyPdf.ts) and streams saves
 * (pdfStreamSave.ts), then checks the output with qpdf (via pikepdf) and
 * against pdf-lib's own full parse. Usage: npx tsx scripts/test-lazy-io.ts [files...]
 */
import { openSync, readSync, fstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadLazyPdf } from '../src/services/lazyPdf';
import { saveToSink } from '../src/services/pdfStreamSave';
import type { ByteSource } from '../src/services/byteSource';

class FileSource implements ByteSource {
  readonly size: number;
  private fd: number;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }
  read(offset: number, length: number) {
    const n = Math.max(0, Math.min(length, this.size - offset));
    const b = Buffer.allocUnsafe(n);
    readSync(this.fd, b, 0, n, offset);
    return new Uint8Array(b.buffer, b.byteOffset, n);
  }
}

const OUT = resolve('test-fixtures/lazy-out');
mkdirSync(OUT, { recursive: true });
const files = process.argv.slice(2);
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const rss0 = process.memoryUsage().rss;
  const doc = loadLazyPdf(new FileSource(f));
  if (!doc) {
    console.log(`FALLBACK  ${basename(f)} (full parser will be used)`);
    continue;
  }
  const pages = doc.getPageCount();
  const tLoad = Date.now() - t0;
  const out = `${OUT}/${basename(f)}`;
  const fd = openSync(out, 'w');
  const { writeSync, closeSync } = await import('node:fs');
  const size = await saveToSink(doc, { write: (c) => void writeSync(fd, c) });
  closeSync(fd);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const rssMB = Math.round((process.memoryUsage().rss - rss0) / 1048576);
  const check = execFileSync('python3', ['-c', `import pikepdf,sys
p=pikepdf.open(sys.argv[1])
bad=[w for w in p.check() if 'error' in w.lower()] if hasattr(p,'check') else []
print(len(p.pages), 'pages;', 'qpdf problems:', len(bad), bad[:2])`, out]).toString().trim();
  let pdfLibPages: number | string = '(skipped, large)';
  if (size < 200 * 1024 * 1024) pdfLibPages = (await PDFDocument.load(readFileSync(out), { ignoreEncryption: true })).getPageCount();
  const ok = check.startsWith(`${pages} pages`) && check.includes('problems: 0') && (typeof pdfLibPages === 'string' || pdfLibPages === pages);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${basename(f)}: ${pages} pages, load ${tLoad} ms, total ${secs}s, +${rssMB} MB RSS, out ${(size / 1048576).toFixed(1)} MB | qpdf: ${check} | pdf-lib reopens: ${pdfLibPages}`);
}
if (failed) process.exit(1);
