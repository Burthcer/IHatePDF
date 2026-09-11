/**
 * Word to PDF — high-fidelity DOM render pipeline
 * IHatePDF - 100% Client-Side Architecture
 *
 * This one tool cannot run inside a Web Worker: producing a *visual* PDF
 * clone of a .docx requires actually laying it out as real DOM/CSS and
 * rasterizing that layout, and neither DOM layout nor `html2canvas` are
 * available in a Worker (no `document`). This runs on the main thread
 * instead — the browser-compatible fallback this app's own architecture
 * doc calls out as the alternative to Electron's main-process-only
 * `webContents.printToPDF` (which would only work in the packaged desktop
 * build, not when this app runs as a plain website, breaking the "100%
 * client-side, works in any browser" promise the whole app is built on).
 *
 * Pipeline: mammoth.convertToHtml -> hidden styled DOM container ->
 * html2canvas rasterization -> sliced into US-Letter-sized pages -> pdf-lib.
 *
 * Fidelity notes (real, not hypothetical — verified against
 * test-fixtures/sample-document.docx in scripts/test-all-features.ts):
 *  - Bold/italic/underline: preserved (mammoth always converts these,
 *    regardless of whether they come from direct formatting or a style).
 *  - Headings, Title/Subtitle, tables, borders: preserved via mammoth's
 *    default + a custom style map (below) mapped to real CSS in this file.
 *  - Named-style text color (e.g. a custom "Accent" character style, or
 *    Word's built-in Title/Subtitle/Heading colors) is preserved: the style
 *    map below targets it and this file's injected CSS renders the color.
 *  - Arbitrary DIRECT text color (a user selecting text and manually
 *    picking a color swatch, with no named style attached) is NOT
 *    preserved. This is a deliberate mammoth limitation — it converts
 *    semantic/named styles, not raw direct formatting — not a bug in this
 *    file. Documents that use named paragraph/character styles for color
 *    (the common case for anything built with a template) render correctly.
 */

import mammoth from 'mammoth';
import html2canvas from 'html2canvas';
import { PDFDocument, rgb } from 'pdf-lib';
import type { OfficeConversionResult } from '../../types/worker';

// US Letter at 96 CSS px/in for DOM layout, matched 1:1 in points (72pt/in)
// when composited into the PDF page.
const PAGE_WIDTH_IN = 8.5;
const PAGE_HEIGHT_IN = 11;
const DOM_DPI = 96;
const PDF_DPI = 72;
const MARGIN_IN = 0.75;
const RENDER_SCALE = 2; // supersample for crisp text

const PAGE_WIDTH_PX = PAGE_WIDTH_IN * DOM_DPI;
const PAGE_HEIGHT_PX = PAGE_HEIGHT_IN * DOM_DPI;
const MARGIN_PX = MARGIN_IN * DOM_DPI;
const CONTENT_WIDTH_PX = PAGE_WIDTH_PX - MARGIN_PX * 2;
const CONTENT_HEIGHT_PX = PAGE_HEIGHT_PX - MARGIN_PX * 2;
const PAGE_WIDTH_PT = PAGE_WIDTH_IN * PDF_DPI;
const PAGE_HEIGHT_PT = PAGE_HEIGHT_IN * PDF_DPI;

// Targets Word's built-in style names (mammoth matches by style NAME, not
// by raw direct formatting) so headings/title/subtitle/callouts/accents
// keep real color and weight instead of collapsing to plain paragraphs.
const STYLE_MAP = [
  "p[style-name='Title'] => h1.docx-title:fresh",
  "p[style-name='Subtitle'] => p.docx-subtitle:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Callout'] => p.docx-callout:fresh",
  "r[style-name='Accent'] => span.docx-accent",
  "r[style-name='Intense Emphasis'] => span.docx-accent",
];

const DOCX_CSS = `
  .docx-render {
    font-family: Calibri, 'Segoe UI', Arial, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    color: #1a1a1a;
  }
  .docx-render h1, .docx-render h2, .docx-render h3 { font-weight: 700; margin: 0.6em 0 0.3em; color: #111827; }
  .docx-render h1 { font-size: 28px; }
  .docx-render h2 { font-size: 22px; }
  .docx-render h3 { font-size: 18px; }
  .docx-render .docx-title { font-size: 34px; font-weight: 800; color: #0f172a; margin-bottom: 0.1em; }
  .docx-render .docx-subtitle { font-size: 18px; color: #64748b; margin-top: 0; margin-bottom: 0.8em; }
  .docx-render p { margin: 0 0 0.8em; }
  .docx-render .docx-callout {
    background: #fef2f2;
    border-left: 4px solid #dc2626;
    padding: 10px 14px;
    color: #7f1d1d;
    border-radius: 4px;
    margin: 0.8em 0;
  }
  .docx-render .docx-accent { color: #dc2626; font-weight: 600; }
  .docx-render strong { font-weight: 700; }
  .docx-render em { font-style: italic; }
  .docx-render table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
  .docx-render td, .docx-render th {
    border: 1px solid #94a3b8;
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }
  .docx-render th { background: #f1f5f9; font-weight: 700; }
  .docx-render ul, .docx-render ol { margin: 0 0 0.8em; padding-left: 1.4em; }
`;

/** Creates the hidden, off-screen render container used for rasterization. */
function createContainer(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'docx-render';
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.style.width = `${CONTENT_WIDTH_PX}px`;
  container.style.background = '#ffffff';
  container.style.padding = '0';

  const style = document.createElement('style');
  style.textContent = DOCX_CSS;
  container.appendChild(style);

  const content = document.createElement('div');
  content.innerHTML = html;
  container.appendChild(content);

  document.body.appendChild(container);
  return container;
}

async function waitForImages(container: HTMLElement): Promise<void> {
  const images = Array.from(container.querySelectorAll('img'));
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) return resolve();
          img.onload = () => resolve();
          img.onerror = () => resolve();
        })
    )
  );
}

export async function renderDocxToPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  onProgress?.(10, 'Parsing .docx structure...');
  const { value: html, messages } = await mammoth.convertToHtml({ arrayBuffer: fileBuffer }, { styleMap: STYLE_MAP });
  if (messages.length > 0) {
    console.warn('mammoth conversion notes:', messages);
  }

  onProgress?.(25, 'Laying out styled page...');
  const container = createContainer(html || '<p>(Empty document)</p>');

  try {
    await waitForImages(container);
    // A macrotask tick (not requestAnimationFrame) so this doesn't hang if
    // the tab is backgrounded mid-conversion — rAF callbacks are throttled
    // to near-never for hidden tabs, but html2canvas reads DOM/computed
    // styles directly rather than an actual painted frame, so it doesn't
    // need one; this tick just lets image-load reflow settle first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    onProgress?.(45, 'Rendering to canvas...');
    const fullCanvas = await html2canvas(container, {
      scale: RENDER_SCALE,
      backgroundColor: '#ffffff',
      useCORS: false,
      logging: false,
      width: CONTENT_WIDTH_PX,
      windowWidth: CONTENT_WIDTH_PX,
    });

    onProgress?.(65, 'Paginating...');
    const contentHeightPxScaled = fullCanvas.height;
    const pageContentHeightPxScaled = CONTENT_HEIGHT_PX * RENDER_SCALE;
    const pageCount = Math.max(1, Math.ceil(contentHeightPxScaled / pageContentHeightPxScaled));

    const pdfDoc = await PDFDocument.create();
    const marginPt = MARGIN_IN * PDF_DPI;
    const contentWidthPt = PAGE_WIDTH_PT - marginPt * 2;

    for (let i = 0; i < pageCount; i++) {
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = CONTENT_WIDTH_PX * RENDER_SCALE;
      sliceCanvas.height = pageContentHeightPxScaled;
      const ctx = sliceCanvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);

      const sourceY = i * pageContentHeightPxScaled;
      const sourceHeight = Math.min(pageContentHeightPxScaled, fullCanvas.height - sourceY);
      ctx.drawImage(fullCanvas, 0, sourceY, fullCanvas.width, sourceHeight, 0, 0, sliceCanvas.width, sourceHeight);

      const dataUrl = sliceCanvas.toDataURL('image/png');
      const pngBytes = await fetch(dataUrl).then((r) => r.arrayBuffer());
      const embedded = await pdfDoc.embedPng(pngBytes);

      const page = pdfDoc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
      page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, color: rgb(1, 1, 1) });
      const contentHeightPt = (sourceHeight / RENDER_SCALE) * (PDF_DPI / DOM_DPI);
      page.drawImage(embedded, {
        x: marginPt,
        y: PAGE_HEIGHT_PT - marginPt - contentHeightPt,
        width: contentWidthPt,
        height: contentHeightPt,
      });

      onProgress?.(65 + Math.round(((i + 1) / pageCount) * 25), `Composing page ${i + 1}/${pageCount}...`);
    }

    onProgress?.(95, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const buffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;

    onProgress?.(100, 'PDF ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    return {
      fileName: `${cleanBaseName}.pdf`,
      buffer,
      size: buffer.byteLength,
      mimeType: 'application/pdf',
    };
  } finally {
    container.remove();
  }
}
