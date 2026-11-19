//! Word (.docx) to PDF. A port of `src/features/wordToPdf` (docxParser.ts + renderDocxToPdf.ts): the same
//! regex-level reading of word/document.xml and the same layout rules (line height 1.35 x font size,
//! callout boxes, tables with proportional columns, page breaks, pictures below their paragraph), so the
//! two engines give the same pages. Text uses the standard fonts when every character fits WinAnsi and an
//! embedded Unicode font (`fonts.rs`) otherwise, like `fontCollection` in fonts.ts.
//!
//! Anything this engine doesn't do exactly like the TypeScript one returns an error and the app runs the
//! TypeScript engine instead: pictures other than PNG/JPEG (GIF, BMP, WebP need a decoder), a picture the
//! PDF writer can't read, text a standard font can't encode (a tab inside a run).

use crate::compress::{Error, Result};
use crate::fonts::{FontSource, Fonts};
use crate::images::{embed_image, Embedded};
use crate::stamp::{f, font_dict, pdf_string, Font};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;

macro_rules! re {
    ($name:ident, $p:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).unwrap());
    };
}

re!(PG_SZ, r#"<w:pgSz[^>]*\bw="(\d+)"[^>]*\bh="(\d+)""#);
re!(PG_MAR, r"<w:pgMar\b([^>]*)/?>");
re!(BODY, r"(?s)<w:body>(.*?)</w:body>");
re!(BLOCK, r"(?s)(<w:p\b.*?</w:p>|<w:tbl\b.*?</w:tbl>)");
re!(PPR, r"(?s)<w:pPr>(.*?)</w:pPr>");
re!(PSTYLE, r#"<w:pStyle[^>]*\bw:val="([^"]+)""#);
re!(HEADING, r"(?i)^Heading(\d+)$");
re!(JC, r#"<w:jc[^>]*\bw:val="([^"]+)""#);
re!(SPACING, r"<w:spacing\b([^>]*)/?>");
re!(SHD, r#"<w:shd[^>]*\bw:fill="([0-9A-Fa-f]{6})""#);
re!(PBDR, r"(?s)<w:pBdr>(.*?)</w:pBdr>");
re!(COLOR_ATTR, r#"\bw:color="([0-9A-Fa-f]{6})""#);
re!(PB_BEFORE, r"<w:pageBreakBefore\s*/>");
re!(BR_PAGE, r#"<w:br[^>]*\bw:type="page""#);
re!(RUN, r"(?s)<w:r\b(.*?)</w:r>");
re!(RPR, r"(?s)<w:rPr>(.*?)</w:rPr>");
re!(BOLD_PLAIN, r"<w:b(?:\s*/)?>");
re!(BOLD_VAL, r#"<w:b\s+[^>]*\bw:val="([^"]*)"\s*/>"#);
re!(ITALIC_PLAIN, r"<w:i(?:\s*/)?>");
re!(ITALIC_VAL, r#"<w:i\s+[^>]*\bw:val="([^"]*)"\s*/>"#);
re!(UNDERLINE, r"<w:u\b");
re!(SZ, r#"<w:sz[^>]*\bw:val="(\d+)""#);
re!(CLR, r#"<w:color[^>]*\bw:val="([0-9A-Fa-f]{6})""#);
re!(TEXT, r"(?s)<w:t\b[^>]*>(.*?)</w:t>");
re!(DRAWING, r"(?s)<w:drawing\b.*?</w:drawing>");
re!(BLIP, r#"<a:blip\b[^>]*\br:embed="([^"]+)""#);
re!(EXTENT, r#"<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#);
re!(VSHAPE, r#"(?s)<v:shape\b[^>]*?style="([^"]*)".*?<v:imagedata\b[^>]*\br:id="([^"]+)""#);
re!(PT_W, r"width:([\d.]+)pt");
re!(PT_H, r"height:([\d.]+)pt");
re!(TBL_GRID, r"(?s)<w:tblGrid>(.*?)</w:tblGrid>");
re!(GRID_COL, r#"<w:gridCol[^>]*\bw:w="(\d+)""#);
re!(TR, r"(?s)<w:tr\b.*?</w:tr>");
re!(TC, r"(?s)<w:tc\b.*?</w:tc>");
re!(TCPR, r"(?s)<w:tcPr>(.*?)</w:tcPr>");
re!(TCW, r#"<w:tcW[^>]*\bw:w="(\d+)""#);
re!(TCBORDERS, r"(?s)<w:tcBorders>(.*?)</w:tcBorders>");
re!(BORDER_SZ, r#"\bw:sz="(\d+)""#);
re!(P_ANY, r"(?s)<w:p\b.*?</w:p>");
re!(REL, r"<Relationship\b[^>]*>");
re!(REL_ID, r#"\bId="([^"]+)""#);
re!(REL_TARGET, r#"\bTarget="([^"]+)""#);
re!(WS, r"\s+");

#[derive(Clone, Copy, PartialEq, Debug)]
struct Rgb(u8, u8, u8);

fn hex_rgb(hex: &str) -> Rgb {
    let p = |a: usize| u8::from_str_radix(hex.get(a..a + 2).unwrap_or("0"), 16).unwrap_or(0);
    Rgb(p(0), p(2), p(4))
}

#[derive(Clone)]
struct Run {
    text: String,
    bold: bool,
    italic: bool,
    size: f64,
    color: Option<Rgb>,
}

#[derive(Clone, Copy, PartialEq)]
enum Align {
    Left,
    Center,
    Right,
    Justify,
}

struct Para {
    align: Align,
    callout: bool,
    callout_bg: Option<Rgb>,
    callout_border: Option<Rgb>,
    runs: Vec<Run>,
    before: f64,
    after: f64,
    page_break_before: bool,
    has_page_break: bool,
    images: Vec<ImgRef>,
}

struct ImgRef {
    id: String,
    w: f64,
    h: f64,
}

struct Cell {
    fill: Option<Rgb>,
    border: Rgb,
    border_w: f64,
    paras: Vec<Para>,
}

struct Table {
    rows: Vec<Vec<Cell>>,
    col_widths: Vec<f64>,
}

enum Block {
    Para(Para),
    Table(Table),
}

struct Setup {
    w: f64,
    h: f64,
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn num(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(0.0)
}

fn twips(s: &str) -> f64 {
    num(s) / 20.0
}

fn flag(plain: &Regex, with_val: &Regex, rpr: &str) -> bool {
    if plain.is_match(rpr) {
        return true;
    }
    with_val.captures_iter(rpr).any(|c| {
        let v = &c[1];
        !(v.starts_with('0') || v.starts_with("false"))
    })
}

fn parse_para(p: &str, known: &HashSet<String>) -> Para {
    let ppr = PPR.captures(p).map(|c| c.get(1).unwrap().as_str()).unwrap_or("");
    let style = PSTYLE.captures(ppr).map(|c| c[1].to_string()).unwrap_or_default();
    let (mut heading, mut level) = (false, 0);
    if let Some(c) = HEADING.captures(&style) {
        heading = true;
        level = c[1].parse::<i64>().unwrap_or(0);
    } else if style.to_lowercase().contains("title") {
        heading = true;
        level = 1;
    }
    let mut align = Align::Left;
    if let Some(c) = JC.captures(ppr) {
        align = match c[1].to_lowercase().as_str() {
            "center" => Align::Center,
            "right" => Align::Right,
            "both" | "justify" => Align::Justify,
            _ => Align::Left,
        };
    }
    let (mut before, mut after) = (0.0, 6.0);
    if let Some(c) = SPACING.captures(ppr) {
        let attrs = c.get(1).unwrap().as_str();
        if let Some(m) = Regex::new(r#"\bbefore="(\d+)""#).unwrap().captures(attrs) {
            before = twips(&m[1]);
        }
        if let Some(m) = Regex::new(r#"\bafter="(\d+)""#).unwrap().captures(attrs) {
            after = twips(&m[1]);
        }
    }
    let mut callout = style.to_lowercase().contains("callout");
    let mut bg = callout.then_some(Rgb(254, 242, 242));
    let mut border = callout.then_some(Rgb(220, 38, 38));
    if let Some(c) = SHD.captures(ppr) {
        callout = true;
        bg = Some(hex_rgb(&c[1]));
    }
    if let Some(c) = PBDR.captures(ppr) {
        callout = true;
        if let Some(m) = COLOR_ATTR.captures(c.get(1).unwrap().as_str()) {
            border = Some(hex_rgb(&m[1]));
        }
    }
    let page_break_before = PB_BEFORE.is_match(ppr);
    let has_page_break = BR_PAGE.is_match(p);

    let mut runs = Vec::new();
    for rm in RUN.captures_iter(p) {
        let rxml = rm.get(1).unwrap().as_str();
        let rpr = RPR.captures(rxml).map(|c| c.get(1).unwrap().as_str()).unwrap_or("");
        let bold = flag(&BOLD_PLAIN, &BOLD_VAL, rpr);
        let italic = flag(&ITALIC_PLAIN, &ITALIC_VAL, rpr);
        let mut size = if heading { if level == 1 { 24.0 } else { 18.0 } } else { 11.0 };
        if let Some(c) = SZ.captures(rpr) {
            size = num(&c[1]) / 2.0;
        }
        let color = match CLR.captures(rpr) {
            Some(c) => Some(hex_rgb(&c[1])),
            None if heading => Some(Rgb(15, 23, 42)),
            None => None,
        };
        let mut text = String::new();
        for t in TEXT.captures_iter(rxml) {
            text.push_str(&unescape(&t[1]));
        }
        let _ = UNDERLINE.is_match(rpr); // underline is parsed by the TypeScript engine but never drawn
        if !text.is_empty() {
            runs.push(Run { text, bold, italic, size, color });
        }
    }

    let mut images = Vec::new();
    for d in DRAWING.find_iter(p) {
        let d = d.as_str();
        let Some(id) = BLIP.captures(d).map(|c| c[1].to_string()) else { continue };
        if !known.contains(&id) {
            continue;
        }
        let (w, h) = EXTENT.captures(d).map(|c| (num(&c[1]) / 12700.0, num(&c[2]) / 12700.0)).unwrap_or((0.0, 0.0));
        images.push(ImgRef { id, w, h });
    }
    if images.is_empty() {
        for v in VSHAPE.captures_iter(p) {
            if !known.contains(&v[2]) {
                continue;
            }
            let w = PT_W.captures(&v[1]).map(|c| num(&c[1])).unwrap_or(0.0);
            let h = PT_H.captures(&v[1]).map(|c| num(&c[1])).unwrap_or(0.0);
            images.push(ImgRef { id: v[2].to_string(), w, h });
        }
    }
    Para { align, callout, callout_bg: bg, callout_border: border, runs, before, after, page_break_before, has_page_break, images }
}

fn parse_table(t: &str, known: &HashSet<String>) -> Table {
    let mut col_widths = Vec::new();
    if let Some(g) = TBL_GRID.captures(t) {
        for c in GRID_COL.captures_iter(g.get(1).unwrap().as_str()) {
            col_widths.push(twips(&c[1]));
        }
    }
    let mut rows = Vec::new();
    for tr in TR.find_iter(t) {
        let mut cells = Vec::new();
        for tc in TC.find_iter(tr.as_str()) {
            let tc = tc.as_str();
            let tcpr = TCPR.captures(tc).map(|c| c.get(1).unwrap().as_str()).unwrap_or("");
            let _ = TCW.is_match(tcpr); // cell widths are parsed but the grid decides
            let fill = SHD.captures(tcpr).map(|c| hex_rgb(&c[1]));
            let (mut border, mut border_w) = (Rgb(100, 116, 139), 1.0);
            if let Some(b) = TCBORDERS.captures(tcpr) {
                let b = b.get(1).unwrap().as_str();
                if let Some(c) = COLOR_ATTR.captures(b) {
                    border = hex_rgb(&c[1]);
                }
                if let Some(s) = BORDER_SZ.captures(b) {
                    border_w = num(&s[1]) / 8.0;
                }
            }
            let paras = P_ANY.find_iter(tc).map(|p| parse_para(p.as_str(), known)).collect();
            cells.push(Cell { fill, border, border_w, paras });
        }
        if !cells.is_empty() {
            rows.push(cells);
        }
    }
    Table { rows, col_widths }
}

struct Media {
    bytes: Vec<u8>,
    png: bool,
}

struct Parsed {
    setup: Setup,
    blocks: Vec<Block>,
    media: HashMap<String, Media>,
    /// Pictures the document refers to that this engine can't draw (GIF, BMP, WebP...).
    unsupported: HashSet<String>,
}

fn read_entry(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let mut e = z.by_name(name).ok()?;
    let mut v = Vec::with_capacity(e.size() as usize);
    e.read_to_end(&mut v).ok()?;
    Some(v)
}

fn parse(input: &Path) -> Result<Parsed> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(input)?).map_err(|e| Error::Msg(e.to_string()))?;
    let xml = read_entry(&mut z, "word/document.xml").ok_or_else(|| Error::Msg("Invalid Word document: missing word/document.xml in package.".into()))?;
    let doc = String::from_utf8_lossy(&xml).into_owned();

    let mut media = HashMap::new();
    let mut unsupported = HashSet::new();
    if let Some(rels) = read_entry(&mut z, "word/_rels/document.xml.rels") {
        let rels = String::from_utf8_lossy(&rels).into_owned();
        for m in REL.find_iter(&rels) {
            let tag = m.as_str();
            if !tag.contains("/image\"") || tag.to_lowercase().contains("targetmode=\"external\"") {
                continue;
            }
            let (Some(id), Some(target)) = (REL_ID.captures(tag), REL_TARGET.captures(tag)) else { continue };
            let target = &target[1];
            let path = match target.strip_prefix('/') {
                Some(t) => t.to_string(),
                None => format!("word/{}", target.strip_prefix("./").unwrap_or(target)),
            };
            let Some(bytes) = read_entry(&mut z, &path) else { continue };
            let png = bytes.len() > 8 && bytes[..4] == [0x89, 0x50, 0x4e, 0x47];
            let jpg = bytes.len() > 3 && bytes[0] == 0xff && bytes[1] == 0xd8;
            if png || jpg {
                media.insert(id[1].to_string(), Media { bytes, png });
            } else {
                unsupported.insert(id[1].to_string());
            }
        }
    }

    let mut setup = Setup { w: 612.0, h: 792.0, top: 72.0, bottom: 72.0, left: 72.0, right: 72.0 };
    if let Some(c) = PG_SZ.captures(&doc) {
        setup.w = twips(&c[1]);
        setup.h = twips(&c[2]);
    }
    if let Some(c) = PG_MAR.captures(&doc) {
        let a = c.get(1).unwrap().as_str();
        let get = |k: &str| Regex::new(&format!(r#"\b{k}="(\d+)""#)).unwrap().captures(a).map(|m| twips(&m[1]));
        if let Some(v) = get("top") { setup.top = v; }
        if let Some(v) = get("bottom") { setup.bottom = v; }
        if let Some(v) = get("left") { setup.left = v; }
        if let Some(v) = get("right") { setup.right = v; }
    }
    let known: HashSet<String> = media.keys().chain(unsupported.iter()).cloned().collect();
    let mut blocks = Vec::new();
    if let Some(body) = BODY.captures(&doc) {
        for m in BLOCK.captures_iter(body.get(1).unwrap().as_str()) {
            let raw = m.get(1).unwrap().as_str();
            if raw.starts_with("<w:p") {
                blocks.push(Block::Para(parse_para(raw, &known)));
            } else {
                blocks.push(Block::Table(parse_table(raw, &known)));
            }
        }
    }
    Ok(Parsed { setup, blocks, media, unsupported })
}

// ------------------------------------------------------------------ layout

struct Tok {
    text: String,
    show: String,
    font: usize,
    size: f64,
    color: Option<Rgb>,
    width: f64,
}

/// Measures and encodes text for one of the four variants (0 regular, 1 bold, 2 italic, 3 bold italic).
struct Typeface<'a> {
    std: Option<[Font; 4]>,
    uni: Fonts<'a>,
    sample: String,
    uni_ids: [Option<ObjectId>; 4],
}

impl Typeface<'_> {
    fn measure(&mut self, doc: &mut Document, text: &str, variant: usize, size: f64) -> Result<(String, f64)> {
        let (bold, italic) = (variant & 1 == 1, variant & 2 == 2);
        // A tab or line break inside a run is drawn as a space (the TypeScript engine stops with an error there).
        let text = &text.replace(['\t', '\r', '\n'], " ");
        if let Some(fonts) = &self.std {
            let font = &fonts[variant];
            let b = font.encode(text).ok_or(Error::NeedsUnicodeFont)?;
            return Ok((format!("{} Tj", pdf_string(&b)), font.width(&b, size)));
        }
        let (id, u) = self.uni.get(doc, &self.sample, bold, italic).ok_or(Error::NeedsUnicodeFont)?;
        self.uni_ids[variant] = Some(id);
        let s = u.shape(text, size)?;
        Ok((format!("{} TJ", s.tj), s.width))
    }
}

fn wrap(runs: &[Run], max_w: f64, tf: &mut Typeface, doc: &mut Document) -> Result<Vec<Vec<Tok>>> {
    let mut tokens: Vec<Tok> = Vec::new();
    for run in runs {
        let variant = run.bold as usize + 2 * run.italic as usize;
        let size = run.size.max(7.0);
        let mut last = 0;
        let mut words: Vec<&str> = Vec::new();
        for m in WS.find_iter(&run.text) {
            if m.start() > last {
                words.push(&run.text[last..m.start()]);
            }
            words.push(m.as_str());
            last = m.end();
        }
        if last < run.text.len() {
            words.push(&run.text[last..]);
        }
        for w in words {
            let (show, width) = tf.measure(doc, w, variant, size)?;
            tokens.push(Tok { text: w.to_string(), show, font: variant, size, color: run.color, width });
        }
    }
    let mut lines: Vec<Vec<Tok>> = Vec::new();
    let mut cur: Vec<Tok> = Vec::new();
    let mut cur_w = 0.0;
    for t in tokens {
        if t.text == "\n" || t.text == "\r\n" {
            if !cur.is_empty() {
                lines.push(std::mem::take(&mut cur));
            }
            cur_w = 0.0;
            continue;
        }
        if cur_w + t.width <= max_w || cur.is_empty() {
            cur_w += t.width;
            cur.push(t);
        } else {
            lines.push(std::mem::take(&mut cur));
            if t.text.trim().is_empty() {
                cur_w = 0.0;
            } else {
                cur_w = t.width;
                cur.push(t);
            }
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    Ok(lines)
}

fn rgb_ops(c: Option<Rgb>, fallback: [f64; 3], stroke: bool) -> String {
    let v = match c {
        Some(Rgb(r, g, b)) => [r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0],
        None => fallback,
    };
    format!("{} {} {} {}", f(v[0]), f(v[1]), f(v[2]), if stroke { "RG" } else { "rg" })
}

struct Pages {
    done: Vec<String>,
    cur: String,
    h: f64,
    top: f64,
    bottom: f64,
    y: f64,
}

impl Pages {
    fn new_page(&mut self) {
        let page = std::mem::take(&mut self.cur);
        self.done.push(page);
        self.y = self.h - self.top;
    }
    fn ensure(&mut self, needed: f64) {
        if self.y - needed < self.bottom {
            self.new_page();
        }
    }
    fn rect_fill(&mut self, color: Option<Rgb>, fb: [f64; 3], x: f64, y: f64, w: f64, h: f64) {
        self.cur.push_str(&format!("q {} {} {} {} {} re f Q\n", rgb_ops(color, fb, false), f(x), f(y), f(w), f(h)));
    }
    fn rect_stroke(&mut self, color: Rgb, bw: f64, x: f64, y: f64, w: f64, h: f64) {
        self.cur.push_str(&format!("q {} {} w {} {} {} {} re S Q\n", rgb_ops(Some(color), [0.0; 3], true), f(bw), f(x), f(y), f(w), f(h)));
    }
    fn text(&mut self, t: &Tok, x: f64, y: f64) {
        self.cur.push_str(&format!("BT /F{} {} Tf {} {} {} Td {} ET\n", t.font, f(t.size), rgb_ops(t.color, [0.1; 3], false), f(x), f(y), t.show));
    }
}

fn line_x(align: Align, left: f64, avail: f64, line_w: f64) -> f64 {
    match align {
        Align::Center => left + (0.0f64).max((avail - line_w) / 2.0),
        Align::Right => left + (0.0f64).max(avail - line_w),
        _ => left,
    }
}

pub fn docx_to_pdf(input: &Path, out: &Path, fonts: Option<FontSource>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(15, "Parsing Word OOXML package...");
    let parsed = parse(input)?;
    if parsed.blocks.is_empty() && parsed.media.is_empty() {
        // The TypeScript engine writes a one-page empty PDF; keep it the only place that does.
        return Err(Error::Msg("empty document".into()));
    }
    progress(40, "Initializing PDF layout engine...");
    let mut doc = Document::with_version("1.7");

    // Text of every run (and cell): decides standard fonts or an embedded face, like collectText().
    let mut sample = String::new();
    {
        let mut add = |p: &Para| p.runs.iter().for_each(|r| sample.push_str(&r.text));
        for b in &parsed.blocks {
            match b {
                Block::Para(p) => add(p),
                Block::Table(t) => t.rows.iter().flatten().flat_map(|c| &c.paras).for_each(&mut add),
            }
        }
    }
    let cleaned = sample.replace(['\r', '\n', '\t'], " ");
    let std_fonts = [Font::standard("sans", false, false), Font::standard("sans", true, false), Font::standard("sans", false, true), Font::standard("sans", true, true)];
    let std_ok = cleaned.chars().all(|c| std_fonts[0].encode(&c.to_string()).is_some());
    let mut tf = Typeface { std: std_ok.then_some(std_fonts), uni: Fonts::new(fonts), sample: cleaned, uni_ids: [None; 4] };

    let s = &parsed.setup;
    let usable = (s.w - s.left - s.right).max(100.0);
    let mut pg = Pages { done: Vec::new(), cur: String::new(), h: s.h, top: s.top, bottom: s.bottom, y: s.h - s.top };
    let mut embedded: HashMap<String, Embedded> = HashMap::new();
    let mut image_names: Vec<(String, ObjectId)> = Vec::new();

    progress(60, "Laying out document content...");
    for block in &parsed.blocks {
        match block {
            Block::Para(para) => {
                if para.page_break_before || para.has_page_break {
                    if pg.y < s.h - s.top {
                        pg.new_page();
                    }
                    if para.runs.is_empty() {
                        continue;
                    }
                }
                let padding = if para.callout { 10.0 } else { 0.0 };
                let content_w = usable - padding * 2.0;
                let lines = wrap(&para.runs, content_w, &mut tf, &mut doc)?;
                let after = if para.after != 0.0 { para.after } else { 6.0 };
                if lines.is_empty() && !para.callout && para.images.is_empty() {
                    pg.y -= after;
                    continue;
                }
                let line_h = |line: &Vec<Tok>| line.iter().map(|t| t.size).fold(11.0, f64::max) * 1.35;
                let para_h: f64 = lines.iter().map(line_h).sum::<f64>() + padding * 2.0;
                pg.ensure(para_h + para.before + after);
                pg.y -= para.before;
                if para.callout {
                    let top = pg.y;
                    pg.rect_fill(para.callout_bg, [0.99, 0.95, 0.95], s.left, top - para_h, usable, para_h);
                    pg.rect_fill(para.callout_border, [0.86, 0.15, 0.15], s.left, top - para_h, 4.0, para_h);
                    pg.y -= padding;
                }
                for line in &lines {
                    let lw: f64 = line.iter().map(|t| t.width).sum();
                    let mut x = line_x(para.align, s.left + padding, content_w, lw);
                    pg.y -= line_h(line);
                    for t in line {
                        let y = pg.y;
                        pg.text(t, x, y);
                        x += t.width;
                    }
                }
                for r in &para.images {
                    if parsed.unsupported.contains(&r.id) {
                        return Err(Error::Msg("picture format needs the TypeScript engine".into()));
                    }
                    let Some(m) = parsed.media.get(&r.id) else { continue };
                    if !embedded.contains_key(&r.id) {
                        let e = embed_image(&mut doc, &m.bytes, m.png)?;
                        image_names.push((r.id.clone(), e.id));
                        embedded.insert(r.id.clone(), e);
                    }
                    let img = &embedded[&r.id];
                    let name_idx = image_names.iter().position(|(id, _)| *id == r.id).unwrap();
                    let (mut w, mut h) = (if r.w > 1.0 { r.w } else { img.w * 0.75 }, if r.h > 1.0 { r.h } else { img.h * 0.75 });
                    if w > content_w {
                        h = h * content_w / w;
                        w = content_w;
                    }
                    let max_h = s.h - s.top - s.bottom;
                    if h > max_h {
                        w = w * max_h / h;
                        h = max_h;
                    }
                    pg.ensure(h);
                    let x = match para.align {
                        Align::Center => s.left + padding + (content_w - w) / 2.0,
                        Align::Right => s.left + padding + content_w - w,
                        _ => s.left + padding,
                    };
                    let y = pg.y - h;
                    pg.cur.push_str(&format!("q {} 0 0 {} {} {} cm /Im{} Do Q\n", f(w), f(h), f(x), f(y), name_idx));
                    pg.y -= h + 4.0;
                }
                if para.callout {
                    pg.y -= padding;
                }
                pg.y -= after;
                if para.has_page_break {
                    pg.new_page();
                }
            }
            Block::Table(table) => {
                let ncols = table.rows.iter().map(|r| r.len()).max().unwrap_or(0).max(1);
                let col_w: Vec<f64> = if table.col_widths.len() == ncols {
                    let total: f64 = table.col_widths.iter().sum();
                    table.col_widths.iter().map(|w| w / total * usable).collect()
                } else {
                    vec![usable / ncols as f64; ncols]
                };
                pg.y -= 8.0;
                for row in &table.rows {
                    let mut data: Vec<Vec<Vec<Vec<Tok>>>> = Vec::new();
                    let mut max_h = 24.0f64;
                    for (ci, cell) in row.iter().enumerate() {
                        let cw = col_w.get(ci).copied().filter(|v| *v != 0.0).unwrap_or(usable / ncols as f64);
                        let inner = (cw - 10.0).max(20.0);
                        let mut h = 10.0;
                        let mut by_para = Vec::new();
                        for p in &cell.paras {
                            let lines = wrap(&p.runs, inner, &mut tf, &mut doc)?;
                            for l in &lines {
                                h += l.iter().map(|t| t.size).fold(10.0, f64::max) * 1.35;
                            }
                            by_para.push(lines);
                        }
                        h = h.max(22.0);
                        max_h = max_h.max(h);
                        data.push(by_para);
                    }
                    pg.ensure(max_h);
                    let mut cx = s.left;
                    for (ci, cell) in row.iter().enumerate() {
                        let cw = col_w.get(ci).copied().filter(|v| *v != 0.0).unwrap_or(usable / ncols as f64);
                        let cy = pg.y - max_h;
                        if cell.fill.is_some() {
                            pg.rect_fill(cell.fill, [0.0; 3], cx, cy, cw, max_h);
                        }
                        let bw = if cell.border_w != 0.0 { cell.border_w } else { 1.0 };
                        pg.rect_stroke(cell.border, bw, cx, cy, cw, max_h);
                        let mut ty = pg.y - 5.0;
                        for (pi, p) in cell.paras.iter().enumerate() {
                            for line in &data[ci][pi] {
                                let lh = line.iter().map(|t| t.size).fold(10.0, f64::max) * 1.35;
                                let lw: f64 = line.iter().map(|t| t.width).sum();
                                let mut x = line_x(p.align, cx + 5.0, cw - 10.0, lw);
                                ty -= lh;
                                for t in line {
                                    pg.text(t, x, ty);
                                    x += t.width;
                                }
                            }
                        }
                        cx += cw;
                    }
                    pg.y -= max_h;
                }
                pg.y -= 8.0;
            }
        }
    }
    let last = std::mem::take(&mut pg.cur);
    pg.done.push(last);
    // pdf-lib starts with one page and adds more: the first page always exists.
    progress(90, "Serializing high-fidelity PDF output...");

    // Resources shared by every page: the four fonts and the pictures.
    let mut font_res = Dictionary::new();
    for v in 0..4 {
        let obj = match (&tf.std, tf.uni_ids[v]) {
            (Some(fonts), _) => font_dict(&fonts[v]),
            (None, Some(id)) => Object::Reference(id),
            (None, None) => continue,
        };
        font_res.set(format!("F{v}"), obj);
    }
    tf.uni.finish(&mut doc)?;
    let mut xo = Dictionary::new();
    for (i, (_, id)) in image_names.iter().enumerate() {
        xo.set(format!("Im{i}"), Object::Reference(*id));
    }
    let mut res = Dictionary::new();
    res.set("Font", Object::Dictionary(font_res));
    res.set("XObject", Object::Dictionary(xo));
    let res_id = doc.add_object(Object::Dictionary(res));

    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for content in &pg.done {
        let mut cs = Stream::new(Dictionary::new(), content.clone().into_bytes());
        cs.allows_compression = true;
        let cid = doc.add_object(Object::Stream(cs));
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages_id));
        page.set("MediaBox", Object::Array(vec![0.into(), 0.into(), Object::Real(s.w as f32), Object::Real(s.h as f32)]));
        page.set("Resources", Object::Reference(res_id));
        page.set("Contents", Object::Reference(cid));
        kids.push(Object::Reference(doc.add_object(Object::Dictionary(page))));
    }
    let n = kids.len();
    let mut root = Dictionary::new();
    root.set("Type", Object::Name(b"Pages".to_vec()));
    root.set("Kids", Object::Array(kids));
    root.set("Count", n as i64);
    doc.objects.insert(pages_id, Object::Dictionary(root));
    let mut cat = Dictionary::new();
    cat.set("Type", Object::Name(b"Catalog".to_vec()));
    cat.set("Pages", Object::Reference(pages_id));
    let cat_id = doc.add_object(Object::Dictionary(cat));
    doc.trailer.set("Root", Object::Reference(cat_id));
    doc.compress();
    let mut w = std::io::BufWriter::new(std::fs::File::create(out)?);
    doc.save_modern(&mut w)?;
    w.flush()?;
    progress(100, "Word to PDF conversion complete.");
    Ok(n)
}
