// Installed app: PowerPoint to PDF end to end on real decks. Each must come out through the Rust engine (no fallback
// warning) with the same page count as PowerPoint's own PDF (<deck>.ref.pdf from scripts/make-ppt-decks.ps1 / the
// real-deck set in test-fixtures/pptx-real) and its first slide's words present.
// Usage: E2E_CDP=http://127.0.0.1:9333 node scripts/e2e/ppt-native.mjs [deck.pptx ...]
import { launch, openTool, upload, runAndDownload } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const decks = process.argv.slice(2).length ? process.argv.slice(2) : ['real22_Combined_Presentation', 'real14_HTTP', 'real29_Web_Technology', 'theme_Ion', 'backgrounds_text_tables'].map((n) => `test-fixtures/pptx-real/${n}.pptx`);
const { browser, page, logs } = await launch();
const py = process.env.PY ?? 'py';
let bad = 0;
for (const d of decks) {
  if (!existsSync(d)) continue;
  logs.length = 0;
  await openTool(page, 'pptToPdf');
  await upload(page, resolve(d));
  const t0 = Date.now();
  const r = await runAndDownload(page, null, 'ppt-native.pdf'); // the tool starts on upload
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ref = d.replace(/\.pptx$/, '.ref.pdf');
  const info = JSON.parse(execFileSync(py, ['-c', `
import sys, json, pymupdf
a = pymupdf.open(sys.argv[1]); b = pymupdf.open(sys.argv[2]) if len(sys.argv) > 2 else None
print(json.dumps({'pages': len(a), 'ref': len(b) if b else None, 'words': len(a[0].get_text().split())}))`, r.path, ...(existsSync(ref) ? [ref] : [])], { encoding: 'utf8' }));
  const fallbacks = logs.filter((l) => /declined/.test(l));
  const ok = info.words > 0 && !fallbacks.length && (info.ref === null || info.ref === info.pages);
  if (!ok) bad++;
  console.log(ok ? 'PASS' : 'FAIL', d.split('/').pop(), `${info.pages} pages (PowerPoint: ${info.ref}), ${info.words} words on slide 1, ${secs}s`, fallbacks.join(' | ').slice(0, 160));
}
await browser.close();
process.exit(bad ? 1 : 0);
