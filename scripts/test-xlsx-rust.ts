/**
 * Excel to PDF: TypeScript engine (SheetJS + pdf-lib) vs Rust (crates/ihp-core/src/xlsx.rs) on generated and real .xlsx
 * files. Compares the cell text per sheet (the Rust engine dumps what it read), then pages, words and pixels with MuPDF
 * (scripts/test-stamp-compare.py).
 *   cd crates/ihp-core && cargo build --release
 *   PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-xlsx-rust.ts
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { convertXlsxToPdf } from '../src/features/excelToPdf/xlsxToPdf.worker';

const OUT = resolve('test-fixtures/xlsx-rust');
mkdirSync(OUT, { recursive: true });
(globalThis as { __ihpReadFile?: (u: URL) => Promise<Uint8Array> }).__ihpReadFile = async (u) => new Uint8Array(readFileSync(u));
const FONTS = resolve('test-fixtures/fonts');
if (!existsSync(FONTS)) throw new Error('Run scripts/test-stamp-rust.ts once first (it copies the fonts to test-fixtures/fonts).');
const CLI = resolve('crates/ihp-core/target/release/ihp-xlsx.exe');
const PY = process.env.PY ?? 'python';

/** The same row extraction as the worker. */
function sheetsOf(buf: Buffer) {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false }) as unknown[][]).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
    return { name, rows };
  });
}

const aoa = (rows: unknown[][], fmt: Record<string, string> = {}, opts: XLSX.AOA2SheetOpts = {}) => {
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, ...opts });
  for (const [addr, z] of Object.entries(fmt)) if (ws[addr]) ws[addr].z = z;
  return ws;
};
const book = (sheets: Record<string, XLSX.WorkSheet>, o: XLSX.WritingOptions = {}) => {
  const wb = XLSX.utils.book_new();
  for (const [n, ws] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, ws, n);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true, ...o }) as Uint8Array);
};

const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'.split(' ');
const generated: Record<string, Buffer> = {};

// number formats and value types
{
  const nums = [0, 1, -1, 12, 1234.5, -1234.567, 0.5, 0.123456, 1e-5, 123456789, 1234567890123, 3.14159265358979, 0.000123, 99.995, 1e15, -0.0042, 2147483648, 1 / 3];
  const fmts = ['General', '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', '0.0', '#,##0.0', '$#,##0.00', '"$"#,##0.00', '#,##0.00;(#,##0.00)', '0.00E+00', '00000', '#,##0;[Red]-#,##0', '0.000', '#.##', '#,##0 "units"', '"EUR "0.00', '0.0%;-0.0%', '#,##0.00_);(#,##0.00)', '[$€-407] #,##0.00', '[$$-409]#,##0.00'];
  const rows: unknown[][] = [['value', ...fmts]];
  const fm: Record<string, string> = {};
  nums.forEach((n, r) => {
    const row: unknown[] = [n];
    fmts.forEach((z, c) => {
      row.push(n);
      fm[XLSX.utils.encode_cell({ r: r + 1, c: c + 1 })] = z;
    });
    rows.push(row);
  });
  generated.number_formats = book({ Numbers: aoa(rows, fm) });
}
// dates and times
{
  // Excel serial numbers (Excel itself writes dates as numbers; SheetJS's own t="d" cells make the Rust engine decline).
  const dates = [45366, 44561.572569, 36161, 47668.999988, 45000.25, 0.75, 1.5, 61, 100.123456, 59, 60, 2958465, 0, 45000.99999];
  const fmts = ['yyyy-mm-dd', 'm/d/yy', 'd-mmm-yy', 'dd/mm/yyyy', 'mmm d, yyyy', 'mmmm yyyy', 'dddd', 'ddd d mmm', 'h:mm', 'h:mm:ss', 'h:mm AM/PM', 'hh:mm:ss', 'yyyy-mm-dd hh:mm', 'm/d/yy h:mm', '[h]:mm:ss', 'mm:ss', 'd/m/yy', 'yy'];
  const rows: unknown[][] = [['date', ...fmts]];
  const fm: Record<string, string> = {};
  dates.forEach((n, r) => {
    const row: unknown[] = [n];
    fmts.forEach((z, c) => {
      row.push(n);
      fm[XLSX.utils.encode_cell({ r: r + 1, c: c + 1 })] = z;
    });
    rows.push(row);
  });
  generated.date_formats = book({ Dates: aoa(rows, fm) });
}
// formats x values grid, one workbook each (the Rust engine falls back on a format it can't do exactly, so each format gets its own file)
{
  const vals = [0, 1, -1, 7, 42.5, -42.5, 0.05, 0.995, 1234.5678, -9876.54321, 100000, 1e6, 123456789.123, 0.000456, 1.005, 2.675, 5e-7, 99999.995, 45000.5, 0.3333333];
  const fmts = ['0.0', '0.00', '0.000', '0.0000', '#,##0.000', '#,###', '#,###.00', '###,###', '#,##0.0;(#,##0.0)', '0.00;-0.00;"zero"', '0;-0;;@', '0.0%', '0.000%', '#.0', '#.00', '.00', '0.##', '0.0#', '#0.0', '??0.00', '000.00', '#,##0,', '#,##0.00,,', '0.0E+0', '0E+00', '0.000E+00', '#,##0 "kr"', '"Total: "#,##0.00', '$#,##0', '$#,##0.00_);[Red]($#,##0.00)', '#,##0.00 [$€-1]', '0.00"%"', '[Blue]0.00', '[Red]-0.00;[Blue]0.00', '[>100]0.0;[<=100]0.00', '"x"0', '@', '0.00_)', '0_);(0)', '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)'];
  const rows = vals.map((v) => [v, v, v, v]);
  fmts.forEach((z, i) => {
    const ws = aoa([[`fmt ${z}`, 'b', 'c', 'd'], ...rows]);
    for (let r = 2; r <= rows.length + 1; r++) for (const c of 'ABCD') ws[c + r].z = z;
    generated[`fmt_${String(i).padStart(2, '0')}`] = book({ F: ws });
  });
}
// text, booleans, formulas, multiple sheets, blank rows and columns
{
  const rows: unknown[][] = [
    ['Name', 'Qty', 'Price', 'In stock', 'Note'],
    ...Array.from({ length: 45 }, (_, i) => [`${words[i % words.length]} item ${i}`, i * 3 + (i % 5 ? 0 : 0.5), (i + 1) * 9.99, i % 3 === 0, i % 7 === 0 ? 'A rather long note that will not fit in its column and gets cut with an ellipsis at the end' : '']),
    [],
    ['Total', { f: 'SUM(B2:B46)', v: 1234 }, { f: 'SUM(C2:C46)', v: 12345.67 }, '', 'quote "x" & <y>'],
  ];
  const ws1 = aoa(rows, { C2: '"$"#,##0.00' });
  for (let r = 2; r <= 46; r++) if (ws1['C' + r]) ws1['C' + r].z = '#,##0.00';
  const ws2 = aoa([['a', 'b'], [1, 2], [3, 4]]);
  const ws3 = aoa([[]]);
  const ws4 = aoa([['x'], [''], ['  ']]);
  generated.text_multi = book({ Inventory: ws1, 'Second sheet': ws2, Empty: ws3, 'Blanks & <odd> name': ws4 });
}
// wide sheet: font shrinks, columns split into bands
{
  const rows: unknown[][] = [Array.from({ length: 40 }, (_, c) => `Column number ${c + 1}`)];
  for (let r = 0; r < 60; r++) rows.push(Array.from({ length: 40 }, (_, c) => (c % 3 ? (r + 1) * (c + 1) * 1.25 : `${words[(r + c) % words.length]} value ${r}`)));
  generated.wide = book({ Wide: aoa(rows) });
}
// long sheet: many pages with the header repeated
{
  const rows: unknown[][] = [['#', 'Id', 'Amount', 'Percent', 'Text']];
  for (let r = 0; r < 400; r++) rows.push([r + 1, `ID-${1000 + r}`, r * 17.25 - 100, r / 400, `${words[r % words.length]} ${words[(r * 7) % words.length]}`]);
  generated.long = book({ Long: aoa(rows, {}) });
  const ws = XLSX.read(generated.long, { cellDates: true }).Sheets.Long;
  for (let r = 2; r <= 401; r++) {
    ws['C' + r].z = '#,##0.00';
    ws['D' + r].z = '0.0%';
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Long');
  generated.long = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Uint8Array);
}
// non-Latin text
generated.greek_cyrillic = book({ 'Έκθεση': aoa([['Ονομα', 'Город', 'Сумма'], ['Γιώργος', 'Москва', 1234.5], ['Мария', 'Αθήνα', 99]]) });
generated.cjk = book({ 'データ': aoa([['名前', '数量'], ['东京', 10], ['大阪', 20.5]]) });
generated.devanagari = book({ 'रिपोर्ट': aoa([['नाम', 'संख्या'], ['दिल्ली', 12], ['मुंबई', 7.5]]) });
// shared strings off (inline strings) and a sheet with offset dimension
generated.inline_strings = book({ S: aoa([['a', 'b'], ['x', 'y']]) }, { bookSST: false });
{
  const ws = aoa([['a', 'b', 'c'], [1, 2, 3], [4, 5, 6]]);
  ws['!ref'] = 'B2:C3';
  generated.offset_ref = book({ S: ws });
}

// hand-written package (the way Excel writes it): rich text and phonetic shared strings, errors, booleans, t="str", inlineStr,
// formulas with and without cached values, styles with custom formats, row/cell refs missing, a dimension that cuts cells off
{
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  z.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  z.file('xl/workbook.xml', `<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Data &amp; more" sheetId="1" r:id="rId1"/><sheet name="Cut" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`);
  z.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst ${ns} count="6" uniqueCount="6"><si><t>Plain</t></si><si><r><rPr><b/></rPr><t xml:space="preserve">Rich </t></r><r><t>text &amp; &lt;stuff&gt;</t></r></si><si><t>With phonetic</t><rPh sb="0" eb="1"><t>ignored</t></rPh></si><si><t xml:space="preserve">  spaced  </t></si><si><t>Caf&#233; &#x4E2D;</t></si><si><t></t></si></sst>`);
  z.file('xl/styles.xml', `<?xml version="1.0"?><styleSheet ${ns}><numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot; kg&quot;"/><numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="49"/></cellXfs></styleSheet>`);
  z.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet ${ns}><dimension ref="A1:F9"/><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>
<row r="2"><c r="A2" s="1"><v>1234.5</v></c><c r="B2" s="2"><v>7.25</v></c><c r="C2" s="3"><v>45366</v></c><c r="D2" s="4"><v>45366.75</v></c><c r="E2" s="5"><v>0.256</v></c><c r="F2" s="6"><v>12</v></c></row>
<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"><v>0</v></c><c r="C3" t="e"><v>#DIV/0!</v></c><c r="D3" t="str"><f>A1&amp;"x"</f><v>formula text</v></c><c r="E3" t="inlineStr"><is><t>inline</t></is></c><c r="F3"><f>1+1</f><v>2</v></c></row>
<row r="4"><c r="A4"><f>SUM(A2:A2)</f></c><c r="B4" s="1"/><c r="C4" t="inlineStr"><is><r><t>in</t></r><r><t>line rich</t></r></is></c><c r="D4" t="n"><v>1E+12</v></c><c r="E4"><v>-0.00001234</v></c><c r="F4"><v>123456789012</v></c></row>
<row r="6"><c t="s"><v>0</v></c><c><v>5</v></c><c t="e"><v>#N/A</v></c></row>
<row r="7"><c r="C7" t="e"><v>#NULL!</v></c></row>
<row r="8" ht="30"><c r="A8"><v>0.1</v></c><c r="B8"><v>0.30000000000000004</v></c><c r="C8"><v>-2147483648</v></c><c r="D8"><v>1.5e-6</v></c><c r="E8"><v>100</v></c></row>
<row r="9"><c r="Z9"><v>1</v></c></row>
</sheetData></worksheet>`);
  z.file('xl/worksheets/sheet2.xml', `<?xml version="1.0"?><worksheet ${ns}><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row><row r="2"><c r="A2"><v>4</v></c></row><row r="3"><c r="A3"><v>5</v></c></row></sheetData></worksheet>`);
  generated.handmade = Buffer.from(await z.generateAsync({ type: 'uint8array' }));
}

const real = [
  ...['complex', 'excel', 'journal_10p', 'q_word', 'test-multi', 'word'].map((n) => `test-fixtures/layout-ab/native/${n}.xlsx`),
  'test-fixtures/misc/book.xlsx',
  ...(existsSync('test-fixtures/xlsx-real') ? readdirSync('test-fixtures/xlsx-real').filter((f) => f.endsWith('.xlsx')).map((f) => `test-fixtures/xlsx-real/${f}`) : []),
].filter(existsSync);

const jobs: Array<{ name: string; path: string }> = [];
for (const [name, buf] of Object.entries(generated)) {
  const path = resolve(OUT, `${name}.xlsx`);
  writeFileSync(path, buf);
  jobs.push({ name, path });
}
for (const r of real) {
  const name = 'real_' + r.split('/').pop()!.replace('.xlsx', '').replace(/\W/g, '_') + '_' + jobs.length;
  const path = resolve(OUT, `${name}.xlsx`);
  copyFileSync(r, path);
  jobs.push({ name, path });
}

const pairs: string[] = [];
let rowsBad = 0;
let fallback = 0;
for (const j of jobs) {
  const buf = readFileSync(j.path);
  const ts = resolve(OUT, `ts_${j.name}.pdf`);
  const rs = resolve(OUT, `rs_${j.name}.pdf`);
  const json = resolve(OUT, `rs_${j.name}.json`);
  let expected: ReturnType<typeof sheetsOf>;
  try {
    expected = sheetsOf(buf);
    const r = await convertXlsxToPdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, `${j.name}.xlsx`);
    writeFileSync(ts, Buffer.from(r.buffer));
  } catch (e) {
    console.log(`SKIP ${j.name}: TypeScript engine failed (${(e as Error).message.slice(0, 80)})`);
    continue;
  }
  const r = spawnSync(CLI, [j.path, rs, json], { encoding: 'utf8', env: { ...process.env, IHP_FONTS: FONTS } });
  if (existsSync(json)) {
    const got = JSON.parse(readFileSync(json, 'utf8')) as typeof expected;
    const a = JSON.stringify(expected);
    const b = JSON.stringify(got);
    if (a !== b) {
      rowsBad++;
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      console.log(`ROWS DIFFER ${j.name}: ts ...${a.slice(Math.max(0, at - 60), at + 80)}\n                 rs ...${b.slice(Math.max(0, at - 60), at + 80)}`);
    }
  }
  if (r.status !== 0) {
    fallback++;
    console.log(`FALLBACK ${j.name}: Rust declined (${r.stderr.trim()})`);
    continue;
  }
  pairs.push(ts, rs);
}
const py = spawnSync(PY, ['scripts/test-stamp-compare.py', ...pairs], { encoding: 'utf8' });
console.log(py.stdout + py.stderr);
console.log(`${pairs.length / 2} compared, ${fallback} fell back to TypeScript, ${rowsBad} with different cell text`);
process.exit(py.status || rowsBad ? 1 : 0);
