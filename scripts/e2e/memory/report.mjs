// Prints the results (test-fixtures/memory/results.jsonl, or RESULTS) as a Markdown table.
import { readFileSync } from 'node:fs';
import { RESULTS } from './harness.mjs';

const rows = readFileSync(process.argv[2] ?? RESULTS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
console.log('| Test | Outcome | Time | Peak (app) | Peak (job) | Level reached | Note |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  const gb = (mb) => (mb ? `${(mb / 1024).toFixed(1)} GB` : '');
  console.log(`| ${r.name} | ${r.outcome} | ${r.secs ?? ''}${r.secs != null ? ' s' : ''} | ${gb(r.peakMB)} | ${r.jobMaxMB != null ? r.jobMaxMB + ' MB' : ''} | ${r.maxLevel ?? ''} | ${(r.message || r.note || '').replace(/\|/g, '/')} |`);
}
const n = (o) => rows.filter((r) => r.outcome === o).length;
console.log(`\n${rows.length} results: ${n('finished')} finished, ${n('slowed')} slowed, ${n('stopped')} stopped, ${rows.length - n('finished') - n('slowed') - n('stopped')} other.`);
