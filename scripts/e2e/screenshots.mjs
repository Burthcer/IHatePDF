// Regenerates the README screenshots in docs/screenshots/ from the built app
// (vite preview on :4173). Usage: node scripts/e2e/screenshots.mjs
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const BASE = 'http://localhost:4173/';
const OUT = resolve('docs/screenshots');
const F = (p) => resolve('test-fixtures', p);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

async function session(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25, acceptDownloads: true });
  await ctx.addInitScript((t) => localStorage.setItem('ihatepdf-theme', t), theme);
  const page = await ctx.newPage();
  return { ctx, page };
}
const open = async (page, hash) => {
  await page.goto('about:blank');
  await page.goto(BASE + hash);
  await page.waitForLoadState('networkidle');
};
const shot = (page, name, height) => page.screenshot({ path: `${OUT}/${name}.png`, clip: height ? { x: 0, y: 0, width: 1440, height } : undefined });

for (const theme of ['light', 'dark']) {
  const { ctx, page } = await session(theme);
  await open(page, '');
  await page.waitForTimeout(400);
  await shot(page, `home-${theme}`);
  await ctx.close();
}

{
  const { ctx, page } = await session('light');
  // Editor: retyping a paragraph in place.
  await open(page, '#/editPdf');
  await page.locator('input[type=file]').first().setInputFiles(F('complex/complex.pdf'));
  const blocks = page.locator('[title="Double-click to edit"]');
  await blocks.nth(3).waitFor({ timeout: 60_000 });
  // Find the body paragraph (the inspector shows the selected block's text).
  const n = await blocks.count();
  for (let i = 0; i < n; i++) {
    await blocks.nth(i).click();
    if ((await page.locator('aside textarea').first().inputValue()).startsWith('Revenue grew')) {
      await blocks.nth(i).dblclick();
      break;
    }
  }
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Revenue grew 18% across every region this quarter, led by renewals and a record finish in the enterprise segment. Retyped in place.');
  await page.keyboard.press('Escape');
  await page.getByText(/1 change/).waitFor({ timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, 'editor');

  // Compress: custom target size with the auto-save countdown.
  await open(page, '#/compress');
  await page.locator('input[type=file]').first().setInputFiles(F('big/scan_photos.pdf'));
  await page.getByRole('button', { name: /^Custom size/ }).click();
  await page.getByLabel('Target size').fill('2');
  await page.getByRole('button', { name: /^Compress to/ }).click();
  await page.getByRole('button', { name: 'Save now' }).waitFor({ timeout: 300_000 });
  await page.waitForTimeout(1200);
  await shot(page, 'compress');

  // Organize: page thumbnails.
  await open(page, '#/organize');
  await page.locator('input[type=file]').first().setInputFiles(F('e2e-out/merge.pdf'));
  await page.locator('main img').nth(6).waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'organize', 505);

  // PowerPoint to PDF result.
  await open(page, '#/pptToPdf');
  await page.locator('input[type=file]').first().setInputFiles(F('test-slides.pptx'));
  await page.getByRole('button', { name: 'Save now' }).waitFor({ timeout: 60_000 });
  await page.locator('main img').nth(2).waitFor();
  await page.waitForTimeout(600);
  await shot(page, 'convert', 560);
  await ctx.close();
}
await browser.close();
console.log('screenshots written to', OUT);
