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
    pages.forEach((page) => {
      const rows = page.rows.length > 0 ? page.rows : [['(No table data detected on this page)']];
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, sheet, `Page ${page.pageNumber}`.slice(0, 31));
    });

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
