import type { PageLayout, StyledRun } from './textLayout';

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]#|<>])/g, '\\$1');
}

function runsToMd(runs: StyledRun[]): string {
  // Merge adjacent runs with the same emphasis so we don't emit **a****b**.
  const merged: StyledRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic && last.mono === r.mono) last.text += r.text;
    else merged.push({ ...r });
  }
  return merged
    .map((r) => {
      const lead = r.text.match(/^\s*/)![0];
      const trail = r.text.match(/\s*$/)![0];
      const core = r.text.trim();
      if (!core) return r.text;
      let s = r.mono ? `\`${core.replace(/`/g, '')}\`` : escapeMd(core);
      if (r.italic && !r.mono) s = `*${s}*`;
      if (r.bold && !r.mono) s = `**${s}**`;
      return lead + s + trail;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MarkdownOptions {
  pageHeadings: boolean;
  emphasis: boolean;
}

export function layoutToMarkdown(pages: PageLayout[], opts: MarkdownOptions): string {
  const out: string[] = [];
  const text = (runs: StyledRun[], plain: string) => (opts.emphasis ? runsToMd(runs) : escapeMd(plain));
  for (const page of pages) {
    if (opts.pageHeadings) out.push(`<!-- Page ${page.pageNumber} -->`, '');
    for (const b of page.blocks) {
      switch (b.kind) {
        case 'heading':
          out.push(`${'#'.repeat(b.level)} ${escapeMd(b.text)}`, '');
          break;
        case 'paragraph':
          out.push(text(b.runs, b.text), '');
          break;
        case 'list':
          b.items.forEach((it, i) => out.push(`${b.ordered ? `${i + 1}.` : '-'} ${text(it.runs, it.text)}`));
          out.push('');
          break;
        case 'table': {
          const cols = Math.max(...b.rows.map((r) => r.length));
          const row = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => escapeMd(cells[i] ?? '').replace(/\n/g, ' ')).join(' | ')} |`;
          out.push(row(b.rows[0]), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`, ...b.rows.slice(1).map(row), '');
          break;
        }
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
