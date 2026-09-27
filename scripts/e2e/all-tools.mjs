// E2E: drives every tool in the built app (vite preview on :4173) with the
// dummy documents in test-fixtures/, saves each output and sanity-checks it.
// Usage: node scripts/e2e/all-tools.mjs [toolId ...]
import { launch, openTool, upload, runAndDownload, OUT } from './harness.mjs';
import { PDFDocument } from 'pdf-lib';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const F = (p) => resolve('test-fixtures', p);
const COMPLEX = F('complex/complex.pdf');
const MULTI = F('test-multi.pdf');

async function pdfPages(path, password) {
  const bytes = readFileSync(path);
  if (password) return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  return (await PDFDocument.load(bytes)).getPageCount();
}
const isZip = (path) => readFileSync(path).subarray(0, 2).toString() === 'PK';

const primary = (page, name) => page.getByRole('button', { name }).first();

const TOOLS = {
  async merge(page) {
    await upload(page, [COMPLEX, MULTI]);
    const r = await runAndDownload(page, /^Merge 2 files/, 'merge.pdf');
    return `${await pdfPages(r.path)} pages (expect 7)`;
  },
  async split(page) {
    await upload(page, MULTI);
    await page.getByText('Loading pages').waitFor({ state: 'detached' }).catch(() => {});
    const r = await runAndDownload(page, /^(Split into|Extract pages)/, 'split');
    return isZip(r.path) ? `zip ${r.size}B` : `${await pdfPages(r.path)} pages`;
  },
  async organize(page) {
    await upload(page, MULTI);
    await page.locator('main img').first().waitFor();
    await page.getByRole('button', { name: 'Reverse order' }).click();
    const r = await runAndDownload(page, 'Save new page order', 'organize.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async rotate(page) {
    await upload(page, MULTI);
    await page.locator('main img').first().waitFor();
    await page.locator('aside').getByRole('button', { name: 'Right' }).click();
    const r = await runAndDownload(page, /^Rotate \d/, 'rotate.pdf');
    const d = await PDFDocument.load(readFileSync(r.path));
    return `rotations ${d.getPages().map((p) => p.getRotation().angle).join(',')}`;
  },
  async crop(page) {
    await upload(page, MULTI);
    const r = await runAndDownload(page, /^Crop$/, 'crop.pdf');
    const d = await PDFDocument.load(readFileSync(r.path));
    const b = d.getPage(0).getCropBox();
    return `cropbox ${Math.round(b.width)}x${Math.round(b.height)}`;
  },
  async compare(page) {
    const inputs = page.locator('input[type=file]');
    await inputs.nth(0).setInputFiles(COMPLEX);
    await inputs.nth(1).setInputFiles(F('complex/edit_page2.pdf'));
    await primary(page, /^Compare$/).click();
    const stats = page.getByText(/\d+ changes? ·/).first();
    await stats.waitFor({ timeout: 60_000 });
    return (await stats.innerText()).replace(/\s+/g, ' ');
  },
  async editPdf(page) {
    await upload(page, COMPLEX);
    // Double-click the paragraph to edit it like a word processor.
    const blocks = page.locator('[title="Double-click to edit"]');
    await blocks.nth(2).waitFor({ timeout: 60_000 });
    await blocks.nth(2).dblclick();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Edited in the browser test.');
    await page.keyboard.press('Escape');
    await page.mouse.click(1300, 800);
    const r = await runAndDownload(page, null, 'edited.pdf');
    const { execFileSync } = await import('node:child_process');
    const text = execFileSync('node', ['scripts/e2e/items.mjs', r.path, '1'], { encoding: 'utf8' });
    if (!text.includes('Edited in the browser test.') || text.includes('Quarterly Operations')) throw new Error('edit not applied: ' + text.slice(0, 300));
    return `${await pdfPages(r.path)} pages, text replaced`;
  },
  async sign(page) {
    await upload(page, COMPLEX);
    await page.getByRole('radio', { name: 'Type' }).or(page.getByRole('button', { name: 'Type', exact: true })).first().click();
    await page.getByPlaceholder('Jane Appleseed').fill('Test Signer');
    await page.locator('.cursor-copy').first().click({ position: { x: 200, y: 300 } });
    const r = await runAndDownload(page, /^Sign \(1/, 'sign.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async forms(page) {
    await upload(page, COMPLEX);
    const field = page.locator('main input:not([type=checkbox])').first();
    await field.waitFor({ timeout: 30_000 });
    await field.fill('Zoë Test');
    const r = await runAndDownload(page, 'Save filled PDF', 'forms.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async watermark(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, 'Add watermark', 'watermark.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async pageNumbers(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, 'Add page numbers', 'numbers.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async redact(page) {
    await upload(page, COMPLEX);
    await page.getByPlaceholder('Word or phrase').fill('Revenue');
    await page.getByRole('button', { name: 'Mark all matches' }).click();
    await page.getByText(/match(es)? marked/).waitFor();
    const r = await runAndDownload(page, /^Redact \d/, 'redact.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async imageToPdf(page) {
    await upload(page, [F('misc/photo1.jpg'), F('misc/photo2.png')]);
    const r = await runAndDownload(page, /^Create PDF \(2/, 'images.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async wordToPdf(page) {
    await upload(page, F('test-document.docx'));
    const r = await runAndDownload(page, null, 'word.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async excelToPdf(page) {
    await upload(page, F('misc/book.xlsx'));
    const r = await runAndDownload(page, null, 'excel.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async pptToPdf(page) {
    await upload(page, F('test-slides.pptx'));
    const r = await runAndDownload(page, null, 'ppt.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async htmlToPdf(page) {
    await upload(page, F('misc/page.html'));
    await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('HTML Report'));
    const r = await runAndDownload(page, 'Create PDF', 'html.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async scanToPdf(page) {
    await page.locator('input[type=file]').last().setInputFiles(F('misc/photo1.jpg'));
    const use = page.getByRole('button', { name: /^(Use|Done|Save|Apply|Keep)/ }).first();
    if (await use.isVisible({ timeout: 10_000 }).catch(() => false)) await use.click();
    const r = await runAndDownload(page, /^Make PDF \(1/, 'scan.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async pdfToWord(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, 'Convert to Word', 'out.docx');
    return isZip(r.path) ? `docx ${r.size}B` : 'NOT A DOCX';
  },
  async pdfToExcel(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, 'Convert to Excel', 'out.xlsx');
    return isZip(r.path) ? `xlsx ${r.size}B` : 'NOT AN XLSX';
  },
  async pdfToPpt(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, 'Convert to PowerPoint', 'out.pptx');
    return isZip(r.path) ? `pptx ${r.size}B` : 'NOT A PPTX';
  },
  async pdfToJpg(page) {
    await upload(page, MULTI);
    const r = await runAndDownload(page, /^Export/, 'images');
    return isZip(r.path) ? `zip ${r.size}B` : `image ${r.size}B`;
  },
  async pdfToMarkdown(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, null, 'out.md');
    const md = readFileSync(r.path, 'utf8');
    return `md ${md.length} chars, table:${md.includes('| Region')} heading:${/^#/m.test(md)}`;
  },
  async compress(page) {
    await upload(page, F('big/scan_photos.pdf'));
    const r = await runAndDownload(page, /^Compress/, 'compress.pdf', 300_000);
    return `${(r.size / 1048576).toFixed(2)}MB`;
  },
  async repair(page) {
    const broken = resolve(OUT, 'broken.pdf');
    const b = readFileSync(COMPLEX);
    (await import('node:fs')).writeFileSync(broken, b.subarray(0, Math.floor(b.length * 0.97)));
    await upload(page, broken);
    const r = await runAndDownload(page, 'Repair', 'repaired.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async pdfToPdfa(page) {
    await upload(page, COMPLEX);
    const r = await runAndDownload(page, 'Convert to PDF/A-2b', 'pdfa.pdf');
    return `${await pdfPages(r.path)} pages`;
  },
  async protect(page) {
    await upload(page, COMPLEX);
    const pw = page.locator('input[type=password]');
    await pw.nth(0).fill('secret123');
    await pw.nth(1).fill('secret123');
    const r = await runAndDownload(page, 'Encrypt PDF', 'protected.pdf');
    return readFileSync(r.path).includes('/Encrypt') ? 'encrypted' : 'NOT ENCRYPTED';
  },
  async unlock(page) {
    const src = resolve(OUT, 'protected.pdf');
    if (!existsSync(src)) throw new Error('run protect first');
    await upload(page, src);
    const pw = page.locator('input[type=password]').first();
    await pw.waitFor({ timeout: 20_000 });
    await pw.fill('secret123');
    const r = await runAndDownload(page, 'Remove protection', 'unlocked.pdf');
    return `${await pdfPages(r.path)} pages, encrypted:${readFileSync(r.path).includes('/Encrypt')}`;
  },
};

const only = process.argv.slice(2);
const { browser, page, logs } = await launch();
const rows = [];
for (const [id, fn] of Object.entries(TOOLS)) {
  if (only.length && !only.includes(id)) continue;
  logs.length = 0;
  const t0 = Date.now();
  try {
    await openTool(page, id);
    const info = await fn(page);
    rows.push({ tool: id, ok: '✓', info, secs: ((Date.now() - t0) / 1000).toFixed(1) });
  } catch (e) {
    await page.screenshot({ path: resolve(OUT, `fail-${id}.png`), fullPage: true }).catch(() => {});
    rows.push({ tool: id, ok: '✗', info: String(e.message).split('\n')[0].slice(0, 160), secs: ((Date.now() - t0) / 1000).toFixed(1) });
  }
  const errs = logs.filter((l) => !/favicon|DevTools/.test(l));
  if (errs.length) rows[rows.length - 1].console = errs.slice(0, 2).join(' ; ').slice(0, 200);
}
console.table(rows);
await browser.close();
process.exit(rows.some((r) => r.ok !== '✓') ? 1 : 0);
