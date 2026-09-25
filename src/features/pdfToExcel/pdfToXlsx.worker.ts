/**
 * PDF to Excel Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Builds a real .xlsx from already-extracted row/cell data (extraction runs
 * on the main thread via pdfjs-dist in usePdfRenderer), one sheet per PDF
 * page, via the `xlsx` (SheetJS) package.
 *
 * ponytail: PDF has no actual table structure, so rows/cells are recovered
 * from text position heuristics (see groupTextItemsIntoRows) — reliable for
 * simple single-column tables, not guaranteed for complex/nested layouts.
 */

import * as XLSX from 'xlsx';
import type {
  WorkerRequest,
  PdfToXlsxPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PdfToXlsxPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'PDF_TO_XLSX') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { pages, fileName } = payload;
    if (!pages || pages.length === 0) throw new Error('No extracted table data provided.');

    emitProgress(40, 'Building workbook...');
    const workbook = XLSX.utils.book_new();
    const toCell = (v: string): string | number => {
      const t = v.trim();
      // "1,234.50", "-12", "(300)", "45%" → numbers; leave codes like "007" alone
      if (/^\(?-?[$€£]?\d{1,3}(,\d{3})*(\.\d+)?\)?%?$|^\(?-?[$€£]?\d+(\.\d+)?\)?%?$/.test(t) && !/^0\d/.test(t)) {
        const neg = t.startsWith('(') || t.startsWith('-');
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (Number.isFinite(n)) return (neg ? -n : n) / (t.endsWith('%') ? 100 : 1);
      }
      return v;
    };
    const sheetFrom = (rows: string[][]) => {
      const sheet = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map(toCell)));
      const cols = Math.max(0, ...rows.map((r) => r.length));
      sheet['!cols'] = Array.from({ length: cols }, (_, c) => ({ wch: Math.min(60, Math.max(8, ...rows.map((r) => (r[c] ?? '').length + 2))) }));
      return sheet;
    };
    if (payload.singleSheet) {
      const all: string[][] = [];
      pages.forEach((page) => {
        if (!page.rows.length) return;
        if (all.length) all.push([]);
        all.push(...page.rows);
      });
      XLSX.utils.book_append_sheet(workbook, sheetFrom(all.length ? all : [['(No text found)']]), 'Data');
    } else {
      pages.forEach((page) => {
        const rows = page.rows.length > 0 ? page.rows : [['(No text on this page)']];
        XLSX.utils.book_append_sheet(workbook, sheetFrom(rows), `Page ${page.pageNumber}`.slice(0, 31));
      });
    }

    emitProgress(80, 'Encoding .xlsx...');
    const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    emitProgress(100, 'Spreadsheet ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.xlsx`,
      buffer: out,
      size: out.byteLength,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [out]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert PDF to Excel';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
