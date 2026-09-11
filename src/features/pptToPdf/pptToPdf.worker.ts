/**
 * PowerPoint to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * High-fidelity rewrite: unzips .pptx via zipReader.ts, resolves theme color
 * schemes, determines exact slide ordering from presentation.xml (preventing
 * orphaned blank slides), resolves placeholder positions from slideLayouts,
 * and renders shapes, tables, bullets, and raster images (<p:pic> PNG/JPEG)
 * onto a pdf-lib landscape page at exact coordinates.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { readZip } from '../../services/zipReader';
import {
  parseSlideSize,
  parseTheme,
  parseSlide,
  parseSlideOrder,
  parseRelationships,
  resolveZipPath,
  DEFAULT_BLACK,
  type ParsedFill,
  type ParsedParagraph,
  type ParsedShape,
  type ParsedTable,
  type RgbColor,
  type Theme,
} from './pptxParser';
import type {
  WorkerRequest,
  PptToPdfPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const GRADIENT_BANDS = 48;
const PAGE_BOTTOM_MARGIN = 36; // Keep 36pt margin at bottom of slide; do not truncate text prematurely

function toColor(c: RgbColor) {
  return rgb(c.r / 255, c.g / 255, c.b / 255);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: RgbColor, b: RgbColor, t: number): RgbColor {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/** Fills a rectangle with a solid color, a gradient (approximated as bands), or nothing. */
function drawFill(page: PDFPage, x: number, y: number, w: number, h: number, fill: ParsedFill) {
  if (fill.kind === 'none') return;
  if (fill.kind === 'solid') {
    page.drawRectangle({ x, y, width: w, height: h, color: toColor(fill.color) });
    return;
  }
  // Approximate linear gradient as horizontal bands
  const stops = [...fill.stops].sort((a, b) => a.pos - b.pos);
  const bandWidth = w / GRADIENT_BANDS;
  for (let i = 0; i < GRADIENT_BANDS; i++) {
    const t = i / (GRADIENT_BANDS - 1);
    let color = stops[stops.length - 1].color;
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s].pos && t <= stops[s + 1].pos) {
        const localT = (t - stops[s].pos) / Math.max(1e-6, stops[s + 1].pos - stops[s].pos);
        color = lerpColor(stops[s].color, stops[s + 1].color, localT);
        break;
      }
    }
    page.drawRectangle({ x: x + i * bandWidth, y, width: bandWidth + 0.5, height: h, color: toColor(color) });
  }
}

function pickFont(fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>, bold: boolean, italic: boolean): PDFFont {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

/** Wraps a paragraph's runs into lines that fit `maxWidth`, keeping per-run styling and handling newlines. */
function wrapParagraph(
  paragraph: ParsedParagraph,
  maxWidth: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
): Array<Array<{ text: string; font: PDFFont; color: RgbColor; sizePt: number; width: number }>> {
  const words: Array<{ text: string; font: PDFFont; color: RgbColor; sizePt: number; width: number }> = [];
  for (const run of paragraph.runs) {
    if (run.text === '\n') {
      words.push({ text: '\n', font: fonts.regular, color: run.color, sizePt: run.sizePt, width: 0 });
      continue;
    }
    const font = pickFont(fonts, run.bold, run.italic);
    for (const word of run.text.split(/(\s+)/).filter((w) => w.length > 0)) {
      words.push({ text: word, font, color: run.color, sizePt: run.sizePt, width: font.widthOfTextAtSize(word, run.sizePt) });
    }
  }

  const lines: Array<Array<{ text: string; font: PDFFont; color: RgbColor; sizePt: number; width: number }>> = [];
  let current: typeof words = [];
  let currentWidth = 0;

  for (const word of words) {
    if (word.text === '\n') {
      lines.push(current);
      current = [];
      currentWidth = 0;
      continue;
    }
    if (word.text.trim() === '') {
      if (current.length > 0) current.push(word);
      currentWidth += word.width;
      continue;
    }
    if (currentWidth + word.width > maxWidth && current.length > 0) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(word);
    currentWidth += word.width;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function drawShapeText(
  page: PDFPage,
  shape: { xPt: number; yPt: number; widthPt: number; heightPt: number },
  paragraphs: ParsedParagraph[],
  pageHeight: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
) {
  const PADDING = 4;
  const boxLeft = shape.xPt + PADDING;
  const boxWidth = Math.max(1, shape.widthPt - PADDING * 2);
  let y = pageHeight - shape.yPt - PADDING; // pdf-lib origin is bottom-left; slide XML origin is top-left

  for (const paragraph of paragraphs) {
    const indent = (paragraph.level || 0) * 16;
    const effectiveWidth = Math.max(20, boxWidth - indent);
    const startX = boxLeft + indent;

    const lines = wrapParagraph(paragraph, effectiveWidth, fonts);
    let isFirstLine = true;

    for (const line of lines) {
      const lineSize = line.length > 0 ? Math.max(...line.map((w) => w.sizePt)) : 14;
      const lineHeight = lineSize * 1.25;
      y -= lineHeight;
      // Allow text to render down to bottom margin of page (do not prematurely truncate!)
      if (y < PAGE_BOTTOM_MARGIN) return;

      const lineWidth = line.reduce((sum, w) => sum + w.width, 0);
      let x = startX;
      if (paragraph.align === 'ctr') x = startX + (effectiveWidth - lineWidth) / 2;
      else if (paragraph.align === 'r') x = startX + (effectiveWidth - lineWidth);

      // Bullet prefix for bulleted lists
      if (isFirstLine && paragraph.bullet) {
        const bulletText = paragraph.bullet + ' ';
        const bulletWidth = fonts.regular.widthOfTextAtSize(bulletText, lineSize);
        page.drawText(bulletText, {
          x: Math.max(boxLeft, x - bulletWidth - 4),
          y,
          size: lineSize,
          font: fonts.regular,
          color: toColor(line[0]?.color || DEFAULT_BLACK),
        });
      }
      isFirstLine = false;

      for (const word of line) {
        if (word.text.trim() !== '') {
          page.drawText(word.text, { x, y, size: word.sizePt, font: word.font, color: toColor(word.color) });
        }
        x += word.width;
      }
    }
  }
}

function drawTable(
  page: PDFPage,
  table: ParsedTable,
  pageHeight: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
) {
  const rowCount = table.rows.length;
  const colCount = Math.max(...table.rows.map((r) => r.length));
  const rowHeight = table.heightPt / rowCount;
  const colWidth = table.widthPt / colCount;

  table.rows.forEach((row, rIdx) => {
    row.forEach((cell, cIdx) => {
      const cellX = table.xPt + cIdx * colWidth;
      const cellY = table.yPt + rIdx * rowHeight;
      drawFill(page, cellX, pageHeight - cellY - rowHeight, colWidth, rowHeight, cell.fill);
      page.drawRectangle({
        x: cellX,
        y: pageHeight - cellY - rowHeight,
        width: colWidth,
        height: rowHeight,
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 0.75,
      });
      drawShapeText(page, { xPt: cellX, yPt: cellY, widthPt: colWidth, heightPt: rowHeight }, cell.paragraphs, pageHeight, fonts);
    });
  });
}

function drawShape(
  page: PDFPage,
  shape: ParsedShape,
  pageHeight: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
) {
  drawFill(page, shape.xPt, pageHeight - shape.yPt - shape.heightPt, shape.widthPt, shape.heightPt, shape.fill);
  drawShapeText(page, shape, shape.paragraphs, pageHeight, fonts);
}

/**
 * Full PPTX -> PDF conversion.
 */
export async function convertPptxToPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  if (!fileBuffer) throw new Error('No PowerPoint file provided.');

  onProgress?.(10, 'Unzipping presentation archive...');
  const entries = await readZip(new Uint8Array(fileBuffer));
  const decoder = new TextDecoder();

  const presentationXmlEntry = entries.get('ppt/presentation.xml');
  if (!presentationXmlEntry) throw new Error('No slides found — this may not be a valid .pptx file.');
  const presentationXml = decoder.decode(presentationXmlEntry);
  const slideSize = parseSlideSize(presentationXml);

  const themeEntryName = Array.from(entries.keys()).find((n) => /^ppt\/theme\/theme\d*\.xml$/.test(n));
  const theme: Theme = parseTheme(themeEntryName ? decoder.decode(entries.get(themeEntryName)!) : undefined);

  // Parse presentation rels to extract slides in true order
  const presentationRelsEntry = entries.get('ppt/_rels/presentation.xml.rels');
  const presentationRelsXml = presentationRelsEntry ? decoder.decode(presentationRelsEntry) : undefined;

  let slideEntries = parseSlideOrder(presentationXml, presentationRelsXml);

  // Fallback if presentation.xml did not have an sldIdLst
  if (slideEntries.length === 0) {
    slideEntries = Array.from(entries.keys())
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)![1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)![1], 10);
        return na - nb;
      });
  }

  // Filter only existing slide entries
  slideEntries = slideEntries.filter((name) => entries.has(name));

  if (slideEntries.length === 0) {
    throw new Error('No slides found — this may not be a valid .pptx file.');
  }

  onProgress?.(30, `Parsing ${slideEntries.length} slides...`);

  // Parse each slide along with its relationships and layout
  const slides = slideEntries.map((name) => {
    const slideXml = decoder.decode(entries.get(name)!);

    // Slide rels path: e.g. ppt/slides/_rels/slide1.xml.rels
    const slideBase = name.substring(name.lastIndexOf('/') + 1);
    const relsPath = `ppt/slides/_rels/${slideBase}.rels`;
    const relsEntry = entries.get(relsPath);
    const rels = parseRelationships(relsEntry ? decoder.decode(relsEntry) : undefined);

    // Find slide layout target
    let layoutXml: string | undefined = undefined;
    for (const [, target] of rels.entries()) {
      if (target.includes('slideLayout')) {
        const layoutPath = resolveZipPath('ppt/slides', target);
        const layoutEntry = entries.get(layoutPath);
        if (layoutEntry) {
          layoutXml = decoder.decode(layoutEntry);
          break;
        }
      }
    }

    return {
      name,
      rels,
      parsed: parseSlide(slideXml, theme, layoutXml, slideSize.widthPt, slideSize.heightPt),
    };
  });

  onProgress?.(50, 'Building PDF...');
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  for (let idx = 0; idx < slides.length; idx++) {
    const { rels, parsed: slide } = slides[idx];
    const page = pdfDoc.addPage([slideSize.widthPt, slideSize.heightPt]);

    // Draw background
    if (slide.background.kind === 'none') {
      page.drawRectangle({ x: 0, y: 0, width: slideSize.widthPt, height: slideSize.heightPt, color: rgb(1, 1, 1) });
    } else {
      drawFill(page, 0, 0, slideSize.widthPt, slideSize.heightPt, slide.background);
    }

    // Embed and draw pictures (<p:pic>)
    if (slide.images && slide.images.length > 0) {
      for (const img of slide.images) {
        try {
          const target = rels.get(img.rId);
          if (target) {
            const mediaPath = resolveZipPath('ppt/slides', target);
            const imgBytes = entries.get(mediaPath);
            if (imgBytes && imgBytes.byteLength > 0) {
              let embeddedImg: any = null;
              if (imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes[2] === 0x4e && imgBytes[3] === 0x47) {
                embeddedImg = await pdfDoc.embedPng(imgBytes);
              } else if (imgBytes[0] === 0xff && imgBytes[1] === 0xd8 && imgBytes[2] === 0xff) {
                embeddedImg = await pdfDoc.embedJpg(imgBytes);
              }
              if (embeddedImg) {
                page.drawImage(embeddedImg, {
                  x: img.xPt,
                  y: slideSize.heightPt - img.yPt - img.heightPt,
                  width: img.widthPt,
                  height: img.heightPt,
                });
              }
            }
          }
        } catch (imgErr) {
          console.warn('Could not embed slide image:', imgErr);
        }
      }
    }

    // Draw vector shapes and text
    for (const shape of slide.shapes) drawShape(page, shape, slideSize.heightPt, fonts);

    // Draw tables
    for (const table of slide.tables) drawTable(page, table, slideSize.heightPt, fonts);

    // Only flag empty if no shapes, no tables, no images AND white background
    if (
      slide.shapes.length === 0 &&
      slide.tables.length === 0 &&
      slide.images.length === 0 &&
      slide.background.kind === 'none'
    ) {
      page.drawText('(No extractable shapes on this slide.)', {
        x: 40,
        y: slideSize.heightPt - 40,
        size: 12,
        font: fonts.regular,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    onProgress?.(50 + Math.round((idx / slides.length) * 40), `Rendering slide ${idx + 1}/${slides.length}...`);
  }

  onProgress?.(95, 'Saving PDF...');
  const pdfBytes = await pdfDoc.save();
  const arrayBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;

  onProgress?.(100, 'PDF ready.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}.pdf`,
    buffer: arrayBuffer,
    size: arrayBuffer.byteLength,
    mimeType: 'application/pdf',
  };
}

if (typeof self !== 'undefined') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PptToPdfPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'PPT_TO_PDF') return;

    try {
      const result = await convertPptxToPdf(payload.fileBuffer, payload.fileName, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      });
      const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
        type: 'RESPONSE',
        payload: { id, success: true, data: result },
      };
      (self as any).postMessage(responseMsg, [result.buffer]);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to convert PowerPoint to PDF';
      const responseMsg: WorkerIncomingMessage = {
        type: 'RESPONSE',
        payload: { id, success: false, error: errorMsg },
      };
      self.postMessage(responseMsg);
    }
  });
}
