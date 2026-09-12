/**
 * Pure OOXML (.docx) Document Parser
 * IHatePDF - 100% Client-Side Architecture
 *
 * Extracts complete document structures directly from OOXML packages:
 * - Page setup & margins (<w:pgSz>, <w:pgMar>)
 * - Paragraphs, headings, direct run colors (<w:color>), bold, italic, sizes (<w:sz>)
 * - Callout boxes with background shading (<w:shd>) and accent borders (<w:pBdr>)
 * - Tables (<w:tbl>) with grid column widths, cell fills, borders, and nested content
 * - Explicit page breaks (<w:br w:type="page"/>, <w:pageBreakBefore/>)
 */

import { readZip } from '../../services/zipReader';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface DocxRun {
  text: string;
  color?: RgbColor;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  sizePt: number;
  fontFamily?: string;
}

export interface DocxParagraph {
  type: 'paragraph';
  styleName?: string;
  isHeading?: boolean;
  headingLevel?: number;
  align: 'left' | 'center' | 'right' | 'justify';
  isCallout?: boolean;
  calloutBgColor?: RgbColor;
  calloutBorderColor?: RgbColor;
  runs: DocxRun[];
  spaceBeforePt: number;
  spaceAfterPt: number;
  pageBreakBefore?: boolean;
  hasPageBreak?: boolean;
}

export interface DocxTableCell {
  widthPt?: number;
  fillColor?: RgbColor;
  borderColor?: RgbColor;
  borderWidthPt?: number;
  paragraphs: DocxParagraph[];
}

export interface DocxTableRow {
  cells: DocxTableCell[];
  heightPt?: number;
}

export interface DocxTable {
  type: 'table';
  rows: DocxTableRow[];
  colWidthsPt?: number[];
}

export type DocxBlock = DocxParagraph | DocxTable;

export interface DocxPageSetup {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  marginRightPt: number;
}

export interface ParsedDocxDocument {
  pageSetup: DocxPageSetup;
  blocks: DocxBlock[];
}

const TWIPS_PER_PT = 20;
const twipsToPt = (twips: number): number => twips / TWIPS_PER_PT;

export function hexToRgb(hex: string): RgbColor {
  const clean = hex.trim().replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0,
  };
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parses `word/document.xml` into a structured document representation */
export async function parseDocx(fileBuffer: ArrayBuffer): Promise<ParsedDocxDocument> {
  const entries = await readZip(new Uint8Array(fileBuffer));
  const decoder = new TextDecoder();

  const docXmlBytes = entries.get('word/document.xml');
  if (!docXmlBytes) {
    throw new Error('Invalid Word document: missing word/document.xml in package.');
  }

  const docXml = decoder.decode(docXmlBytes);

  // 1. Page Setup (<w:sectPr>)
  const pageSetup: DocxPageSetup = {
    widthPt: 612, // US Letter fallback (8.5 x 11 in)
    heightPt: 792,
    marginTopPt: 72,
    marginBottomPt: 72,
    marginLeftPt: 72,
    marginRightPt: 72,
  };

  const pgSzMatch = docXml.match(/<w:pgSz[^>]*\bw="(\d+)"[^>]*\bh="(\d+)"/);
  if (pgSzMatch) {
    pageSetup.widthPt = twipsToPt(parseInt(pgSzMatch[1], 10));
    pageSetup.heightPt = twipsToPt(parseInt(pgSzMatch[2], 10));
  }

  const pgMarMatch = docXml.match(/<w:pgMar\b([^>]*)\/?>/);
  if (pgMarMatch) {
    const attrs = pgMarMatch[1];
    const top = attrs.match(/\btop="(\d+)"/);
    const bottom = attrs.match(/\bbottom="(\d+)"/);
    const left = attrs.match(/\bleft="(\d+)"/);
    const right = attrs.match(/\bright="(\d+)"/);
    if (top) pageSetup.marginTopPt = twipsToPt(parseInt(top[1], 10));
    if (bottom) pageSetup.marginBottomPt = twipsToPt(parseInt(bottom[1], 10));
    if (left) pageSetup.marginLeftPt = twipsToPt(parseInt(left[1], 10));
    if (right) pageSetup.marginRightPt = twipsToPt(parseInt(right[1], 10));
  }

  // 2. Extract Document Body Blocks
  const bodyMatch = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) {
    return { pageSetup, blocks: [] };
  }

  const bodyContent = bodyMatch[1];
  const blocks: DocxBlock[] = [];

  // Match either <w:p> or <w:tbl> sequentially
  const blockRegex = /(<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>)/g;
  let m: RegExpExecArray | null;

  while ((m = blockRegex.exec(bodyContent))) {
    const rawBlock = m[1];
    if (rawBlock.startsWith('<w:p')) {
      const parsedPara = parseParagraphNode(rawBlock);
      if (parsedPara) blocks.push(parsedPara);
    } else if (rawBlock.startsWith('<w:tbl')) {
      const parsedTbl = parseTableNode(rawBlock);
      if (parsedTbl) blocks.push(parsedTbl);
    }
  }

  return { pageSetup, blocks };
}

function parseParagraphNode(pXml: string): DocxParagraph | null {
  const pPrMatch = pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[1] : '';

  // Style name
  const styleMatch = pPr.match(/<w:pStyle[^>]*\bw:val="([^"]+)"/);
  const styleVal = styleMatch ? styleMatch[1] : '';

  let isHeading = false;
  let headingLevel = 0;
  if (/^Heading(\d+)$/i.test(styleVal)) {
    isHeading = true;
    headingLevel = parseInt(styleVal.replace(/Heading/i, ''), 10);
  } else if (/Title/i.test(styleVal)) {
    isHeading = true;
    headingLevel = 1;
  }

  // Alignment
  const jcMatch = pPr.match(/<w:jc[^>]*\bw:val="([^"]+)"/);
  let align: DocxParagraph['align'] = 'left';
  if (jcMatch) {
    const val = jcMatch[1].toLowerCase();
    if (val === 'center') align = 'center';
    else if (val === 'right') align = 'right';
    else if (val === 'both' || val === 'justify') align = 'justify';
  }

  // Spacing
  let spaceBeforePt = 0;
  let spaceAfterPt = 6;
  const spacingMatch = pPr.match(/<w:spacing\b([^>]*)\/?>/);
  if (spacingMatch) {
    const sBefore = spacingMatch[1].match(/\bbefore="(\d+)"/);
    const sAfter = spacingMatch[1].match(/\bafter="(\d+)"/);
    if (sBefore) spaceBeforePt = twipsToPt(parseInt(sBefore[1], 10));
    if (sAfter) spaceAfterPt = twipsToPt(parseInt(sAfter[1], 10));
  }

  // Callout detection: either style name has 'Callout' or shading + border present
  let isCallout = /Callout/i.test(styleVal);
  let calloutBgColor: RgbColor | undefined = isCallout ? { r: 254, g: 242, b: 242 } : undefined;
  let calloutBorderColor: RgbColor | undefined = isCallout ? { r: 220, g: 38, b: 38 } : undefined;

  const shdMatch = pPr.match(/<w:shd[^>]*\bw:fill="([0-9A-Fa-f]{6})"/);
  if (shdMatch) {
    isCallout = true;
    calloutBgColor = hexToRgb(shdMatch[1]);
  }

  const pBdrMatch = pPr.match(/<w:pBdr>([\s\S]*?)<\/w:pBdr>/);
  if (pBdrMatch) {
    isCallout = true;
    const bdrClr = pBdrMatch[1].match(/\bw:color="([0-9A-Fa-f]{6})"/);
    if (bdrClr) calloutBorderColor = hexToRgb(bdrClr[1]);
  }

  // Page break detection
  const pageBreakBefore = /<w:pageBreakBefore\s*\/>/.test(pPr);
  const hasPageBreak = /<w:br[^>]*\bw:type="page"/.test(pXml);

  // Text runs
  const runs: DocxRun[] = [];
  const runRegex = /<w:r\b([\s\S]*?)<\/w:r>/g;
  let rm: RegExpExecArray | null;

  while ((rm = runRegex.exec(pXml))) {
    const runXml = rm[1];
    const rPrMatch = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[1] : '';

    const bold = /<w:b(\s*\/|\s+[^>]*\bw:val="(?!0|false)[^"]*"\s*\/)?>/.test(rPr);
    const italic = /<w:i(\s*\/|\s+[^>]*\bw:val="(?!0|false)[^"]*"\s*\/)?>/.test(rPr);
    const underline = /<w:u\b/.test(rPr);

    let sizePt = isHeading ? (headingLevel === 1 ? 24 : 18) : 11;
    const szMatch = rPr.match(/<w:sz[^>]*\bw:val="(\d+)"/);
    if (szMatch) {
      sizePt = parseInt(szMatch[1], 10) / 2; // half-points to points
    }

    let color: RgbColor | undefined = undefined;
    const clrMatch = rPr.match(/<w:color[^>]*\bw:val="([0-9A-Fa-f]{6})"/);
    if (clrMatch) {
      color = hexToRgb(clrMatch[1]);
    } else if (isHeading) {
      color = { r: 15, g: 23, b: 42 };
    }

    // Extract text strings
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    let text = '';
    while ((tm = tRegex.exec(runXml))) {
      text += unescapeXml(tm[1]);
    }

    if (text) {
      runs.push({
        text,
        bold,
        italic,
        underline,
        sizePt,
        color,
      });
    }
  }

  return {
    type: 'paragraph',
    styleName: styleVal || undefined,
    isHeading,
    headingLevel: isHeading ? headingLevel : undefined,
    align,
    isCallout,
    calloutBgColor,
    calloutBorderColor,
    runs,
    spaceBeforePt,
    spaceAfterPt,
    pageBreakBefore,
    hasPageBreak,
  };
}

function parseTableNode(tblXml: string): DocxTable | null {
  const colWidthsPt: number[] = [];
  const gridMatch = tblXml.match(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/);
  if (gridMatch) {
    const colRegex = /<w:gridCol[^>]*\bw:w="(\d+)"/g;
    let cm: RegExpExecArray | null;
    while ((cm = colRegex.exec(gridMatch[1]))) {
      colWidthsPt.push(twipsToPt(parseInt(cm[1], 10)));
    }
  }

  const rows: DocxTableRow[] = [];
  const trRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  let trM: RegExpExecArray | null;

  while ((trM = trRegex.exec(tblXml))) {
    const trXml = trM[0];
    const cells: DocxTableCell[] = [];
    const tcRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    let tcM: RegExpExecArray | null;

    while ((tcM = tcRegex.exec(trXml))) {
      const tcXml = tcM[0];
      const tcPrMatch = tcXml.match(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/);
      const tcPr = tcPrMatch ? tcPrMatch[1] : '';

      let widthPt: number | undefined;
      const tcWMatch = tcPr.match(/<w:tcW[^>]*\bw:w="(\d+)"/);
      if (tcWMatch) {
        widthPt = twipsToPt(parseInt(tcWMatch[1], 10));
      }

      let fillColor: RgbColor | undefined;
      const shdMatch = tcPr.match(/<w:shd[^>]*\bw:fill="([0-9A-Fa-f]{6})"/);
      if (shdMatch) {
        fillColor = hexToRgb(shdMatch[1]);
      }

      let borderColor: RgbColor | undefined = { r: 100, g: 116, b: 139 }; // default slate border
      let borderWidthPt: number | undefined = 1;
      const borderMatch = tcPr.match(/<w:tcBorders>([\s\S]*?)<\/w:tcBorders>/);
      if (borderMatch) {
        const clr = borderMatch[1].match(/\bw:color="([0-9A-Fa-f]{6})"/);
        if (clr) borderColor = hexToRgb(clr[1]);
        const sz = borderMatch[1].match(/\bw:sz="(\d+)"/);
        if (sz) borderWidthPt = parseInt(sz[1], 10) / 8; // eighths of a point
      }

      // Paragraphs inside cell
      const cellParagraphs: DocxParagraph[] = [];
      const pRegex = /<w:p\b[\s\S]*?<\/w:p>/g;
      let pm: RegExpExecArray | null;
      while ((pm = pRegex.exec(tcXml))) {
        const parsedP = parseParagraphNode(pm[0]);
        if (parsedP) cellParagraphs.push(parsedP);
      }

      cells.push({
        widthPt,
        fillColor,
        borderColor,
        borderWidthPt,
        paragraphs: cellParagraphs,
      });
    }

    if (cells.length > 0) {
      rows.push({ cells });
    }
  }

  return {
    type: 'table',
    rows,
    colWidthsPt: colWidthsPt.length > 0 ? colWidthsPt : undefined,
  };
}
