/**
 * High-Fidelity Word (.docx) to PDF Conversion Engine
 * IHatePDF - 100% Client-Side Architecture
 *
 * Direct OOXML vector/text layout pipeline:
 * - 100% thread-safe & offline: runs identically in Web Workers and Node.js
 * - Full table support: custom column widths, cell background shading, borders, and typography
 * - Multi-page pagination: tracks vertical layout margins and honors explicit page breaks
 * - Complete styling: font sizes, bold, italics, direct RGB colors, and callout blocks
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  parseDocx,
  type ParsedDocxDocument,
  type DocxParagraph,
  type DocxTable,
  type DocxRun,
  type RgbColor,
} from './docxParser';
import type { OfficeConversionResult } from '../../types/worker';

function toColor(c: RgbColor | undefined, fallback = rgb(0.1, 0.1, 0.1)) {
  if (!c) return fallback;
  return rgb(c.r / 255, c.g / 255, c.b / 255);
}

interface FontCollection {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

function selectFont(fonts: FontCollection, bold: boolean, italic: boolean): PDFFont {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

interface WordToken {
  text: string;
  font: PDFFont;
  sizePt: number;
  color?: RgbColor;
  width: number;
}

function wrapRuns(runs: DocxRun[], maxWidth: number, fonts: FontCollection): WordToken[][] {
  const tokens: WordToken[] = [];

  for (const run of runs) {
    const font = selectFont(fonts, run.bold, run.italic);
    const size = Math.max(7, run.sizePt);
    const words = run.text.split(/(\s+)/).filter((w) => w.length > 0);

    for (const w of words) {
      tokens.push({
        text: w,
        font,
        sizePt: size,
        color: run.color,
        width: font.widthOfTextAtSize(w, size),
      });
    }
  }

  const lines: WordToken[][] = [];
  let currentLine: WordToken[] = [];
  let currentWidth = 0;

  for (const token of tokens) {
    if (token.text === '\n' || token.text === '\r\n') {
      if (currentLine.length > 0) lines.push(currentLine);
      currentLine = [];
      currentWidth = 0;
      continue;
    }

    if (currentWidth + token.width <= maxWidth || currentLine.length === 0) {
      currentLine.push(token);
      currentWidth += token.width;
    } else {
      lines.push(currentLine);
      currentLine = token.text.trim() === '' ? [] : [token];
      currentWidth = currentLine.length > 0 ? token.width : 0;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);

  return lines;
}

export async function convertDocxToPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  if (!fileBuffer || fileBuffer.byteLength === 0) {
    throw new Error('No Word document provided.');
  }

  onProgress?.(15, 'Parsing Word OOXML package...');
  const doc: ParsedDocxDocument = await parseDocx(fileBuffer);

  onProgress?.(40, 'Initializing PDF layout engine...');
  const pdfDoc = await PDFDocument.create();
  const fonts: FontCollection = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  const { pageSetup, blocks } = doc;
  const pageWidth = pageSetup.widthPt;
  const pageHeight = pageSetup.heightPt;
  const marginLeft = pageSetup.marginLeftPt;
  const marginRight = pageSetup.marginRightPt;
  const marginTop = pageSetup.marginTopPt;
  const marginBottom = pageSetup.marginBottomPt;
  const usableWidth = Math.max(100, pageWidth - marginLeft - marginRight);

  let currentPage: PDFPage = pdfDoc.addPage([pageWidth, pageHeight]);
  let cursorY = pageHeight - marginTop;

  const addNewPage = () => {
    currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    cursorY = pageHeight - marginTop;
  };

  const ensureSpace = (neededPt: number) => {
    if (cursorY - neededPt < marginBottom) {
      addNewPage();
    }
  };

  onProgress?.(60, 'Laying out document content...');

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const block = blocks[bIdx];

    if (block.type === 'paragraph') {
      const para = block as DocxParagraph;

      // Handle page breaks
      if (para.pageBreakBefore || para.hasPageBreak) {
        if (cursorY < pageHeight - marginTop) {
          addNewPage();
        }
        if (para.runs.length === 0) {
          continue;
        }
      }

      const isCallout = para.isCallout;
      const padding = isCallout ? 10 : 0;
      const contentWidth = usableWidth - padding * 2;

      const lines = wrapRuns(para.runs, contentWidth, fonts);
      if (lines.length === 0 && !isCallout) {
        cursorY -= para.spaceAfterPt || 6;
        continue;
      }

      // Compute paragraph height
      let paraHeight = 0;
      for (const line of lines) {
        const lineMaxFont = Math.max(...line.map((t) => t.sizePt), 11);
        paraHeight += lineMaxFont * 1.35;
      }
      paraHeight += padding * 2;

      // Ensure space on page
      ensureSpace(paraHeight + (para.spaceBeforePt || 0) + (para.spaceAfterPt || 6));
      cursorY -= para.spaceBeforePt || 0;

      // Draw Callout Box Background & Left Border Accent
      if (isCallout) {
        const boxTop = cursorY;
        const boxHeight = paraHeight;
        const bgColor = para.calloutBgColor ? toColor(para.calloutBgColor) : rgb(0.99, 0.95, 0.95);
        const borderColor = para.calloutBorderColor ? toColor(para.calloutBorderColor) : rgb(0.86, 0.15, 0.15);

        // Background fill
        currentPage.drawRectangle({
          x: marginLeft,
          y: boxTop - boxHeight,
          width: usableWidth,
          height: boxHeight,
          color: bgColor,
        });

        // Left accent border (4pt width)
        currentPage.drawRectangle({
          x: marginLeft,
          y: boxTop - boxHeight,
          width: 4,
          height: boxHeight,
          color: borderColor,
        });

        cursorY -= padding;
      }

      // Render Text Lines
      for (const line of lines) {
        const lineMaxFont = Math.max(...line.map((t) => t.sizePt), 11);
        const lineHeight = lineMaxFont * 1.35;
        const lineWidth = line.reduce((sum, t) => sum + t.width, 0);

        let startX = marginLeft + padding;
        if (para.align === 'center') {
          startX = marginLeft + padding + Math.max(0, (contentWidth - lineWidth) / 2);
        } else if (para.align === 'right') {
          startX = marginLeft + padding + Math.max(0, contentWidth - lineWidth);
        }

        cursorY -= lineHeight;
        let runX = startX;

        for (const token of line) {
          currentPage.drawText(token.text, {
            x: runX,
            y: cursorY,
            size: token.sizePt,
            font: token.font,
            color: toColor(token.color),
          });
          runX += token.width;
        }
      }

      if (isCallout) {
        cursorY -= padding;
      }

      cursorY -= para.spaceAfterPt || 6;

      if (para.hasPageBreak) {
        addNewPage();
      }
    } else if (block.type === 'table') {
      const table = block as DocxTable;
      const numCols = Math.max(...table.rows.map((r) => r.cells.length), 1);

      // Compute column widths
      let colWidths: number[] = [];
      if (table.colWidthsPt && table.colWidthsPt.length === numCols) {
        const totalW = table.colWidthsPt.reduce((a, b) => a + b, 0);
        colWidths = table.colWidthsPt.map((w) => (w / totalW) * usableWidth);
      } else {
        const defaultW = usableWidth / numCols;
        colWidths = Array(numCols).fill(defaultW);
      }

      cursorY -= 8; // table top spacing

      for (const row of table.rows) {
        // Pre-calculate wrapped lines for each cell to determine row height
        const cellData: Array<{
          linesByPara: WordToken[][][];
          height: number;
        }> = [];

        let maxCellHeight = 24;

        row.cells.forEach((cell, cIdx) => {
          const cWidth = colWidths[cIdx] || usableWidth / numCols;
          const cellContentWidth = Math.max(20, cWidth - 10);
          let cellH = 10; // top/bottom padding
          const linesByPara: WordToken[][][] = [];

          for (const cPara of cell.paragraphs) {
            const lines = wrapRuns(cPara.runs, cellContentWidth, fonts);
            linesByPara.push(lines);
            for (const line of lines) {
              const maxFont = Math.max(...line.map((t) => t.sizePt), 10);
              cellH += maxFont * 1.35;
            }
          }
          cellH = Math.max(cellH, 22);
          if (cellH > maxCellHeight) maxCellHeight = cellH;

          cellData.push({ linesByPara, height: cellH });
        });

        // Ensure row fits on page
        ensureSpace(maxCellHeight);

        // Render each cell in row
        let cellX = marginLeft;
        row.cells.forEach((cell, cIdx) => {
          const cWidth = colWidths[cIdx] || usableWidth / numCols;
          const cellY = cursorY - maxCellHeight;

          // Background Fill
          if (cell.fillColor) {
            currentPage.drawRectangle({
              x: cellX,
              y: cellY,
              width: cWidth,
              height: maxCellHeight,
              color: toColor(cell.fillColor),
            });
          }

          // Cell Border
          const bColor = cell.borderColor ? toColor(cell.borderColor) : rgb(0.4, 0.45, 0.55);
          const bWidth = cell.borderWidthPt || 1;
          currentPage.drawRectangle({
            x: cellX,
            y: cellY,
            width: cWidth,
            height: maxCellHeight,
            borderColor: bColor,
            borderWidth: bWidth,
          });

          // Cell Paragraphs
          let cTextY = cursorY - 5;
          const { linesByPara } = cellData[cIdx];

          for (let pI = 0; pI < cell.paragraphs.length; pI++) {
            const cPara = cell.paragraphs[pI];
            const lines = linesByPara[pI] || [];

            for (const line of lines) {
              const maxFont = Math.max(...line.map((t) => t.sizePt), 10);
              const lineHeight = maxFont * 1.35;
              const lineWidth = line.reduce((sum, t) => sum + t.width, 0);

              let startX = cellX + 5;
              if (cPara.align === 'center') {
                startX = cellX + 5 + Math.max(0, (cWidth - 10 - lineWidth) / 2);
              } else if (cPara.align === 'right') {
                startX = cellX + 5 + Math.max(0, cWidth - 10 - lineWidth);
              }

              cTextY -= lineHeight;
              let runX = startX;

              for (const token of line) {
                currentPage.drawText(token.text, {
                  x: runX,
                  y: cTextY,
                  size: token.sizePt,
                  font: token.font,
                  color: toColor(token.color),
                });
                runX += token.width;
              }
            }
          }

          cellX += cWidth;
        });

        cursorY -= maxCellHeight;
      }

      cursorY -= 8; // table bottom spacing
    }
  }

  onProgress?.(90, 'Serializing high-fidelity PDF output...');
  const pdfBytes = await pdfDoc.save();
  const arrayBuffer = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Word to PDF conversion complete.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}.pdf`,
    buffer: arrayBuffer,
    size: arrayBuffer.byteLength,
    mimeType: 'application/pdf',
    pageCount: pdfDoc.getPageCount(),
  };
}

export const renderDocxToPdf = convertDocxToPdf;

