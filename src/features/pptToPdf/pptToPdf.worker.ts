/**
 * High-Fidelity PowerPoint (.pptx) to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * 1-to-1 Document Conversion Pipeline:
 * - Unpacks .pptx XML structures via zipReader across ppt/slides/slide*.xml,
 *   slideLayouts, slideMasters, and relationships.
 * - Zero Page Drops: output page count strictly equals total slide count.
 * - Extracts presentation dimensions (<p:sldSz cx="..." cy="..."/>) for true 16:9 or 4:3 viewports.
 * - Renders slide backgrounds: solid colors, gradient fills, and image backgrounds.
 * - Renders vector shapes: rect, roundRect, ellipse, and connector lines with stroke borders.
 * - Renders embedded images (<p:pic>) resolved via relationships.
 * - Renders tables (<a:tbl>) with grid dimensions, cell fills, and borders.
 * - Renders typography: font sizes, bold/italic, alignments, bullet points, and text colors.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { readZip } from '../../services/zipReader';
import {
  parseSlideSize,
  parseTheme,
  parseRelsXml,
  parseSlide,
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
  if (fill.kind === 'gradient') {
    const stops = [...fill.stops].sort((a, b) => a.pos - b.pos);
    if (stops.length === 0) return;
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
      page.drawRectangle({
        x: x + i * bandWidth,
        y,
        width: bandWidth + 0.5,
        height: h,
        color: toColor(color),
      });
    }
  }
}

function pickFont(
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>,
  bold: boolean,
  italic: boolean
): PDFFont {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

/** Wraps a paragraph's runs into lines that fit `maxWidth`, keeping per-run styling. */
function wrapParagraph(
  paragraph: ParsedParagraph,
  maxWidth: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
): Array<Array<{ text: string; font: PDFFont; color: RgbColor; sizePt: number; width: number }>> {
  const words: Array<{ text: string; font: PDFFont; color: RgbColor; sizePt: number; width: number }> = [];

  // If bullet point, prepend bullet symbol
  let isFirst = true;
  for (const run of paragraph.runs) {
    const font = pickFont(fonts, run.bold, run.italic);
    let runText = run.text;
    if (paragraph.isBullet && isFirst) {
      runText = '• ' + runText;
      isFirst = false;
    }
    for (const word of runText.split(/(\s+)/).filter((w) => w.length > 0)) {
      words.push({
        text: word,
        font,
        color: run.color,
        sizePt: run.sizePt,
        width: font.widthOfTextAtSize(word, run.sizePt),
      });
    }
  }

  const lines: Array<Array<{ text: string; font: PDFFont; color: RgbColor; sizePt: number; width: number }>> = [];
  let current: typeof words = [];
  let currentWidth = 0;

  for (const word of words) {
    if (word.text === '\n' || word.text === '\r\n') {
      if (current.length > 0) lines.push(current);
      current = [];
      currentWidth = 0;
      continue;
    }

    if (currentWidth + word.width <= maxWidth || current.length === 0) {
      current.push(word);
      currentWidth += word.width;
    } else {
      lines.push(current);
      current = word.text.trim() === '' ? [] : [word];
      currentWidth = current.length > 0 ? word.width : 0;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines;
}

/** Draws wrapped text lines inside a shape or table cell bounding box. */
function drawShapeText(
  page: PDFPage,
  box: { xPt: number; yPt: number; widthPt: number; heightPt: number },
  paragraphs: ParsedParagraph[],
  pageHeight: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
) {
  const padding = 6;
  const usableWidth = Math.max(20, box.widthPt - padding * 2);
  let currentY = pageHeight - box.yPt - padding;

  for (const para of paragraphs) {
    const lines = wrapParagraph(para, usableWidth, fonts);
    for (const line of lines) {
      const maxFontSize = Math.max(...line.map((w) => w.sizePt), 12);
      const lineHeight = maxFontSize * 1.25;
      const lineWidth = line.reduce((sum, w) => sum + w.width, 0);

      currentY -= lineHeight;
      if (currentY < pageHeight - box.yPt - box.heightPt) break; // clipped

      let startX = box.xPt + padding;
      if (para.align === 'ctr') {
        startX = box.xPt + padding + Math.max(0, (usableWidth - lineWidth) / 2);
      } else if (para.align === 'r') {
        startX = box.xPt + padding + Math.max(0, usableWidth - lineWidth);
      }

      let runX = startX;
      for (const word of line) {
        page.drawText(word.text, {
          x: runX,
          y: currentY,
          size: word.sizePt,
          font: word.font,
          color: toColor(word.color),
        });
        runX += word.width;
      }
    }
    currentY -= 4; // paragraph spacing
  }
}

function drawTable(
  page: PDFPage,
  table: ParsedTable,
  pageHeight: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
) {
  const rowCount = table.rows.length;
  if (rowCount === 0) return;
  const colCount = Math.max(...table.rows.map((r) => r.length));
  const rowHeight = table.heightPt / rowCount;

  table.rows.forEach((row, rIdx) => {
    let currentX = table.xPt;
    row.forEach((cell, cIdx) => {
      const colWidth = table.colWidthsPt && table.colWidthsPt[cIdx] ? table.colWidthsPt[cIdx] : table.widthPt / colCount;
      const cellY = table.yPt + rIdx * rowHeight;

      // Cell Fill
      drawFill(page, currentX, pageHeight - cellY - rowHeight, colWidth, rowHeight, cell.fill);

      // Cell Border
      const borderColor = cell.borderColor ? toColor(cell.borderColor) : rgb(0.5, 0.5, 0.5);
      const borderWidth = cell.borderWidthPt ?? 0.75;
      page.drawRectangle({
        x: currentX,
        y: pageHeight - cellY - rowHeight,
        width: colWidth,
        height: rowHeight,
        borderColor,
        borderWidth,
      });

      // Cell Text
      drawShapeText(
        page,
        { xPt: currentX, yPt: cellY, widthPt: colWidth, heightPt: rowHeight },
        cell.paragraphs,
        pageHeight,
        fonts
      );

      currentX += colWidth;
    });
  });
}

function drawShape(
  page: PDFPage,
  shape: ParsedShape,
  pageHeight: number,
  fonts: Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>
) {
  const yPdf = pageHeight - shape.yPt - shape.heightPt;

  if (shape.kind === 'ellipse') {
    const xCenter = shape.xPt + shape.widthPt / 2;
    const yCenter = yPdf + shape.heightPt / 2;
    const xRadius = shape.widthPt / 2;
    const yRadius = shape.heightPt / 2;

    const fillColor = shape.fill.kind === 'solid' ? toColor(shape.fill.color) : undefined;
    const borderColor = shape.line ? toColor(shape.line.color) : undefined;
    const borderWidth = shape.line ? shape.line.widthPt : 0;

    page.drawEllipse({
      x: xCenter,
      y: yCenter,
      xScale: xRadius,
      yScale: yRadius,
      color: fillColor,
      borderColor,
      borderWidth,
    });
  } else if (shape.kind === 'line') {
    const strokeColor = shape.line ? toColor(shape.line.color) : rgb(0.4, 0.4, 0.4);
    const strokeWidth = shape.line ? shape.line.widthPt : 1.5;
    page.drawLine({
      start: { x: shape.xPt, y: pageHeight - shape.yPt },
      end: { x: shape.xPt + shape.widthPt, y: yPdf },
      color: strokeColor,
      thickness: strokeWidth,
    });
  } else {
    // Rect or RoundRect
    drawFill(page, shape.xPt, yPdf, shape.widthPt, shape.heightPt, shape.fill);

    if (shape.line) {
      page.drawRectangle({
        x: shape.xPt,
        y: yPdf,
        width: shape.widthPt,
        height: shape.heightPt,
        borderColor: toColor(shape.line.color),
        borderWidth: shape.line.widthPt,
      });
    }
  }

  // Draw Shape Text
  if (shape.paragraphs.length > 0) {
    drawShapeText(page, shape, shape.paragraphs, pageHeight, fonts);
  }
}

/**
 * Full PPTX -> PDF conversion. Pure function usable directly in Node and Web Worker contexts.
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

  const presentationXml = entries.get('ppt/presentation.xml');
  if (!presentationXml) throw new Error('No slides found — this may not be a valid .pptx file.');
  const slideSize = parseSlideSize(decoder.decode(presentationXml));

  const themeEntryName = Array.from(entries.keys()).find((n) => /^ppt\/theme\/theme\d*\.xml$/.test(n));
  const theme: Theme = parseTheme(themeEntryName ? decoder.decode(entries.get(themeEntryName)!) : undefined);

  // Discover all slide entries in strict numerical sequence
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

  onProgress?.(30, `Parsing ${slideEntries.length} slides with full relationships...`);

  // Parse each slide along with its relationships and layout
  const slides = slideEntries.map((slidePath) => {
    const slideXml = decoder.decode(entries.get(slidePath)!);
    const slideNumber = slidePath.match(/slide(\d+)\.xml$/)![1];
    const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const relsXml = entries.has(relsPath) ? decoder.decode(entries.get(relsPath)!) : undefined;
    const relsMap = parseRelsXml(relsXml);

    // Layout XML if linked
    let layoutXml: string | undefined;
    for (const [, target] of relsMap.entries()) {
      if (target.includes('slideLayout')) {
        const layoutData = entries.get(target);
        if (layoutData) layoutXml = decoder.decode(layoutData);
        break;
      }
    }

    return parseSlide(slideXml, theme, relsMap, layoutXml);
  });

  onProgress?.(50, 'Initializing PDF generation engine...');
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  // Image cache to avoid duplicate embedding
  const imageCache = new Map<string, any>();

  for (let idx = 0; idx < slides.length; idx++) {
    const slide = slides[idx];
    const page = pdfDoc.addPage([slideSize.widthPt, slideSize.heightPt]);

    // 1. Draw Slide Background
    if (slide.background.kind === 'image') {
      const imgData = entries.get(slide.background.imageKey);
      if (imgData) {
        try {
          let embedded = imageCache.get(slide.background.imageKey);
          if (!embedded) {
            const isPng = imgData[0] === 0x89 && imgData[1] === 0x50;
            embedded = isPng ? await pdfDoc.embedPng(imgData) : await pdfDoc.embedJpg(imgData);
            imageCache.set(slide.background.imageKey, embedded);
          }
          page.drawImage(embedded, {
            x: 0,
            y: 0,
            width: slideSize.widthPt,
            height: slideSize.heightPt,
          });
        } catch {
          page.drawRectangle({ x: 0, y: 0, width: slideSize.widthPt, height: slideSize.heightPt, color: rgb(1, 1, 1) });
        }
      }
    } else if (slide.background.kind !== 'none') {
      drawFill(page, 0, 0, slideSize.widthPt, slideSize.heightPt, slide.background);
    } else {
      page.drawRectangle({ x: 0, y: 0, width: slideSize.widthPt, height: slideSize.heightPt, color: rgb(1, 1, 1) });
    }

    // 2. Draw Vector Shapes and Connectors
    for (const shape of slide.shapes) {
      drawShape(page, shape, slideSize.heightPt, fonts);
    }

    // 3. Draw Embedded Pictures (<p:pic>)
    for (const pic of slide.pictures) {
      const imgData = entries.get(pic.imageKey);
      if (imgData) {
        try {
          let embedded = imageCache.get(pic.imageKey);
          if (!embedded) {
            const isPng = imgData[0] === 0x89 && imgData[1] === 0x50;
            embedded = isPng ? await pdfDoc.embedPng(imgData) : await pdfDoc.embedJpg(imgData);
            imageCache.set(pic.imageKey, embedded);
          }
          page.drawImage(embedded, {
            x: pic.xPt,
            y: slideSize.heightPt - pic.yPt - pic.heightPt,
            width: pic.widthPt,
            height: pic.heightPt,
          });
        } catch (err) {
          console.warn('Failed to embed slide picture:', err);
        }
      }
    }

    // 4. Draw Tables
    for (const table of slide.tables) {
      drawTable(page, table, slideSize.heightPt, fonts);
    }

    onProgress?.(
      50 + Math.round(((idx + 1) / slides.length) * 40),
      `Rendered slide ${idx + 1}/${slides.length}`
    );
  }

  onProgress?.(95, 'Assembling final PDF document...');
  const pdfBytes = await pdfDoc.save();
  const arrayBuffer = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'PPTX conversion complete.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}.pdf`,
    buffer: arrayBuffer,
    size: arrayBuffer.byteLength,
    mimeType: 'application/pdf',
    pageCount: pdfDoc.getPageCount(),
  };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener(
    'message',
    async (event: MessageEvent<WorkerRequest<PptToPdfPayload>>) => {
      const { id, action, payload } = event.data;
      if (action !== 'PPT_TO_PDF') return;

      try {
        const result = await convertPptxToPdf(payload.fileBuffer, payload.fileName, (progress, stage) => {
          const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
          (self as any).postMessage(msg);
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
        (self as any).postMessage(responseMsg);
      }
    }
  );
}
