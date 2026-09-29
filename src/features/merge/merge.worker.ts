/**
 * Merge PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Combines multiple PDF ArrayBuffers into a single document using pdf-lib.
 * Utilizes zero-copy buffer transfers back to the UI thread.
 *
 * `mergePdfs` is a plain exported function (no Worker/`self` dependency)
 * so it's directly testable from a Node script — see
 * scripts/verify-conversions.ts.
 */

import { PDFDocument } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import type { MergePayload, ProcessedPdfResult } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { appendPages } from '../../services/pageTree';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function mergePdfs(
  files: MergePayload['files'],
  onProgress?: (progress: number, stage: string) => void,
  outputName = 'merged.pdf',
  sink?: OutputSink
): Promise<ProcessedPdfResult> {
  if (!files || files.length < 2) {
    throw new Error('At least two PDF files are required for merging.');
  }

  onProgress?.(5, 'Creating empty target document...');
  const mergedDoc = await PDFDocument.create();

  const totalFiles = files.length;
  let totalPagesMerged = 0;

  for (let i = 0; i < totalFiles; i++) {
    const file = files[i];
    const progressBase = 10 + Math.round((i / totalFiles) * 80);
    onProgress?.(progressBase, `Importing pages from "${file.name}" (${i + 1}/${totalFiles})...`);

    let sourceDoc: PDFDocument;
    try {
      sourceDoc = await openPdf(file.buffer);
    } catch (err) {
      throw new Error(`"${file.name}" couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    const pageIndices = sourceDoc.getPageIndices();
    const copiedPages = await mergedDoc.copyPages(sourceDoc, pageIndices);

    appendPages(mergedDoc, copiedPages);

    totalPagesMerged += pageIndices.length;
  }

  onProgress?.(95, 'Writing the merged PDF...');
  const out = await emitPdf(mergedDoc, sink);
  onProgress?.(100, 'Merge completed successfully.');

  return {
    fileName: outputName.toLowerCase().endsWith('.pdf') ? outputName : `${outputName}.pdf`,
    ...out,
    pageCount: totalPagesMerged,
  };
}

serveTask<MergePayload, ProcessedPdfResult>(
  'MERGE_PDFS',
  (payload, ctx) => mergePdfs(payload.files, ctx.progress, payload.outputName || 'merged.pdf', ctx.sink()),
  'Failed to merge PDF documents'
);
