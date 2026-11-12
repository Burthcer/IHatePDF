//! PowerPoint (.pptx) to PDF. A port of `src/features/pptToPdf` (pptxParser.ts + pptToPdf.worker.ts): the
//! same regex-level reading of the slide XML (shapes, connectors, pictures, tables, backgrounds with the
//! layout fallback) and the same drawing rules (one page per slide at the deck's size, gradients as 48
//! bands, 6 pt text padding, line height 1.25 x the largest size, tables with equal row heights), so the
//! two engines give the same pages. Text uses the standard fonts when every character fits WinAnsi and an
//! embedded Unicode font (`fonts.rs`) otherwise, like `fontCollection` in fonts.ts.
//!
//! Anything this engine can't do exactly like the TypeScript one returns an error and the app runs the
//! TypeScript engine instead: a picture the PDF writer can't read, text no available font can draw.
//! (A picture that isn't PNG or JPEG is skipped, as the TypeScript engine does.)

use crate::compress::{Error, Result};
use crate::fonts::{FontSource, Fonts};
use crate::images::{embed_image, Embedded};
use crate::stamp::{f, font_dict, pdf_string, Font};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use regex::Regex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;

macro_rules! re {
    ($name:ident, $p:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).unwrap());
    };
}

re!(THEME_SCHEME, r"(?s)<a:clrScheme[^>]*>(.*?)</a:clrScheme>");
re!(
    THEME_NODE,
    r#"<a:(dk1|lt1|dk2|lt2|accent1|accent2|accent3|accent4|accent5|accent6|hlink|folHlink)>\s*<a:(?:srgbClr val="([0-9A-Fa-f]{6})"|sysClr val="\w+" lastClr="([0-9A-Fa-f]{6})")"#
);
re!(SRGB, r#"<a:srgbClr val="([0-9A-Fa-f]{6})""#);
re!(SCHEME, r#"<a:schemeClr val="(\w+)""#);
re!(SOLID, r"(?s)<a:solidFill>(.*?)</a:solidFill>");
re!(GRAD, r"(?s)<a:gradFill[^>]*>(.*?)</a:gradFill>");
re!(GS, r#"(?s)<a:gs pos="(\d+)">(.*?)</a:gs>"#);
re!(BLIP, r#"<a:blip [^>]*r:embed="([^"]+)""#);
re!(LN_W, r#"\bw="(\d+)""#);
re!(BOLD, r#"\bb="1""#);
re!(ITALIC, r#"\bi="1""#);
re!(SZ, r#"\bsz="(\d+)""#);
re!(LATIN, r#"<a:latin typeface="([^"]+)""#);
re!(PARA, r"(?s)<a:p>(.*?)</a:p>");
re!(ALGN, r#"<a:pPr[^>]*\balgn="(\w+)""#);
re!(PPR, r"(?s)<a:pPr[^>]*>(.*?)</a:pPr>");
re!(BU_CHAR, r"<a:buChar\b");
re!(BU_NONE, r"<a:buNone\b");
re!(MAR_L, r#"\bmarL="\d+""#);
re!(RUN, r"(?s)<a:r>(.*?)</a:r>");
re!(RPR, r"(?s)<a:rPr\b[^>]*(?:/>|>.*?</a:rPr>)");
re!(TEXT, r"(?s)<a:t>(.*?)</a:t>");
re!(XFRM, r"(?s)<[ap]:xfrm[^>]*>(.*?)</[ap]:xfrm>");
re!(OFF, r#"<a:off x="(-?\d+)" y="(-?\d+)""#);
re!(EXT, r#"<a:ext cx="(\d+)" cy="(\d+)""#);
re!(SLD_SZ, r#"<p:sldSz cx="(\d+)" cy="(\d+)""#);
re!(REL, r#"<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)""#);
re!(BG, r"(?s)<p:bg>(.*?)</p:bg>");
re!(SP, r"(?s)<p:sp>(.*?)</p:sp>");
re!(SP_PR, r"(?s)<p:spPr>(.*?)</p:spPr>");
re!(PRST, r#"<a:prstGeom prst="([^"]+)""#);
re!(TX_BODY, r"(?s)<p:txBody>(.*?)</p:txBody>");
re!(LN, r"(?s)<a:ln\b[^>]*>(.*?)</a:ln>");
re!(CXN, r"(?s)<p:cxnSp>(.*?)</p:cxnSp>");
re!(PIC, r"(?s)<p:pic>(.*?)</p:pic>");
re!(FRAME, r"(?s)<p:graphicFrame>(.*?)</p:graphicFrame>");
re!(TBL, r"(?s)<a:tbl>(.*?)</a:tbl>");
re!(GRID_COL, r#"<a:gridCol w="(\d+)""#);
re!(TR, r"(?s)<a:tr[^>]*>(.*?)</a:tr>");
re!(TC, r"(?s)<a:tc[^>]*>(.*?)</a:tc>");
re!(TC_PR, r"(?s)<a:tcPr[^>]*>(.*?)</a:tcPr>");
re!(TC_BORDER, r"(?s)<a:ln[LTRB]\b[^>]*>(.*?)</a:ln[LTRB]>");
re!(TC_TX, r"(?s)<a:txBody>(.*?)</a:txBody>");
re!(WS_SPLIT, r"\s+");
re!(THEME_NAME, r"^ppt/theme/theme\d*\.xml$");
re!(SLIDE_NAME, r"^ppt/slides/slide(\d+)\.xml$");

type C = [f64; 3];
const BLACK: C = [0.0, 0.0, 0.0];
const WHITE: C = [255.0, 255.0, 255.0];

fn hex(h: &str) -> C {
    let p = |a: usize| u8::from_str_radix(h.get(a..a + 2).unwrap_or("0"), 16).unwrap_or(0) as f64;
    [p(0), p(2), p(4)]
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn num(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(0.0)
}

fn pt(emu: &str) -> f64 {
    num(emu) / 12700.0
}

type Theme = HashMap<&'static str, C>;
type Rels = Vec<(String, String)>;

fn parse_theme(xml: Option<&str>) -> Theme {
    let mut t: Theme = HashMap::from([
        ("dk1", BLACK),
        ("lt1", WHITE),
        ("dk2", [68.0, 68.0, 68.0]),
        ("lt2", [221.0, 221.0, 221.0]),
        ("accent1", [68.0, 114.0, 196.0]),
        ("accent2", [237.0, 125.0, 49.0]),
        ("accent3", [165.0, 165.0, 165.0]),
        ("accent4", [255.0, 192.0, 0.0]),
        ("accent5", [91.0, 155.0, 213.0]),
        ("accent6", [112.0, 173.0, 71.0]),
        ("hlink", [5.0, 99.0, 193.0]),
        ("folHlink", [149.0, 79.0, 114.0]),
    ]);
    let Some(xml) = xml else { return t };
    let Some(s) = THEME_SCHEME.captures(xml) else { return t };
    for m in THEME_NODE.captures_iter(s.get(1).unwrap().as_str()) {
        let name: &'static str = match &m[1] {
            "dk1" => "dk1",
            "lt1" => "lt1",
            "dk2" => "dk2",
            "lt2" => "lt2",
            "accent1" => "accent1",
            "accent2" => "accent2",
            "accent3" => "accent3",
            "accent4" => "accent4",
            "accent5" => "accent5",
            "accent6" => "accent6",
            "hlink" => "hlink",
            _ => "folHlink",
        };
        if let Some(h) = m.get(2).or(m.get(3)) {
            t.insert(name, hex(h.as_str()));
        }
    }
    t
}

fn resolve(fragment: &str, th: &Theme, fallback: C) -> C {
    if let Some(m) = SRGB.captures(fragment) {
        return hex(&m[1]);
    }
    if let Some(m) = SCHEME.captures(fragment) {
        if let Some(c) = th.get(&m[1]) {
            return *c;
        }
    }
    fallback
}

#[derive(Clone)]
enum Fill {
    None,
    Solid(C),
    Gradient(Vec<(f64, C)>),
    Image(String),
}

fn rels_get<'a>(rels: &'a Rels, id: &str) -> Option<&'a String> {
    rels.iter().find(|(i, _)| i == id).map(|(_, t)| t)
}

fn parse_fill(block: &str, th: &Theme, rels: &Rels) -> Fill {
    if let Some(m) = SOLID.captures(block) {
        return Fill::Solid(resolve(&m[1], th, BLACK));
    }
    if let Some(g) = GRAD.captures(block) {
        let stops: Vec<(f64, C)> = GS.captures_iter(g.get(1).unwrap().as_str()).map(|s| (num(&s[1]) / 100000.0, resolve(&s[2], th, WHITE))).collect();
        if stops.len() >= 2 {
            return Fill::Gradient(stops);
        }
    }
    if let Some(b) = BLIP.captures(block) {
        if let Some(t) = rels_get(rels, &b[1]) {
            return Fill::Image(t.clone());
        }
    }
    Fill::None
}

#[derive(Clone, Copy)]
struct Line {
    w: f64,
    color: C,
}

fn parse_line(ln: Option<&str>, th: &Theme) -> Option<Line> {
    let ln = ln?;
    let w = LN_W.captures(ln).map(|m| pt(&m[1])).unwrap_or(1.0);
    Some(Line { w, color: resolve(ln, th, [100.0, 100.0, 100.0]) })
}

struct Run {
    text: String,
    color: C,
    bold: bool,
    italic: bool,
    size: f64,
}

struct Para {
    runs: Vec<Run>,
    ctr: bool,
    right: bool,
    bullet: bool,
}

/// Strings the TypeScript engine feeds to collectText(): font family names and picture paths count too.
fn parse_paragraphs(tx: &str, th: &Theme, sample: &mut String) -> Vec<Para> {
    let mut out = Vec::new();
    for pm in PARA.captures_iter(tx) {
        let body = pm.get(1).unwrap().as_str();
        let algn = ALGN.captures(body).map(|m| m[1].to_string()).unwrap_or_else(|| "l".into());
        let ppr = PPR.captures(body).map(|m| m.get(1).unwrap().as_str());
        let bullet = ppr.is_some_and(|p| BU_CHAR.is_match(p)) || ppr.is_some_and(|p| !BU_NONE.is_match(p) && MAR_L.is_match(body));
        let mut runs = Vec::new();
        for rm in RUN.captures_iter(body) {
            let rb = rm.get(1).unwrap().as_str();
            let rpr = RPR.find(rb).map(|m| m.as_str());
            let text = TEXT.captures(rb).map(|t| unescape(&t[1])).unwrap_or_default();
            if text.is_empty() {
                continue;
            }
            let (mut color, mut bold, mut italic, mut size) = (BLACK, false, false, 18.0);
            if let Some(r) = rpr {
                bold = BOLD.is_match(r);
                italic = ITALIC.is_match(r);
                if let Some(s) = SZ.captures(r) {
                    size = num(&s[1]) / 100.0;
                }
                if let Some(fam) = LATIN.captures(r) {
                    sample.push_str(&fam[1]);
                }
                if let Some(fill) = SOLID.captures(r) {
                    color = resolve(&fill[1], th, BLACK);
                }
            }
            sample.push_str(&text);
            runs.push(Run { text, color, bold, italic, size });
        }
        if !runs.is_empty() {
            out.push(Para { runs, ctr: algn == "ctr", right: algn == "r", bullet });
        }
    }
    out
}

#[derive(Clone, Copy)]
struct Xf {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn parse_xfrm(block: &str) -> Option<Xf> {
    let x = XFRM.captures(block)?;
    let inner = x.get(1).unwrap().as_str();
    let off = OFF.captures(inner)?;
    let ext = EXT.captures(inner)?;
    Some(Xf { x: pt(&off[1]), y: pt(&off[2]), w: pt(&ext[1]), h: pt(&ext[2]) })
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Rect,
    Ellipse,
    Line,
}

struct Shape {
    kind: Kind,
    xf: Xf,
    fill: Fill,
    line: Option<Line>,
    paras: Vec<Para>,
}

struct Pic {
    xf: Xf,
    key: String,
}

struct Cell {
    paras: Vec<Para>,
    fill: Fill,
    border: Option<(C, f64)>,
}

struct Table {
    xf: Xf,
    rows: Vec<Vec<Cell>>,
    cols: Vec<f64>,
}

struct Slide {
    bg: Fill,
    shapes: Vec<Shape>,
    pics: Vec<Pic>,
    tables: Vec<Table>,
}

fn parse_slide(xml: &str, th: &Theme, rels: &Rels, layout: Option<&str>, sample: &mut String) -> Slide {
    let mut bg = Fill::None;
    if let Some(b) = BG.captures(xml) {
        bg = parse_fill(b.get(1).unwrap().as_str(), th, rels);
    } else if let Some(b) = layout.and_then(|l| BG.captures(l)) {
        bg = parse_fill(b.get(1).unwrap().as_str(), th, rels);
    }
    let mut shapes = Vec::new();
    for m in SP.captures_iter(xml) {
        let body = m.get(1).unwrap().as_str();
        let sp_pr = SP_PR.captures(body).map(|c| c.get(1).unwrap().as_str()).unwrap_or("");
        let Some(xf) = parse_xfrm(sp_pr) else { continue };
        let mut kind = Kind::Rect;
        if let Some(g) = PRST.captures(sp_pr) {
            let g = &g[1];
            kind = if g.contains("roundRect") {
                Kind::Rect
            } else if g.contains("ellipse") || g.contains("circle") {
                Kind::Ellipse
            } else if g.contains("line") {
                Kind::Line
            } else {
                Kind::Rect
            };
        }
        let paras = TX_BODY.captures(body).map(|t| parse_paragraphs(t.get(1).unwrap().as_str(), th, sample)).unwrap_or_default();
        let fill = parse_fill(sp_pr, th, rels);
        let line = parse_line(LN.find(sp_pr).map(|l| l.as_str()), th);
        shapes.push(Shape { kind, xf, fill, line, paras });
    }
    for m in CXN.captures_iter(xml) {
        let body = m.get(1).unwrap().as_str();
        let sp_pr = SP_PR.captures(body).map(|c| c.get(1).unwrap().as_str()).unwrap_or("");
        let Some(xf) = parse_xfrm(sp_pr) else { continue };
        let line = parse_line(LN.find(sp_pr).map(|l| l.as_str()), th).unwrap_or(Line { w: 1.5, color: [100.0, 100.0, 100.0] });
        shapes.push(Shape { kind: Kind::Line, xf, fill: Fill::None, line: Some(line), paras: vec![] });
    }
    let mut pics = Vec::new();
    for m in PIC.captures_iter(xml) {
        let body = m.get(1).unwrap().as_str();
        let xf = SP_PR.captures(body).and_then(|s| parse_xfrm(s.get(1).unwrap().as_str()));
        let blip = BLIP.captures(body);
        if let (Some(xf), Some(b)) = (xf, blip) {
            if let Some(t) = rels_get(rels, &b[1]) {
                sample.push_str(t);
                pics.push(Pic { xf, key: t.clone() });
            }
        }
    }
    let mut tables = Vec::new();
    for m in FRAME.captures_iter(xml) {
        let body = m.get(1).unwrap().as_str();
        let (Some(xf), Some(tbl)) = (parse_xfrm(body), TBL.captures(body)) else { continue };
        let tbl = tbl.get(1).unwrap().as_str();
        let cols: Vec<f64> = GRID_COL.captures_iter(tbl).map(|c| pt(&c[1])).collect();
        let mut rows = Vec::new();
        for tr in TR.captures_iter(tbl) {
            let mut cells = Vec::new();
            for tc in TC.captures_iter(tr.get(1).unwrap().as_str()) {
                let tcb = tc.get(1).unwrap().as_str();
                let tcpr = TC_PR.captures(tcb).map(|c| c.get(1).unwrap().as_str());
                let fill = tcpr.map(|p| parse_fill(p, th, rels)).unwrap_or(Fill::None);
                let border = tcpr.and_then(|p| TC_BORDER.find(p)).and_then(|b| parse_line(Some(b.as_str()), th)).map(|l| (l.color, l.w));
                let paras = TC_TX.captures(tcb).map(|t| parse_paragraphs(t.get(1).unwrap().as_str(), th, sample)).unwrap_or_default();
                cells.push(Cell { paras, fill, border });
            }
            if !cells.is_empty() {
                rows.push(cells);
            }
        }
        if !rows.is_empty() {
            tables.push(Table { xf, rows, cols });
        }
    }
    if let Fill::Image(k) = &bg {
        sample.push_str(k);
    }
    Slide { bg, shapes, pics, tables }
}

fn parse_rels(xml: Option<&str>) -> Rels {
    let mut out: Rels = Vec::new();
    let Some(xml) = xml else { return out };
    for m in REL.captures_iter(xml) {
        let mut t = m[3].to_string();
        if let Some(rest) = t.strip_prefix("../") {
            t = format!("ppt/{rest}");
        } else if !t.starts_with("ppt/") {
            t = format!("ppt/slides/{t}");
        }
        match out.iter_mut().find(|(i, _)| *i == m[1]) {
            Some(e) => e.1 = t,
            None => out.push((m[1].to_string(), t)),
        }
    }
    out
}

struct Package {
    z: zip::ZipArchive<std::fs::File>,
    names: Vec<String>,
}

impl Package {
    fn open(path: &Path) -> Result<Package> {
        let z = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|e| Error::Msg(e.to_string()))?;
        let mut names = Vec::new();
        for i in 0..z.len() {
            names.push(z.name_for_index(i).and_then(|n| n.ok()).map(|n| n.to_string()).unwrap_or_default());
        }
        Ok(Package { z, names })
    }
    fn has(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name)
    }
    fn read(&mut self, name: &str) -> Option<Vec<u8>> {
        let mut e = self.z.by_name(name).ok()?;
        let mut v = Vec::with_capacity(e.size() as usize);
        e.read_to_end(&mut v).ok()?;
        Some(v)
    }
    fn text(&mut self, name: &str) -> Option<String> {
        self.read(name).map(|b| String::from_utf8_lossy(&b).into_owned())
    }
}

// ------------------------------------------------------------------ drawing

struct Tok {
    text: String,
    show: String,
    font: usize,
    size: f64,
    color: C,
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

fn wrap_paragraph(p: &Para, max_w: f64, tf: &mut Typeface, doc: &mut Document) -> Result<Vec<Vec<Tok>>> {
    let mut tokens: Vec<Tok> = Vec::new();
    let mut first = true;
    for run in &p.runs {
        let variant = run.bold as usize + 2 * run.italic as usize;
        let mut text = run.text.clone();
        if p.bullet && first {
            text = format!("\u{2022} {text}");
            first = false;
        }
        let mut last = 0;
        let mut words: Vec<&str> = Vec::new();
        for m in WS_SPLIT.find_iter(&text) {
            if m.start() > last {
                words.push(&text[last..m.start()]);
            }
            words.push(m.as_str());
            last = m.end();
        }
        if last < text.len() {
            words.push(&text[last..]);
        }
        for w in words {
            let (show, width) = tf.measure(doc, w, variant, run.size)?;
            tokens.push(Tok { text: w.to_string(), show, font: variant, size: run.size, color: run.color, width });
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

fn col(c: C) -> [f64; 3] {
    [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0]
}

fn rgb_op(c: C, stroke: bool) -> String {
    // Full precision like pdf-lib: MuPDF truncates, so 4 decimals would be one level off.
    let g = |v: f64| {
        let s = format!("{:.10}", v);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    let v = col(c);
    format!("{} {} {} {}", g(v[0]), g(v[1]), g(v[2]), if stroke { "RG" } else { "rg" })
}

/// pdf-lib's drawRectangle: fill and/or border, nothing when neither colour is given.
fn rect(cur: &mut String, x: f64, y: f64, w: f64, h: f64, color: Option<C>, border: Option<(C, f64)>) {
    let bw = border.map_or(0.0, |b| b.1);
    let op = match (color, border) {
        (Some(_), _) if bw != 0.0 => "B",
        (Some(_), _) => "f",
        (None, Some(_)) => "S",
        _ => return,
    };
    let mut s = String::from("q ");
    if let Some(c) = color {
        s += &format!("{} ", rgb_op(c, false));
    }
    if let Some((c, _)) = border {
        s += &format!("{} ", rgb_op(c, true));
    }
    s += &format!("{} w {} {} {} {} re {op} Q\n", f(bw), f(x), f(y), f(w), f(h));
    cur.push_str(&s);
}

const KAPPA: f64 = 0.552_284_749_830_793_4;

fn ellipse(cur: &mut String, cx: f64, cy: f64, xs: f64, ys: f64, color: Option<C>, border: Option<(C, f64)>) {
    let bw = border.map_or(0.0, |b| b.1);
    let op = match (color, border) {
        (Some(_), _) if bw != 0.0 => "B",
        (Some(_), _) => "f",
        (None, Some(_)) => "S",
        _ => return,
    };
    let (x, y) = (cx - xs, cy - ys);
    let (ox, oy) = (xs * KAPPA, ys * KAPPA);
    let (xe, ye, xm, ym) = (x + xs * 2.0, y + ys * 2.0, x + xs, y + ys);
    let mut s = String::from("q ");
    if let Some(c) = color {
        s += &format!("{} ", rgb_op(c, false));
    }
    if let Some((c, _)) = border {
        s += &format!("{} ", rgb_op(c, true));
    }
    s += &format!("{} w {} {} m ", f(bw), f(x), f(ym));
    for p in [[x, ym - oy, xm - ox, y, xm, y], [xm + ox, y, xe, ym - oy, xe, ym], [xe, ym + oy, xm + ox, ye, xm, ye], [xm - ox, ye, x, ym + oy, x, ym]] {
        s += &format!("{} {} {} {} {} {} c ", f(p[0]), f(p[1]), f(p[2]), f(p[3]), f(p[4]), f(p[5]));
    }
    s += &format!("{op} Q\n");
    cur.push_str(&s);
}

fn lerp(a: C, b: C, t: f64) -> C {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

const BANDS: usize = 48;

fn draw_fill(cur: &mut String, x: f64, y: f64, w: f64, h: f64, fill: &Fill) {
    match fill {
        Fill::Solid(c) => rect(cur, x, y, w, h, Some(*c), None),
        Fill::Gradient(stops) => {
            let mut stops = stops.clone();
            stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let bw = w / BANDS as f64;
            for i in 0..BANDS {
                let t = i as f64 / (BANDS - 1) as f64;
                let mut color = stops[stops.len() - 1].1;
                for s in 0..stops.len() - 1 {
                    if t >= stops[s].0 && t <= stops[s + 1].0 {
                        let local = (t - stops[s].0) / (stops[s + 1].0 - stops[s].0).max(1e-6);
                        color = lerp(stops[s].1, stops[s + 1].1, local);
                        break;
                    }
                }
                rect(cur, x + i as f64 * bw, y, bw + 0.5, h, Some(color), None);
            }
        }
        _ => {}
    }
}

fn draw_text(cur: &mut String, bx: Xf, paras: &[Para], ph: f64, tf: &mut Typeface, doc: &mut Document) -> Result<()> {
    let pad = 6.0;
    let usable = (bx.w - pad * 2.0).max(20.0);
    let mut cy = ph - bx.y - pad;
    for para in paras {
        for line in wrap_paragraph(para, usable, tf, doc)? {
            let max = line.iter().map(|t| t.size).fold(12.0, f64::max);
            let lw: f64 = line.iter().map(|t| t.width).sum();
            cy -= max * 1.25;
            if cy < ph - bx.y - bx.h {
                break;
            }
            let mut x = bx.x + pad;
            if para.ctr {
                x += (0.0f64).max((usable - lw) / 2.0);
            } else if para.right {
                x += (0.0f64).max(usable - lw);
            }
            for t in &line {
                cur.push_str(&format!("BT /F{} {} Tf {} {} {} Td {} ET\n", t.font, f(t.size), rgb_op(t.color, false), f(x), f(cy), t.show));
                x += t.width;
            }
        }
        cy -= 4.0;
    }
    Ok(())
}

pub fn pptx_to_pdf(input: &Path, out: &Path, fonts: Option<FontSource>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(10, "Unzipping presentation archive...");
    let mut pkg = Package::open(input)?;
    let none = || Error::Msg("No slides found — this may not be a valid .pptx file.".into());
    let pres = pkg.text("ppt/presentation.xml").ok_or_else(none)?;
    let (sw, sh) = SLD_SZ.captures(&pres).map(|m| (pt(&m[1]), pt(&m[2]))).unwrap_or((960.0, 540.0));

    let theme_name = pkg.names.iter().find(|n| THEME_NAME.is_match(n)).cloned();
    let theme_xml = theme_name.and_then(|n| pkg.text(&n));
    let theme = parse_theme(theme_xml.as_deref());

    let mut slide_names: Vec<(u64, String)> = pkg.names.iter().filter_map(|n| SLIDE_NAME.captures(n).map(|c| (c[1].parse().unwrap_or(0), n.clone()))).collect();
    slide_names.sort_by_key(|s| s.0);
    if slide_names.is_empty() {
        return Err(none());
    }

    progress(30, &format!("Parsing {} slides with full relationships...", slide_names.len()));
    let mut sample = String::new();
    let mut slides = Vec::new();
    for (_, path) in &slide_names {
        let xml = pkg.text(path).unwrap_or_default();
        let num = SLIDE_NAME.captures(path).unwrap()[1].to_string();
        let rels_path = format!("ppt/slides/_rels/slide{num}.xml.rels");
        let rels_xml = if pkg.has(&rels_path) { pkg.text(&rels_path) } else { None };
        let rels = parse_rels(rels_xml.as_deref());
        let mut layout: Option<String> = None;
        if let Some((_, target)) = rels.iter().find(|(_, t)| t.contains("slideLayout")) {
            layout = pkg.text(target);
        }
        slides.push(parse_slide(&xml, &theme, &rels, layout.as_deref(), &mut sample));
    }

    progress(50, "Initializing PDF generation engine...");
    let mut doc = Document::with_version("1.7");
    let cleaned = sample.replace(['\r', '\n', '\t'], " ");
    let std_fonts = [Font::standard("sans", false, false), Font::standard("sans", true, false), Font::standard("sans", false, true), Font::standard("sans", true, true)];
    let std_ok = cleaned.chars().all(|c| std_fonts[0].encode(&c.to_string()).is_some());
    let mut tf = Typeface { std: std_ok.then_some(std_fonts), uni: Fonts::new(fonts), sample: cleaned, uni_ids: [None; 4] };

    let mut embedded: HashMap<String, usize> = HashMap::new();
    let mut images: Vec<(ObjectId, Embedded)> = Vec::new();
    // Some(index) when the picture is drawable; None when the TypeScript engine skips it too.
    let mut image_for = |key: &str, pkg: &mut Package, doc: &mut Document| -> Result<Option<usize>> {
        if let Some(i) = embedded.get(key) {
            return Ok(Some(*i));
        }
        let Some(bytes) = pkg.read(key) else { return Ok(None) };
        let png = bytes.len() > 1 && bytes[0] == 0x89 && bytes[1] == 0x50;
        let jpg = bytes.len() > 1 && bytes[0] == 0xff && bytes[1] == 0xd8;
        if !png && !jpg {
            return Ok(None);
        }
        let e = embed_image(doc, &bytes, png)?;
        images.push((e.id, e));
        embedded.insert(key.to_string(), images.len() - 1);
        Ok(Some(images.len() - 1))
    };

    let mut pages: Vec<String> = Vec::new();
    for (idx, slide) in slides.iter().enumerate() {
        let mut cur = String::new();
        let white = |cur: &mut String| rect(cur, 0.0, 0.0, sw, sh, Some(WHITE), None);
        match &slide.bg {
            Fill::Image(key) => {
                if pkg.has(key) {
                    match image_for(key, &mut pkg, &mut doc)? {
                        Some(i) => cur.push_str(&format!("q {} 0 0 {} 0 0 cm /Im{i} Do Q\n", f(sw), f(sh))),
                        None => white(&mut cur),
                    }
                }
            }
            Fill::None => white(&mut cur),
            fill => draw_fill(&mut cur, 0.0, 0.0, sw, sh, fill),
        }
        for s in &slide.shapes {
            let ypdf = sh - s.xf.y - s.xf.h;
            match s.kind {
                Kind::Ellipse => {
                    let fill = if let Fill::Solid(c) = s.fill { Some(c) } else { None };
                    let border = s.line.map(|l| (l.color, l.w));
                    ellipse(&mut cur, s.xf.x + s.xf.w / 2.0, ypdf + s.xf.h / 2.0, s.xf.w / 2.0, s.xf.h / 2.0, fill, border);
                }
                Kind::Line => {
                    let (c, w) = s.line.map_or(([102.0, 102.0, 102.0], 1.5), |l| (l.color, l.w));
                    cur.push_str(&format!("q {} {} w {} {} m {} {} l S Q\n", rgb_op(c, true), f(w), f(s.xf.x), f(sh - s.xf.y), f(s.xf.x + s.xf.w), f(ypdf)));
                }
                Kind::Rect => {
                    draw_fill(&mut cur, s.xf.x, ypdf, s.xf.w, s.xf.h, &s.fill);
                    if let Some(l) = s.line {
                        rect(&mut cur, s.xf.x, ypdf, s.xf.w, s.xf.h, None, Some((l.color, l.w)));
                    }
                }
            }
            if !s.paras.is_empty() {
                draw_text(&mut cur, s.xf, &s.paras, sh, &mut tf, &mut doc)?;
            }
        }
        for p in &slide.pics {
            if let Some(i) = image_for(&p.key, &mut pkg, &mut doc)? {
                cur.push_str(&format!("q {} 0 0 {} {} {} cm /Im{i} Do Q\n", f(p.xf.w), f(p.xf.h), f(p.xf.x), f(sh - p.xf.y - p.xf.h)));
            }
        }
        for t in &slide.tables {
            let rows = t.rows.len();
            let ncols = t.rows.iter().map(|r| r.len()).max().unwrap_or(0);
            let row_h = t.xf.h / rows as f64;
            for (ri, row) in t.rows.iter().enumerate() {
                let mut x = t.xf.x;
                for (ci, cell) in row.iter().enumerate() {
                    let cw = t.cols.get(ci).copied().filter(|v| *v != 0.0).unwrap_or(t.xf.w / ncols as f64);
                    let cell_y = t.xf.y + ri as f64 * row_h;
                    draw_fill(&mut cur, x, sh - cell_y - row_h, cw, row_h, &cell.fill);
                    let (bc, bw) = cell.border.unwrap_or(([127.5, 127.5, 127.5], 0.75));
                    rect(&mut cur, x, sh - cell_y - row_h, cw, row_h, None, Some((bc, bw)));
                    draw_text(&mut cur, Xf { x, y: cell_y, w: cw, h: row_h }, &cell.paras, sh, &mut tf, &mut doc)?;
                    x += cw;
                }
            }
        }
        pages.push(cur);
        progress(50 + (((idx + 1) * 40) / slides.len()) as u32, &format!("Rendered slide {}/{}", idx + 1, slides.len()));
    }

    progress(95, "Assembling final PDF document...");
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
    for (i, (id, _)) in images.iter().enumerate() {
        xo.set(format!("Im{i}"), Object::Reference(*id));
    }
    let mut res = Dictionary::new();
    res.set("Font", Object::Dictionary(font_res));
    res.set("XObject", Object::Dictionary(xo));
    let res_id = doc.add_object(Object::Dictionary(res));

    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for content in &pages {
        let mut cs = Stream::new(Dictionary::new(), content.clone().into_bytes());
        cs.allows_compression = true;
        let cid = doc.add_object(Object::Stream(cs));
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages_id));
        page.set("MediaBox", Object::Array(vec![0.into(), 0.into(), Object::Real(sw as f32), Object::Real(sh as f32)]));
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
    progress(100, "PPTX conversion complete.");
    Ok(n)
}
