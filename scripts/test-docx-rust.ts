/**
 * Word to PDF: TypeScript engine vs Rust (crates/ihp-core/src/docx.rs) on generated and real .docx files;
 * compares pages, words and pixels with MuPDF (scripts/test-stamp-compare.py).
 *   cd crates/ihp-core && cargo build --release
 *   PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-docx-rust.ts
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, PageBreak, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { convertDocxToPdf } from '../src/features/wordToPdf/renderDocxToPdf';

const OUT = resolve('test-fixtures/docx-rust');
mkdirSync(OUT, { recursive: true });
(globalThis as { __ihpReadFile?: (u: URL) => Promise<Uint8Array> }).__ihpReadFile = async (u) => new Uint8Array(readFileSync(u));
const FONTS = resolve('test-fixtures/fonts');
if (!existsSync(FONTS)) throw new Error('Run scripts/test-stamp-rust.ts once first (it copies the fonts to test-fixtures/fonts).');
const CLI = resolve('crates/ihp-core/target/release/ihp-docx.exe');
const PY = process.env.PY ?? 'python';

function picture(w: number, h: number, kind: 'png' | 'jpeg') {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#336699';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.font = '28px sans-serif';
  g.fillText('picture ' + kind, 20, h / 2);
  return kind === 'png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', 90);
}
const p = (t: string, o: Record<string, unknown> = {}) => new Paragraph({ children: [new TextRun(t)], ...o });
const lorem = 'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly. '.repeat(12);

const generated: Record<string, Document> = {
  text_styles: new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Quarterly Report')] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Summary')] }),
        new Paragraph({ children: [new TextRun({ text: 'Bold ', bold: true }), new TextRun({ text: 'italic ', italics: true }), new TextRun({ text: 'both ', bold: true, italics: true }), new TextRun({ text: 'red 16pt ', color: 'CC0000', size: 32 }), new TextRun({ text: 'underlined', underline: {} })] }),
        p(lorem),
        p('Centered line', { alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 } }),
        p('Right aligned line', { alignment: AlignmentType.RIGHT }),
        p(lorem),
        new Paragraph({ children: [new PageBreak(), new TextRun('After a page break')] }),
        p(lorem + lorem + lorem),
      ],
    }],
  }),
  callout_table: new Document({
    sections: [{
      children: [
        new Paragraph({ shading: { type: ShadingType.CLEAR, fill: 'FEF2F2' }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'DC2626', space: 4 } }, children: [new TextRun('Warning: this is a callout box with a shaded background and an accent border.')] }),
        p('Table below'),
        new Table({
          width: { size: 9000, type: WidthType.DXA },
          columnWidths: [2000, 3000, 4000],
          rows: [
            new TableRow({ children: ['Name', 'Qty', 'Notes'].map((t) => new TableCell({ shading: { type: ShadingType.CLEAR, fill: 'E2E8F0' }, children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })) }),
            ...Array.from({ length: 30 }, (_, i) => new TableRow({ children: [`Item ${i + 1}`, String(i * 3), 'A longer note that has to wrap inside the cell ' + (i % 3 ? '' : lorem.slice(0, 120))].map((t) => new TableCell({ children: [new Paragraph({ children: [new TextRun(t)] })] })) })),
          ],
        }),
        p('End of document.'),
      ],
    }],
  }),
  pictures: new Document({
    sections: [{
      children: [
        p('Before the pictures.'),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: picture(800, 400, 'png'), transformation: { width: 400, height: 200 } })] }),
        p('Between them.'),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'jpg', data: picture(600, 900, 'jpeg'), transformation: { width: 300, height: 450 } })] }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: picture(2000, 500, 'png'), transformation: { width: 1500, height: 375 } })] }),
        p('After the pictures.'),
      ],
    }],
  }),
  greek_cyrillic: new Document({ sections: [{ children: [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Έκθεση / Отчёт')] }), p('Γειά σου κόσμε. Привет, мир! ' + 'Ελληνικά και русский текст. '.repeat(20))] }] }),
  devanagari: new Document({ sections: [{ children: [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('रिपोर्ट सारांश')] }), p('यह एक परीक्षण दस्तावेज़ है। ' + 'हिन्दी में क्रिया और पृष्ठ संख्या। '.repeat(15))] }] }),
  cjk: new Document({ sections: [{ children: [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('季度报告 日本語')] }), p('这是一个测试文档。' + '中文和日本語のテキスト。'.repeat(20))] }] }),
};

const real = ['test-fixtures/complex/complex.docx', 'test-fixtures/sample-document.docx', 'test-fixtures/layout-ab/native/word.docx', 'test-fixtures/layout-ab/native/journal_10p.docx', 'test-fixtures/layout-ab/native/test-multi.docx'].filter(existsSync);

const jobs: Array<{ name: string; path: string }> = [];
for (const [name, doc] of Object.entries(generated)) {
  const path = resolve(OUT, `${name}.docx`);
  writeFileSync(path, await Packer.toBuffer(doc));
  jobs.push({ name, path });
}
for (const r of real) {
  const name = 'real_' + r.split('/').pop()!.replace('.docx', '').replace(/\W/g, '_') + '_' + jobs.length;
  const path = resolve(OUT, `${name}.docx`);
  copyFileSync(r, path);
  jobs.push({ name, path });
}

const pairs: string[] = [];
for (const j of jobs) {
  const buf = readFileSync(j.path);
  const ts = resolve(OUT, `ts_${j.name}.pdf`);
  const rs = resolve(OUT, `rs_${j.name}.pdf`);
  try {
    const r = await convertDocxToPdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, `${j.name}.docx`);
    writeFileSync(ts, Buffer.from(r.buffer));
  } catch (e) {
    console.log(`SKIP ${j.name}: TypeScript engine failed (${(e as Error).message.slice(0, 80)})`);
    continue;
  }
  const r = spawnSync(CLI, [j.path, rs], { encoding: 'utf8', env: { ...process.env, IHP_FONTS: FONTS } });
  if (r.status !== 0) {
    console.log(`FALLBACK ${j.name}: Rust declined (${r.stderr.trim()})`);
    continue;
  }
  pairs.push(ts, rs);
}
const py = spawnSync(PY, ['scripts/test-stamp-compare.py', ...pairs], { encoding: 'utf8' });
console.log(py.stdout + py.stderr);
process.exit(py.status ? 1 : 0);
