/**
 * PDF → PowerPoint, step 1: split each page into
 *  - a background (the page with every glyph removed from its content
 *    stream by the editor engine — so no "ghost" text under the text boxes)
 *  - positioned, styled paragraphs to become real PowerPoint text boxes.
 */

import { openPdf } from '../../services/pdfLoader';
import { analyzePage, applyPageEdits } from '../editPdf/engine/rewrite';
import type { PdfInput, PptTextBox } from '../../types/worker';

function familyFace(fontName: string, family: 'sans' | 'serif' | 'mono'): string {
  const base = fontName.split(/[-,+]/)[0].replace(/(MT|PS|Std|Pro)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (base && /^[A-Za-z ]{3,40}$/.test(base)) return base;
  return family === 'serif' ? 'Times New Roman' : family === 'mono' ? 'Courier New' : 'Arial';
}

self.addEventListener('message', async (event: MessageEvent<{ id: string; action: string; payload: { buffer: PdfInput } }>) => {
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
        boxes: blocks
          .filter((b) => b.text.trim())
          .map((b) => ({
            x: b.box.x,
            y: b.box.y,
            width: b.box.width,
            height: b.box.height,
            lines: b.lines.map((l) => l.text),
            fontSize: b.style.fontSize,
            color: b.style.color,
            bold: b.style.bold,
            italic: b.style.italic,
            fontFace: familyFace(b.fontName, b.style.family),
            align: b.style.align === 'justify' ? 'left' : b.style.align,
            lineHeight: b.lines.length > 1 ? b.frame.lineHeight : undefined,
            rotate: b.angle,
          })),
      });
      await applyPageEdits(doc, pages[i], {
        pageIndex: i,
        blocks: blocks.map((b) => ({ id: b.id, deleted: true })),
        images: [],
        texts: [],
        addedImages: [],
        shapes: [],
      });
    }
    progress(95, 'Saving backgrounds...');
    const bytes = await doc.save({ useObjectStreams: false });
    const background = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    (self as unknown as Worker).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: { background, pages: out } } }, [background]);
  } catch (err) {
    self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : String(err) } });
  }
});
