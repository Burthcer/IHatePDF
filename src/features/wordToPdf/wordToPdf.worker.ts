/**
 * Word (.docx) to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Dedicated worker for OOXML Word-to-PDF conversion with zero-copy buffer transfers.
 */

import { convertDocxToPdf } from './renderDocxToPdf';
import type {
  WorkerRequest,
  WordToPdfPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener(
    'message',
    async (event: MessageEvent<WorkerRequest<WordToPdfPayload>>) => {
      const { id, action, payload } = event.data;
      if (action !== 'WORD_TO_PDF') return;

      try {
        const result = await convertDocxToPdf(payload.fileBuffer, payload.fileName, (progress, stage) => {
          const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
          (self as any).postMessage(msg);
        });

        const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
          type: 'RESPONSE',
          payload: { id, success: true, data: result },
        };
        (self as any).postMessage(responseMsg, [result.buffer]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to convert Word document to PDF';
        const responseMsg: WorkerIncomingMessage = {
          type: 'RESPONSE',
          payload: { id, success: false, error: errorMsg },
        };
        (self as any).postMessage(responseMsg);
      }
    }
  );
}
