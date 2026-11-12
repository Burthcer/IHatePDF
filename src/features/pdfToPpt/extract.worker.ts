/**
 * PDF → PowerPoint, step 1: split each page into
 *  - a background (the page with every glyph removed from its content
 *    stream by the editor engine — so no "ghost" text under the text boxes)
 *  - positioned, styled paragraphs to become real PowerPoint text boxes.
 */

import { openPdf } from '../../services/pdfLoader';
import { analyzePage, applyPageEdits } from '../editPdf/engine/rewrite';
import { blocksToPptBoxes } from './textBoxes';
import type { PdfInput, PptTextBox } from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<{ id: string; action: string; payload: { buffer: PdfInput; skipBackground?: boolean } }>) => {
  const { id, action, payload } = event.data ?? {};
  if (action !== 'EXTRACT_FOR_PPT') return;
  const progress = (p: number, stage: string) => self.postMessage({ type: 'PROGRESS', payload: { id, progress: p, stage } });
  try {
    const doc = await openPdf(payload.buffer);
    const pages = doc.getPages();
    const out: Array<{ boxes: PptTextBox[] }> = [];
    for (let i = 0; i < pages.length; i++) {
      progress(Math.round((i / pages.length) * 90), `Separating text from page ${i + 1}...`);
      const { blocks } = analyzePage(pages[i], i);
      out.push({
        boxes: blocksToPptBoxes(blocks),
      });
      if (payload.skipBackground) continue;
      await applyPageEdits(doc, pages[i], {
        pageIndex: i,
        blocks: blocks.map((b) => ({ id: b.id, deleted: true })),
        images: [],
        texts: [],
        addedImages: [],
        shapes: [],
      });
    }
    if (payload.skipBackground) {
      (self as unknown as Worker).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: { background: null, pages: out } } });
      return;
    }
    progress(95, 'Saving backgrounds...');
    const bytes = await doc.save({ useObjectStreams: false });
    const background = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    (self as unknown as Worker).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: { background, pages: out } } }, [background]);
  } catch (err) {
    self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : String(err) } });
  }
});
