/**
 * Runs every PDF tool the way the app does — input as a disk-backed Blob
 * read on demand, output streamed to a file — one tool per child process,
 * and reports each one's time and peak memory. Outputs are checked with
 * qpdf (via pikepdf).
 *
 *   npx tsx scripts/test-streaming-tools.ts <input.pdf> [tool ...]
 *
 * Tools: merge split split-zip rotate organize crop watermark numbers
 * compress protect unlock pdfa sign redact repair images jpgzip
 */
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import type { OutputSink } from '../src/services/workerOutput';
import type { ToolOutput } from '../src/types/worker';

// ------------------------------------------------------------ disk-backed Blob

/** A Blob over a byte range of a file on disk, like a picked File in the browser. */
class DiskBlob extends Blob {
  constructor(
    readonly path: string,
    readonly start = 0,
    readonly end = statSync(path).size,
    readonly mime = ''
  ) {
    super([]);
  }
  override get size() {
    return this.end - this.start;
  }
  override get type() {
    return this.mime;
  }
  override slice(s = 0, e = this.size, type = '') {
    const clamp = (v: number) => (v < 0 ? Math.max(0, this.size + v) : Math.min(v, this.size));
    return new DiskBlob(this.path, this.start + clamp(s), this.start + Math.max(clamp(s), clamp(e)), type);
  }
  readSync(): ArrayBuffer {
    const n = this.size;
    const buf = new ArrayBuffer(n);
    const fd = openSync(this.path, 'r');
    try {
      let done = 0;
      while (done < n) done += readSync(fd, new Uint8Array(buf, done, n - done), 0, n - done, this.start + done);
    } finally {
      closeSync(fd);
    }
    return buf;
  }
  override async arrayBuffer() {
    return this.readSync();
  }
}

// What workers have: synchronous Blob reads.
(globalThis as Record<string, unknown>).FileReaderSync = class {
  readAsArrayBuffer(b: Blob) {
    if (b instanceof DiskBlob) return b.readSync();
    throw new Error('FileReaderSync polyfill: only DiskBlob');
  }
};

/** An output sink writing straight to a file (the desktop app's temp file). */
function fileSink(path: string): OutputSink {
  const fd = openSync(path, 'w');
  let size = 0;
  return {
    write(chunk) {
      writeSync(fd, chunk);
      size += chunk.length;
    },
    async close(): Promise<ToolOutput> {
      closeSync(fd);
      return { kind: 'stream', id: 'test', size };
    },
    abort() {
      closeSync(fd);
    },
  };
}

// ------------------------------------------------------------ one tool (child)

async function runTool(tool: string, input: string, out: string) {
  const blob = new DiskBlob(input, 0, statSync(input).size, 'application/pdf');
  const name = basename(input);
  const sink = fileSink(out);
  const t0 = Date.now();
  const progress = () => undefined;
  const photos = '/tmp/ihp-stress/fx/photos';
  const jpg = (p: string) => new DiskBlob(p, 0, statSync(p).size, 'image/jpeg');
  let r: { size: number; pageCount?: number; note?: string };
  switch (tool) {
    case 'merge': {
      const { mergePdfs } = await import('../src/features/merge/merge.worker');
      r = await mergePdfs([{ name, buffer: blob }, { name, buffer: blob }], progress, 'merged.pdf', sink);
      break;
    }
    case 'split': {
      const { splitPdf } = await import('../src/features/split/split.worker');
      r = await splitPdf(blob, name, [{ from: 1, to: 2 }], progress, { sink });
      break;
    }
    case 'split-zip': {
      const { splitPdf } = await import('../src/features/split/split.worker');
      r = await splitPdf(blob, name, 'all', progress, { sink });
      break;
    }
    case 'rotate': {
      const { rotatePdfPages } = await import('../src/features/rotate/rotate.worker');
      r = await rotatePdfPages(blob, name, [], 90, progress, sink);
      break;
    }
    case 'organize': {
      const { organizePdfPages } = await import('../src/features/organize/organize.worker');
      const { openPdf } = await import('../src/services/pdfLoader');
      const n = (await openPdf(blob)).getPageCount();
      r = await organizePdfPages(blob, name, Array.from({ length: n }, (_, i) => n - 1 - i), [], progress, [], sink);
      break;
    }
    case 'crop': {
      const { cropPdf } = await import('../src/features/crop/crop.worker');
      r = await cropPdf({ fileBuffer: blob, fileName: name, margins: { top: 10, right: 10, bottom: 10, left: 10 } }, progress, sink);
      break;
    }
    case 'watermark': {
      const { applyWatermark } = await import('../src/features/watermark/watermark.worker');
      r = await applyWatermark(
        { fileBuffer: blob, fileName: name, mode: 'text', text: 'CONFIDENTIAL', fontSize: 48, color: '#cc0000', opacity: 0.3, rotationDegrees: 45, position: 'middle-center', layer: 'above', tile: true },
        progress,
        sink
      );
      break;
    }
    case 'numbers': {
      const { addPageNumbers } = await import('../src/features/pageNumbers/pageNumbers.worker');
      r = await addPageNumbers(
        { fileBuffer: blob, fileName: name, format: 'n', template: 'Page {n} of {total}', position: 'bottom-center', fontSize: 10, color: '#000000', marginMm: 10, startPage: 1, startingNumber: 1 },
        progress,
        sink
      );
      break;
    }
    case 'compress': {
      const { compressPdf } = await import('../src/features/compress/compress.worker');
      r = await compressPdf(blob, name, 'recommended', progress, undefined, sink);
      break;
    }
    case 'protect': {
      const { protectPdf } = await import('../src/features/protect/protect.worker');
      r = await protectPdf({ fileBuffer: blob, fileName: name, userPassword: 'test-pw' }, progress, sink);
      break;
    }
    case 'unlock': {
      const { unlockPdf } = await import('../src/features/unlock/unlock.worker');
      r = await unlockPdf({ fileBuffer: blob, fileName: name, password: 'test-pw' }, progress, sink);
      break;
    }
    case 'pdfa': {
      const { convertToPdfa } = await import('../src/features/pdfToPdfa/pdfToPdfa.worker');
      r = await convertToPdfa({ fileBuffer: blob, fileName: name }, progress, sink);
      break;
    }
    case 'sign': {
      const { stampSignature } = await import('../src/features/sign/sign.worker');
      const png = new DiskBlob(resolve('test-fixtures/misc/photo2.png'));
      r = await stampSignature(
        { fileBuffer: blob, fileName: name, signatureImageBytes: png.readSync(), placements: [{ pageIndex: 0, x: 50, y: 50, width: 150, height: 60 }] },
        progress,
        sink
      );
      break;
    }
    case 'redact': {
      const { redactPdf } = await import('../src/features/redact/redact.worker');
      const files = readdirSync(photos).slice(0, 20);
      r = await redactPdf(
        { fileBuffer: blob, fileName: name, stripMetadata: true, pages: files.map((f, i) => ({ pageIndex: i, jpeg: jpg(join(photos, f)), widthPt: 595, heightPt: 842 })) },
        progress,
        sink
      );
      break;
    }
    case 'repair': {
      const { repairPdf } = await import('../src/features/repair/repair.worker');
      r = await repairPdf({ fileBuffer: blob, fileName: name }, progress, sink);
      break;
    }
    case 'images': {
      const { imagesToPdf } = await import('../src/features/imageToPdf/imagesToPdf.worker');
      const files = readdirSync(photos).sort();
      r = await imagesToPdf(
        { images: files.map((f) => ({ bytes: jpg(join(photos, f)), type: 'jpg' as const })), orientation: 'auto', margin: 'small', pageSize: 'a4', fileName: 'photos' },
        progress,
        sink
      );
      break;
    }
    case 'jpgzip': {
      const { buildJpgZip } = await import('../src/features/pdfToJpg/pdfToJpg.worker');
      const files = readdirSync(photos).sort();
      r = await buildJpgZip({ images: files.map((f, i) => ({ pageNumber: i + 1, bytes: jpg(join(photos, f)) })), fileName: 'photos', ext: 'jpg' }, progress, sink);
      break;
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
  const ms = Date.now() - t0;
  const peakMB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(JSON.stringify({ ok: true, ms, peakMB, size: r.size, pageCount: r.pageCount, note: r.note }));
}

// ------------------------------------------------------------ driver (parent)

const ALL = ['merge', 'split', 'split-zip', 'rotate', 'organize', 'crop', 'watermark', 'numbers', 'compress', 'protect', 'unlock', 'pdfa', 'sign', 'redact', 'repair', 'images', 'jpgzip'];

function check(out: string, tool: string): string {
  if (tool === 'split-zip' || tool === 'jpgzip') {
    return execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print(len(z.namelist()), "entries; CRC", "OK" if bad is None else "BAD "+bad)', out]).toString().trim();
  }
  const pw = tool === 'protect' ? 'test-pw' : '';
  return execFileSync('python3', [
    '-c',
    `import pikepdf,sys
p=pikepdf.open(sys.argv[1], password=sys.argv[2])
bad=[str(w) for w in p.check_pdf_syntax() if 'error' in str(w).lower()]
n=len(p.pages)
# touch every page's content so a broken stream is noticed
for pg in p.pages: pg.obj.get('/Contents')
print(n, 'pages;', 'encrypted' if p.is_encrypted else 'plain', '; qpdf problems:', len(bad), bad[:2])`,
    out,
    pw,
  ])
    .toString()
    .trim();
}

if (process.argv[2] === '--child') {
  const [, , , tool, input, out] = process.argv;
  runTool(tool, input, out).catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
} else {
  const input = resolve(process.argv[2]);
  const tools = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
  const OUT = resolve('test-fixtures/stream-out');
  mkdirSync(OUT, { recursive: true });
  const inMB = (fstatSync(openSync(input, 'r')).size / 1048576).toFixed(1);
  console.log(`Input: ${basename(input)} (${inMB} MB)\n`);
  let failed = 0;
  let protectedOut = '';
  for (const tool of tools) {
    const ext = tool === 'split-zip' || tool === 'jpgzip' ? 'zip' : 'pdf';
    const out = join(OUT, `${tool}.${ext}`);
    // Unlock runs on Protect's output when there is one.
    const src = tool === 'unlock' && protectedOut ? protectedOut : input;
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/test-streaming-tools.ts', '--child', tool, src, out], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const line = res.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const r = line ? JSON.parse(line) : { ok: false, error: (res.stderr || '').trim().split('\n').slice(-3).join(' | ') };
    let verdict = '';
    if (r.ok) {
      try {
        verdict = check(out, tool);
        if (/problems: [1-9]|BAD/.test(verdict)) r.ok = false;
      } catch (e) {
        r.ok = false;
        verdict = `check failed: ${(e as Error).message.split('\n')[0]}`;
      }
    }
    if (!r.ok) failed++;
    const outMB = r.size ? (r.size / 1048576).toFixed(1) : '-';
    console.log(
      `${r.ok ? 'OK  ' : 'FAIL'} ${tool.padEnd(10)} ${r.ok ? `${(r.ms / 1000).toFixed(1).padStart(6)} s  peak ${String(r.peakMB).padStart(5)} MB  out ${outMB.padStart(7)} MB | ${verdict}${r.note ? ` | ${r.note}` : ''}` : r.error || verdict}`
    );
    if (tool === 'protect' && r.ok) protectedOut = out;
    else if (!process.env.KEEP_OUT) rmSync(out, { force: true });
  }
  if (protectedOut && !process.env.KEEP_OUT) rmSync(protectedOut, { force: true });
  if (failed) process.exit(1);
}
