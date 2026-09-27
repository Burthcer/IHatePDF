/**
 * Excel to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Parses the .xlsx via `xlsx` (SheetJS) and draws each sheet as a simple
 * gridded table (one PDF per workbook, paginating rows that don't fit).
 * Cell styling (colors, fonts, merged cells, formulas-as-formatted-values)
 * isn't preserved — this carries over the actual cell values in a grid.
 */

import * as XLSX from 'xlsx';
import { PDFDocument, rgb } from 'pdf-lib';
import { collectText, fontCollection } from '../../services/fonts';
import type {
  WorkerRequest,
  XlsxToPdfPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const PAGE_WIDTH = 842; // A4 landscape — spreadsheets are usually wide
const PAGE_HEIGHT = 595;
const MARGIN = 32;
const MAX_COL_WIDTH = 220;
const PADDING = 4;

/**
 * Full .xlsx -> PDF conversion. Plain exported function (no Worker/`self`
 * dependency) so it's directly testable from a Node script.
 *
 * Uses each cell's *formatted* value (dates, currency, percentages as Excel
 * shows them), sizes columns to their content, shrinks the font when a
 * sheet is too wide to fit (down to 6pt, then splits columns across
 * pages), repeats the header row on every page, and numbers pages.
 */
export async function convertXlsxToPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  if (!fileBuffer) throw new Error('No Excel file provided.');

  onProgress?.(15, 'Reading workbook...');
  const workbook = XLSX.read(new Uint8Array(fileBuffer), { type: 'array', cellDates: true });
  if (workbook.SheetNames.length === 0) throw new Error('This workbook has no sheets.');

  const sheets = workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false }) as unknown[][]).map((r) =>
      r.map((c) => (c === null || c === undefined ? '' : String(c)))
    );
    // trim empty trailing columns
    let cols = 0;
    rows.forEach((r) => r.forEach((c, i) => c.trim() && (cols = Math.max(cols, i + 1))));
    return { name, rows: rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? '')), cols };
  });

  const pdfDoc = await PDFDocument.create();
  const fonts = await fontCollection(pdfDoc, collectText(sheets.map((sh) => [sh.name, sh.rows])));
  const availW = PAGE_WIDTH - MARGIN * 2;

  onProgress?.(30, 'Laying out sheets...');
  sheets.forEach((sheet, sheetIdx) => {
    const { rows, cols } = sheet;
    const drawTitle = (page: import('pdf-lib').PDFPage, suffix: string) =>
      page.drawText(`${sheet.name}${suffix}`, { x: MARGIN, y: PAGE_HEIGHT - MARGIN - 10, size: 11, font: fonts.bold, color: rgb(0.1, 0.1, 0.1) });

    if (rows.length === 0 || cols === 0) {
      const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      drawTitle(page, '');
      page.drawText('(Empty sheet)', { x: MARGIN, y: PAGE_HEIGHT - MARGIN - 34, size: 9, font: fonts.regular, color: rgb(0.5, 0.5, 0.5) });
      return;
    }

    // Natural column widths at 9pt, then shrink the font to fit if needed.
    let fontSize = 9;
    const natural = Array.from({ length: cols }, (_, c) =>
      Math.min(MAX_COL_WIDTH, Math.max(24, ...rows.slice(0, 500).map((r, ri) => (ri === 0 ? fonts.bold : fonts.regular).widthOfTextAtSize(r[c], 9) + PADDING * 2)))
    );
    const totalNatural = natural.reduce((a, b) => a + b, 0);
    if (totalNatural > availW) fontSize = Math.max(6, (9 * availW) / totalNatural);
    const widths = natural.map((w) => (w * fontSize) / 9);

    // Split columns into bands that fit the page width.
    const bands: number[][] = [];
    let band: number[] = [];
    let used = 0;
    widths.forEach((w, c) => {
      if (band.length && used + w > availW) {
        bands.push(band);
        band = [];
        used = 0;
      }
      band.push(c);
      used += w;
    });
    bands.push(band);

    const rowH = fontSize * 1.9;
    const top = PAGE_HEIGHT - MARGIN - 26;
    const rowsPerPage = Math.max(2, Math.floor((top - MARGIN - 14) / rowH));
    const header = rows[0];
    const body = rows.slice(1);
    const chunks: string[][][] = [];
    for (let i = 0; i < Math.max(1, body.length); i += rowsPerPage - 1) chunks.push(body.slice(i, i + rowsPerPage - 1));

    const fit = (text: string, font: import('pdf-lib').PDFFont, max: number) => {
      if (font.widthOfTextAtSize(text, fontSize) <= max) return text;
      let t = text;
      while (t.length > 1 && font.widthOfTextAtSize(t + '…', fontSize) > max) t = t.slice(0, -1);
      return t + '…';
    };
    const numeric = (t: string) => /^[-+(]?[$€£¥]?\s?[\d.,]+%?\)?$/.test(t.trim());

    let pageNo = 0;
    const totalPages = chunks.length * bands.length;
    bands.forEach((bandCols) => {
      chunks.forEach((chunk) => {
        pageNo++;
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        drawTitle(page, bands.length > 1 ? `  (columns ${XLSX.utils.encode_col(bandCols[0])}–${XLSX.utils.encode_col(bandCols[bandCols.length - 1])})` : '');
        let y = top;
        [header, ...chunk].forEach((row, ri) => {
          let x = MARGIN;
          if (ri === 0) page.drawRectangle({ x, y: y - rowH, width: bandCols.reduce((n, c) => n + widths[c], 0), height: rowH, color: rgb(0.94, 0.93, 0.9) });
          for (const c of bandCols) {
            const w = widths[c];
            const font = ri === 0 ? fonts.bold : fonts.regular;
            const text = fit((row[c] ?? '').replace(/\s+/g, ' '), font, w - PADDING * 2);
            const tw = font.widthOfTextAtSize(text, fontSize);
            const tx = ri > 0 && numeric(text) ? x + w - PADDING - tw : x + PADDING;
            if (text) page.drawText(text, { x: tx, y: y - rowH + (rowH - fontSize) / 2 + fontSize * 0.2, size: fontSize, font, color: rgb(0.12, 0.12, 0.12) });
            page.drawRectangle({ x, y: y - rowH, width: w, height: rowH, borderColor: rgb(0.8, 0.79, 0.75), borderWidth: 0.5 });
            x += w;
          }
          y -= rowH;
        });
        page.drawText(`${pageNo} / ${totalPages}`, { x: PAGE_WIDTH - MARGIN - 40, y: MARGIN - 14, size: 8, font: fonts.regular, color: rgb(0.5, 0.5, 0.5) });
      });
    });

    onProgress?.(30 + Math.round(((sheetIdx + 1) / sheets.length) * 55), `Laid out "${sheet.name}"...`);
  });

  onProgress?.(95, 'Saving PDF...');
  const pdfBytes = await pdfDoc.save();
  const resultBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;

  onProgress?.(100, 'PDF ready.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    mimeType: 'application/pdf',
    pageCount: pdfDoc.getPageCount(),
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<XlsxToPdfPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'XLSX_TO_PDF') return;

  try {
    const result = await convertXlsxToPdf(payload.fileBuffer, payload.fileName, (progress, stage) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
      self.postMessage(msg);
    });
    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert Excel to PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
