/**
 * Pure OOXML (.pptx) slide parser — regex-based (Worker-safe & Node-safe).
 *
 * Extracts the subset of DrawingML needed for a faithful PDF re-render:
 * slide size, slide background fill (solid or linear gradient, with layout fallback),
 * shape/table position + fill, run-level text styling (color, bold, italic, size, bullets),
 * and embedded raster images (<p:pic>).
 *
 * Resolves slide order from presentation.xml to eliminate orphaned blank slides,
 * and inherits placeholder coordinates from slideLayouts so title and content
 * shapes are never lost or dropped.
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
}

export interface ParsedParagraph {
  runs: ParsedRun[];
  align: 'l' | 'ctr' | 'r' | 'just';
  bullet?: string;
  level?: number;
}

export type ParsedFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: RgbColor }
  | { kind: 'gradient'; stops: Array<{ pos: number; color: RgbColor }> };

export interface ParsedTableCell {
  paragraphs: ParsedParagraph[];
  fill: ParsedFill;
}

export interface ParsedTable {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  rows: ParsedTableCell[][];
}

export interface ParsedShape {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  fill: ParsedFill;
  paragraphs: ParsedParagraph[];
}

export interface ParsedImage {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  rId: string;
}

export interface ParsedSlide {
  background: ParsedFill;
  shapes: ParsedShape[];
  tables: ParsedTable[];
  images: ParsedImage[];
}

export interface Theme {
  colors: Record<string, RgbColor>;
}

export interface PlaceholderInfo {
  type?: string;
  idx?: string;
  xfrm?: { xPt: number; yPt: number; widthPt: number; heightPt: number };
}

const EMU_PER_POINT = 12700;
export const emuToPt = (emu: number): number => emu / EMU_PER_POINT;

export const DEFAULT_BLACK: RgbColor = { r: 0, g: 0, b: 0 };
export const DEFAULT_WHITE: RgbColor = { r: 255, g: 255, b: 255 };

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

/** Resolves relative ZIP paths (e.g. baseDir="ppt/slides", target="../slideLayouts/slideLayout1.xml") */
export function resolveZipPath(baseDir: string, target: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  const targetParts = target.replace(/\\/g, '/').split('/');
  for (const p of targetParts) {
    if (p === '.' || p === '') continue;
    if (p === '..') {
      parts.pop();
    } else {
      parts.push(p);
    }
  }
  return parts.join('/');
}

/** Parses any .rels XML into a Map of Relationship Id -> Target */
export function parseRelationships(relsXml: string | undefined): Map<string, string> {
  const rels = new Map<string, string>();
  if (!relsXml) return rels;
  const relRegex = /<Relationship\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = relRegex.exec(relsXml))) {
    const attrs = m[1];
    const idMatch = attrs.match(/\bId="([^"]+)"/) || attrs.match(/\bId='([^']+)'/);
    const targetMatch = attrs.match(/\bTarget="([^"]+)"/) || attrs.match(/\bTarget='([^']+)'/);
    if (idMatch && targetMatch) {
      rels.set(idMatch[1], targetMatch[1]);
    }
  }
  return rels;
}

/** Extracts the true presentation slide order from ppt/presentation.xml and its rels */
export function parseSlideOrder(presentationXml: string, presentationRelsXml?: string): string[] {
  const rels = parseRelationships(presentationRelsXml);
  const slides: string[] = [];
  const sldIdLstMatch = presentationXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (sldIdLstMatch) {
    const sldRegex = /<p:sldId\b([^>]*)\/?>/g;
    let sm: RegExpExecArray | null;
    while ((sm = sldRegex.exec(sldIdLstMatch[1]))) {
      const attrs = sm[1];
      const rIdMatch = attrs.match(/\br:id="([^"]+)"/) || attrs.match(/\br:id='([^']+)'/);
      if (rIdMatch) {
        const target = rels.get(rIdMatch[1]);
        if (target) {
          slides.push(resolveZipPath('ppt', target));
        }
      }
    }
  }
  return slides;
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

/** Parses a `<a:solidFill>...</a:solidFill>` or `<a:gradFill>...</a:gradFill>` block. */
export function parseFill(spPrOrTcPr: string, theme: Theme): ParsedFill {
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
      stops.push({ pos: parseInt(sm[1], 10) / 100000, color: resolveColorNode(sm[2], theme, DEFAULT_WHITE) });
    }
    if (stops.length >= 2) return { kind: 'gradient', stops };
  }
  if (/<a:noFill\s*\/>/.test(spPrOrTcPr)) return { kind: 'none' };
  return { kind: 'none' };
}

export function parseRunProps(
  rPr: string | undefined,
  theme: Theme
): { color: RgbColor; bold: boolean; italic: boolean; sizePt: number } {
  if (!rPr) return { color: DEFAULT_BLACK, bold: false, italic: false, sizePt: 18 };
  const bold = /\bb="1"/.test(rPr);
  const italic = /\bi="1"/.test(rPr);
  const szMatch = rPr.match(/\bsz="(\d+)"/);
  const sizePt = szMatch ? parseInt(szMatch[1], 10) / 100 : 18;
  const fillMatch = rPr.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
  const color = fillMatch ? resolveColorNode(fillMatch[1], theme, DEFAULT_BLACK) : DEFAULT_BLACK;
  return { color, bold, italic, sizePt };
}

/** Parses the `<a:p>` paragraphs inside a `<p:txBody>` or `<a:txBody>` block. */
export function parseParagraphs(txBody: string, theme: Theme): ParsedParagraph[] {
  const paragraphs: ParsedParagraph[] = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let paraMatch: RegExpExecArray | null;
  while ((paraMatch = paraRegex.exec(txBody))) {
    const paraBody = paraMatch[1];
    const pPrMatch = paraBody.match(/<a:pPr\b([\s\S]*?)(?:\/>|>[\s\S]*?<\/a:pPr>)/);
    const pPr = pPrMatch ? pPrMatch[0] : '';
    const alignMatch = pPr.match(/\balgn="(\w+)"/);
    const align = (alignMatch?.[1] as ParsedParagraph['align']) || 'l';

    const buNone = /<a:buNone\b/.test(pPr);
    const buCharMatch = pPr.match(/<a:buChar\b[^>]*\bchar="([^"]+)"/);
    const buAutoNum = /<a:buAutoNum\b/.test(pPr);
    let bullet: string | undefined = undefined;
    if (!buNone) {
      if (buCharMatch) {
        bullet = buCharMatch[1];
      } else if (buAutoNum) {
        bullet = '•';
      }
    }

    const lvlMatch = pPr.match(/\blvl="(\d+)"/);
    const level = lvlMatch ? parseInt(lvlMatch[1], 10) : 0;

    const runs: ParsedRun[] = [];
    // Match <a:r>, <a:fld>, or <a:br>
    const itemRegex = /<a:r\b([\s\S]*?)<\/a:r>|<a:fld\b([\s\S]*?)<\/a:fld>|<a:br\b[^>]*\/?>/g;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(paraBody))) {
      const full = itemMatch[0];
      if (full.startsWith('<a:br')) {
        runs.push({
          text: '\n',
          color: DEFAULT_BLACK,
          bold: false,
          italic: false,
          sizePt: 14,
        });
        continue;
      }
      const itemBody = itemMatch[1] || itemMatch[2] || '';
      const rPrMatch = itemBody.match(/<a:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/);
      const textMatch = itemBody.match(/<a:t>([\s\S]*?)<\/a:t>/);
      const text = textMatch ? unescapeXml(textMatch[1]) : '';
      if (!text) continue;
      const props = parseRunProps(rPrMatch?.[0], theme);
      runs.push({ text, ...props });
    }

    if (runs.length > 0) {
      paragraphs.push({ runs, align, bullet, level });
    }
  }
  return paragraphs;
}

/** Extracts the `<a:xfrm>` position/size (in points) from a shape/frame's properties block, regardless of attribute order. */
export function parseXfrm(propsBlock: string): { xPt: number; yPt: number; widthPt: number; heightPt: number } | null {
  const xfrmMatch = propsBlock.match(/<[ap]:xfrm\b[^>]*>([\s\S]*?)<\/[ap]:xfrm>/);
  if (!xfrmMatch) return null;
  const body = xfrmMatch[1];
  const offTag = body.match(/<a:off\b([^>]*)\/?>/);
  const extTag = body.match(/<a:ext\b([^>]*)\/?>/);
  if (!offTag || !extTag) return null;

  const xMatch = offTag[1].match(/\bx="(-?\d+)"/);
  const yMatch = offTag[1].match(/\by="(-?\d+)"/);
  const cxMatch = extTag[1].match(/\bcx="(\d+)"/);
  const cyMatch = extTag[1].match(/\bcy="(\d+)"/);
  if (!xMatch || !yMatch || !cxMatch || !cyMatch) return null;

  return {
    xPt: emuToPt(parseInt(xMatch[1], 10)),
    yPt: emuToPt(parseInt(yMatch[1], 10)),
    widthPt: emuToPt(parseInt(cxMatch[1], 10)),
    heightPt: emuToPt(parseInt(cyMatch[1], 10)),
  };
}

/** Parses placeholders and their xfrm coordinates from a slideLayout XML file */
export function parseLayoutPlaceholders(layoutXml: string | undefined): PlaceholderInfo[] {
  if (!layoutXml) return [];
  const list: PlaceholderInfo[] = [];
  const spRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let spMatch: RegExpExecArray | null;
  while ((spMatch = spRegex.exec(layoutXml))) {
    const spBody = spMatch[1];
    const phMatch = spBody.match(/<p:ph\b([^>]*)\/?>/);
    if (!phMatch) continue;
    const attrs = phMatch[1];
    const typeMatch = attrs.match(/\btype="([^"]+)"/);
    const idxMatch = attrs.match(/\bidx="([^"]+)"/);

    const spPrMatch = spBody.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
    const xfrm = spPrMatch ? parseXfrm(spPrMatch[1]) : null;

    list.push({
      type: typeMatch ? typeMatch[1] : undefined,
      idx: idxMatch ? idxMatch[1] : undefined,
      xfrm: xfrm || undefined,
    });
  }
  return list;
}

/** Provides safe fallback geometry when layout coordinates cannot be resolved, preventing dropped text. */
export function getFallbackXfrm(
  phType: string | undefined,
  shapeIndex: number,
  slideWidthPt: number,
  slideHeightPt: number
): { xPt: number; yPt: number; widthPt: number; heightPt: number } {
  const margin = 40;
  const w = Math.max(100, slideWidthPt - margin * 2);
  if (phType === 'title' || phType === 'ctrTitle') {
    return { xPt: margin, yPt: 40, widthPt: w, heightPt: 70 };
  }
  if (phType === 'subTitle') {
    return { xPt: margin, yPt: 120, widthPt: w, heightPt: 50 };
  }
  const top = 120 + shapeIndex * 35;
  return {
    xPt: margin,
    yPt: Math.min(top, Math.max(margin, slideHeightPt - 100)),
    widthPt: w,
    heightPt: Math.max(60, slideHeightPt - top - margin),
  };
}

/** Parses `ppt/presentation.xml`'s `<p:sldSz>` into points. */
export function parseSlideSize(presentationXml: string): { widthPt: number; heightPt: number } {
  const m = presentationXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  if (!m) return { widthPt: 720, heightPt: 540 }; // 10x7.5in fallback
  return { widthPt: emuToPt(parseInt(m[1], 10)), heightPt: emuToPt(parseInt(m[2], 10)) };
}

export function parseSlide(
  xml: string,
  theme: Theme,
  layoutXml?: string,
  slideWidthPt = 720,
  slideHeightPt = 540
): ParsedSlide {
  // Background: check slide XML first, then fallback to layout XML
  const bgMatch = xml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
  let background: ParsedFill = bgMatch ? parseFill(bgMatch[1], theme) : { kind: 'none' };
  if (background.kind === 'none' && layoutXml) {
    const layoutBgMatch = layoutXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
    if (layoutBgMatch) {
      background = parseFill(layoutBgMatch[1], theme);
    }
  }

  const layoutPlaceholders = parseLayoutPlaceholders(layoutXml);

  const shapes: ParsedShape[] = [];
  const spRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let spMatch: RegExpExecArray | null;
  let shapeIdx = 0;

  while ((spMatch = spRegex.exec(xml))) {
    const spBody = spMatch[1];
    const spPrMatch = spBody.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
    const spPr = spPrMatch ? spPrMatch[1] : '';
    let xfrm = parseXfrm(spPr);

    const phMatch = spBody.match(/<p:ph\b([^>]*)\/?>/);
    const phAttrs = phMatch ? phMatch[1] : '';
    const phType = phAttrs.match(/\btype="([^"]+)"/)?.[1];
    const phIdx = phAttrs.match(/\bidx="([^"]+)"/)?.[1];

    // If xfrm is missing, resolve from layout placeholder
    if (!xfrm && (phType || phIdx !== undefined)) {
      const match = layoutPlaceholders.find(
        (p) => (phIdx !== undefined && p.idx === phIdx) || (phType && p.type === phType)
      );
      if (match?.xfrm) {
        xfrm = { ...match.xfrm };
      }
    }

    const txBodyMatch = spBody.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
    const paragraphs = txBodyMatch ? parseParagraphs(txBodyMatch[1], theme) : [];
    const fill = parseFill(spPr, theme);

    // If still no xfrm, but shape has extractable text, use smart fallback coordinates rather than dropping it!
    if (!xfrm && paragraphs.length > 0) {
      xfrm = getFallbackXfrm(phType, shapeIdx, slideWidthPt, slideHeightPt);
    }

    if (xfrm) {
      shapes.push({ ...xfrm, fill, paragraphs });
    }
    shapeIdx++;
  }

  // Tables (<p:graphicFrame>)
  const tables: ParsedTable[] = [];
  const frameRegex = /<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g;
  let frameMatch: RegExpExecArray | null;
  while ((frameMatch = frameRegex.exec(xml))) {
    const frameBody = frameMatch[1];
    const xfrm = parseXfrm(frameBody);
    const tblMatch = frameBody.match(/<a:tbl>([\s\S]*?)<\/a:tbl>/);
    if (!xfrm || !tblMatch) continue;

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
        const cellFill = tcPrMatch ? parseFill(tcPrMatch[1], theme) : { kind: 'none' as const };
        const txBodyMatch = tcBody.match(/<a:txBody>([\s\S]*?)<\/a:txBody>/);
        const paragraphs = txBodyMatch ? parseParagraphs(txBodyMatch[1], theme) : [];
        cells.push({ paragraphs, fill: cellFill });
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push({ ...xfrm, rows });
  }

  // Pictures (<p:pic>)
  const images: ParsedImage[] = [];
  const picRegex = /<p:pic>([\s\S]*?)<\/p:pic>/g;
  let picMatch: RegExpExecArray | null;
  while ((picMatch = picRegex.exec(xml))) {
    const picBody = picMatch[1];
    const blipMatch = picBody.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/);
    const spPrMatch = picBody.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
    const xfrm = spPrMatch ? parseXfrm(spPrMatch[1]) : null;
    if (blipMatch && xfrm) {
      images.push({
        rId: blipMatch[1],
        ...xfrm,
      });
    }
  }

  return { background, shapes, tables, images };
}
