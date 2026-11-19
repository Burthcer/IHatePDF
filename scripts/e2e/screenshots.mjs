// Regenerates the README screenshots in docs/screenshots/.
// Installed desktop app (preferred): launch it with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222,
// then E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/screenshots.mjs
// Browser build: vite preview on :4173, then node scripts/e2e/screenshots.mjs
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const CDP = process.env.E2E_CDP;
const BASE = CDP ? 'http://tauri.localhost/' : 'http://localhost:4173/';
const OUT = resolve('docs/screenshots');
const F = (p) => resolve('test-fixtures', p);
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);

let browser, appPage;
if (CDP) {
  browser = await chromium.connectOverCDP(CDP);
  appPage = browser.contexts()[0].pages()[0];
  await appPage.setViewportSize({ width: 1440, height: 900 });
} else {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge' } : { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
}

async function session(theme) {
  if (CDP) {
    await appPage.evaluate((t) => localStorage.setItem('ihatepdf-theme', t), theme);
    return { ctx: { close: async () => {} }, page: appPage };
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25, acceptDownloads: true });
  await ctx.addInitScript((t) => localStorage.setItem('ihatepdf-theme', t), theme);
  return { ctx, page: await ctx.newPage() };
}
const open = async (page, hash) => {
  await page.goto('about:blank');
  await page.goto(BASE + hash);
  await page.waitForLoadState('networkidle');
};
const shot = (page, name, height) => page.screenshot({ path: `${OUT}/${name}.png`, clip: height ? { x: 0, y: 0, width: 1440, height } : undefined });

for (const theme of ['light', 'dark']) {
  if (!want('home')) break;
  const { ctx, page } = await session(theme);
  await open(page, '');
  await page.waitForTimeout(600);
  await shot(page, `home-${theme}`);
  await ctx.close();
}

{
  const { ctx, page } = await session('light');
  if (want('editor')) {
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
  }

  if (want('compress')) {
    // Compress: custom target size with the auto-save countdown (a 10 MB scan in the app: fits the debug connection).
    await open(page, '#/compress');
    await page.locator('input[type=file]').first().setInputFiles(F(CDP ? 'scans/scan_10MB.pdf' : 'big/scan_photos.pdf'), { timeout: 240_000 });
    await page.getByRole('button', { name: /^Custom size/ }).click();
    await page.getByLabel('Target size').fill('2');
    await page.getByRole('button', { name: /^Compress to/ }).click();
    await page.getByRole('button', { name: 'Save now' }).waitFor({ timeout: 300_000 });
    await page.waitForTimeout(1200);
    await shot(page, 'compress');
  }

  if (want('split')) {
    // Split: two named parts, each with its own colour; page 4 is in both.
    await open(page, '#/split');
    await page.locator('input[type=file]').first().setInputFiles(F('e2e-out/merge.pdf'));
    await page.locator('main img').nth(5).waitFor();
    await page.getByLabel('Pages for part 1').fill('1-3');
    await page.getByLabel('File name for part 1').fill('Quarterly review');
    await page.getByRole('button', { name: 'Add part' }).click();
    await page.getByLabel('Pages for part 2').fill('3-7');
    await page.getByLabel('File name for part 2').fill('Appendix');
    await page.waitForTimeout(1000);
    await shot(page, 'split', 620);
  }

  if (want('organize')) {
    // Organize: page thumbnails with the move arrows.
    await open(page, '#/organize');
    await page.locator('input[type=file]').first().setInputFiles(F('e2e-out/merge.pdf'));
    await page.locator('main img').nth(6).waitFor();
    await page.waitForTimeout(800);
    await shot(page, 'organize', 540);
  }

  if (want('convert')) {
    // PowerPoint to PDF result.
    await open(page, '#/pptToPdf');
    await page.locator('input[type=file]').first().setInputFiles(F('test-slides.pptx'));
    await page.getByRole('button', { name: 'Save now' }).waitFor({ timeout: 60_000 });
    await page.locator('main img').nth(2).waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'convert', 560);
  }

  if (CDP && want('share')) {
    // Share to phone (desktop app only): the empty screen, then a live Wi-Fi share with its QR code.
    await open(page, '#/share');
    await page.waitForTimeout(800);
    await shot(page, 'share-setup', 760);
    await page.evaluate(async (paths) => {
      const d = window.ihpDesktop.share;
      await d.start((await d.describe(paths)).map((i) => i.path), 5, 'wifi');
    }, [F('test-multi.pdf'), F('misc')]);
    await page.waitForTimeout(1500);
    await shot(page, 'share-qr', 760);
    await page.evaluate(() => window.ihpDesktop.share.stop());
  }
  await ctx.close();
}
if (CDP) await appPage.evaluate(() => localStorage.setItem('ihatepdf-theme', 'dark'));
await browser.close();
console.log('screenshots written to', OUT);
