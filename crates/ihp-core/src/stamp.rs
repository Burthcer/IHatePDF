//! Stamp tools: Watermark (text or image, single or tiled), Page numbers, Sign. They draw on pages
//! "as the reader sees them" (rotation and crop respected), like the TypeScript workers
//! (`watermark.worker.ts`, `pageNumbers.worker.ts`, `sign.worker.ts`) and with the same layout maths.
//!
//! Text uses the 14 standard fonts (WinAnsi). Text that needs an embedded Unicode font (Greek,
//! Cyrillic, Devanagari, CJK...) returns `Error::NeedsUnicodeFont` and the app hands the job to the
//! TypeScript engine, which shapes and embeds those scripts.

use crate::afm::{FONTS, KERNS};
use crate::compress::{Error, Result};
use crate::images::{embed_image, Embedded};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde_json::Value;
use std::io::Write;
use std::path::Path;

type M = [f64; 6];
const ID: M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// "Apply m, then n" (PDF convention).
fn mul(m: &M, n: &M) -> M {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

fn invert(m: &M) -> M {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return ID;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn inherited(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut id = page;
    for _ in 0..64 {
        let d = doc.get_dictionary(id).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(doc.dereference(v).map(|(_, o)| o.clone()).unwrap_or_else(|_| v.clone()));
        }
        id = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn rect(doc: &Document, o: Option<Object>) -> Option<[f64; 4]> {
    let Object::Array(a) = o? else { return None };
    let v: Vec<f64> = a.iter().filter_map(|x| num(doc.dereference(x).map(|(_, o)| o).unwrap_or(x))).collect();
    (v.len() == 4).then(|| [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

/// CropBox ∩ MediaBox, like `visibleBox` in geometry.ts.
fn visible_box(doc: &Document, page: ObjectId) -> [f64; 4] {
    let m = rect(doc, inherited(doc, page, b"MediaBox")).unwrap_or([0.0, 0.0, 595.28, 841.89]);
    let Some(c) = rect(doc, inherited(doc, page, b"CropBox")) else { return m };
    let b = [m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])];
    if b[2] - b[0] < 1.0 || b[3] - b[1] < 1.0 { m } else { b }
}

/// (matrix from the displayed bottom-left frame to user space, displayed width, displayed height).
fn viewer_frame(doc: &Document, page: ObjectId) -> (M, f64, f64) {
    let [x0, y0, x1, y1] = visible_box(doc, page);
    let r = inherited(doc, page, b"Rotate").and_then(|o| num(&o)).unwrap_or(0.0);
    let rot = ((((r / 90.0).round() as i32) * 90) % 360 + 360) % 360;
    let (ra, rb, rc, rd) = match rot {
        180 => (-1.0, 0.0, 0.0, 1.0),
        90 => (0.0, 1.0, 1.0, 0.0),
        270 => (0.0, -1.0, -1.0, 0.0),
        _ => (1.0, 0.0, 0.0, -1.0),
    };
    let (cx, cy) = ((x1 + x0) / 2.0, (y1 + y0) / 2.0);
    let (off_x, off_y, width, height) = if ra == 0.0 { ((cy - y0).abs(), (cx - x0).abs(), y1 - y0, x1 - x0) } else { ((cx - x0).abs(), (cy - y0).abs(), x1 - x0, y1 - y0) };
    let user_to_viewer: M = [ra, rb, rc, rd, off_x - ra * cx - rc * cy, off_y - rb * cx - rd * cy];
    (mul(&[1.0, 0.0, 0.0, -1.0, 0.0, height], &invert(&user_to_viewer)), width, height)
}

// ------------------------------------------------------------------ fonts

pub struct Font {
    idx: usize,
    pub base: &'static str,
    widths: &'static [u16; 224],
    pub ascender: f64,
}

impl Font {
    /// family: "sans" | "serif" | "mono".
    pub fn standard(family: &str, bold: bool, italic: bool) -> Font {
        let idx = match family {
            "serif" => 4,
            "mono" => 8,
            _ => 0,
        } + (bold as usize) + 2 * (italic as usize);
        let (base, widths, asc) = &FONTS[idx];
        Font { idx, base, widths, ascender: *asc as f64 }
    }

    /// WinAnsi bytes for `text`, or None when a character has no glyph (needs an embedded font).
    pub fn encode(&self, text: &str) -> Option<Vec<u8>> {
        text.chars().map(|c| winansi(c).filter(|&b| b >= 32 && self.widths[(b - 32) as usize] > 0)).collect()
    }

    /// Width of the text, with the font's kerning pairs (as pdf-lib measures it).
    pub fn width(&self, bytes: &[u8], size: f64) -> f64 {
        let glyphs: f64 = bytes.iter().map(|&b| self.widths[(b.max(32) - 32) as usize] as f64).sum();
        let kern: f64 = bytes
            .windows(2)
            .map(|p| {
                let key = ((p[0] as u16) << 8) | p[1] as u16;
                KERNS[self.idx].binary_search_by_key(&key, |(k, _)| *k).map(|i| KERNS[self.idx][i].1 as f64).unwrap_or(0.0)
            })
            .sum();
        (glyphs + kern) * size / 1000.0
    }
}

fn winansi(c: char) -> Option<u8> {
    let u = c as u32;
    if (0x20..0x7f).contains(&u) || (0xa0..=0xff).contains(&u) {
        return Some(u as u8);
    }
    // Windows-1252 0x80..0x9F
    const HI: [(u32, u8); 27] = [
        (0x20ac, 0x80), (0x201a, 0x82), (0x0192, 0x83), (0x201e, 0x84), (0x2026, 0x85), (0x2020, 0x86), (0x2021, 0x87), (0x02c6, 0x88),
        (0x2030, 0x89), (0x0160, 0x8a), (0x2039, 0x8b), (0x0152, 0x8c), (0x017d, 0x8e), (0x2018, 0x91), (0x2019, 0x92), (0x201c, 0x93),
        (0x201d, 0x94), (0x2022, 0x95), (0x2013, 0x96), (0x2014, 0x97), (0x02dc, 0x98), (0x2122, 0x99), (0x0161, 0x9a), (0x203a, 0x9b),
        (0x0153, 0x9c), (0x017e, 0x9e), (0x0178, 0x9f),
    ];
    HI.iter().find(|(k, _)| *k == u).map(|(_, b)| *b)
}

fn pdf_string(bytes: &[u8]) -> String {
    let mut s = String::from("(");
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                s.push('\\');
                s.push(b as char);
            }
            32..=126 => s.push(b as char),
            _ => s.push_str(&format!("\\{:03o}", b)),
        }
    }
    s.push(')');
    s
}

// ------------------------------------------------------------------ page editing

struct Wraps {
    q: ObjectId,
    big_q: ObjectId,
}

fn stream(doc: &mut Document, bytes: Vec<u8>) -> ObjectId {
    let mut s = Stream::new(Dictionary::new(), bytes);
    s.allows_compression = true;
    doc.add_object(Object::Stream(s))
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

/// Makes the page's /Resources a direct dictionary of its own (copying inherited or shared ones) and returns it.
fn own_resources(doc: &mut Document, page: ObjectId) -> Result<&mut Dictionary> {
    let res = match inherited(doc, page, b"Resources") {
        Some(Object::Dictionary(d)) => d,
        _ => Dictionary::new(),
    };
    doc.get_dictionary_mut(page)?.set("Resources", Object::Dictionary(res));
    match doc.get_dictionary_mut(page)?.get_mut(b"Resources")? {
        Object::Dictionary(d) => Ok(d),
        _ => Err(Error::Msg("Page resources unreadable.".into())),
    }
}

fn add_resource(doc: &mut Document, page: ObjectId, category: &str, key: &str, value: Object) -> Result<()> {
    // The category may itself be a reference: make it direct too.
    let existing = match own_resources(doc, page)?.get(category.as_bytes()) {
        Ok(Object::Reference(id)) => Some(*id),
        _ => None,
    };
    let sub = match existing.and_then(|id| doc.get_dictionary(id).ok().cloned()) {
        Some(d) => Some(d),
        None => None,
    };
    let res = own_resources(doc, page)?;
    if let Some(d) = sub {
        res.set(category, Object::Dictionary(d));
    }
    if !matches!(res.get(category.as_bytes()), Ok(Object::Dictionary(_))) {
        res.set(category, Object::Dictionary(Dictionary::new()));
    }
    if let Ok(Object::Dictionary(d)) = res.get_mut(category.as_bytes()) {
        d.set(key, value);
    }
    Ok(())
}

/// Existing content (wrapped in q ... Q so its leftover state can't leak) plus `ours`, before or after it.
fn add_content(doc: &mut Document, page: ObjectId, ours: Vec<u8>, below: bool, w: &Wraps) -> Result<()> {
    let mut parts: Vec<Object> = Vec::new();
    match doc.get_dictionary(page)?.get(b"Contents").ok().cloned() {
        Some(Object::Reference(id)) => match doc.get_object(id) {
            Ok(Object::Array(a)) => parts = a.clone(),
            _ => parts.push(Object::Reference(id)),
        },
        Some(Object::Array(a)) => parts = a,
        _ => {}
    }
    let mine = Object::Reference(stream(doc, ours));
    let mut all = vec![Object::Reference(w.q)];
    all.extend(parts);
    all.push(Object::Reference(w.big_q));
    if below { all.insert(0, mine) } else { all.push(mine) }
    doc.get_dictionary_mut(page)?.set("Contents", Object::Array(all));
    Ok(())
}

fn new_wraps(doc: &mut Document) -> Wraps {
    Wraps { q: stream(doc, b"q".to_vec()), big_q: stream(doc, b"Q".to_vec()) }
}

fn font_dict(font: &Font) -> Object {
    let mut d = Dictionary::new();
    d.set("Type", name("Font"));
    d.set("Subtype", name("Type1"));
    d.set("BaseFont", name(font.base));
    if !font.base.starts_with("Symbol") && !font.base.starts_with("ZapfDingbats") {
        d.set("Encoding", name("WinAnsiEncoding"));
    }
    Object::Dictionary(d)
}

fn gstate(opacity: f64) -> Object {
    let mut d = Dictionary::new();
    d.set("Type", name("ExtGState"));
    d.set("ca", Object::Real(opacity as f32));
    d.set("CA", Object::Real(opacity as f32));
    Object::Dictionary(d)
}

fn hex_rgb(hex: &str) -> (f64, f64, f64) {
    let c = hex.trim_start_matches('#');
    let full: String = if c.len() == 3 { c.chars().flat_map(|x| [x, x]).collect() } else { c.to_string() };
    let n = u32::from_str_radix(&full, 16).unwrap_or(0);
    (((n >> 16) & 255) as f64 / 255.0, ((n >> 8) & 255) as f64 / 255.0, (n & 255) as f64 / 255.0)
}

fn f(v: f64) -> String {
    let s = format!("{:.4}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" { "0".into() } else { s.to_string() }
}

fn load(path: &Path) -> Result<Document> {
    let d = Document::load(path)?;
    if d.is_encrypted() {
        return Err(Error::Encrypted);
    }
    Ok(d)
}

fn save(doc: &mut Document, out: &Path) -> Result<()> {
    let mut w = std::io::BufWriter::new(std::fs::File::create(out)?);
    doc.save_modern(&mut w)?;
    w.flush()?;
    Ok(())
}

// ------------------------------------------------------------------ placement maths (pdfStampPosition.ts)

fn anchor(pw: f64, ph: f64, cw: f64, ch: f64, position: &str, margin: f64) -> (f64, f64) {
    let x = if position.ends_with("left") { margin } else if position.ends_with("right") { pw - cw - margin } else { (pw - cw) / 2.0 };
    let y = if position.starts_with("top") { ph - ch - margin } else if position.starts_with("bottom") { margin } else { (ph - ch) / 2.0 };
    (x, y)
}

fn rotated_placement(pw: f64, ph: f64, w: f64, h: f64, deg: f64, position: &str, margin: f64) -> (f64, f64) {
    let t = deg.to_radians();
    let (c, s) = (t.cos(), t.sin());
    let (bw, bh) = ((w * c).abs() + (h * s).abs(), (w * s).abs() + (h * c).abs());
    let (ax, ay) = anchor(pw, ph, bw, bh, position, margin);
    let (cx, cy) = (ax + bw / 2.0, ay + bh / 2.0);
    (cx - ((w / 2.0) * c - (h / 2.0) * s), cy - ((w / 2.0) * s + (h / 2.0) * c))
}

fn to_roman(n: i64) -> String {
    let table: [(i64, &str); 13] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];
    let mut left = n.max(1);
    let mut out = String::new();
    for (v, s) in table {
        while left >= v {
            out.push_str(s);
            left -= v;
        }
    }
    out
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}
fn f64_of(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(d)
}

/// "1-3, 5, 8-" (1-based) -> 0-based page set. Anything odd is an error (the TypeScript engine words the message).
fn parse_pages(spec: &str, max: usize) -> Result<std::collections::HashSet<usize>> {
    let mut set = std::collections::HashSet::new();
    for token in spec.split([',', ';']).map(|t| t.trim()).filter(|t| !t.is_empty()) {
        let norm = token.replace(['–', ' '], "-").replace("to", "-");
        let (a, b, has_dash) = match norm.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim(), true),
            None => (norm.trim(), "", false),
        };
        let bad = || Error::Msg(format!("\"{token}\" isn't a page number or range."));
        if a.is_empty() && b.is_empty() {
            return Err(bad());
        }
        let from: usize = if a.is_empty() { 1 } else { a.parse().map_err(|_| bad())? };
        let to: usize = if !has_dash { from } else if b.is_empty() { max } else { b.parse().map_err(|_| bad())? };
        if from < 1 || to < 1 || from > max || to > max || from > to {
            return Err(bad());
        }
        set.extend((from..=to).map(|p| p - 1));
    }
    if set.is_empty() {
        return Err(Error::Msg("Enter at least one page or range.".into()));
    }
    Ok(set)
}

// ------------------------------------------------------------------ page numbers

fn mirrored(p: &str) -> String {
    if p.ends_with("left") { p.replace("left", "right") } else if p.ends_with("right") { p.replace("right", "left") } else { p.to_string() }
}

pub fn page_numbers(input: &Path, out: &Path, p: &Value, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(10, "Loading PDF document...");
    let mut doc = load(input)?;
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let total_pages = pages.len() as i64;
    let start_page = p.get("startPage").and_then(|v| v.as_i64()).unwrap_or(1);
    let end_page = p.get("endPage").and_then(|v| v.as_i64()).unwrap_or(0);
    let starting = p.get("startingNumber").and_then(|v| v.as_i64()).unwrap_or(1);
    let from = start_page.max(1) - 1;
    let to = (if end_page > 0 { end_page } else { total_pages }).min(total_pages) - 1;
    let count_total = to - from + 1 + (starting - 1);
    let template = str_of(p, "template").map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let format = str_of(p, "format").unwrap_or("n");
    let label = |n: i64| -> String {
        if let Some(t) = &template {
            return t.replace("{n}", &n.to_string()).replace("{total}", &count_total.to_string()).replace("{roman}", &to_roman(n));
        }
        match format {
            "roman" => to_roman(n),
            "n_of_total" => format!("Page {n} of {count_total}"),
            _ => n.to_string(),
        }
    };
    let font = Font::standard("sans", false, false);
    let size = f64_of(p, "fontSize", 12.0);
    let (r, g, b) = hex_rgb(str_of(p, "color").unwrap_or("#000000"));
    let margin = f64_of(p, "marginMm", 10.0) * 72.0 / 25.4;
    let position = str_of(p, "position").unwrap_or("bottom-center").to_string();
    let mirror = p.get("mirror").and_then(|v| v.as_bool()).unwrap_or(false);
    let wraps = new_wraps(&mut doc);
    progress(35, "Stamping page numbers...");
    for i in from..=to {
        let page = pages[i as usize];
        let text = label(starting + (i - from));
        let bytes = font.encode(&text.replace(['\r', '\n', '\t'], " ")).ok_or(Error::NeedsUnicodeFont)?;
        let pos = if mirror && (i - from) % 2 == 1 { mirrored(&position) } else { position.clone() };
        let (frame, pw, ph) = viewer_frame(&doc, page);
        let tw = font.width(&bytes, size);
        let th = font.ascender * size / 1000.0;
        let (x, y) = anchor(pw, ph, tw, th, &pos, margin);
        let content = format!(
            "q {} cm BT /IHPF {} Tf {} {} {} rg {} {} Td {} Tj ET Q",
            frame.iter().map(|v| f(*v)).collect::<Vec<_>>().join(" "),
            f(size), f(r), f(g), f(b), f(x), f(y), pdf_string(&bytes)
        );
        add_resource(&mut doc, page, "Font", "IHPF", font_dict(&font))?;
        add_content(&mut doc, page, content.into_bytes(), false, &wraps)?;
        if to > from {
            progress(35 + (((i - from) * 50) / (to - from)) as u32, &format!("Stamping page {}...", i + 1));
        }
    }
    progress(90, "Saving document...");
    save(&mut doc, out)?;
    Ok(pages.len())
}

// ------------------------------------------------------------------ watermark

pub fn watermark(input: &Path, out: &Path, p: &Value, image: Option<(&[u8], bool)>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    let mode = str_of(p, "mode").unwrap_or("text");
    let text = str_of(p, "text").unwrap_or("");
    if mode == "text" && text.trim().is_empty() {
        return Err(Error::Msg("Watermark text is required.".into()));
    }
    if mode == "image" && image.is_none() {
        return Err(Error::Msg("Watermark image is required.".into()));
    }
    progress(10, "Loading PDF document...");
    let mut doc = load(input)?;
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let targets: Option<std::collections::HashSet<usize>> = match str_of(p, "pages").filter(|t| !t.trim().is_empty()) {
        Some(spec) => Some(parse_pages(spec, pages.len())?),
        None => p.get("pageIndices").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect()),
    };
    let size = f64_of(p, "fontSize", 48.0);
    let (r, g, b) = hex_rgb(str_of(p, "color").unwrap_or("#000000"));
    let opacity = f64_of(p, "opacity", 0.3);
    let rot = f64_of(p, "rotationDegrees", 0.0);
    let position = str_of(p, "position").unwrap_or("center").to_string();
    let below = str_of(p, "layer") == Some("below");
    let tile = p.get("tile").and_then(|v| v.as_bool()).unwrap_or(false);
    let image_scale = f64_of(p, "imageScale", 0.5);
    let font = Font::standard(str_of(p, "fontFamily").unwrap_or("sans"), p.get("bold").and_then(|v| v.as_bool()).unwrap_or(true), false);
    let lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    let encoded: Vec<Vec<u8>> = if mode == "text" { lines.iter().map(|l| font.encode(l).ok_or(Error::NeedsUnicodeFont)).collect::<Result<_>>()? } else { Vec::new() };
    let img: Option<Embedded> = match image {
        Some((bytes, png)) if mode == "image" => {
            progress(20, "Embedding watermark image...");
            Some(embed_image(&mut doc, bytes, png)?)
        }
        _ => None,
    };
    let wraps = new_wraps(&mut doc);
    progress(35, "Stamping pages...");
    let t = rot.to_radians();
    let (c, s) = (t.cos(), t.sin());
    let gs_name = "IHPG";
    for (i, page) in pages.iter().enumerate() {
        if targets.as_ref().map_or(false, |set| !set.contains(&i)) {
            continue;
        }
        let (frame, pw, ph) = viewer_frame(&doc, *page);
        let (w, h) = if mode == "text" {
            (encoded.iter().map(|b| font.width(b, size)).fold(0.0, f64::max), size * 1.15 * lines.len() as f64)
        } else {
            let im = img.as_ref().unwrap();
            let scale = (image_scale * pw) / im.w;
            (im.w * scale, im.h * scale)
        };
        let mut body = String::new();
        let draw = |x: f64, y: f64, body: &mut String| {
            if mode == "text" {
                for (li, bytes) in encoded.iter().enumerate() {
                    let dy = (lines.len() - 1 - li) as f64 * size * 1.15 + size * 0.2;
                    body.push_str(&format!(
                        "BT /IHPF {} Tf {} {} {} rg {} {} {} {} {} {} Tm {} Tj ET\n",
                        f(size), f(r), f(g), f(b), f(c), f(s), f(-s), f(c), f(x - dy * s), f(y + dy * c), pdf_string(bytes)
                    ));
                }
            } else {
                body.push_str(&format!("q {} {} {} {} {} {} cm /IHPX Do Q\n", f(w * c), f(w * s), f(-h * s), f(h * c), f(x), f(y)));
            }
        };
        if tile {
            let (bw, bh) = ((w * c).abs() + (h * s).abs(), (w * s).abs() + (h * c).abs());
            let (step_x, step_y) = (bw + 40f64.max(bw * 0.4), bh + 60f64.max(bh * 0.8));
            let (mut row, mut cy) = (0, ph - step_y / 2.0);
            while cy > -step_y {
                let mut cx = (if row % 2 == 1 { step_x / 2.0 } else { 0.0 }) + step_x / 2.0 - step_x;
                while cx < pw + step_x {
                    draw(cx - ((w / 2.0) * c - (h / 2.0) * s), cy - ((w / 2.0) * s + (h / 2.0) * c), &mut body);
                    cx += step_x;
                }
                cy -= step_y;
                row += 1;
            }
        } else {
            let (x, y) = rotated_placement(pw, ph, w, h, rot, &position, 24.0);
            draw(x, y, &mut body);
        }
        let content = format!("q {} cm /{gs_name} gs\n{}Q", frame.iter().map(|v| f(*v)).collect::<Vec<_>>().join(" "), body);
        add_resource(&mut doc, *page, "ExtGState", gs_name, gstate(opacity))?;
        if mode == "text" {
            add_resource(&mut doc, *page, "Font", "IHPF", font_dict(&font))?;
        } else {
            add_resource(&mut doc, *page, "XObject", "IHPX", Object::Reference(img.as_ref().unwrap().id))?;
        }
        add_content(&mut doc, *page, content.into_bytes(), below, &wraps)?;
        if pages.len() > 1 {
            progress(35 + ((i * 50) / pages.len()) as u32, &format!("Stamping page {} of {}...", i + 1, pages.len()));
        }
    }
    progress(90, "Saving document...");
    save(&mut doc, out)?;
    Ok(pages.len())
}

// ------------------------------------------------------------------ sign

/// placements: [{pageIndex, x, y, width, height}] in displayed points, origin top-left.
pub fn sign(input: &Path, out: &Path, png: &[u8], placements: &Value, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    let list = placements.as_array().ok_or_else(|| Error::Msg("Place the signature on at least one page.".into()))?;
    if list.is_empty() {
        return Err(Error::Msg("Place the signature on at least one page.".into()));
    }
    progress(20, "Loading document...");
    let mut doc = load(input)?;
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    progress(50, "Embedding signature...");
    let img = embed_image(&mut doc, png, true)?;
    let wraps = new_wraps(&mut doc);
    for p in list {
        let Some(page) = p.get("pageIndex").and_then(|v| v.as_u64()).and_then(|i| pages.get(i as usize)).copied() else { continue };
        let (frame, _, height) = viewer_frame(&doc, page);
        let (x, y, w, h) = (f64_of(p, "x", 0.0), f64_of(p, "y", 0.0), f64_of(p, "width", 0.0), f64_of(p, "height", 0.0));
        let content = format!("q {} cm q {} 0 0 {} {} {} cm /IHPX Do Q Q", frame.iter().map(|v| f(*v)).collect::<Vec<_>>().join(" "), f(w), f(h), f(x), f(height - y - h));
        add_resource(&mut doc, page, "XObject", "IHPX", Object::Reference(img.id))?;
        add_content(&mut doc, page, content.into_bytes(), false, &wraps)?;
    }
    progress(85, "Saving PDF...");
    save(&mut doc, out)?;
    Ok(pages.len())
}
