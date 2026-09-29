/**
 * End-to-end checks for the edit engine, decryption, layout analysis and
 * the reworked tools, run against the "complicated" fixture from
 * complexFixtures.ts. Execution: npx tsx scripts/test-editor-and-tools.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildComplexPdf, encryptLegacy, PAGE1_TEXT } from './complexFixtures';
import { openPdf, PdfPasswordError } from '../src/services/pdfLoader';
import { analyzePage, applyPageEdits, type PageEdits } from '../src/features/editPdf/engine/rewrite';
import { analyzeDocumentLayout } from '../src/services/textLayout';
import { layoutToMarkdown } from '../src/services/layoutToMarkdown';
import { buildDocxFromLayout } from '../src/features/pdfToWord/pdfToWord.worker';
import { compressPdf } from '../src/features/compress/compress.worker';
import { cropPdf } from '../src/features/crop/crop.worker';
import { applyWatermark } from '../src/features/watermark/watermark.worker';
import { addPageNumbers } from '../src/features/pageNumbers/pageNumbers.worker';
import { splitPdf } from '../src/features/split/split.worker';
import { organizePdfPages } from '../src/features/organize/organize.worker';
import { unlockPdf } from '../src/features/unlock/unlock.worker';
import { protectPdf } from '../src/features/protect/protect.worker';
import { redactPdf } from '../src/features/redact/redact.worker';
import { convertToPdfa } from '../src/features/pdfToPdfa/pdfToPdfa.worker';
import { fillForm, describeFields } from '../src/features/forms/forms.worker';
import { repairPdf } from '../src/features/repair/repair.worker';
import { stampSignature } from '../src/features/sign/sign.worker';
import { mergePdfs } from '../src/features/merge/merge.worker';
import { diffWords } from '../src/features/compare/textDiff';

globalThis.__ihpReadFile = async (url: URL) => new Uint8Array(await readFile(fileURLToPath(url)));

const OUT = resolve('test-fixtures/complex');
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}\n         ${err instanceof Error ? err.stack?.split('\n').slice(0, 3).join('\n         ') : String(err)}`);
    failed++;
    failures.push(name);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function pdfText(bytes: Uint8Array | ArrayBuffer, password?: string): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(bytes instanceof Uint8Array ? bytes.slice() : bytes.slice(0)), password, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push((tc.items as Array<{ str?: string }>).map((it) => it.str ?? '').join(' ').replace(/\s+/g, ' '));
  }
  await doc.loadingTask.destroy();
  return pages;
}

const squash = (s: string) => s.replace(/\s+/g, '');

async function edit(bytes: Uint8Array, edits: PageEdits): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  await applyPageEdits(doc, doc.getPage(edits.pageIndex), edits);
  return doc.save();
}

const noEdits = (pageIndex: number): PageEdits => ({ pageIndex, blocks: [], images: [], texts: [], addedImages: [], shapes: [] });

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log('\n--- Building complicated fixture ---');
  const complex = await buildComplexPdf();
  await writeFile(resolve(OUT, 'complex.pdf'), complex);
  const baseline = await pdfText(complex);
  console.log(`  fixture: ${complex.length} bytes, ${baseline.length} pages`);

  console.log('\n--- Edit engine ---');
  const doc0 = await openPdf(complex);
  const page0 = analyzePage(doc0.getPage(0), 0);
  const find = (needle: string) => page0.blocks.find((b) => squash(b.text).includes(squash(needle)));

  await check('analysis finds the heading, the paragraph (as one block) and the kerned TJ line', () => {
    assert(find(PAGE1_TEXT.heading), 'heading block missing');
    const para = find(PAGE1_TEXT.para1[0]);
    assert(para, 'paragraph block missing');
    assert(squash(para.text).includes(squash(PAGE1_TEXT.para1[2])), `paragraph not grouped: ${para.text}`);
    assert(find('AVATAR'), `kerned line missing; blocks: ${page0.blocks.map((b) => b.text).join(' | ')}`);
    assert(find(PAGE1_TEXT.header), 'text inside the form XObject missing');
    assert(find('Rotated sidebar'), 'rotated text missing');
    assert(find(PAGE1_TEXT.quoteOp) && find(PAGE1_TEXT.dquoteOp), 'quote-operator text missing');
  });

  await check('analysis keeps two columns apart', () => {
    const left = find(PAGE1_TEXT.colLeft[0]);
    assert(left && !squash(left.text).includes('Right'), `columns merged: ${left?.text}`);
  });

  await check('replacing a paragraph removes the old words and adds the new ones', async () => {
    const para = find(PAGE1_TEXT.para1[0])!;
    const out = await edit(complex, { ...noEdits(0), blocks: [{ id: para.id, text: 'Totally new paragraph text that reflows onto several lines inside the original width of the paragraph box.' }] });
    await writeFile(resolve(OUT, 'edit_replace.pdf'), out);
    const text = (await pdfText(out))[0];
    assert(!text.includes('renewals'), 'old text still present');
    assert(squash(text).includes(squash('Totally new paragraph text')), 'new text missing');
    assert(squash(text).includes(squash(PAGE1_TEXT.heading)), 'heading was damaged');
    assert(squash(text).includes('AVATAR') || squash(text).includes('AVA'), 'neighbouring kerned line damaged');
  });

  await check('editing text in the shared header form leaves page 2 untouched', async () => {
    const hdr = find(PAGE1_TEXT.header)!;
    const out = await edit(complex, { ...noEdits(0), blocks: [{ id: hdr.id, text: 'Public version' }] });
    const [p1, p2] = await pdfText(out);
    assert(p1.includes('Public version') && !p1.includes('Confidential'), `page 1 header not edited: ${p1.slice(0, 120)}`);
    assert(p2.includes('Confidential'), 'page 2 header changed too');
  });

  await check('deleting the kerned TJ line keeps the rest of its BT block in place', async () => {
    const k = find('AVATAR')!;
    const out = await edit(complex, { ...noEdits(0), blocks: [{ id: k.id, deleted: true }] });
    const text = (await pdfText(out))[0];
    assert(!squash(text).includes('AVATAR') && !text.includes('okyo'), 'kerned text still present');
    assert(squash(text).includes(squash(PAGE1_TEXT.quoteOp)), 'other text lost');
  });

  await check('moving a block keeps its text and changes its position', async () => {
    const b = find('Text on a gray box')!;
    const out = await edit(complex, { ...noEdits(0), blocks: [{ id: b.id, dx: 100, dy: 50 }] });
    const d = await openPdf(out);
    const again = analyzePage(d.getPage(0), 0).blocks.find((x) => x.text.includes('gray box'));
    assert(again, 'moved text missing');
    assert(Math.abs(again.box.x - (b.box.x + 100)) < 3 && Math.abs(again.box.y - (b.box.y + 50)) < 3, `wrong position ${again.box.x},${again.box.y} vs ${b.box.x},${b.box.y}`);
  });

  await check('style changes (bold, size, color) re-typeset the block', async () => {
    const b = find(PAGE1_TEXT.colRight[0])!;
    const out = await edit(complex, { ...noEdits(0), blocks: [{ id: b.id, style: { bold: true, fontSize: 14, color: '#cc0000' } }] });
    const d = await openPdf(out);
    const again = analyzePage(d.getPage(0), 0).blocks.find((x) => x.text.includes('Right column first'));
    assert(again && again.style.bold && Math.abs(again.style.fontSize - 14) < 0.6 && again.style.color === '#cc0000', `style not applied: ${JSON.stringify(again?.style)}`);
  });

  await check('editing on a rotated, cropped page and with an embedded subset font', async () => {
    const d = await openPdf(complex);
    const p2 = analyzePage(d.getPage(1), 1);
    const uni = p2.blocks.find((b) => b.text.includes('Unicode line'));
    assert(uni, `unicode block missing: ${p2.blocks.map((b) => b.text).join(' | ')}`);
    assert(uni.editable, `subset Type0 block not editable: ${uni.reason}`);
    const rot = p2.blocks.find((b) => b.text.includes('rotated ninety'))!;
    await applyPageEdits(d, d.getPage(1), { ...noEdits(1), blocks: [{ id: uni.id, text: 'Unicode line: Grüße aus Köln' }, { id: rot.id, text: 'Page two edited.' }] });
    const out = await d.save();
    await writeFile(resolve(OUT, 'edit_page2.pdf'), out);
    const text = (await pdfText(out))[1];
    assert(squash(text).includes('Köln') && text.includes('Page two edited.'), `page 2 edits missing: ${text}`);
    assert(!text.includes('rotated ninety'), 'old rotated-page text remains');
  });

  await check('added text, shapes, highlight and image render into the page', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const out = await edit(complex, {
      ...noEdits(0),
      texts: [{ id: 't1', x: 100, y: 100, width: 0, text: 'Added note — ünïcødé ✓', style: { fontSize: 12, color: '#111111', bold: false, italic: false, family: 'sans', align: 'left', fontChoice: 'sans' } }],
      shapes: [
        { id: 's1', kind: 'rect', x: 50, y: 50, width: 80, height: 40, fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 },
        { id: 's2', kind: 'highlight', x: 72, y: 90, width: 200, height: 18, fill: '#FFE066', stroke: null, strokeWidth: 0, opacity: 0.45 },
        { id: 's3', kind: 'ellipse', x: 300, y: 50, width: 60, height: 30, fill: null, stroke: '#d6341f', strokeWidth: 1.5, opacity: 1 },
      ],
      addedImages: [{ id: 'i1', x: 400, y: 60, width: 40, height: 40, bytes: ab(png), type: 'png' }],
    });
    await writeFile(resolve(OUT, 'edit_added.pdf'), out);
    const text = (await pdfText(out))[0];
    assert(text.includes('Added note'), 'added text missing');
  });

  await check('existing images can be deleted and moved', async () => {
    const imgs = page0.model.images;
    assert(imgs.length >= 1, 'inline image not detected');
    const out = await edit(complex, { ...noEdits(0), images: [{ id: imgs[0].id, box: { ...imgs[0].box, x: imgs[0].box.x - 100 } }] });
    const d = await openPdf(out);
    const moved = analyzePage(d.getPage(0), 0).model.images[0];
    assert(Math.abs(moved.box.x - (imgs[0].box.x - 100)) < 1, `image not moved: ${moved.box.x}`);
    const del = await edit(complex, { ...noEdits(0), images: [{ id: imgs[0].id, deleted: true }] });
    const d2 = await openPdf(del);
    assert(analyzePage(d2.getPage(0), 0).model.images.length === imgs.length - 1, 'image not deleted');
  });

  console.log('\n--- Encryption / decryption ---');
  const rc4Owner = await encryptLegacy(complex, { userPassword: '', ownerPassword: 'owner-secret', aes: false });
  const aesUser = await encryptLegacy(complex, { userPassword: 'open-me', ownerPassword: 'owner-secret', aes: true });
  await writeFile(resolve(OUT, 'rc4_owner_only.pdf'), rc4Owner);
  await writeFile(resolve(OUT, 'aes128_user_pw.pdf'), aesUser);

  await check('fixtures are valid encrypted PDFs (pdf.js reads them)', async () => {
    const t = await pdfText(rc4Owner);
    assert(t[0].includes('Quarterly'), 'pdf.js could not read RC4 fixture');
    const t2 = await pdfText(aesUser, 'open-me');
    assert(t2[0].includes('Quarterly'), 'pdf.js could not read AES fixture');
  });

  await check('owner-password-only RC4 file opens with no password and every tool can use it', async () => {
    const d = await openPdf(rc4Owner);
    const out = await d.save();
    const t = await pdfText(out);
    assert(t[0].includes('Quarterly') && t[1].includes('rotated'), 'decrypted text wrong');
    const merged = await mergePdfs([{ name: 'a', buffer: ab(rc4Owner) }, { name: 'b', buffer: ab(complex) }]);
    assert(merged.pageCount === 6, `merge of encrypted file gave ${merged.pageCount} pages`);
  });

  await check('AES-128 file with an open password: rejected without, opened with', async () => {
    let threw: unknown = null;
    try {
      await openPdf(aesUser);
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof PdfPasswordError && threw.code === 'PASSWORD_REQUIRED', 'expected PASSWORD_REQUIRED');
    try {
      await openPdf(aesUser, { password: 'nope' });
      throw new Error('wrong password accepted');
    } catch (e) {
      assert(e instanceof PdfPasswordError && e.code === 'PASSWORD_INCORRECT', 'expected PASSWORD_INCORRECT');
    }
    const res = await unlockPdf({ fileBuffer: ab(aesUser), fileName: 'x.pdf', password: 'open-me' });
    const t = await pdfText(res.buffer);
    assert(t[0].includes('Quarterly'), 'unlocked text wrong');
    const res2 = await unlockPdf({ fileBuffer: ab(aesUser), fileName: 'x.pdf', password: 'owner-secret' });
    assert((await pdfText(res2.buffer))[0].includes('Quarterly'), 'owner password did not unlock');
  });

  await check('Protect (AES-256) then Unlock round-trips', async () => {
    const p = await protectPdf({ fileBuffer: ab(complex), fileName: 'c.pdf', userPassword: 'pw', permissions: { printing: false } });
    const t = await pdfText(p.buffer, 'pw');
    assert(t[0].includes('Quarterly'), 'protected file unreadable');
    const u = await unlockPdf({ fileBuffer: p.buffer, fileName: 'c.pdf', password: 'pw' });
    assert((await pdfText(u.buffer))[0].includes('Quarterly'), 'unlock of AES-256 failed');
  });

  console.log('\n--- Layout analysis & conversions ---');
  const pdfjsDoc = await getDocument({ data: complex.slice() }).promise;
  const layout = await analyzeDocumentLayout(pdfjsDoc as never);
  await check('layout: heading, table, list and separate columns detected', () => {
    const b1 = layout[0].blocks;
    assert(b1.some((b) => b.kind === 'heading' && b.text.includes('Quarterly')), 'heading not detected');
    assert(b1.some((b) => b.kind === 'table' && b.rows.length >= 3), `table not detected: ${b1.map((b) => b.kind).join(',')}`);
    assert(layout[2].blocks.some((b) => b.kind === 'list' && b.items.length === 3), 'bullet list not detected');
  });
  await check('layout: pictures found where they are drawn (for PDF→Word)', () => {
    const pics = layout.flatMap((p) => p.blocks.filter((b) => b.kind === 'image').map((b) => ({ page: p.pageNumber, box: b.box })));
    assert(pics.length >= 1, 'no picture found');
    for (const { box } of pics) assert(box.x1 - box.x0 >= 24 && box.y1 - box.y0 >= 24, `picture box too small: ${JSON.stringify(box)}`);
  });
  await check('Markdown output has #, table pipes and list items', () => {
    const md = layoutToMarkdown(layout, { pageHeadings: false, emphasis: true });
    assert(/^# |\n# |^## |\n## /m.test(md), 'no heading');
    assert(md.includes('| Region |'), 'no table');
    assert(/\n- First bullet/.test(md), 'no list');
  });
  await check('tables: centred headers and right-aligned numbers keep their columns; prose stays prose', async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const b = await d.embedFont(StandardFonts.HelveticaBold);
    const pg = d.addPage([595, 842]);
    let y = 800;
    const at = (t: string, x: number, font = f) => pg.drawText(t, { x, y, size: 10, font });
    const right = (t: string, x1: number) => at(t, x1 - f.widthOfTextAtSize(t, 10));
    const center = (t: string, cx: number) => at(t, cx - b.widthOfTextAtSize(t, 10) / 2, b);
    at('Ordinary prose that runs across most of the page and must remain a paragraph of text,', 50);
    y -= 13;
    at('not turn into a table just because it has several lines of similar length in a row.', 50);
    y -= 30;
    center('Region', 90); center('Units', 185); center('Revenue', 250); center('Growth', 312);
    y -= 13;
    for (const [r, u, rev, g] of [['North', '1,204', '1,234,567', '4%'], ['South', '980', '5', '-12%'], ['East Coast', '12', '98,000', '100%']]) {
      at(r, 50); right(u, 209); right(rev, 274); right(g, 340);
      y -= 13;
    }
    const pdf = await getDocument({ data: await d.save() }).promise;
    const [pageLayout] = await analyzeDocumentLayout(pdf as never);
    const tables = pageLayout.blocks.filter((x) => x.kind === 'table') as Array<{ rows: string[][] }>;
    assert(tables.length === 1, `expected one table, got ${tables.length}`);
    const rows = tables[0].rows;
    assert(JSON.stringify(rows[0]) === JSON.stringify(['Region', 'Units', 'Revenue', 'Growth']), `header row: ${JSON.stringify(rows[0])}`);
    assert(JSON.stringify(rows[2]) === JSON.stringify(['South', '980', '5', '-12%']), `data row: ${JSON.stringify(rows[2])}`);
    assert(!pageLayout.blocks.some((x) => x.kind === 'heading' && /Region/.test(x.text)), 'header row became a heading');
    assert(pageLayout.blocks.some((x) => x.kind === 'paragraph' && /Ordinary prose/.test(x.text)), 'prose was not kept as a paragraph');
  });
  await check('Word output builds', async () => {
    const r = await buildDocxFromLayout(layout, 'c.pdf', { pageBreaks: true });
    assert(r.size > 3000, 'docx too small');
    await writeFile(resolve(OUT, 'complex.docx'), new Uint8Array(r.buffer));
  });

  console.log('\n--- Memory fail-safe ---');
  await check('fail-safe: slows down, then pauses, and stops only as a last resort', async () => {
    const { levelFor } = createRequire(import.meta.url)('../electron/memoryGuard.cjs') as {
      levelFor: (o: { growth: number; budget: number; low?: boolean; overFor?: number }) => { level: string; reason?: string };
    };
    const MB = 1024 * 1024;
    const budget = 1024 * MB;
    const at = (growth: number, extra: { low?: boolean; overFor?: number } = {}) => levelFor({ growth, budget, ...extra });
    assert(at(300 * MB).level === 'normal', 'normal under 70%');
    assert(at(800 * MB).level === 'high', 'smaller pieces from 70%');
    assert(at(1100 * MB).level === 'over', 'over the budget pauses first');
    assert(at(1100 * MB, { overFor: 5000 }).level === 'over', 'still pausing after 5 s');
    const stuck = at(1100 * MB, { overFor: 9000 });
    assert(stuck.level === 'critical' && stuck.reason === 'too-big', 'stops when pausing does not help');
    assert(at(2100 * MB).level === 'critical', 'a runaway stops at once');
    const low = at(200 * MB, { low: true });
    assert(low.level === 'critical' && low.reason === 'system', 'stops when Windows is nearly out of memory');
    assert(at(50 * MB, { low: true }).level === 'high', 'a tiny job is only slowed when Windows is low');
  });

  console.log('\n--- Tools on the complicated fixture ---');
  await check('Compress keeps pages and never grows the file', async () => {
    const r = await compressPdf(ab(complex), 'c.pdf', 'recommended');
    assert(r.size <= complex.length, 'compressed file is larger');
    assert((await pdfText(r.buffer)).length === 3, 'page count changed');
  });
  await check('Crop respects rotation (displayed top margin on the rotated page)', async () => {
    const r = await cropPdf({ fileBuffer: ab(complex), fileName: 'c.pdf', margins: { top: 10, right: 0, bottom: 0, left: 0 }, pageIndices: [1] });
    const d = await PDFDocument.load(r.buffer);
    const cb = d.getPage(1).getCropBox();
    // Rotate 90: displayed top = user-space left side
    assert(Math.abs(cb.x - (20 + 10 * 72 / 25.4)) < 0.5 && Math.abs(cb.width - (800 - 10 * 72 / 25.4)) < 0.5, `crop box ${JSON.stringify(cb)}`);
  });
  await check('Watermark with non-Latin text (Unicode fallback font), tiled', async () => {
    const r = await applyWatermark({ fileBuffer: ab(complex), fileName: 'c.pdf', mode: 'text', text: 'ЧЕРНОВИК draft', fontSize: 40, color: '#cc0000', opacity: 0.2, rotationDegrees: 30, position: 'center', layer: 'above', tile: true });
    assert((await pdfText(r.buffer))[0].includes('ЧЕРНОВИК'), 'Cyrillic watermark missing');
  });
  await check('Chinese/Japanese watermark: every character embedded and readable (subset fix)', async () => {
    const text = '机密文件 請勿外傳 マル秘 東京';
    const r = await applyWatermark({ fileBuffer: ab(complex), fileName: 'c.pdf', mode: 'text', text, fontSize: 30, color: '#000000', opacity: 1, rotationDegrees: 0, position: 'center', layer: 'above' });
    const got = (await pdfText(r.buffer))[0].replace(/\s+/g, '');
    assert(got.includes(text.replace(/\s+/g, '')), `CJK text missing: ${got.slice(0, 80)}`);
    // The embedded subset must hold a real outline for each character (it used to lose most of them).
    const doc = await PDFDocument.load(new Uint8Array(r.buffer));
    const fonts = [...doc.context.enumerateIndirectObjects()]
      .map(([, o]) => o)
      .filter((o): o is PDFDict => o instanceof PDFDict && o.has(PDFName.of('FontFile2')))
      .map((fd) => doc.context.lookup(fd.get(PDFName.of('FontFile2'))));
    assert(fonts.length >= 1, 'no embedded TrueType font');
    const fk = (await import('@pdf-lib/fontkit')).default as unknown as { create(b: Uint8Array): { numGlyphs: number; getGlyph(i: number): { path: { commands: unknown[] } } } };
    const sub = fk.create(decodePDFRawStream(fonts[fonts.length - 1] as PDFRawStream).decode());
    // Only the space may be empty (13 visible characters + space + .notdef).
    let empty = 0;
    for (let g = 1; g < sub.numGlyphs; g++) if (!sub.getGlyph(g).path.commands.length) empty++;
    assert(sub.numGlyphs >= 14 && empty <= 1, `${empty} of ${sub.numGlyphs} subset glyphs are empty`);
  });
  await check('Hindi/Marathi watermark and page numbers: shaped with the Devanagari font', async () => {
    const r = await applyWatermark({ fileBuffer: ab(complex), fileName: 'c.pdf', mode: 'text', text: 'गोपनीय क्षत्रिय महाराष्ट्र', fontSize: 30, color: '#000000', opacity: 1, rotationDegrees: 0, position: 'center', layer: 'above' });
    const n = await addPageNumbers({ fileBuffer: r.buffer!, fileName: 'c.pdf', format: 'n', template: 'पृष्ठ {n} / {total}', position: 'bottom-center', fontSize: 10, color: '#000000', marginMm: 10, startPage: 1, startingNumber: 1 });
    const doc = await PDFDocument.load(new Uint8Array(n.buffer!));
    const names = [...doc.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Font')).map((o) => String((o as PDFDict).get(PDFName.of('BaseFont'))));
    assert(names.some((x) => x.includes('NotoSansDevanagari')), `Devanagari font not used: ${names.join(', ')}`);
    // Shaped output: conjuncts are single glyphs, so there are fewer glyphs than characters.
    const t = await pdfText(n.buffer);
    assert(/पृष्ठ|पृ/.test(t[0]), 'page label missing');
  });
  await check('Page numbers land upright on the rotated page', async () => {
    const r = await addPageNumbers({ fileBuffer: ab(complex), fileName: 'c.pdf', format: 'n', template: 'Page {n} of {total}', position: 'bottom-center', fontSize: 10, color: '#000000', marginMm: 10, startPage: 1, startingNumber: 1 });
    const t = await pdfText(r.buffer);
    assert(t[1].includes('Page 2 of 3'), 'label missing');
    const doc = await getDocument({ data: new Uint8Array(r.buffer) }).promise;
    const page = await doc.getPage(2);
    const vp = page.getViewport({ scale: 1 });
    const item = ((await page.getTextContent()).items as Array<{ str: string; transform: number[] }>).find((i) => i.str.includes('Page 2'))!;
    const [x, y] = [vp.transform[0] * item.transform[4] + vp.transform[2] * item.transform[5] + vp.transform[4], vp.transform[1] * item.transform[4] + vp.transform[3] * item.transform[5] + vp.transform[5]];
    assert(y > vp.height * 0.85 && x > vp.width * 0.3 && x < vp.width * 0.7, `number not at displayed bottom center (${x.toFixed(0)},${y.toFixed(0)} in ${vp.width}x${vp.height})`);
  });
  await check('Split into groups -> ZIP; organize with blank page and rotation', async () => {
    const z = await splitPdf(ab(complex), 'c.pdf', [], undefined, { groups: [[0], [1, 2]] });
    assert(z.fileName.endsWith('.zip'), 'expected zip');
    const o = await organizePdfPages(ab(complex), 'c.pdf', [2, -1, 0], [], undefined, [90, 0, 0]);
    const d = await PDFDocument.load(o.buffer);
    assert(d.getPageCount() === 3 && d.getPage(0).getRotation().angle === 90, 'organize result wrong');
  });
  await check('Redact flattens only the redacted page', async () => {
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    const r = await redactPdf({ fileBuffer: ab(complex), fileName: 'c.pdf', pages: [{ pageIndex: 0, jpeg: ab(jpeg), widthPt: 612, heightPt: 792 }], stripMetadata: true });
    const t = await pdfText(r.buffer);
    assert(!t[0].includes('Quarterly') && t[1].includes('rotated'), 'redaction scope wrong');
  });
  await check('Redact writes pages one at a time (asks for each render as it writes it)', async () => {
    // A 1×1 JPEG stands in for the page renders.
    const jpeg = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
    const asked: number[] = [];
    const ask = async <T,>(what: string, data: unknown): Promise<T> => {
      assert(what === 'redacted-page', `unexpected ask ${what}`);
      asked.push((data as { pageIndex: number }).pageIndex);
      return { jpeg: jpeg.slice().buffer, width: 1, height: 1 } as T;
    };
    const r = await redactPdf({ fileBuffer: ab(complex), fileName: 'c.pdf', pages: [0, 2].map((pageIndex) => ({ pageIndex, widthPt: 612, heightPt: 792 })), stripMetadata: true }, undefined, undefined, ask);
    assert(JSON.stringify(asked) === '[0,2]', `asked for ${JSON.stringify(asked)}`);
    const t = await pdfText(r.buffer);
    assert(t.length === 3 && !t[0].includes('Quarterly') && t[1].includes('rotated'), 'redaction scope wrong');
    const d = await PDFDocument.load(new Uint8Array(r.buffer!), { throwOnInvalidObject: true });
    assert(d.getPageCount() === 3, 'pdf-lib could not reopen the output');
  });
  await check('PDF/A: output intent, XMP and ID present', async () => {
    const r = await convertToPdfa({ fileBuffer: ab(complex), fileName: 'c.pdf' });
    const d = await PDFDocument.load(r.buffer);
    assert(d.catalog.lookup(PDFName.of('OutputIntents')) instanceof PDFArray, 'no output intent');
    assert(d.catalog.lookup(PDFName.of('Metadata')), 'no metadata');
    await writeFile(resolve(OUT, 'complex_pdfa.pdf'), new Uint8Array(r.buffer));
  });
  await check('Forms: detect and fill (with non-Latin value), flatten', async () => {
    const d = await openPdf(complex);
    const fields = describeFields(d);
    assert(fields.some((f) => f.name === 'applicant.name' && f.page === 3), `fields: ${JSON.stringify(fields)}`);
    const r = await fillForm({ fileBuffer: ab(complex), fileName: 'c.pdf', values: { 'applicant.name': 'Zoë Ødegård', 'applicant.agree': true, 'applicant.plan': 'Pro' }, flatten: true });
    const t = await pdfText(r.buffer);
    assert(t[2].includes('Zoë'), 'filled value not visible after flatten');
  });
  await check('Sign places the image on the displayed page', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const r = await stampSignature({ fileBuffer: ab(complex), fileName: 'c.pdf', signatureImageBytes: ab(png), placements: [{ pageIndex: 1, x: 100, y: 100, width: 120, height: 40 }] });
    assert(r.size > 0, 'no output');
  });
  await check('Repair rebuilds a truncated file', async () => {
    const broken = complex.slice(0, Math.floor(complex.length * 0.97));
    const r = await repairPdf({ fileBuffer: ab(broken), fileName: 'b.pdf' });
    assert((r.pageCount ?? 0) >= 1, 'nothing recovered');
  });
  await check('Word diff finds an inserted and a removed word', () => {
    const w = (s: string) => s.split(' ').map((text) => ({ text, page: 1 }));
    const d = diffWords(w('the quick brown fox jumps'), w('the quick red fox jumps high'))!;
    assert(d.some((o) => o.type === 'del' && o.words[0].text === 'brown') && d.some((o) => o.type === 'ins' && o.words.some((x) => x.text === 'high')), JSON.stringify(d));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
