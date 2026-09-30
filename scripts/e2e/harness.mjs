// Shared Playwright helpers for driving the built app (vite preview on :4173).
import { chromium } from 'playwright-core';
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:4173/';
export const OUT = resolve('test-fixtures/e2e-out');
mkdirSync(OUT, { recursive: true });

export async function launch() {
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
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  const path = resolve(OUT, outName ?? download.suggestedFilename());
  await download.saveAs(path);
  return { path, size: statSync(path).size, suggested: download.suggestedFilename() };
}
