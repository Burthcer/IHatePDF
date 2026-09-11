/**
 * PowerPoint to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * .pptx is a ZIP of OOXML slide XML. Unzips via zipReader.ts (native
 * DecompressionStream, no dependency), extracts each slide's text runs with
 * a lightweight regex pass (deliberately not a full DOMParser-based XML
 * parse — this only needs `<a:t>` text nodes inside `<a:p>` paragraphs, and
 * regex extraction of that narrow, well-defined shape is simpler and more
 * predictable in a Worker than standing up a DOM XML parser), then lays out
 * one PDF page per slide (first paragraph as a title, rest as bullets).
 * This carries over the actual slide *text*, not the visual design/images —
 * matching how PDF -> PPTX in this app goes the opposite direction (images
 * only, no editable text) since faithfully reproducing arbitrary slide
 * layouts+text+images in both directions is a much larger undertaking.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readZip } from '../../services/zipReader';
import type {
  WorkerRequest,
  PptToPdfPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const PAGE_WIDTH = 720; // 10in landscape, points
const PAGE_HEIGHT = 540; // 7.5in
const MARGIN = 48;
const TITLE_SIZE = 22;
const BODY_SIZE = 14;
const LINE_HEIGHT = BODY_SIZE * 1.4;

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractSlideParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let paraMatch: RegExpExecArray | null;
  while ((paraMatch = paraRegex.exec(xml))) {
    const textRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let textMatch: RegExpExecArray | null;
    let text = '';
    while ((textMatch = textRegex.exec(paraMatch[1]))) {
      text += textMatch[1];
    }
    text = unescapeXml(text).trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function wrapLine(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = current + ' ' + words[i];
    if (measure(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PptToPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'PPT_TO_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName } = payload;
    if (!fileBuffer) throw new Error('No PowerPoint file provided.');

    emitProgress(10, 'Unzipping presentation archive...');
    const entries = await readZip(new Uint8Array(fileBuffer));

    const slideEntries = Array.from(entries.keys())
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)![1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)![1], 10);
        return na - nb;
      });

    if (slideEntries.length === 0) {
      throw new Error('No slides found — this may not be a valid .pptx file.');
    }

    emitProgress(30, `Extracting text from ${slideEntries.length} slides...`);
    const decoder = new TextDecoder();
    const slides = slideEntries.map((name) => extractSlideParagraphs(decoder.decode(entries.get(name)!)));

    emitProgress(50, 'Building PDF...');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const maxWidth = PAGE_WIDTH - MARGIN * 2;

    slides.forEach((paragraphs, idx) => {
      const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      let y = PAGE_HEIGHT - MARGIN;

      const [title, ...body] = paragraphs;
      if (title) {
        const titleLines = wrapLine(title, maxWidth, (s) => boldFont.widthOfTextAtSize(s, TITLE_SIZE));
        for (const line of titleLines) {
          page.drawText(line, { x: MARGIN, y, size: TITLE_SIZE, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
          y -= TITLE_SIZE * 1.3;
        }
        y -= 12;
      }

      for (const para of body) {
        const lines = wrapLine(`•  ${para}`, maxWidth, (s) => font.widthOfTextAtSize(s, BODY_SIZE));
        for (const line of lines) {
          if (y < MARGIN) break;
          page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font, color: rgb(0.2, 0.2, 0.2) });
          y -= LINE_HEIGHT;
        }
      }

      if (paragraphs.length === 0) {
        page.drawText('(No extractable text on this slide.)', {
          x: MARGIN,
          y,
          size: BODY_SIZE,
          font,
          color: rgb(0.5, 0.5, 0.5),
        });
      }

      emitProgress(50 + Math.round((idx / slides.length) * 40), `Laying out slide ${idx + 1}/${slides.length}...`);
    });

    emitProgress(95, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const arrayBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'PDF ready.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.pdf`,
      buffer: arrayBuffer,
      size: arrayBuffer.byteLength,
      mimeType: 'application/pdf',
    };

    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [arrayBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert PowerPoint to PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
