/**
 * Split PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Either extracts pages into one new PDF, or writes several PDFs (one per
 * group of pages) packed into a ZIP.
 *
 * `splitPdf` is a plain exported function (no Worker/`self` dependency) so
 * it's directly testable from a Node script.
 */

import { PDFDocument } from 'pdf-lib';
import { createZip } from '../../services/zipWriter';
import { openPdf } from '../../services/pdfLoader';
import type { WorkerRequest, SplitPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

async function buildDoc(source: PDFDocument, indices: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(source, indices);
  copied.forEach((p) => doc.addPage(p));
  return doc.save({ useObjectStreams: true });
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function label(indices: number[]): string {
  const first = indices[0] + 1;
  const last = indices[indices.length - 1] + 1;
  return first === last ? `p${first}` : `p${first}-${last}`;
}

export async function splitPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  ranges: SplitPayload['ranges'],
  onProgress?: (progress: number, stage: string) => void,
  options: { groups?: number[][] } = {}
): Promise<ProcessedPdfResult> {
  if (!fileBuffer) throw new Error('No PDF buffer supplied for splitting.');

  onProgress?.(10, 'Loading source PDF document...');
  const sourceDoc = await openPdf(fileBuffer);
  const totalPages = sourceDoc.getPageCount();
  const base = fileName.replace(/\.[^/.]+$/, '');

  // Multiple output files
  let groups = options.groups;
  if (!groups && ranges === 'all') groups = Array.from({ length: totalPages }, (_, i) => [i]);
  if (groups) {
    const valid = groups.map((g) => g.filter((i) => i >= 0 && i < totalPages)).filter((g) => g.length > 0);
    if (valid.length === 0) throw new Error('No valid pages selected.');
    if (valid.length === 1) {
      onProgress?.(60, 'Extracting pages...');
      const bytes = await buildDoc(sourceDoc, valid[0]);
      const buffer = toBuffer(bytes);
      onProgress?.(100, 'Done.');
      return { fileName: `${base}_${label(valid[0])}.pdf`, buffer, size: buffer.byteLength, pageCount: valid[0].length };
    }
    const entries: { name: string; data: Uint8Array }[] = [];
    const pad = String(valid.length).length;
    for (let i = 0; i < valid.length; i++) {
      onProgress?.(10 + Math.round((i / valid.length) * 80), `Writing file ${i + 1} of ${valid.length}...`);
      entries.push({ name: `${base}_${String(i + 1).padStart(pad, '0')}_${label(valid[i])}.pdf`, data: await buildDoc(sourceDoc, valid[i]) });
    }
    onProgress?.(92, `Packing ${valid.length} files into a ZIP...`);
    const buffer = toBuffer(createZip(entries));
    onProgress?.(100, 'Done.');
    return {
      fileName: `${base}_split.zip`,
      buffer,
      size: buffer.byteLength,
      pageCount: valid.reduce((n, g) => n + g.length, 0),
    };
  }

  // One output file from the given ranges
  const indices: number[] = [];
  if (Array.isArray(ranges)) {
    for (const range of ranges) {
      const start = Math.max(0, range.from - 1);
      const end = Math.min(totalPages - 1, range.to - 1);
      for (let p = start; p <= end; p++) indices.push(p);
    }
  }
  if (indices.length === 0) throw new Error('No valid pages selected to extract.');

  onProgress?.(60, `Extracting ${indices.length} pages...`);
  const buffer = toBuffer(await buildDoc(sourceDoc, indices));
  onProgress?.(100, 'Split operation complete.');
  return { fileName: `${base}_split.pdf`, buffer, size: buffer.byteLength, pageCount: indices.length };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<SplitPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'SPLIT_PDF') return;

  try {
    const result = await splitPdf(
      payload.fileBuffer,
      payload.fileName,
      payload.ranges,
      (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      },
      { groups: payload.groups }
    );
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = { type: 'RESPONSE', payload: { id, success: true, data: result } };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to split PDF document';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
