// A/B for the PDFium text route vs pdf.js: runs PDF to Markdown / Word / Excel on the same files both ways in the
// running Tauri app and saves the outputs to test-fixtures/layout-ab/{native,pdfjs}/ (compare: scripts/layout-ab-compare.py).
// Usage: E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/layout-ab.mjs [files...]
import { launch, openTool, upload, runAndDownload } from './harness.mjs';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const files = process.argv.length > 2 ? process.argv.slice(2) : ['test-fixtures/complex/complex.pdf', 'test-fixtures/scans/journal_10p.pdf', 'test-fixtures/quality/q_word.pdf', 'test-fixtures/test-multi.pdf', 'test-fixtures/e2e-out/excel.pdf', 'test-fixtures/e2e-out/word.pdf'];
const tools = { pdfToMarkdown: ['md', null], pdfToWord: ['docx', 'Convert to Word'], pdfToExcel: ['xlsx', 'Convert to Excel'] };
const out = resolve('test-fixtures/layout-ab');
const { browser, page } = await launch();
for (const mode of ['native', 'pdfjs']) {
  mkdirSync(join(out, mode), { recursive: true });
  for (const [tool, [ext, action]] of Object.entries(tools)) {
    for (const f of files) {
      const name = `${basename(f, '.pdf')}.${ext}`;
      try {
        await openTool(page, tool);
        if (mode === 'pdfjs') {
          // No desktop bridge: pdf.js reads the text; the result is captured from the blob the page saves.
          await page.evaluate(() => {
            delete window.ihpDesktop;
            window.__blobs = [];
            const o = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); };
          });
          await upload(page, resolve(f));
          if (action) await page.getByRole('button', { name: action }).first().click({ timeout: 60000 });
          await page.getByRole('button', { name: 'Save now' }).click({ timeout: 60000 });
          await page.waitForFunction(() => window.__blobs.length > 0, null, { timeout: 30000 });
          const b64 = await page.evaluate(async () => { const buf = new Uint8Array(await window.__blobs[0].arrayBuffer()); let s = ''; for (const c of buf) s += String.fromCharCode(c); return btoa(s); });
          (await import('node:fs')).writeFileSync(join(out, mode, name), Buffer.from(b64, 'base64'));
        } else {
          await upload(page, resolve(f));
          const r = await runAndDownload(page, action, `ab_${name}`, 60000);
          copyFileSync(r.path, join(out, mode, name));
        }
      } catch (e) {
        console.log(`${mode} ${tool} ${basename(f)}: ${String(e.message).split('\n')[0].slice(0, 120)}`);
      }
    }
  }
}
await browser.close();
console.log('done', readdirSync(join(out, 'native')).length, readdirSync(join(out, 'pdfjs')).length);
