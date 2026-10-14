// Turns IHatePDF's local usage logs into the tables a report needs.
// Usage: node scripts/log-summary.mjs <log folder or usage-*.log files…> [--md out.md]
// Default folder: %APPDATA%\ihatepdf\logs. Reads usage-<pc>.log and its rotated .1 / .2 copies.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const mdAt = args.indexOf('--md');
const outFile = mdAt >= 0 ? args.splice(mdAt, 2)[1] : null;
const inputs = args.length ? args : [join(process.env.APPDATA || '', 'ihatepdf', 'logs')];

const files = [];
for (const p of inputs) {
  if (!existsSync(p)) continue;
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) if (/^usage-.*\.log(\.\d+)?$/.test(f)) files.push(join(p, f));
  else files.push(p);
}
if (!files.length) {
  console.error('No usage logs found in:', inputs.join(', '));
  process.exit(1);
}

const rows = [];
let bad = 0;
let logBytes = 0;
for (const f of files) {
  logBytes += statSync(f).size;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
}
rows.sort((a, b) => a.ts.localeCompare(b.ts));

const by = (xs, key) => xs.reduce((m, x) => ((m[key(x)] ??= []).push(x), m), {});
const sum = (xs, f) => xs.reduce((n, x) => n + (f(x) || 0), 0);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const q = (xs, p) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
const med = (xs) => q(xs, 0.5);
const secs = (ms) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
const mb = (b) => (b / 1048576).toFixed(b < 1048576 * 10 ? 1 : 0);
const day = (r) => r.ts.slice(0, 10);

const starts = rows.filter((r) => r.event === 'app_start');
const quits = rows.filter((r) => r.event === 'app_quit');
const opens = rows.filter((r) => r.event === 'tool_open' && r.tool !== 'home');
const jobs = rows.filter((r) => r.event === 'job');
const ok = jobs.filter((j) => j.outcome === 'ok');
const first = rows[0]?.ts.slice(0, 10);
const last = rows.at(-1)?.ts.slice(0, 10);
const days = first ? Math.max(1, Math.round((new Date(last) - new Date(first)) / 864e5) + 1) : 0;

const out = [];
const h = (t) => out.push(`\n## ${t}\n`);
const table = (head, body) => {
  out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  for (const r of body) out.push(`| ${r.join(' | ')} |`);
};

out.push('# IHatePDF usage log summary', '', `Logs: ${files.length} file(s), ${rows.length} events${bad ? `, ${bad} unreadable lines skipped` : ''}, ${first} to ${last} (${days} day${days === 1 ? '' : 's'}). Versions: ${[...new Set(starts.map((s) => s.version))].join(', ') || '–'}.`);

h('Usage');
table(['What', 'Value'], [
  ['PCs', new Set(rows.map((r) => r.pc)).size],
  ['Anonymous users', new Set(rows.map((r) => r.user)).size],
  ['App launches', starts.length],
  ['Launches per active day (average)', (starts.length / Math.max(1, new Set(starts.map(day)).size)).toFixed(1)],
  ['Active days', new Set(rows.map(day)).size],
  ['Total time the app was open', `${(sum(quits, (q) => q.seconds) / 3600).toFixed(1)} h`],
  ['Tool openings', opens.length],
  ['Jobs run', jobs.length],
  ['Windows crashes / fail-safe restarts', `${rows.filter((r) => r.event === 'crash').length} / ${rows.filter((r) => r.event === 'window_restarted').length}`],
]);

h('Launches per day');
table(['Day', 'Launches', 'Users', 'Jobs'], Object.entries(by(rows, day)).map(([d, rs]) => [d, rs.filter((r) => r.event === 'app_start').length, new Set(rs.map((r) => r.user)).size, rs.filter((r) => r.event === 'job').length]));

h('Success rate');
const errs = jobs.filter((j) => j.outcome !== 'ok');
out.push(`**${pct(ok.length, jobs.length)}** of ${jobs.length} jobs finished successfully (${errs.filter((j) => j.outcome === 'stopped').length} stopped by the memory fail-safe, ${errs.filter((j) => j.outcome === 'cancelled').length} cancelled by the user, ${errs.filter((j) => j.outcome === 'error').length} errors).`, '');
table(['Tool', 'Opened', 'Jobs', 'OK', 'Success', 'Median time (s)', 'P95 time (s)', 'Median input (MB)', 'Median RAM peak (MB)'],
  Object.entries(by(jobs, (j) => j.tool)).sort((a, b) => b[1].length - a[1].length).map(([t, js]) => {
    const good = js.filter((j) => j.outcome === 'ok');
    return [t, opens.filter((o) => o.tool === t).length, js.length, good.length, pct(good.length, js.length), secs(med(js.map((j) => j.ms))), secs(q(js.map((j) => j.ms), 0.95)), mb(med(js.map((j) => j.inBytes))), med(js.map((j) => j.ramPeakMB))];
  }));

if (errs.length) {
  h('Errors');
  table(['Class', 'Count', 'Example (file names removed)'], Object.entries(by(errs, (j) => `${j.outcome}: ${j.errorClass || '–'}`)).map(([c, js]) => [c, js.length, (js[0].errorText || '').replace(/\|/g, '/')]));
}

h('Resources while jobs ran');
table(['Measure', 'Median', 'P95', 'Max'], [
  ['App RAM peak (MB)', med(jobs.map((j) => j.ramPeakMB)), q(jobs.map((j) => j.ramPeakMB), 0.95), Math.max(0, ...jobs.map((j) => j.ramPeakMB))],
  ['App CPU, average during a job (% of all cores)', med(jobs.map((j) => j.appCpuAvg)), q(jobs.map((j) => j.appCpuAvg), 0.95), Math.max(0, ...jobs.map((j) => j.appCpuAvg))],
  ['App CPU peak (% of all cores)', med(jobs.map((j) => j.appCpuPeak)), q(jobs.map((j) => j.appCpuPeak), 0.95), Math.max(0, ...jobs.map((j) => j.appCpuPeak))],
  ['Whole-PC CPU peak (%)', med(jobs.map((j) => j.sysCpuPeak)), q(jobs.map((j) => j.sysCpuPeak), 0.95), Math.max(0, ...jobs.map((j) => j.sysCpuPeak))],
  ['Free RAM at its lowest during a job (MB)', med(jobs.map((j) => j.freeRamMinMB).filter((x) => x != null)), '–', Math.min(...jobs.map((j) => j.freeRamMinMB).filter((x) => x != null), Infinity)],
]);
out.push('', `CPU spikes: ${jobs.filter((j) => j.sysCpuPeak >= 90).length} of ${jobs.length} jobs pushed the whole PC to 90% CPU or more at some moment.`);

h('Temp files and clean-up');
const tc = sum(quits, (q) => q.tempCreated);
const td = sum(quits, (q) => q.tempDeleted);
table(['Check', 'Value'], [
  ['Temp files created (output files written during jobs)', tc],
  ['Deleted as soon as they were saved or discarded', td],
  ['Left at quit, before the final clean-up (results never saved)', sum(quits, (q) => q.tempFilesBeforeCleanup)],
  ['**Left after the final clean-up (must be 0)**', `**${sum(quits, (q) => q.tempFilesAfterCleanup)}**`],
  ['Found at the next start from an earlier run (must be 0; non-zero = a crash or a forced shutdown)', sum(starts, (s) => s.tempLeftoverFiles)],
  ['Files saved by the user', rows.filter((r) => r.event === 'file_saved').length],
]);

h('Size of the log itself');
const sizes = rows.filter((r) => r.logBytes != null);
const growth = sizes.length > 1 ? (sizes.at(-1).logBytes - sizes[0].logBytes) / Math.max(1, (new Date(sizes.at(-1).ts) - new Date(sizes[0].ts)) / 864e5) : 0;
table(['Measure', 'Value'], [
  ['Log files now', `${files.length} file(s), ${(logBytes / 1024).toFixed(0)} KB`],
  ['Average growth per active day', `${(growth / 1024).toFixed(0)} KB/day (the log is capped at 3 files of 5 MB: 15 MB per PC)`],
  ['Average size of a line', `${rows.length ? Math.round(logBytes / rows.length) : 0} bytes`],
  ['App data folder (cache) at last quit', `${quits.at(-1)?.userDataMB ?? '–'} MB`],
]);

const text = out.join('\n') + '\n';
console.log(text);
if (outFile) writeFileSync(outFile, text);
