/**
 * Comprehensive OOXML (.pptx) Presentation Parser
 * IHatePDF - 100% Client-Side Architecture
 *
 * Extracts complete slide presentation structures:
 * - Slide dimensions & aspect ratios (<p:sldSz>)
 * - Background fills (solid, gradient, embedded images) with layout/master inheritance
 * - Vector shapes, connectors, and preset geometries (<p:sp>, <p:cxnSp>, <a:prstGeom>)
 * - Embedded pictures (<p:pic>) resolved via relationships (_rels) and media
 * - Typography with font sizes, bold/italic, alignment, bullet points, and colors (<a:srgbClr>, <a:schemeClr>)
 * - Tables (<a:tbl>) with grid dimensions, cell borders, and fill shading
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface ParsedRun {
  text: string;
  color: RgbColor;
  bold: boolean;
  italic: boolean;
  sizePt: number;
  fontFamily?: string;
}

export interface ParsedParagraph {
  runs: ParsedRun[];
  align: 'l' | 'ctr' | 'r' | 'just';
  isBullet?: boolean;
}

export type ParsedFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: RgbColor }
  | { kind: 'gradient'; stops: Array<{ pos: number; color: RgbColor }> }
  | { kind: 'image'; imageKey: string };

export interface ParsedLineStyle {
  widthPt: number;
  color: RgbColor;
}

export interface ParsedTableCell {
  paragraphs: ParsedParagraph[];
  fill: ParsedFill;
  borderColor?: RgbColor;
  borderWidthPt?: number;
}

export interface ParsedTable {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  rows: ParsedTableCell[][];
  colWidthsPt?: number[];
}

export interface ParsedShape {
  kind: 'rect' | 'roundRect' | 'ellipse' | 'line' | 'other';
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  fill: ParsedFill;
  line?: ParsedLineStyle;
  paragraphs: ParsedParagraph[];
}

export interface ParsedPicture {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  imageKey: string;
}

export interface ParsedSlide {
  index: number;
  background: ParsedFill;
  shapes: ParsedShape[];
  pictures: ParsedPicture[];
  tables: ParsedTable[];
}

export interface Theme {
  colors: Record<string, RgbColor>;
}

export const EMU_PER_POINT = 12700;
export const emuToPt = (emu: number): number => emu / EMU_PER_POINT;

const DEFAULT_BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const DEFAULT_WHITE: RgbColor = { r: 255, g: 255, b: 255 };

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

/** Parses `ppt/theme/theme1.xml`'s `<a:clrScheme>` into a name -> RGB map. */
export function parseTheme(xml: string | undefined): Theme {
  const colors: Record<string, RgbColor> = {
    dk1: DEFAULT_BLACK,
    lt1: DEFAULT_WHITE,
    dk2: { r: 68, g: 68, b: 68 },
    lt2: { r: 221, g: 221, b: 221 },
    accent1: { r: 68, g: 114, b: 196 },
    accent2: { r: 237, g: 125, b: 49 },
    accent3: { r: 165, g: 165, b: 165 },
    accent4: { r: 255, g: 192, b: 0 },
    accent5: { r: 91, g: 155, b: 213 },
    accent6: { r: 112, g: 173, b: 71 },
    hlink: { r: 5, g: 99, b: 193 },
    folHlink: { r: 149, g: 79, b: 114 },
  };
  if (!xml) return { colors };

  const schemeMatch = xml.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/);
  if (!schemeMatch) return { colors };

  const body = schemeMatch[1];
  const nodeRegex =
    /<a:(dk1|lt1|dk2|lt2|accent1|accent2|accent3|accent4|accent5|accent6|hlink|folHlink)>\s*<a:(?:srgbClr val="([0-9A-Fa-f]{6})"|sysClr val="\w+" lastClr="([0-9A-Fa-f]{6})")/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRegex.exec(body))) {
    const hex = m[2] || m[3];
    if (hex) colors[m[1]] = hexToRgb(hex);
  }
  return { colors };
}

/** Resolves a `<a:srgbClr val="RRGGBB"/>` or `<a:schemeClr val="accent1"/>` node's color. */
export function resolveColorNode(fragment: string, theme: Theme, fallback: RgbColor): RgbColor {
  const srgb = fragment.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/);
  if (srgb) return hexToRgb(srgb[1]);
  const scheme = fragment.match(/<a:schemeClr val="(\w+)"/);
  if (scheme && theme.colors[scheme[1]]) return theme.colors[scheme[1]];
  return fallback;
}

/** Parses `<a:solidFill>`, `<a:gradFill>`, or `<a:blipFill>` block. */
export function parseFill(
  spPrOrTcPr: string,
  theme: Theme,
  relsMap?: Map<string, string>
): ParsedFill {
  const solidMatch = spPrOrTcPr.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
  if (solidMatch) {
    return { kind: 'solid', color: resolveColorNode(solidMatch[1], theme, DEFAULT_BLACK) };
  }

  const gradMatch = spPrOrTcPr.match(/<a:gradFill[^>]*>([\s\S]*?)<\/a:gradFill>/);
  if (gradMatch) {
    const stops: Array<{ pos: number; color: RgbColor }> = [];
    const stopRegex = /<a:gs pos="(\d+)">([\s\S]*?)<\/a:gs>/g;
    let sm: RegExpExecArray | null;
    while ((sm = stopRegex.exec(gradMatch[1]))) {
      stops.push({
        pos: parseInt(sm[1], 10) / 100000,
        color: resolveColorNode(sm[2], theme, DEFAULT_WHITE),
      });
    }
    if (stops.length >= 2) return { kind: 'gradient', stops };
  }

  const blipMatch = spPrOrTcPr.match(/<a:blip [^>]*r:embed="([^"]+)"/);
  if (blipMatch && relsMap) {
    const rId = blipMatch[1];
    const target = relsMap.get(rId);
    if (target) return { kind: 'image', imageKey: target };
  }

  if (/<a:noFill\s*\/>/.test(spPrOrTcPr)) return { kind: 'none' };
  return { kind: 'none' };
}

/** Parses border outline `<a:ln>` */
export function parseLineStyle(lnBlock: string | undefined, theme: Theme): ParsedLineStyle | undefined {
  if (!lnBlock) return undefined;
  const wMatch = lnBlock.match(/\bw="(\d+)"/);
  const widthPt = wMatch ? emuToPt(parseInt(wMatch[1], 10)) : 1;
  const color = resolveColorNode(lnBlock, theme, { r: 100, g: 100, b: 100 });
  return { widthPt, color };
}

export function parseRunProps(
  rPr: string | undefined,
  theme: Theme
): { color: RgbColor; bold: boolean; italic: boolean; sizePt: number; fontFamily?: string } {
  if (!rPr) return { color: DEFAULT_BLACK, bold: false, italic: false, sizePt: 18 };
  const bold = /\bb="1"/.test(rPr);
  const italic = /\bi="1"/.test(rPr);
  const szMatch = rPr.match(/\bsz="(\d+)"/);
  const sizePt = szMatch ? parseInt(szMatch[1], 10) / 100 : 18;

  const fontMatch = rPr.match(/<a:latin typeface="([^"]+)"/);
  const fontFamily = fontMatch ? fontMatch[1] : undefined;

  const fillMatch = rPr.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
  const color = fillMatch ? resolveColorNode(fillMatch[1], theme, DEFAULT_BLACK) : DEFAULT_BLACK;
  return { color, bold, italic, sizePt, fontFamily };
}

/** Parses the `<a:p>` paragraphs inside a text body block. */
export function parseParagraphs(txBody: string, theme: Theme): ParsedParagraph[] {
  const paragraphs: ParsedParagraph[] = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let paraMatch: RegExpExecArray | null;
  while ((paraMatch = paraRegex.exec(txBody))) {
    const paraBody = paraMatch[1];
    const alignMatch = paraBody.match(/<a:pPr[^>]*\balgn="(\w+)"/);
    const align = (alignMatch?.[1] as ParsedParagraph['align']) || 'l';

    const pPrMatch = paraBody.match(/<a:pPr[^>]*>([\s\S]*?)<\/a:pPr>/);
    const isBullet = Boolean(
      (pPrMatch && /<a:buChar\b/.test(pPrMatch[1])) ||
      (pPrMatch && !/<a:buNone\b/.test(pPrMatch[1]) && /\bmarL="\d+"/.test(paraBody))
    );

    const runs: ParsedRun[] = [];
    const runRegex = /<a:r>([\s\S]*?)<\/a:r>/g;
    let runMatch: RegExpExecArray | null;
    while ((runMatch = runRegex.exec(paraBody))) {
      const runBody = runMatch[1];
      const rPrMatch = runBody.match(/<a:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/);
      const textMatch = runBody.match(/<a:t>([\s\S]*?)<\/a:t>/);
      const text = textMatch ? unescapeXml(textMatch[1]) : '';
      if (!text) continue;
      const props = parseRunProps(rPrMatch?.[0], theme);
      runs.push({ text, ...props });
    }
    if (runs.length > 0) {
      paragraphs.push({ runs, align, isBullet });
    }
  }
  return paragraphs;
}

/** Extracts `<a:xfrm>` position/size (in points). */
export function parseXfrm(
  propsBlock: string
): { xPt: number; yPt: number; widthPt: number; heightPt: number } | null {
  const xfrmMatch = propsBlock.match(/<[ap]:xfrm[^>]*>([\s\S]*?)<\/[ap]:xfrm>/);
  if (!xfrmMatch) return null;
  const offMatch = xfrmMatch[1].match(/<a:off x="(-?\d+)" y="(-?\d+)"/);
  const extMatch = xfrmMatch[1].match(/<a:ext cx="(\d+)" cy="(\d+)"/);
  if (!offMatch || !extMatch) return null;
  return {
    xPt: emuToPt(parseInt(offMatch[1], 10)),
    yPt: emuToPt(parseInt(offMatch[2], 10)),
    widthPt: emuToPt(parseInt(extMatch[1], 10)),
    heightPt: emuToPt(parseInt(extMatch[2], 10)),
  };
}

/** Parses `ppt/presentation.xml`'s `<p:sldSz>` into points. */
export function parseSlideSize(presentationXml: string): { widthPt: number; heightPt: number } {
  const m = presentationXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  if (!m) return { widthPt: 960, heightPt: 540 }; // 16:9 widescreen fallback (13.33 x 7.5 in)
  return { widthPt: emuToPt(parseInt(m[1], 10)), heightPt: emuToPt(parseInt(m[2], 10)) };
}

/** Parses `_rels/slideX.xml.rels` into a Map of rId -> normalized target path */
export function parseRelsXml(relsXml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const relRegex = /<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = relRegex.exec(relsXml))) {
    const id = m[1];
    let target = m[3];
    // Normalize target relative to ppt/
    if (target.startsWith('../')) {
      target = 'ppt/' + target.replace(/^\.\.\//, '');
    } else if (!target.startsWith('ppt/')) {
      target = 'ppt/slides/' + target;
    }
    map.set(id, target);
  }
  return map;
}

/** Parses a single slide XML along with its relationships and theme */
export function parseSlide(
  xml: string,
  theme: Theme,
  relsMap?: Map<string, string>,
  layoutXml?: string,
  masterXml?: string
): ParsedSlide {
  // Slide Background (Check slide, then layout, then master)
  let background: ParsedFill = { kind: 'none' };
  const bgMatch = xml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
  if (bgMatch) {
    background = parseFill(bgMatch[1], theme, relsMap);
  } else if (layoutXml) {
    const lBgMatch = layoutXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
    if (lBgMatch) background = parseFill(lBgMatch[1], theme, relsMap);
  }
  if (background.kind === 'none' && masterXml) {
    const mBgMatch = masterXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
    if (mBgMatch) background = parseFill(mBgMatch[1], theme, relsMap);
  }

  const shapes: ParsedShape[] = [];

  // Parse Shapes (<p:sp>)
  const spRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let spMatch: RegExpExecArray | null;
  while ((spMatch = spRegex.exec(xml))) {
    const spBody = spMatch[1];
    const spPrMatch = spBody.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
    const spPr = spPrMatch ? spPrMatch[1] : '';
    const xfrm = parseXfrm(spPr);
    if (!xfrm) continue;

    // Detect preset geometry (rect, roundRect, ellipse, etc.)
    const geomMatch = spPr.match(/<a:prstGeom prst="([^"]+)"/);
    let kind: ParsedShape['kind'] = 'rect';
    if (geomMatch) {
      const g = geomMatch[1];
      if (g.includes('roundRect')) kind = 'roundRect';
      else if (g.includes('ellipse') || g.includes('circle')) kind = 'ellipse';
      else if (g.includes('line')) kind = 'line';
      else kind = 'rect';
    }

    const txBodyMatch = spBody.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
    const paragraphs = txBodyMatch ? parseParagraphs(txBodyMatch[1], theme) : [];
    const fill = parseFill(spPr, theme, relsMap);

    const lnMatch = spPr.match(/<a:ln\b[^>]*>([\s\S]*?)<\/a:ln>/);
    const line = parseLineStyle(lnMatch ? lnMatch[0] : undefined, theme);

    shapes.push({ kind, ...xfrm, fill, line, paragraphs });
  }

  // Parse Connection Shapes / Lines (<p:cxnSp>)
  const cxnRegex = /<p:cxnSp>([\s\S]*?)<\/p:cxnSp>/g;
  let cxnMatch: RegExpExecArray | null;
  while ((cxnMatch = cxnRegex.exec(xml))) {
    const cxnBody = cxnMatch[1];
    const spPrMatch = cxnBody.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
    const spPr = spPrMatch ? spPrMatch[1] : '';
    const xfrm = parseXfrm(spPr);
    if (!xfrm) continue;

    const lnMatch = spPr.match(/<a:ln\b[^>]*>([\s\S]*?)<\/a:ln>/);
    const line = parseLineStyle(lnMatch ? lnMatch[0] : undefined, theme) || {
      widthPt: 1.5,
      color: { r: 100, g: 100, b: 100 },
    };

    shapes.push({
      kind: 'line',
      ...xfrm,
      fill: { kind: 'none' },
      line,
      paragraphs: [],
    });
  }

  // Parse Embedded Pictures (<p:pic>)
  const pictures: ParsedPicture[] = [];
  const picRegex = /<p:pic>([\s\S]*?)<\/p:pic>/g;
  let picMatch: RegExpExecArray | null;
  while ((picMatch = picRegex.exec(xml))) {
    const picBody = picMatch[1];
    const spPrMatch = picBody.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
    const xfrm = spPrMatch ? parseXfrm(spPrMatch[1]) : null;
    const blipMatch = picBody.match(/<a:blip [^>]*r:embed="([^"]+)"/);

    if (xfrm && blipMatch && relsMap) {
      const rId = blipMatch[1];
      const target = relsMap.get(rId);
      if (target) {
        pictures.push({
          ...xfrm,
          imageKey: target,
        });
      }
    }
  }

  // Parse Tables (<p:graphicFrame> -> <a:tbl>)
  const tables: ParsedTable[] = [];
  const frameRegex = /<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g;
  let frameMatch: RegExpExecArray | null;
  while ((frameMatch = frameRegex.exec(xml))) {
    const frameBody = frameMatch[1];
    const xfrm = parseXfrm(frameBody);
    const tblMatch = frameBody.match(/<a:tbl>([\s\S]*?)<\/a:tbl>/);
    if (!xfrm || !tblMatch) continue;

    // Optional column widths
    const colWidthsPt: number[] = [];
    const colRegex = /<a:gridCol w="(\d+)"/g;
    let colM: RegExpExecArray | null;
    while ((colM = colRegex.exec(tblMatch[1]))) {
      colWidthsPt.push(emuToPt(parseInt(colM[1], 10)));
    }

    const rows: ParsedTableCell[][] = [];
    const trRegex = /<a:tr[^>]*>([\s\S]*?)<\/a:tr>/g;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRegex.exec(tblMatch[1]))) {
      const cells: ParsedTableCell[] = [];
      const tcRegex = /<a:tc[^>]*>([\s\S]*?)<\/a:tc>/g;
      let tcMatch: RegExpExecArray | null;
      while ((tcMatch = tcRegex.exec(trMatch[1]))) {
        const tcBody = tcMatch[1];
        const tcPrMatch = tcBody.match(/<a:tcPr[^>]*>([\s\S]*?)<\/a:tcPr>/);
        const cellFill = tcPrMatch ? parseFill(tcPrMatch[1], theme, relsMap) : { kind: 'none' as const };

        let borderColor: RgbColor | undefined = undefined;
        let borderWidthPt: number | undefined = undefined;
        if (tcPrMatch) {
          const borderMatch = tcPrMatch[1].match(/<a:ln[LTRB]\b[^>]*>([\s\S]*?)<\/a:ln[LTRB]>/);
          if (borderMatch) {
            const parsed = parseLineStyle(borderMatch[0], theme);
            if (parsed) {
              borderColor = parsed.color;
              borderWidthPt = parsed.widthPt;
            }
          }
        }

        const txBodyMatch = tcBody.match(/<a:txBody>([\s\S]*?)<\/a:txBody>/);
        const paragraphs = txBodyMatch ? parseParagraphs(txBodyMatch[1], theme) : [];
        cells.push({ paragraphs, fill: cellFill, borderColor, borderWidthPt });
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) {
      tables.push({ ...xfrm, rows, colWidthsPt: colWidthsPt.length > 0 ? colWidthsPt : undefined });
    }
  }

  return { index: 0, background, shapes, pictures, tables };
}
