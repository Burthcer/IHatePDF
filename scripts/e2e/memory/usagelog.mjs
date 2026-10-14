// The local usage log, checked end to end on the real app (IHP_EXE = installed or unpacked app):
// events and fields, no file names, errors classified, temp files cleaned, size cap by rotation,
// the off switch, and the summary tool. Exits 1 if anything is wrong.
// Usage: node scripts/e2e/memory/usagelog.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { A, REPO, input, runTool, scan } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'ihp-logtest-'));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const readLog = (dir) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('usage-')) : [];
  const lines = files.filter((f) => f.endsWith('.log')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
  return { files, rows: lines.map((l) => JSON.parse(l)), text: files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') };
};

// ---- 1. A normal session: two good jobs, one error ----
const dir1 = join(root, 'normal');
const env1 = { IHP_LOG_DIR: dir1 };
await runTool('log: watermark journal', 'watermark', [input('../scans/journal_10p.pdf')], { action: 'Add watermark', env: env1 });
await runTool('log: compress 50 MB scan', 'compress', [scan(50)], { action: /^Compress/, env: env1 });
await runTool('log: watermark a cut-off scan (error)', 'watermark', [input('scan_50MB_cut90.pdf')], { action: 'Add watermark', env: env1 });
{
  const { files, rows, text } = readLog(dir1);
  const ev = (e) => rows.filter((r) => r.event === e);
  check('log file created, one per PC', files.some((f) => /^usage-[0-9a-f]{8}\.log$/.test(f)), files.join(', '));
  check('app_start per launch (3)', ev('app_start').length === 3, String(ev('app_start').length));
  check('app_start has version, OS, RAM, cores, budget', ev('app_start').every((r) => r.version && r.os && r.ramGB > 0 && r.cores > 0 && r.budgetMB > 0));
  check('tool_open for watermark and compress', ['watermark', 'compress'].every((t) => ev('tool_open').some((r) => r.tool === t)));
  const jobs = ev('job');
  const good = jobs.filter((j) => j.outcome === 'ok');
  check('two successful jobs logged', good.length >= 2, `${good.length} ok of ${jobs.length}`);
  check('job has tool, time, input and output size', good.every((j) => j.tool && j.ms > 0 && j.inBytes > 0 && j.outBytes > 0));
  check('job has RAM peak and CPU (app and PC)', good.every((j) => j.ramPeakMB > 0 && j.appCpuPeak >= 0 && j.sysCpuPeak >= 0 && 'sysCpuAvg' in j));
  check('compress input size matches the 50 MB scan', good.some((j) => j.tool === 'compress' && j.inBytes > 40e6 && j.inBytes < 60e6));
  const bad = jobs.filter((j) => j.outcome !== 'ok');
  check('the cut-off file is logged as an error with a class', bad.length >= 1 && bad.every((j) => j.errorClass), JSON.stringify(bad.map((j) => [j.outcome, j.errorClass, j.errorText])));
  check('every launch ends with app_quit', ev('app_quit').length === 3);
  check('temp files: none left after clean-up', ev('app_quit').every((r) => r.tempFilesAfterCleanup === 0));
  check('temp files: none left over from a previous run', ev('app_start').every((r) => r.tempLeftoverFiles === 0));
  check('temp files created and deleted are counted', ev('app_quit').some((r) => r.tempCreated > 0));
  check('files saved are logged by type and size only', ev('file_saved').length >= 2 && ev('file_saved').every((r) => r.ext === 'pdf' && r.bytes > 0 && !('name' in r) && !('path' in r)));
  const names = ['journal_10p', 'scan_50MB', 'cut90', '.pdf', 'Downloads', 'C:\\\\', 'Users'];
  const leaked = names.filter((n) => text.includes(n));
  check('no file names or paths anywhere in the log', leaked.length === 0, leaked.join(', '));
  check('user and PC ids are anonymous (hashes, not names)', rows.every((r) => /^[0-9a-f]{10}$/.test(r.user) && /^[0-9a-f]{8}$/.test(r.pc)));
}

// ---- 2. The summary tool ----
{
  const md = join(root, 'summary.md');
  let outText = '';
  try {
    execFileSync(process.execPath, [resolve(REPO, 'scripts/log-summary.mjs'), dir1, '--md', md], { stdio: 'pipe' });
    outText = readFileSync(md, 'utf8');
  } catch (e) {
    outText = String(e.stderr || e.message);
  }
  check('summary tool runs and reports usage, success rate, resources, temp files, log size', ['## Usage', '## Success rate', '## Resources while jobs ran', '## Temp files and clean-up', '## Size of the log itself'].every((h) => outText.includes(h)));
  check('summary shows 3 launches', /App launches \| 3/.test(outText));
}

// ---- 3. Size cap: a tiny limit forces rotation; never more than 3 files ----
{
  const dir = join(root, 'rotate');
  const env = { IHP_LOG_DIR: dir, IHP_LOG_MAX_BYTES: '3000' };
  for (let i = 0; i < 4; i++) await runTool(`log: rotation ${i}`, 'watermark', [input('../scans/journal_10p.pdf')], { action: 'Add watermark', env });
  const { files } = readLog(dir);
  const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  check('rotation keeps at most 3 files', files.length >= 2 && files.length <= 3, files.join(', '));
  check('rotation keeps the total under 3 × the limit', total <= 3 * 3200, `${total} bytes`);
}

// ---- 4. Off switch ----
{
  const dir = join(root, 'off');
  await runTool('log: off switch', 'watermark', [input('../scans/journal_10p.pdf')], { action: 'Add watermark', env: { IHP_LOG_DIR: dir, IHP_LOG: 'off' } });
  check('IHP_LOG=off writes nothing', readLog(dir).files.length === 0);
}

rmSync(root, { recursive: true, force: true });
const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed} / ${checks.length} passed`);
process.exit(failed ? 1 : 0);
