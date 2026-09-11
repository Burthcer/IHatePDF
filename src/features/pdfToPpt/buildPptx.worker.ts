/**
 * PDF to PowerPoint Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Builds a .pptx from already-rendered page images (rendering runs on the
 * main thread via pdfjs-dist in usePdfRenderer). Each PDF page becomes one
 * full-slide image — this preserves exact visual appearance (the one thing
 * PDF pages actually are, pixel-for-pixel) but slide content isn't editable
 * text/shapes, matching how most real "PDF to PPT" tools work in practice
 * (reconstructing an *editable* slide from an arbitrary PDF page's raw
 * content stream is a much larger, fundamentally different feature).
 */

import pptxgen from 'pptxgenjs';
import type {
  WorkerRequest,
  BuildPptxPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const PT_TO_IN = 1 / 72;

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<BuildPptxPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'BUILD_PPTX') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { slides, fileName } = payload;
    if (!slides || slides.length === 0) {
      throw new Error('No rendered pages provided to build a presentation from.');
    }

    emitProgress(20, 'Assembling slides...');
    const pres = new pptxgen();
    const widthIn = slides[0].widthPt * PT_TO_IN;
    const heightIn = slides[0].heightPt * PT_TO_IN;
    pres.defineLayout({ name: 'PDF_PAGE', width: widthIn, height: heightIn });
    pres.layout = 'PDF_PAGE';

    slides.forEach((slide, idx) => {
      const s = pres.addSlide();
      s.addImage({
        data: slide.dataUrl,
        x: 0,
        y: 0,
        w: slide.widthPt * PT_TO_IN,
        h: slide.heightPt * PT_TO_IN,
      });
      emitProgress(20 + Math.round((idx / slides.length) * 50), `Adding slide ${idx + 1}/${slides.length}...`);
    });

    emitProgress(80, 'Packing .pptx archive...');
    const arrayBuffer = (await pres.write({ outputType: 'arraybuffer' })) as ArrayBuffer;

    emitProgress(100, 'Presentation ready.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.pptx`,
      buffer: arrayBuffer,
      size: arrayBuffer.byteLength,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };

    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [arrayBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to build PowerPoint presentation';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
