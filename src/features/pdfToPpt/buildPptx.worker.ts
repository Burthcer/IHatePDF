/**
 * PDF to PowerPoint Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Each PDF page becomes one full-slide image (rendering runs on the main
 * thread via pdfjs-dist in usePdfRenderer) — this preserves exact visual
 * appearance pixel-for-pixel. On top of that background, real positioned
 * text frames are added at each text line's actual x/y/size (also
 * extracted on the main thread, via `extractPositionedText`), so the text
 * is genuinely selectable/editable in PowerPoint, not just a flat picture.
 *
 * This intentionally layers text ON TOP of the full-page image rather than
 * trying to render a text-free background (removing exactly the pixels
 * under each glyph from an arbitrary PDF's rendered raster isn't reliably
 * possible without deep content-stream surgery). The result — a faint
 * "shadow" of the original glyphs visible under/around the editable text
 * box once you select and move it — is the same tradeoff most real-world
 * "PDF to editable PPTX" converters make; a purely vector reconstruction
 * from a PDF's raw content stream is a fundamentally different, much
 * larger feature. Per-run color and bold/italic aren't extracted (see
 * `usePdfRenderer.extractPositionedText`'s doc comment for why) — text
 * frames render in solid dark grey at their real position and size.
 */

import pptxgen from 'pptxgenjs';
import type {
  WorkerRequest,
  BuildPptxPayload,
  PositionedPageText,
  PositionedTextItem,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const PT_TO_IN = 1 / 72;

interface TextLine {
  text: string;
  xPt: number;
  yTopPt: number; // top of the line, in top-left-origin slide space
  fontSizePt: number;
}

/** Groups same-line text items (close Y, PDF bottom-left origin) into lines, in reading order. */
function groupIntoLines(items: PositionedTextItem[], pageHeightPt: number): TextLine[] {
  const sorted = [...items].sort((a, b) => (b.yPt - a.yPt) || (a.xPt - b.xPt));
  const lines: TextLine[] = [];
  let current: PositionedTextItem[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const minX = Math.min(...current.map((i) => i.xPt));
    const maxFontSize = Math.max(...current.map((i) => i.fontSizePt));
    const avgY = current.reduce((sum, i) => sum + i.yPt, 0) / current.length;
    const text = current.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      lines.push({ text, xPt: minX, yTopPt: pageHeightPt - avgY - maxFontSize * 0.15, fontSizePt: maxFontSize });
    }
    current = [];
  };

  let prevY: number | null = null;
  for (const item of sorted) {
    if (prevY !== null && Math.abs(item.yPt - prevY) > item.fontSizePt * 0.6) {
      flush();
    }
    current.push(item);
    prevY = item.yPt;
  }
  flush();

  return lines;
}

/**
 * Builds a .pptx from rendered page images + positioned text. Plain
 * exported function (no Worker/`self` dependency) so it's directly
 * testable from a Node script — see scripts/test-all-features.ts.
 */
export async function buildPptxFromPages(
  slides: BuildPptxPayload['slides'],
  pageText: PositionedPageText[] | undefined,
  fileName: string,
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  if (!slides || slides.length === 0) {
    throw new Error('No rendered pages provided to build a presentation from.');
  }

  onProgress?.(20, 'Assembling slides...');
  const pres = new pptxgen();
  const widthIn = slides[0].widthPt * PT_TO_IN;
  const heightIn = slides[0].heightPt * PT_TO_IN;
  pres.defineLayout({ name: 'PDF_PAGE', width: widthIn, height: heightIn });
  pres.layout = 'PDF_PAGE';

  const textByPage = new Map<number, PositionedPageText>();
  (pageText || []).forEach((p) => textByPage.set(p.pageNumber, p));

  slides.forEach((slide, idx) => {
    const s = pres.addSlide();
    s.addImage({
      data: slide.dataUrl,
      x: 0,
      y: 0,
      w: slide.widthPt * PT_TO_IN,
      h: slide.heightPt * PT_TO_IN,
    });

    const pageTextData = textByPage.get(idx + 1);
    if (pageTextData) {
      const lines = groupIntoLines(pageTextData.items, pageTextData.heightPt);
      for (const line of lines) {
        s.addText(line.text, {
          x: line.xPt * PT_TO_IN,
          y: line.yTopPt * PT_TO_IN,
          w: (slide.widthPt - line.xPt) * PT_TO_IN,
          h: line.fontSizePt * 1.4 * PT_TO_IN,
          fontSize: line.fontSizePt,
          color: '1A1A1A',
          fontFace: 'Arial',
          margin: 0,
          valign: 'top',
        });
      }
    }

    onProgress?.(20 + Math.round((idx / slides.length) * 50), `Adding slide ${idx + 1}/${slides.length}...`);
  });

  onProgress?.(80, 'Packing .pptx archive...');
  const arrayBuffer = (await pres.write({ outputType: 'arraybuffer' })) as ArrayBuffer;

  onProgress?.(100, 'Presentation ready.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}.pptx`,
    buffer: arrayBuffer,
    size: arrayBuffer.byteLength,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<BuildPptxPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'BUILD_PPTX') return;

  try {
    const result = await buildPptxFromPages(payload.slides, payload.pageText, payload.fileName, (progress, stage) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
      self.postMessage(msg);
    });
    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to build PowerPoint presentation';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
