/**
 * Edit PDF worker — holds one editing session.
 *
 *  OPEN     load the document (decrypting if needed), report page sizes
 *  ANALYZE  paragraphs, fonts and images of one page (viewer coordinates)
 *  PREVIEW  a one-page PDF with that page's edits applied, for pdf.js to
 *           render — the editor shows the real output, not an imitation
 *  EXPORT   apply every page's edits to a fresh copy and save
 */

import { PDFDocument } from 'pdf-lib';
import { openPdf, PdfPasswordError } from '../../services/pdfLoader';
import { analyzePage, applyPageEdits, pageHasEdits, type PageEdits } from './engine/rewrite';
import { userToViewer } from './engine/geometry';
import type { TextBlock } from './engine/layout';

export interface EditorPageInfo {
  width: number;
  height: number;
}

export interface EditorBlockDTO {
  id: string;
  text: string;
  lines: TextBlock['lines'];
  dir: [number, number];
  angle: number;
  box: TextBlock['box'];
  frame: TextBlock['frame'];
  style: TextBlock['style'];
  fontName: string;
  fontEmbedded: boolean;
  fontSubset: boolean;
  editable: boolean;
  reason?: string;
}

export interface EditorImageDTO {
  id: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface EditorPageAnalysis {
  pageIndex: number;
  width: number;
  height: number;
  blocks: EditorBlockDTO[];
  images: EditorImageDTO[];
}

interface Session {
  bytes: Uint8Array;
  doc: PDFDocument;
  password?: string;
}

let session: Session | null = null;

function toTransferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function handle(action: string, payload: any, progress: (p: number, s: string) => void): Promise<{ data: unknown; transfer?: Transferable[] }> {
  switch (action) {
    case 'OPEN': {
      const bytes = new Uint8Array(payload.buffer as ArrayBuffer);
      const doc = await openPdf(bytes, { password: payload.password });
      session = { bytes, doc, password: payload.password };
      const pages: EditorPageInfo[] = doc.getPages().map((p) => {
        const { width, height } = userToViewer(p);
        return { width, height };
      });
      return { data: { pages } };
    }
    case 'ANALYZE': {
      if (!session) throw new Error('No document open.');
      const pageIndex = payload.pageIndex as number;
      const page = session.doc.getPage(pageIndex);
      const { model, blocks } = analyzePage(page, pageIndex);
      const analysis: EditorPageAnalysis = {
        pageIndex,
        width: model.viewerWidth,
        height: model.viewerHeight,
        blocks: blocks.map((b) => ({
          id: b.id,
          text: b.text,
          lines: b.lines,
          dir: b.dir,
          angle: b.angle,
          box: b.box,
          frame: b.frame,
          style: b.style,
          fontName: b.fontName,
          fontEmbedded: b.font.embedded,
          fontSubset: b.font.subset,
          editable: b.editable,
          reason: b.reason,
        })),
        images: model.images
          .filter((im) => im.box.width > 1 && im.box.height > 1)
          .map((im) => ({ id: im.id, box: im.box })),
      };
      return { data: analysis };
    }
    case 'PREVIEW': {
      if (!session) throw new Error('No document open.');
      const edits = payload.edits as PageEdits;
      const out = await PDFDocument.create();
      const [copy] = await out.copyPages(session.doc, [edits.pageIndex]);
      out.addPage(copy);
      await applyPageEdits(out, copy, { ...edits, pageIndex: edits.pageIndex });
      const saved = await out.save({ useObjectStreams: false });
      const buffer = toTransferable(saved);
      return { data: { buffer }, transfer: [buffer] };
    }
    case 'EXPORT': {
      if (!session) throw new Error('No document open.');
      const all = (payload.edits as PageEdits[]).filter(pageHasEdits);
      progress(5, 'Loading a clean copy of the document...');
      const doc = await openPdf(session.bytes, { password: session.password });
      for (let i = 0; i < all.length; i++) {
        progress(10 + Math.round((i / Math.max(1, all.length)) * 75), `Applying edits to page ${all[i].pageIndex + 1}...`);
        await applyPageEdits(doc, doc.getPage(all[i].pageIndex), all[i]);
      }
      progress(90, 'Saving PDF...');
      const saved = await doc.save({ useObjectStreams: true });
      const buffer = toTransferable(saved);
      const base = String(payload.fileName || 'document').replace(/\.[^/.]+$/, '');
      progress(100, 'Done.');
      return {
        data: { fileName: `${base}_edited.pdf`, buffer, size: buffer.byteLength, pageCount: doc.getPageCount() },
        transfer: [buffer],
      };
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

self.addEventListener('message', async (event: MessageEvent<{ id: string; action: string; payload: unknown }>) => {
  const { id, action, payload } = event.data;
  const progress = (p: number, stage: string) =>
    self.postMessage({ type: 'PROGRESS', payload: { id, progress: p, stage } });
  try {
    const { data, transfer } = await handle(action, payload, progress);
    (self as unknown as Worker).postMessage({ type: 'RESPONSE', payload: { id, success: true, data } }, transfer ?? []);
  } catch (err) {
    const code = err instanceof PdfPasswordError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: message, code } });
  }
});
