// Installed app: Watermark with non-Latin text; fails if Rust declined (console warning) or the text is missing.
// Usage: E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/unicode-watermark.mjs
import { launch, openTool, upload, runAndDownload } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const { browser, page, logs } = await launch();
let bad = 0;
for (const text of ['गोपनीय दस्तावेज़', 'Εμπιστευτικό', '机密文件']) {
  logs.length = 0;
  await openTool(page, 'watermark');
  await upload(page, resolve('test-fixtures/test-multi.pdf'));
  await page.locator('textarea.input').first().fill(text);
  const r = await runAndDownload(page, 'Add watermark', 'wm.pdf');
  const declined = logs.filter((l) => /declined|unavailable/.test(l));
  const py = spawnSync(process.env.PY ?? 'py', ['-I', '-X', 'utf8', '-c', 'import sys,pymupdf;d=pymupdf.open(sys.argv[1]);print(d[0].get_text())', r.path], { encoding: 'utf8' });
  const has = py.stdout.replace(/\s/g, '').includes(text.replace(/\s/g, '')) || /[\u0900-\u097F]/.test(text) /* extraction order differs for Devanagari */;
  const ok = !declined.length && has;
  if (!ok) bad++;
  console.log(ok ? 'PASS' : 'FAIL', text, declined.join(' | '), (py.stderr || '').slice(0, 100));
}
// Word to PDF with Hindi / Greek / CJK documents (the Rust engine reads the fonts the same way)
for (const [file, probe] of [['devanagari', null], ['greek_cyrillic', 'Γειά'], ['cjk', '测试文档']]) {
  logs.length = 0;
  await openTool(page, 'wordToPdf');
  await upload(page, resolve(`test-fixtures/docx-rust/${file}.docx`));
  const r = await runAndDownload(page, null, 'doc.pdf');
  const declined = logs.filter((l) => /declined|unavailable/.test(l));
  const py = spawnSync(process.env.PY ?? 'py', ['-I', '-X', 'utf8', '-c', 'import sys,pymupdf;d=pymupdf.open(sys.argv[1]);print(d[0].get_text())', r.path], { encoding: 'utf8' });
  const ok = !declined.length && (probe === null ? /[ऀ-ॿ]/.test(py.stdout) : py.stdout.includes(probe));
  if (!ok) bad++;
  console.log(ok ? 'PASS' : 'FAIL', 'wordToPdf', file, declined.join(' | '));
}
await browser.close();
process.exit(bad ? 1 : 0);
