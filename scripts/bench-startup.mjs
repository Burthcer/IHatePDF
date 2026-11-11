// Startup time (launch -> home screen rendered) and idle memory of the desktop app, Electron vs Tauri.
// Usage: node scripts/bench-startup.mjs electron|tauri [runs=3]
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const which = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
const PORT = 9333;
const exe = which === 'electron' ? resolve('node_modules/electron/dist/electron.exe') : resolve('src-tauri/target/release/ihatepdf.exe');
const args = which === 'electron' ? [`--remote-debugging-port=${PORT}`, '.'] : [];
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 60000 }).trim();
const match = which === 'electron' ? "$_.Name -eq 'electron.exe'" : "$_.Name -eq 'ihatepdf.exe' -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*com.ihatepdf.desktop*')";
function memory() {
  const out = ps(`$p = Get-CimInstance Win32_Process | Where-Object { ${match} }; $ids = $p.ProcessId; $m = Get-Process -Id $ids -ErrorAction SilentlyContinue; '{0} {1} {2}' -f $m.Count, [math]::Round(($m | Measure-Object WorkingSet64 -Sum).Sum/1MB), [math]::Round(($m | Measure-Object PrivateMemorySize64 -Sum).Sum/1MB)`);
  const [n, ws, priv] = out.split(' ').map(Number);
  return { procs: n, workingSetMB: ws, privateMB: priv };
}
const rows = [];
for (let i = 0; i < runs; i++) {
  const t0 = Date.now();
  const child = spawn(exe, args, { env, cwd: process.cwd(), stdio: 'ignore' });
  let page = null, browser = null;
  while (!page && Date.now() - t0 < 60000) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 1500 });
      page = browser.contexts()[0]?.pages()[0];
    } catch { await new Promise((r) => setTimeout(r, 40)); }
  }
  await page.getByText('Compress').first().waitFor({ timeout: 60000 });
  const ready = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 6000));
  rows.push({ run: i + 1, readyMs: ready, ...memory() });
  await browser.close().catch(() => {});
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
  if (which === 'tauri') { try { execFileSync('taskkill', ['/F', '/IM', 'msedgewebview2.exe', '/FI', 'WINDOWTITLE eq nothing'], { stdio: 'ignore' }); } catch {} }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(which);
console.table(rows);
const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
console.log(`median: ready ${med('readyMs')} ms, working set ${med('workingSetMB')} MB, private ${med('privateMB')} MB, processes ${med('procs')}`);
