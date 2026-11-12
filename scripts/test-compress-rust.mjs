// Runs the Rust Compress CLI over fixture PDFs at every level (+ a custom size) and checks
// each result with scripts/e2e/pdf_regress.py (pages, text, pixels).
// Build first: cd crates/ihp-core && cargo build --release
// Usage: PY=<python> node scripts/test-compress-rust.mjs [files...]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const cli = resolve('crates/ihp-core/target/release/ihp-compress.exe');
const py = process.env.PY ?? 'python';
const out = resolve('test-fixtures/compress-rust');
mkdirSync(out, { recursive: true });
const pdfs = process.argv.length > 2 ? process.argv.slice(2) : (process.env.DIRS ?? 'quality,scans,complex,.').split(',')
  .flatMap((d) => { try { const dir = resolve('test-fixtures', d); return readdirSync(dir).filter((f) => f.endsWith('.pdf') && !f.includes('encrypted') && !/rc4|aes/.test(f)).map((f) => join(dir, f)); } catch { return []; } });

const pairs = [];
let failed = 0;
for (const pdf of pdfs) {
  const size = statSync(pdf).size;
  const levels = ['low', 'recommended', 'extreme', `custom:${Math.floor(size * 0.4)}`];
  for (const level of levels) {
    const dst = join(out, `${basename(pdf, '.pdf')}__${level.replace(':', '_')}.pdf`);
    const r = spawnSync(cli, [pdf, dst, level], { encoding: 'utf8' });
    console.log(`${basename(pdf)} [${level}] ${r.status === 0 ? r.stdout.trim().slice(0, 150) : 'ERROR ' + r.stderr.trim()}`);
    if (r.status !== 0) { failed++; continue; }
    pairs.push(pdf, dst);
  }
}
const res = spawnSync(py, ['scripts/e2e/pdf_regress.py', ...pairs], { encoding: 'utf8' });
console.log(res.stdout + res.stderr);
process.exit(failed || res.status ? 1 : 0);
