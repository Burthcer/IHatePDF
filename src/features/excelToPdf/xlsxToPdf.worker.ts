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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type {
  WorkerRequest,
  XlsxToPdfPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const PAGE_WIDTH = 792; // 11in landscape, points — spreadsheets are usually wide
const PAGE_HEIGHT = 612; // 8.5in
const MARGIN = 36;
const FONT_SIZE = 9;
const ROW_HEIGHT = 18;
const MAX_COL_WIDTH = 140;

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<XlsxToPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'XLSX_TO_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName } = payload;
    if (!fileBuffer) throw new Error('No Excel file provided.');

    emitProgress(15, 'Reading workbook...');
    const workbook = XLSX.read(new Uint8Array(fileBuffer), { type: 'array' });
    if (workbook.SheetNames.length === 0) throw new Error('This workbook has no sheets.');

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const availW = PAGE_WIDTH - MARGIN * 2;

    emitProgress(30, 'Laying out sheets...');
    workbook.SheetNames.forEach((sheetName, sheetIdx) => {
      const ws = workbook.Sheets[sheetName];
      const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const colCount = Math.max(1, ...rows.map((r) => r.length));
      const colWidth = Math.min(MAX_COL_WIDTH, availW / colCount);
      const rowsPerPage = Math.max(1, Math.floor((PAGE_HEIGHT - MARGIN * 2 - ROW_HEIGHT) / ROW_HEIGHT));

      for (let start = 0; start < rows.length || start === 0; start += rowsPerPage) {
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        let y = PAGE_HEIGHT - MARGIN;

        page.drawText(`${sheetName}`, { x: MARGIN, y, size: 13, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
        y -= ROW_HEIGHT * 1.3;

        const chunk = rows.slice(start, start + rowsPerPage);
        for (const row of chunk) {
          let x = MARGIN;
          for (let c = 0; c < colCount; c++) {
            const cellValue = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
            const truncated = cellValue.length > 20 ? cellValue.slice(0, 19) + '…' : cellValue;
            page.drawText(truncated, { x: x + 3, y: y - 12, size: FONT_SIZE, font, color: rgb(0.15, 0.15, 0.15) });
            page.drawRectangle({
              x,
              y: y - ROW_HEIGHT,
              width: colWidth,
              height: ROW_HEIGHT,
              borderColor: rgb(0.85, 0.85, 0.85),
              borderWidth: 0.5,
            });
            x += colWidth;
          }
          y -= ROW_HEIGHT;
        }

        if (rows.length === 0) {
          page.drawText('(Empty sheet)', { x: MARGIN, y: y - 12, size: FONT_SIZE, font, color: rgb(0.5, 0.5, 0.5) });
        }
      }

      emitProgress(30 + Math.round(((sheetIdx + 1) / workbook.SheetNames.length) * 55), `Laying out "${sheetName}"...`);
    });

    emitProgress(95, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const resultBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'PDF ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      mimeType: 'application/pdf',
    };
    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert Excel to PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
