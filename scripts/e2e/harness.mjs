// Shared Playwright helpers for driving the built app (vite preview on :4173).
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

// E2E_CDP=http://127.0.0.1:9222 drives the running Tauri app instead (see scripts/e2e/tauri.mjs for launching it).
export const CDP = process.env.E2E_CDP;
export const BASE = process.env.E2E_BASE ?? (CDP ? 'http://tauri.localhost/' : 'http://localhost:4173/');
const SAVE_DIR = join(homedir(), 'Downloads', 'IHatePDF');
export const OUT = resolve('test-fixtures/e2e-out');
mkdirSync(OUT, { recursive: true });

export async function launch() {
  if (CDP) {
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    const logs = [];
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    return { browser, context, page, logs };
  }
  // Windows: the installed Microsoft Edge (Chromium). Elsewhere: the Linux CI Chromium, or CHROMIUM_PATH.
  const where = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : process.platform === 'win32' ? { channel: 'msedge' } : { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' };
  const browser = await chromium.launch({ ...where, args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  return { browser, context, page, logs };
}

export async function openTool(page, id) {
  await page.goto('about:blank');
  await page.goto(`${BASE}#/${id}`);
  await page.waitForLoadState('networkidle');
}

export async function upload(page, files, nth = 0) {
  const input = page.locator('input[type=file]').nth(nth);
  await input.setInputFiles(files);
}

/** Clicks the primary action, waits for the result, saves it ("Save now" skips the auto-save countdown). */
export async function runAndDownload(page, actionName, outName, timeout = 180_000) {
  if (actionName) await page.getByRole('button', { name: actionName }).first().click();
  const save = page.getByRole('button', { name: /^Save now$/ }).first();
  const err = page.getByText('That didn’t work');
  await Promise.race([save.waitFor({ timeout }), err.waitFor({ timeout }).then(async () => { throw new Error('Tool error: ' + (await page.locator('aside').innerText())); })]);
  if (CDP) {
    // The desktop app saves into Downloads/IHatePDF (no download event): pick up the new file and remove it there.
    const before = new Set(readdirSync(SAVE_DIR));
    await save.click();
    let fresh = [];
    for (let i = 0; i < 150 && !fresh.length; i++) { fresh = readdirSync(SAVE_DIR).filter((n) => !before.has(n)); if (!fresh.length) await page.waitForTimeout(100); }
    if (!fresh.length) throw new Error('Nothing was saved to ' + SAVE_DIR);
    await page.waitForTimeout(200);
    const path = resolve(OUT, outName ?? fresh[0]);
    copyFileSync(join(SAVE_DIR, fresh[0]), path);
    const suggested = fresh[0];
    for (const f of fresh) rmSync(join(SAVE_DIR, f), { force: true });
    return { path, size: statSync(path).size, suggested };
  }
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  const path = resolve(OUT, outName ?? download.suggestedFilename());
  await download.saveAs(path);
  return { path, size: statSync(path).size, suggested: download.suggestedFilename() };
}
