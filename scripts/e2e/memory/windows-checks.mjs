// Windows checks that aren't pass/fail runs of a tool (tests A, G and H in docs/testing/WINDOWS_TESTS.md):
//   idle   A. the app's memory on the home screen, then with the 500 MB scan open in Rotate
//   thumbs G. seconds until the first 12 thumbnails of the 50 MB scan show in Rotate, at budget 1024 and unset
//   text   H. Hindi and Chinese in Watermark and Edit PDF; outputs kept in test-fixtures/memory/text-check/
// Usage: node scripts/e2e/memory/windows-checks.mjs [only=idle,thumbs,text]
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, appMB, args, input, launch, record, scan } from './harness.mjs';

const o = args({ only: 'idle,thumbs,text' });
const want = new Set(o.only.split(','));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds until `n` thumbnails in the page have loaded, after adding `file` to `tool`. */
async function thumbs(win, tool, file, n = 12, timeoutMs = 10 * 60_000) {
  await win.evaluate((t) => (location.hash = '#/' + t), tool);
  await win.waitForTimeout(500);
  const t0 = Date.now();
  await win.locator('input[type=file]').first().setInputFiles(file, { timeout: 10 * 60_000 });
  while (Date.now() - t0 < timeoutMs) {
    const ready = await win.evaluate(() => [...document.querySelectorAll('main img')].filter((i) => i.complete && i.naturalWidth > 0).length).catch(() => 0);
    if (ready >= n) return +((Date.now() - t0) / 1000).toFixed(1);
    await sleep(100);
  }
  return null;
}

if (want.has('idle')) {
  const { app, win } = await launch({});
  await sleep(5000);
  const home = await appMB(app);
  const secs = await thumbs(win, 'rotate', scan(500));
  await sleep(3000);
  const open = await appMB(app);
  record({ name: 'A. idle: home screen', outcome: `${home} MB` });
  record({ name: `A. idle: 500 MB scan open in Rotate (12 thumbnails after ${secs} s)`, outcome: `${open} MB` });
  await app.close();
}

if (want.has('thumbs')) {
  for (const budget of ['1024', 'none']) {
    const { app, win } = await launch(budget === 'none' ? {} : { IHP_MEMORY_BUDGET_MB: budget });
    const secs = await thumbs(win, 'rotate', scan(50));
    record({ name: `G. first 12 thumbnails, 50 MB scan in Rotate @${budget}`, outcome: secs == null ? 'timeout' : `${secs} s`, secs });
    await app.close();
  }
}

if (want.has('text')) {
  const out = resolve(REPO, 'test-fixtures/memory/text-check');
  mkdirSync(out, { recursive: true });
  /** Clicks "Save now" and copies the saved file into `out` as `name`. */
  async function keep(win, name) {
    const done = win.getByRole('button', { name: /^Save now$/ }).first();
    await done.waitFor({ timeout: 5 * 60_000 });
    await done.click();
    const where = win.getByText(/Downloads.IHatePDF/).first();
    await where.waitFor({ timeout: 60_000 });
    copyFileSync((await where.innerText()).trim(), resolve(out, name));
    return name;
  }
  const cases = [
    ['watermark-hindi.pdf', 'watermark', 'गोपनीय'],
    ['watermark-chinese.pdf', 'watermark', '机密'],
    ['edit-hindi.pdf', 'editPdf', 'गोपनीय दस्तावेज़ — परीक्षण'],
    ['edit-chinese.pdf', 'editPdf', '机密文件 测试'],
  ];
  for (const [name, tool, text] of cases) {
    const { app, win } = await launch({});
    try {
      await win.evaluate((t) => (location.hash = '#/' + t), tool);
      await win.waitForTimeout(500);
      if (tool === 'watermark') {
        await win.locator('input[type=file]').first().setInputFiles(input('../scans/journal_10p.pdf'));
        await win.locator('textarea').first().fill(text);
        const btn = win.getByRole('button', { name: 'Add watermark' }).first();
        await win.waitForFunction((el) => !el.disabled, await btn.elementHandle(), { timeout: 60_000 });
        await btn.click();
      } else {
        await win.locator('input[type=file]').first().setInputFiles(resolve(REPO, 'test-fixtures/complex/complex.pdf'));
        const blocks = win.locator('[title="Double-click to edit"]');
        await blocks.first().waitFor({ timeout: 120_000 });
        await blocks.first().dblclick();
        await win.keyboard.press('Control+A');
        await win.keyboard.insertText(text);
        await win.keyboard.press('Escape');
        await win.waitForTimeout(1500);
        await win.getByRole('button', { name: /^Download/ }).first().click();
      }
      record({ name: `H. ${tool} with "${text}"`, outcome: 'saved ' + (await keep(win, name)) });
    } catch (e) {
      record({ name: `H. ${tool} with "${text}"`, outcome: 'error', message: String(e.message).split('\n')[0].slice(0, 160) });
    }
    await app.close();
  }
}
process.exit(0);
