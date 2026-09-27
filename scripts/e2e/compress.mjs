// E2E: every compression level, plus custom target sizes, on the big fixtures.
// Requires `vite preview` on :4173. Usage: node scripts/e2e/compress.mjs [file.pdf]
import { launch, openTool, upload, runAndDownload } from './harness.mjs';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test-fixtures/big/scan_photos.pdf'];
const cases = [
  { level: 'Light' },
  { level: 'Balanced' },
  { level: 'Smallest' },
  { level: 'Custom size', target: '10', unit: 'MB' },
  { level: 'Custom size', target: '2', unit: 'MB' },
  { level: 'Custom size', target: '400', unit: 'KB' },
];
const { browser, page, logs } = await launch();
const rows = [];
for (const file of files) {
  const orig = statSync(file).size;
  for (const c of cases) {
    await openTool(page, 'compress');
    await upload(page, file);
    await page.getByRole('button', { name: new RegExp('^' + c.level) }).click();
    if (c.target) {
      await page.getByLabel('Target size').fill(c.target);
      await page.getByLabel('Unit').selectOption(c.unit);
    }
    const t0 = Date.now();
    try {
      const r = await runAndDownload(page, /^Compress/, `compress-${basename(file, '.pdf')}-${c.level.split(' ')[0]}${c.target ?? ''}.pdf`, 600_000);
      const targetBytes = c.target ? +c.target * (c.unit === 'MB' ? 1048576 : 1024) : null;
      rows.push({
        file: basename(file), level: c.level + (c.target ? ` ${c.target}${c.unit}` : ''),
        orig: (orig / 1048576).toFixed(2) + 'MB', out: (r.size / 1048576).toFixed(2) + 'MB',
        underTarget: targetBytes ? r.size <= targetBytes : '', secs: ((Date.now() - t0) / 1000).toFixed(1),
        note: (await page.locator('aside').innerText()).split('\n').filter((l) => /→|image|target|already/i.test(l)).join(' | ').slice(0, 160),
      });
    } catch (e) {
      rows.push({ file: basename(file), level: c.level, error: String(e.message).slice(0, 200) });
    }
  }
}
console.table(rows);
if (logs.length) console.log(logs.join('\n'));
await browser.close();
