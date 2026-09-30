// Shared runner for the memory tests: drives the real desktop app, one fresh app
// per test, and records the outcome, time and memory.
//
// App: IHP_EXE=<path to the installed IHatePDF.exe> tests the installed app;
// without it, the dev build in this repo (run `npm run build` first).
// Results: appended as JSON lines to RESULTS (default test-fixtures/memory/results.jsonl);
// `node scripts/e2e/memory/report.mjs` turns them into tables.

import { _electron as electron } from 'playwright-core';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SCANS = resolve(REPO, 'test-fixtures/scans');
export const INPUTS = resolve(REPO, 'test-fixtures/memory');
export const scan = (mb) => resolve(SCANS, `scan_${mb}MB.pdf`);
export const input = (name) => resolve(INPUTS, name);
export const RESULTS = process.env.RESULTS ?? resolve(INPUTS, 'results.jsonl');
/** File the app reads "Windows free memory, in MB" from (IHP_SIMULATE_FREE_FILE), for busy-Windows tests. */
export const FREE_FILE = resolve(tmpdir(), 'ihp-simulated-free-mb.txt');

const RANK = { normal: 0, high: 1, over: 2, critical: 3 };
const log = (...a) => process.env.DEBUG && console.log('  ..', ...a);

/** Launches the app with `env` added (e.g. { IHP_MEMORY_BUDGET_MB: '1024' }). */
export async function launch(env = {}) {
  const exe = process.env.IHP_EXE;
  const electronBin = resolve(REPO, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const app = await electron.launch({
    executablePath: exe ?? electronBin,
    args: exe ? [] : ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    cwd: exe ? undefined : REPO,
    env: { ...process.env, ...env },
  });
  const win = await app.firstWindow();
  await win.getByText('Compress').first().waitFor({ timeout: 60_000 });
  return { app, win };
}

/** All of the app's processes' working sets, in MB (same measure on Windows and Linux). */
export const appMB = (app) => app.evaluate(({ app }) => Math.round(app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024)).catch(() => 0);

/** The fail-safe's current state: level, jobMB, limitMB, budgetMB, availableMB. */
export const memInfo = (win) => win.evaluate(() => window.ihpDesktop.memory.info()).catch(() => null);

/**
 * Runs one tool: opens it, adds `files`, runs `before(win)`, clicks `action`
 * and waits for "Save now" (finished), "Stopped to protect this PC" (stopped)
 * or an error. `opts.env` is passed to the app; `opts.onTick(state)` runs every 250 ms.
 */
export async function runTool(name, tool, files, { before, action, env = {}, timeout = 40 * 60_000, onTick, keepApp = false } = {}) {
  const row = { name, tool, budgetMB: env.IHP_MEMORY_BUDGET_MB ? Number(env.IHP_MEMORY_BUDGET_MB) : undefined };
  // Same start for every test: the input files in the OS's file cache.
  for (const f of files ?? []) readFileSync(f).length;
  const t0 = Date.now();
  const { app, win } = await launch(env);
  let peak = 0, maxLevel = 'normal', maxJob = 0, minLimit = Infinity, slowed = false;
  const sampler = setInterval(async () => {
    peak = Math.max(peak, await appMB(app));
    const st = await memInfo(win);
    if (st) {
      if (RANK[st.level] > RANK[maxLevel]) maxLevel = st.level;
      maxJob = Math.max(maxJob, st.jobMB ?? 0);
      if (st.limitMB) minLimit = Math.min(minLimit, st.limitMB);
      await onTick?.(st);
    }
    if (!slowed && (await win.getByText('Low on memory: taking longer').first().isVisible().catch(() => false))) slowed = true;
  }, 250);
  try {
    await win.evaluate((t) => (location.hash = '#/' + t), tool);
    await win.waitForTimeout(500);
    row.idleMB = await appMB(app);
    if (files) await win.locator('input[type=file]').first().setInputFiles(files, { timeout: 10 * 60_000 });
    if (before) await before(win);
    let tRun = Date.now();
    if (action) {
      const btn = win.getByRole('button', { name: action }).first();
      await btn.waitFor({ timeout });
      await win.waitForFunction((el) => !el.disabled, await btn.elementHandle(), { timeout });
      tRun = Date.now();
      log('click', action);
      await btn.click();
    }
    const done = win.getByRole('button', { name: /^Save now$/ }).first();
    const stop = win.getByText(/Stopped to protect this PC/).first();
    const err = win.getByText(/That didn’t work|Something went wrong/).first();
    const res = await Promise.race([
      done.waitFor({ timeout }).then(() => 'finished'),
      stop.waitFor({ timeout }).then(() => 'stopped'),
      err.waitFor({ timeout }).then(() => 'error'),
    ]).catch(() => 'timeout');
    row.secs = +((Date.now() - tRun) / 1000).toFixed(1);
    row.outcome = res === 'finished' && (slowed || RANK[maxLevel] >= 1) ? 'slowed' : res;
    if (res === 'stopped') row.message = (await stop.innerText()).replace(/\s+/g, ' ').slice(0, 220);
    if (res === 'error') row.message = (await err.locator('..').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220);
    if (res === 'finished') {
      row.note = (await win.locator('aside').first().innerText().catch(() => '')).split('\n').filter((l) => /→|recompressed|skipped|pages|Recovered/.test(l)).join(' | ').slice(0, 200);
      await done.click();
      const where = win.getByText(/Downloads.IHatePDF/).first();
      if (await where.isVisible({ timeout: 5 * 60_000 }).catch(() => false)) rmSync((await where.innerText()).trim(), { force: true });
    }
  } catch (e) {
    row.outcome = 'harness-error';
    row.message = String(e.message).split('\n')[0].slice(0, 220);
  } finally {
    clearInterval(sampler);
    Object.assign(row, { peakMB: peak, maxLevel, jobMaxMB: maxJob, lowestLimitMB: minLimit === Infinity ? undefined : minLimit, totalSecs: +((Date.now() - t0) / 1000).toFixed(1) });
    if (!keepApp) await app.close().catch(() => {});
  }
  record(row);
  return keepApp ? { row, app, win } : { row };
}

export function record(row) {
  mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, JSON.stringify(row) + '\n');
  console.log(`${row.outcome.padEnd(9)} ${String(row.secs ?? '').padStart(6)} s  peak ${String(row.peakMB ?? '').padStart(5)} MB  job ${String(row.jobMaxMB ?? '').padStart(5)} MB  ${row.name}${row.message ? '  — ' + row.message : ''}`);
}

// Common interactions.
export const A = {
  rotateRight: async (w) => { await w.locator('main img').first().waitFor({ timeout: 10 * 60_000 }); await w.locator('aside').getByRole('button', { name: 'Right' }).click(); },
  splitAll: async (w) => { await w.getByRole('radio', { name: 'All pages' }).click(); },
  organizeReverse: async (w) => { await w.locator('main img').first().waitFor({ timeout: 10 * 60_000 }); await w.getByRole('button', { name: 'Reverse order' }).click(); },
  protectPw: async (w) => { const pw = w.locator('input[type=password]'); await pw.nth(0).fill('secret123'); await pw.nth(1).fill('secret123'); },
  unlockPw: async (w) => { const pw = w.locator('input[type=password]').first(); await pw.waitFor({ timeout: 10 * 60_000 }); await pw.fill('secret123'); },
  sign: async (w) => {
    await w.getByRole('radio', { name: 'Type' }).click();
    await w.getByPlaceholder('Jane Appleseed').fill('Test Signer');
    await w.locator('.cursor-copy').first().waitFor({ timeout: 10 * 60_000 });
    await w.waitForTimeout(800);
    await w.locator('.cursor-copy').first().click({ position: { x: 200, y: 300 } });
  },
  redactSearch: (q) => async (w) => { await w.getByPlaceholder('Word or phrase').fill(q); await w.getByRole('button', { name: 'Mark all matches' }).click(); await w.getByText(/match(es)? marked|No matches/).waitFor({ timeout: 20 * 60_000 }); },
  editFirst: async (w) => {
    const blocks = w.locator('[title="Double-click to edit"]');
    await blocks.first().waitFor({ timeout: 10 * 60_000 });
    await blocks.first().dblclick();
    await w.keyboard.press('Control+A');
    await w.keyboard.type('Edited under memory test.');
    await w.keyboard.press('Escape');
    await w.waitForTimeout(1500);
  },
};

/** Arguments like budgets=624,1024 sizes=10,50 tools=compress|merge. */
export function args(defaults) {
  const out = { ...defaults };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split('=');
    if (k in out) out[k] = v;
  }
  return out;
}
