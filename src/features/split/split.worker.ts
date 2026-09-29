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
import { ZipStreamWriter } from '../../services/zipWriter';
import { openPdf } from '../../services/pdfLoader';
import { appendPages } from '../../services/pageTree';
import { saveToSink, type ChunkSink } from '../../services/pdfStreamSave';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';
import type { SplitPayload, ProcessedPdfResult, PdfInput } from '../../types/worker';

async function buildDoc(source: PDFDocument, indices: number[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(source, indices);
  appendPages(doc, copied);
  return doc;
}

/** Collects streamed bytes (for the in-memory, sink-less path). */
function memorySink(): ChunkSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: (c) => void parts.push(c.slice()),
    bytes() {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    },
  };
}

function label(indices: number[]): string {
  const first = indices[0] + 1;
  const last = indices[indices.length - 1] + 1;
  return first === last ? `p${first}` : `p${first}-${last}`;
}

export async function splitPdf(
  fileBuffer: PdfInput,
  fileName: string,
  ranges: SplitPayload['ranges'],
  onProgress?: (progress: number, stage: string) => void,
  options: { groups?: number[][]; sink?: OutputSink } = {}
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
      const out = await emitPdf(await buildDoc(sourceDoc, valid[0]), options.sink);
      onProgress?.(100, 'Done.');
      return { fileName: `${base}_${label(valid[0])}.pdf`, ...out, pageCount: valid[0].length };
    }
    // Each part is written straight into the ZIP as it's made.
    const mem = options.sink ? null : memorySink();
    const zip = new ZipStreamWriter(options.sink ?? mem!);
    const pad = String(valid.length).length;
    for (let i = 0; i < valid.length; i++) {
      onProgress?.(10 + Math.round((i / valid.length) * 85), `Writing file ${i + 1} of ${valid.length}...`);
      const part = await buildDoc(sourceDoc, valid[i]);
      await zip.addEntry(`${base}_${String(i + 1).padStart(pad, '0')}_${label(valid[i])}.pdf`, (s) => saveToSink(part, s).then(() => undefined));
    }
    await zip.finish();
    onProgress?.(100, 'Done.');
    const pageCount = valid.reduce((n, g) => n + g.length, 0);
    if (options.sink) {
      const output = await options.sink.close();
      return { fileName: `${base}_split.zip`, output, size: output.size, pageCount };
    }
    const bytes = mem!.bytes();
    return { fileName: `${base}_split.zip`, buffer: bytes.buffer as ArrayBuffer, size: bytes.byteLength, pageCount };
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
  const out = await emitPdf(await buildDoc(sourceDoc, indices), options.sink);
  onProgress?.(100, 'Split operation complete.');
  return { fileName: `${base}_split.pdf`, ...out, pageCount: indices.length };
}

serveTask<SplitPayload, ProcessedPdfResult>(
  'SPLIT_PDF',
  (p, ctx) => splitPdf(p.fileBuffer, p.fileName, p.ranges, ctx.progress, { groups: p.groups, sink: ctx.sink() }),
  'Failed to split PDF document'
);
