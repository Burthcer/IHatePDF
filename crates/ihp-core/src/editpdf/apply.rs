//! Edit PDF engine, editing half, ported from src/features/editPdf/engine/rewrite.ts (`applyPageEdits`):
//! edited, moved and deleted paragraphs lose their glyphs from the content stream (each removed glyph
//! becomes an equal TJ displacement) and the new text is typeset in the document's own font when it has
//! every character, otherwise in the standard font of the chosen family; existing images are deleted or
//! moved with a compensating `cm`; form XObjects that change are cloned per use; new text, images and
//! shapes are drawn on top. Same arithmetic as the TypeScript engine (compared in scripts/test-editapply-rust.ts).
//!
//! Anything this port can't draw (Greek/Cyrillic/Devanagari/CJK text that needs an embedded Unicode font,
//! encrypted files) returns Err and the TypeScript engine does the job instead.

use super::*;
use crate::images::embed_image;
use crate::stamp::{font_dict, Font as StampFont};
use lopdf::Stream;

const FALLBACK_SPACE: f64 = 569.0 / 2048.0; // Liberation Sans space, what TypeScript uses when a font has no space glyph

fn invert(m: &Matrix) -> Matrix {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return IDENTITY;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}

/// lexer.ts `formatNumber`.
fn fnum(n: f64) -> String {
    if !n.is_finite() {
        return "0".into();
    }
    if n == n.trunc() && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    let s = format!("{:.4}", n);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() { "0".into() } else { s.to_string() }
}

fn fname(name: &str) -> String {
    let mut out = String::from("/");
    for c in name.chars() {
        let u = c as u32;
        if u < 0x21 || u > 0x7e || c == '#' || is_delim(c as u8) {
            out.push_str(&format!("#{:02x}", u & 0xff));
        } else {
            out.push(c);
        }
    }
    out
}

fn fhex(bytes: &[u8]) -> String {
    let mut s = String::from("<");
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s.push('>');
    s
}

fn hex_rgb(hex: &str) -> (f64, f64, f64) {
    let c = hex.trim_start_matches('#');
    let full: String = if c.chars().count() == 3 { c.chars().flat_map(|x| [x, x]).collect() } else { format!("{:0<6}", c) };
    let n = u32::from_str_radix(&full.chars().take(6).collect::<String>(), 16).unwrap_or(0);
    (((n >> 16) & 255) as f64 / 255.0, ((n >> 8) & 255) as f64 / 255.0, (n & 255) as f64 / 255.0)
}

fn rgb_ops(hex: &str, stroke: bool) -> String {
    let (r, g, b) = hex_rgb(hex);
    format!("{} {} {} {}", fnum(r), fnum(g), fnum(b), if stroke { "RG" } else { "rg" })
}

fn needs_shaping(ch: char) -> bool {
    matches!(ch as u32, 0x0900..=0x097f | 0xa8e0..=0xa8ff | 0x1cd0..=0x1cff)
}

fn sanitize(text: &str) -> String {
    let t = text.replace("\r\n", "\n").replace('\r', "\n").replace('\t', "    ");
    t.chars().filter(|&c| !matches!(c as u32, 0..=8 | 0x0b..=0x1f)).collect()
}

// ------------------------------------------------------------------ resources

#[derive(Default)]
struct Adds {
    font: Vec<(String, ObjectId)>,
    xobject: Vec<(String, ObjectId)>,
    ext_gstate: Vec<(String, ObjectId)>,
}

impl Adds {
    fn sets(&self) -> [(&'static str, &Vec<(String, ObjectId)>); 3] {
        [("Font", &self.font), ("XObject", &self.xobject), ("ExtGState", &self.ext_gstate)]
    }
}

struct Namer {
    used: HashSet<String>,
    n: usize,
}

impl Namer {
    fn new(doc: &Document, res: Option<&Dictionary>) -> Namer {
        let mut used = HashSet::new();
        if let Some(r) = res {
            for cat in ["Font", "XObject", "ExtGState"] {
                if let Some(Object::Dictionary(d)) = r.get(cat.as_bytes()).ok().and_then(|o| doc.dereference(o).ok()).map(|x| x.1) {
                    for k in d.iter().map(|(k, _)| k) {
                        used.insert(latin1(k));
                    }
                }
            }
        }
        Namer { used, n: 0 }
    }
    fn next(&mut self, prefix: &str) -> String {
        loop {
            self.n += 1;
            let name = format!("{prefix}{}", self.n);
            if self.used.insert(name.clone()) {
                return name;
            }
        }
    }
}

fn clone_resources(doc: &Document, base: Option<&Dictionary>, adds: &Adds) -> Dictionary {
    let mut res = base.cloned().unwrap_or_default();
    for (cat, entries) in adds.sets() {
        if entries.is_empty() {
            continue;
        }
        let mut sub = match res.get(cat.as_bytes()).ok().and_then(|o| doc.dereference(o).ok()).map(|x| x.1) {
            Some(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        };
        for (name, id) in entries {
            sub.set(name.as_bytes().to_vec(), Object::Reference(*id));
        }
        res.set(cat, Object::Dictionary(sub));
    }
    res
}

// ------------------------------------------------------------------ text op rewriting

fn rebuild_text_op(info: &TextOp, removed: &HashSet<usize>, glyphs: &[Glyph], fonts: &[FontModel]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    for el in &info.elems {
        match el {
            Elem::Num(v) => {
                if !pending.is_empty() {
                    parts.push(fhex(&pending));
                    pending.clear();
                }
                parts.push(fnum(*v));
            }
            Elem::Str { bytes, spans, glyph_ids } => {
                for (i, (_, len, start)) in spans.iter().enumerate() {
                    let gid = glyph_ids.get(i).copied();
                    let g = gid.map(|id| &glyphs[id]);
                    match (gid, g) {
                        (Some(id), Some(g)) if removed.contains(&id) && g.font_size != 0.0 => {
                            if !pending.is_empty() {
                                parts.push(fhex(&pending));
                                pending.clear();
                            }
                            let value = (g.adv_text * 1000.0) / g.font_size;
                            parts.push(fnum(if fonts[g.font].vertical { value } else { -value }));
                        }
                        _ => pending.extend_from_slice(&bytes[*start..*start + *len]),
                    }
                }
                if !pending.is_empty() {
                    parts.push(fhex(&pending));
                    pending.clear();
                }
            }
        }
    }
    let prefix = match info.kind.as_str() {
        "'" => "T* ".to_string(),
        "\"" => format!("{} Tw {} Tc T* ", fnum(info.aw), fnum(info.ac)),
        _ => String::new(),
    };
    format!("{prefix}[{}] TJ", parts.join(" "))
}

fn rebuild_context(bytes: &[u8], ops: &[(usize, usize)], reps: &HashMap<usize, String>) -> Vec<u8> {
    if reps.is_empty() {
        return bytes.to_vec();
    }
    let mut order: Vec<usize> = reps.keys().copied().collect();
    order.sort_by_key(|&i| ops[i].0);
    let mut out = Vec::with_capacity(bytes.len());
    let mut pos = 0usize;
    for idx in order {
        let (start, end) = ops[idx];
        if start < pos {
            continue;
        }
        out.extend_from_slice(&bytes[pos..start]);
        out.extend_from_slice(reps[&idx].as_bytes());
        pos = end;
    }
    out.extend_from_slice(&bytes[pos..]);
    out
}

// ------------------------------------------------------------------ typesetting

enum FaceKind {
    Original(usize),
    Standard(StampFont),
}

#[allow(dead_code)]
struct Face {
    kind: FaceKind,
    id: ObjectId,
    has_space: bool,
    ascent: f64,
}

impl Face {
    fn code_width(&self, fonts: &[FontModel], ch: char) -> Option<f64> {
        match &self.kind {
            FaceKind::Original(i) => {
                let f = &fonts[*i];
                let (_, codes) = f.encode(&ch.to_string())?;
                Some(codes.iter().map(|&c| f.width(c)).sum())
            }
            FaceKind::Standard(s) => s.char_width(ch),
        }
    }
    fn has(&self, fonts: &[FontModel], ch: char) -> bool {
        self.code_width(fonts, ch).is_some()
    }
    fn width(&self, fonts: &[FontModel], ch: char) -> f64 {
        self.code_width(fonts, ch).unwrap_or(0.5)
    }
    fn encode(&self, fonts: &[FontModel], text: &str) -> String {
        match &self.kind {
            FaceKind::Original(i) => fhex(&fonts[*i].encode(text).map(|e| e.0).unwrap_or_default()),
            FaceKind::Standard(s) => fhex(&s.encode(text).unwrap_or_default()),
        }
    }
}

struct Typesetter<'a> {
    face: Face,
    fonts: &'a [FontModel],
}

impl<'a> Typesetter<'a> {
    fn space_width(&self) -> f64 {
        if self.face.has_space {
            self.face.width(self.fonts, ' ')
        } else {
            FALLBACK_SPACE
        }
    }

    fn measure(&self, text: &str) -> f64 {
        text.chars().map(|ch| if ch == ' ' { self.space_width() } else { self.face.width(self.fonts, ch) }).sum()
    }

    /// TJ drawing of one line; `extra` is additional space (pt) per word gap.
    fn emit(&self, text: &str, size: f64, extra: f64, name: &str) -> String {
        let mut out = format!("{} {} Tf ", fname(name), fnum(size));
        let mut tj: Vec<String> = Vec::new();
        let mut run = String::new();
        for ch in text.chars() {
            if ch == ' ' {
                if !run.is_empty() {
                    tj.push(self.face.encode(self.fonts, &run));
                    run.clear();
                }
                if self.face.has_space {
                    tj.push(self.face.encode(self.fonts, " "));
                } else {
                    tj.push(fnum(-self.space_width() * 1000.0));
                }
                if extra != 0.0 {
                    tj.push(fnum((-extra / size) * 1000.0));
                }
            } else {
                run.push(ch);
            }
        }
        if !run.is_empty() {
            tj.push(self.face.encode(self.fonts, &run));
        }
        if !tj.is_empty() {
            out.push_str(&format!("[{}] TJ ", tj.join(" ")));
        }
        out
    }
}

struct EditStyle {
    font_size: f64,
    color: String,
    bold: bool,
    italic: bool,
    align: String,
    font_choice: String,
}

fn style_from(base: Option<&Block>, v: Option<&Value>) -> EditStyle {
    let mut st = match base {
        Some(b) => EditStyle { font_size: b.font_size, color: b.color.clone(), bold: b.bold, italic: b.italic, align: b.align.to_string(), font_choice: "original".into() },
        None => EditStyle { font_size: 12.0, color: "#000000".into(), bold: false, italic: false, align: "left".into(), font_choice: "original".into() },
    };
    if let Some(Value::Object(o)) = v {
        if let Some(x) = o.get("fontSize").and_then(|x| x.as_f64()) {
            st.font_size = x;
        }
        if let Some(x) = o.get("color").and_then(|x| x.as_str()) {
            st.color = x.into();
        }
        if let Some(x) = o.get("bold").and_then(|x| x.as_bool()) {
            st.bold = x;
        }
        if let Some(x) = o.get("italic").and_then(|x| x.as_bool()) {
            st.italic = x;
        }
        if let Some(x) = o.get("align").and_then(|x| x.as_str()) {
            st.align = x.into();
        }
        if let Some(x) = o.get("fontChoice").and_then(|x| x.as_str()) {
            st.font_choice = x.into();
        }
    }
    st
}

struct Ctxs<'a> {
    doc: &'a mut Document,
    fonts: &'a [FontModel],
    orig_ids: HashMap<usize, ObjectId>,
    std_ids: &'a mut HashMap<String, ObjectId>,
}

fn build_typesetter<'a>(c: &mut Ctxs<'a>, text: &str, style: &EditStyle, original: Option<usize>) -> Result<Typesetter<'a>, String> {
    let fonts = c.fonts;
    let family = if style.font_choice == "original" {
        match original.map(|i| fonts[i].family) {
            Some(Family::Serif) => "serif",
            Some(Family::Mono) => "mono",
            _ => "sans",
        }
    } else {
        style.font_choice.as_str()
    };
    let use_original = original.filter(|&i| style.font_choice == "original" && style.bold == fonts[i].bold && style.italic == fonts[i].italic);
    let face = match use_original {
        Some(i) => {
            let id = match c.orig_ids.get(&i) {
                Some(id) => *id,
                None => {
                    let id = match fonts[i].raw.clone() {
                        Some(FontRaw::Ref(id)) => id,
                        Some(FontRaw::Direct(d)) => c.doc.add_object(Object::Dictionary(d)),
                        None => return Err("font object unknown".into()),
                    };
                    c.orig_ids.insert(i, id);
                    id
                }
            };
            Face { kind: FaceKind::Original(i), id, has_space: fonts[i].encode(" ").is_some(), ascent: fonts[i].ascent }
        }
        None => {
            let sf = StampFont::standard(family, style.bold, style.italic);
            let key = sf.base.to_string();
            let id = match c.std_ids.get(&key) {
                Some(id) => *id,
                None => {
                    let id = c.doc.add_object(font_dict(&sf));
                    c.std_ids.insert(key, id);
                    id
                }
            };
            let ascent = (sf.ascender / 1000.0).max(0.6);
            Face { kind: FaceKind::Standard(sf), id, has_space: true, ascent }
        }
    };
    // Characters this face can't draw would need an embedded Unicode font: leave that to the TypeScript engine.
    if text.chars().any(|ch| ch != ' ' && ch != '\n' && (needs_shaping(ch) || !face.has(fonts, ch))) {
        return Err("text needs an embedded Unicode font".into());
    }
    Ok(Typesetter { face, fonts })
}

fn wrap_paragraph(text: &str, width: f64, measure: &dyn Fn(&str) -> f64) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split(' ') {
        let candidate = if cur.is_empty() { word.to_string() } else { format!("{cur} {word}") };
        if !cur.is_empty() && measure(&candidate) > width {
            lines.push(std::mem::take(&mut cur));
            cur = word.to_string();
        } else {
            cur = candidate;
        }
    }
    lines.push(cur);
    lines
}

struct TLine {
    text: String,
    along: f64,
    perp: f64,
    justify_to: Option<f64>,
}

fn normalize((x, y): (f64, f64)) -> (f64, f64) {
    let l = x.hypot(y);
    let l = if l == 0.0 { 1.0 } else { l };
    (x / l, y / l)
}

fn aligned_along(align: &str, x0: f64, width: f64, line_width: f64) -> f64 {
    match align {
        "center" => x0 + (width - line_width) / 2.0,
        "right" => x0 + width - line_width,
        _ => x0,
    }
}

fn draw_lines(lines: &[TLine], d: (f64, f64), n: (f64, f64), v2u: &Matrix, ts: &Typesetter, size: f64, color: &str, name: &str) -> String {
    let (ux, uy) = normalize(apply_vector(v2u, d.0, d.1));
    let (upx, upy) = normalize(apply_vector(v2u, -n.0, -n.1));
    let mut out = format!("BT {}\n", rgb_ops(color, false));
    for line in lines {
        if line.text.is_empty() {
            continue;
        }
        let vx = line.along * d.0 + line.perp * n.0;
        let vy = line.along * d.1 + line.perp * n.1;
        let (ox, oy) = apply(v2u, vx, vy);
        let mut extra = 0.0;
        if let Some(target) = line.justify_to {
            let gaps = line.text.split(' ').count() as f64 - 1.0;
            let natural = ts.measure(&line.text) * size;
            let e = if gaps > 0.0 { (target - natural) / gaps } else { 0.0 };
            if e > 0.0 && e < size * 3.0 {
                extra = e;
            }
        }
        let tm: Vec<String> = [ux, uy, upx, upy, ox, oy].iter().map(|v| fnum(*v)).collect();
        out.push_str(&format!("{} Tm {}\n", tm.join(" "), ts.emit(&line.text, size, extra, name)));
    }
    out.push_str("ET\n");
    out
}

// ------------------------------------------------------------------ page

fn n_of(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

fn has_edits(e: &Value) -> bool {
    ["blocks", "images", "texts", "addedImages", "shapes"].iter().any(|k| !arr(e, k).is_empty())
}

fn apply_page(doc: &mut Document, page_id: ObjectId, page_index: usize, e: &Value, std_ids: &mut HashMap<String, ObjectId>) -> Result<(), String> {
    let (model, _, _) = {
        let page = doc.get_dictionary(page_id).map_err(|x| x.to_string())?;
        interpret_page(doc, page)?
    };
    let mut blocks = build_blocks(&model);
    let by_id: HashMap<String, usize> = (0..blocks.len()).map(|i| (format!("p{page_index}b{i}"), i)).collect();
    let v2u = invert(&model.u2v);
    let u2v = model.u2v;

    let mut reps: HashMap<usize, HashMap<usize, String>> = HashMap::new();
    let mut adds: HashMap<usize, Adds> = HashMap::new();

    // 1. glyph removal for edited / deleted / moved blocks
    let mut removed: HashSet<usize> = HashSet::new();
    let block_edits: Vec<(&Value, usize)> = arr(e, "blocks").iter().filter_map(|be| by_id.get(be.get("id")?.as_str()?).map(|&i| (be, i))).collect();
    for (be, bi) in &block_edits {
        let b = &blocks[*bi];
        let deleted = be.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false);
        let text_changed = be.get("text").and_then(|x| x.as_str()).map_or(false, |t| t != b.text);
        let style_set = be.get("style").and_then(|x| x.as_object()).map_or(false, |o| !o.is_empty());
        let changed = deleted || text_changed || n_of(be, "dx") != 0.0 || n_of(be, "dy") != 0.0 || be.get("width").map_or(false, |w| !w.is_null()) || style_set;
        if changed {
            removed.extend(b.glyph_ids.iter().copied());
        }
    }
    let mut touched: HashSet<(usize, usize)> = HashSet::new();
    for &id in &removed {
        touched.insert((model.glyphs[id].ctx, model.glyphs[id].op));
    }
    for key in touched {
        if let Some(info) = model.text_ops.get(&key) {
            reps.entry(key.0).or_default().insert(key.1, rebuild_text_op(info, &removed, &model.glyphs, &model.fonts));
        }
    }

    // 2. existing images
    for ie in arr(e, "images") {
        let Some(img) = ie.get("id").and_then(|x| x.as_u64()).and_then(|i| model.images.get(i as usize)) else { continue };
        let ctx = &model.contexts[img.ctx];
        let (os, oe) = ctx.ops[img.op];
        let op_bytes = latin1(&ctx.bytes[os..oe]);
        if ie.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false) {
            reps.entry(img.ctx).or_default().insert(img.op, String::new());
        } else if let Some(bx) = ie.get("box").filter(|b| b.is_object()) {
            if img.bw > 0.0 && img.bh > 0.0 {
                let sx = n_of(bx, "width") / img.bw;
                let sy = n_of(bx, "height") / img.bh;
                let t_view: Matrix = [sx, 0.0, 0.0, sy, n_of(bx, "x") - img.bx * sx, n_of(bx, "y") - img.by * sy];
                let t_user = multiply(&multiply(&u2v, &t_view), &v2u);
                let x = multiply(&multiply(&img.ctm, &t_user), &invert(&img.ctm));
                let cm: Vec<String> = x.iter().map(|v| fnum(*v)).collect();
                reps.entry(img.ctx).or_default().insert(img.op, format!("q {} cm {} Q", cm.join(" "), op_bytes));
            }
        }
    }

    // 3. new content, appended to the page
    let page_res = model.contexts[0].resources.clone();
    let mut namer = Namer::new(doc, page_res.as_ref());
    let mut font_names: HashMap<ObjectId, String> = HashMap::new();
    let mut draw = String::new();

    let mut cx = Ctxs { doc, fonts: &model.fonts, orig_ids: HashMap::new(), std_ids };
    let mut page_adds = Adds::default();

    for (be, bi) in &block_edits {
        let b = &blocks[*bi];
        let deleted = be.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false);
        if deleted || b.glyph_ids.first().map_or(true, |g| !removed.contains(g)) {
            continue;
        }
        let style = style_from(Some(b), be.get("style"));
        let text = sanitize(be.get("text").and_then(|x| x.as_str()).unwrap_or(&b.text));
        if js_trim(&text).is_empty() {
            continue;
        }
        let ts = build_typesetter(&mut cx, &text, &style, Some(b.font))?;
        let name = font_names.entry(ts.face.id).or_insert_with(|| {
            let n = namer.next("IHF");
            page_adds.font.push((n.clone(), ts.face.id));
            n
        }).clone();
        let size = style.font_size;
        let scale = size / if b.font_size != 0.0 { b.font_size } else { size };
        let (dx, dy) = b.dir;
        let (edx, edy) = (n_of(be, "dx"), n_of(be, "dy"));
        let shift_along = edx * dx + edy * dy;
        let shift_perp = edx * -dy + edy * dx;
        let x0 = b.frame_x0 + shift_along;
        let width = be.get("width").and_then(|w| w.as_f64()).unwrap_or((b.frame_x1 - b.frame_x0) * scale);
        let same_text = text == b.text && be.get("width").map_or(true, |w| w.is_null()) && (scale - 1.0).abs() < 1e-6;
        let mut lines: Vec<TLine> = Vec::new();
        if same_text {
            for (i, l) in b.lines.iter().enumerate() {
                let (lx0, lx1, lperp) = b.line_geo[i];
                let justify = style.align == "justify" && !l.1;
                lines.push(TLine { text: l.0.clone(), along: lx0 + shift_along, perp: lperp + shift_perp, justify_to: justify.then_some(lx1 - lx0) });
            }
        } else {
            let line_height = b.line_height * scale;
            let mut perp = b.first_perp + shift_perp;
            let measure = |t: &str| ts.measure(t) * size;
            for (pi, para) in text.split('\n').enumerate() {
                let wrapped = wrap_paragraph(para, width, &measure);
                let count = wrapped.len();
                for (li, line_text) in wrapped.into_iter().enumerate() {
                    let w = measure(&line_text);
                    let indent = if pi == 0 && li == 0 && style.align == "left" { b.first_x - b.frame_x0 } else { 0.0 };
                    let is_last = li == count - 1;
                    lines.push(TLine {
                        along: aligned_along(&style.align, x0 + indent, width - indent, w),
                        text: line_text,
                        perp,
                        justify_to: (style.align == "justify" && !is_last).then_some(width - indent),
                    });
                    perp += line_height;
                }
            }
        }
        draw.push_str(&draw_lines(&lines, b.dir, (-dy, dx), &v2u, &ts, size, &style.color, &name));
    }

    for t in arr(e, "texts") {
        let text = sanitize(t.get("text").and_then(|x| x.as_str()).unwrap_or(""));
        if js_trim(&text).is_empty() {
            continue;
        }
        let style = style_from(None, t.get("style"));
        let ts = build_typesetter(&mut cx, &text, &style, None)?;
        let name = font_names.entry(ts.face.id).or_insert_with(|| {
            let n = namer.next("IHF");
            page_adds.font.push((n.clone(), ts.face.id));
            n
        }).clone();
        let size = style.font_size;
        let measure = |s: &str| ts.measure(s) * size;
        let line_height = size * 1.25;
        let (tx, ty, tw) = (n_of(t, "x"), n_of(t, "y"), n_of(t, "width"));
        let mut lines = Vec::new();
        let mut perp = ty + (line_height - 1.12 * size) / 2.0 + 0.9 * size;
        for para in text.split('\n') {
            let wrapped = if tw > 0.0 { wrap_paragraph(para, tw, &measure) } else { vec![para.to_string()] };
            let count = wrapped.len();
            for (li, line_text) in wrapped.into_iter().enumerate() {
                let w = measure(&line_text);
                lines.push(TLine {
                    along: if tw > 0.0 { aligned_along(&style.align, tx, tw, w) } else { tx },
                    text: line_text,
                    perp,
                    justify_to: (style.align == "justify" && li + 1 < count).then_some(tw),
                });
                perp += line_height;
            }
        }
        draw.push_str(&draw_lines(&lines, (1.0, 0.0), (0.0, 1.0), &v2u, &ts, size, &style.color, &name));
    }
    let doc = cx.doc;

    let mut gs_cache: HashMap<String, String> = HashMap::new();
    let v2u_cm = format!("{} cm", v2u.iter().map(|v| fnum(*v)).collect::<Vec<_>>().join(" "));
    for s in arr(e, "shapes") {
        let kind = s.get("kind").and_then(|x| x.as_str()).unwrap_or("rect");
        let highlight = kind == "highlight";
        let raw_opacity = s.get("opacity").and_then(|x| x.as_f64()).unwrap_or(1.0);
        let opacity = if highlight { raw_opacity.min(0.6) } else { raw_opacity };
        let mut ops = format!("q {v2u_cm} ");
        if opacity < 1.0 || highlight {
            let key = format!("{opacity}:{highlight}");
            let name = match gs_cache.get(&key) {
                Some(n) => n.clone(),
                None => {
                    let n = namer.next("IHG");
                    let mut d = Dictionary::new();
                    d.set("Type", Object::Name(b"ExtGState".to_vec()));
                    d.set("ca", Object::Real(opacity as f32));
                    d.set("CA", Object::Real(opacity as f32));
                    if highlight {
                        d.set("BM", Object::Name(b"Multiply".to_vec()));
                    }
                    let id = doc.add_object(Object::Dictionary(d));
                    page_adds.ext_gstate.push((n.clone(), id));
                    gs_cache.insert(key, n.clone());
                    n
                }
            };
            ops.push_str(&format!("{} gs ", fname(&name)));
        }
        let fill_in = s.get("fill").and_then(|x| x.as_str());
        let stroke_in = s.get("stroke").and_then(|x| x.as_str());
        let stroke_w = n_of(s, "strokeWidth");
        let fill = if highlight { Some(fill_in.unwrap_or("#FFE066")) } else { fill_in };
        if let Some(f) = fill {
            ops.push_str(&rgb_ops(f, false));
            ops.push(' ');
        }
        if let (Some(st), false) = (stroke_in, highlight) {
            ops.push_str(&format!("{} {} w ", rgb_ops(st, true), fnum(stroke_w)));
        }
        let paint = if fill.is_some() && stroke_in.is_some() && !highlight { "B" } else if fill.is_some() { "f" } else { "S" };
        let (x, y, w, h) = (n_of(s, "x"), n_of(s, "y"), n_of(s, "width"), n_of(s, "height"));
        match kind {
            "line" => {
                ops.push_str(&format!("{} {} w 1 J ", rgb_ops(stroke_in.or(fill).unwrap_or("#000000"), true), fnum(stroke_w)));
                ops.push_str(&format!("{} {} m {} {} l S", fnum(x), fnum(y), fnum(x + w), fnum(y + h)));
            }
            "ellipse" => {
                let k = 0.5522847498;
                let (cx2, cy, rx, ry) = (x + w / 2.0, y + h / 2.0, w / 2.0, h / 2.0);
                let f = fnum;
                ops.push_str(&format!(
                    "{} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {}",
                    f(cx2 + rx), f(cy),
                    f(cx2 + rx), f(cy + ry * k), f(cx2 + rx * k), f(cy + ry), f(cx2), f(cy + ry),
                    f(cx2 - rx * k), f(cy + ry), f(cx2 - rx), f(cy + ry * k), f(cx2 - rx), f(cy),
                    f(cx2 - rx), f(cy - ry * k), f(cx2 - rx * k), f(cy - ry), f(cx2), f(cy - ry),
                    f(cx2 + rx * k), f(cy - ry), f(cx2 + rx), f(cy - ry * k), f(cx2 + rx), f(cy),
                    paint
                ));
            }
            _ => ops.push_str(&format!("{} {} {} {} re {}", fnum(x), fnum(y), fnum(w), fnum(h), paint)),
        }
        draw.push_str(&ops);
        draw.push_str(" Q\n");
    }

    for im in arr(e, "addedImages") {
        let file = im.get("file").and_then(|x| x.as_str()).ok_or("added image has no file")?;
        let bytes = std::fs::read(file).map_err(|x| x.to_string())?;
        let png = im.get("type").and_then(|x| x.as_str()) == Some("png");
        let emb = embed_image(doc, &bytes, png).map_err(|x| x.to_string())?;
        let name = namer.next("IHI");
        page_adds.xobject.push((name.clone(), emb.id));
        let (x, y, w, h) = (n_of(im, "x"), n_of(im, "y"), n_of(im, "width"), n_of(im, "height"));
        let placement = multiply(&[w, 0.0, 0.0, -h, x, y + h], &v2u);
        draw.push_str(&format!("q {} cm {} Do Q\n", placement.iter().map(|v| fnum(*v)).collect::<Vec<_>>().join(" "), fname(&name)));
    }

    adds.insert(0, page_adds);

    // 4. changed form XObjects, deepest first; their `Do` is renamed in the parent
    let mut form_namers: HashMap<usize, Namer> = HashMap::new();
    for ctx_id in (1..model.contexts.len()).rev() {
        let ctx = &model.contexts[ctx_id];
        let has_reps = reps.get(&ctx_id).map_or(false, |m| !m.is_empty());
        if !has_reps && !adds.contains_key(&ctx_id) {
            continue;
        }
        let (Some(sd), Some(parent)) = (&ctx.stream_dict, ctx.parent) else { continue };
        let empty = HashMap::new();
        let new_bytes = rebuild_context(&ctx.bytes, &ctx.ops, reps.get(&ctx_id).unwrap_or(&empty));
        let mut dict = sd.clone();
        for k in ["Filter", "DecodeParms", "Length", "DL"] {
            dict.remove(k.as_bytes());
        }
        if let Some(a) = adds.get(&ctx_id) {
            dict.set("Resources", Object::Dictionary(clone_resources(doc, ctx.resources.as_ref(), a)));
        }
        let mut stream = Stream::new(dict, new_bytes);
        stream.allows_compression = true;
        let id = doc.add_object(Object::Stream(stream));
        let new_name = if parent == 0 {
            namer.next("IHX")
        } else {
            form_namers.entry(parent).or_insert_with(|| Namer::new(doc, model.contexts[parent].resources.as_ref())).next("IHX")
        };
        adds.entry(parent).or_default().xobject.push((new_name.clone(), id));
        reps.entry(parent).or_default().insert(ctx.parent_op, format!("{} Do", fname(&new_name)));
    }

    // 5. page content: the original (edited) wrapped in q/Q, then the new drawing
    let page0 = &model.contexts[0];
    let empty = HashMap::new();
    let mut body = rebuild_context(&page0.bytes, &page0.ops, reps.get(&0).unwrap_or(&empty));
    if page0.ends_in_text {
        body.extend_from_slice(b"\nET");
    }
    body.push(b'\n');
    for _ in 0..page0.end_depth {
        body.extend_from_slice(b"Q\n");
    }
    let mut content = b"q\n".to_vec();
    content.extend_from_slice(&body);
    content.extend_from_slice(b"Q\n");
    content.extend_from_slice(draw.as_bytes());
    let mut cs = Stream::new(Dictionary::new(), content);
    cs.allows_compression = true;
    let content_id = doc.add_object(Object::Stream(cs));
    let res = clone_resources(doc, page_res.as_ref(), adds.get(&0).unwrap());
    let page = doc.get_dictionary_mut(page_id).map_err(|x| x.to_string())?;
    page.set("Contents", Object::Reference(content_id));
    page.set("Resources", Object::Dictionary(res));
    blocks.clear();
    Ok(())
}

/// Applies `edits` (an array of PageEdits, as in rewrite.ts) to `input` and writes `out`.
/// `only_page`: keep just that page (the editor's preview). Err means "let the TypeScript engine do it".
pub fn apply_edits(input: &Path, out: &Path, edits: &Value, only_page: Option<usize>, progress: &mut dyn FnMut(u8, &str)) -> Result<usize, String> {
    let mut doc = Document::load(input).map_err(|e| format!("Couldn't read the PDF: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted PDF".into());
    }
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let all: Vec<&Value> = edits.as_array().ok_or("edits must be an array")?.iter().filter(|e| has_edits(e)).collect();
    let mut std_ids = HashMap::new();
    for (i, e) in all.iter().enumerate() {
        let idx = e.get("pageIndex").and_then(|x| x.as_u64()).ok_or("edit without pageIndex")? as usize;
        let id = *pages.get(idx).ok_or("page out of range")?;
        progress(10 + ((i * 75) / all.len().max(1)) as u8, &format!("Applying edits to page {}...", idx + 1));
        apply_page(&mut doc, id, idx, e, &mut std_ids)?;
    }
    if let Some(keep) = only_page {
        let drop: Vec<u32> = (1..=pages.len() as u32).filter(|n| *n as usize != keep + 1).collect();
        doc.delete_pages(&drop);
        doc.prune_objects();
    }
    progress(90, "Saving PDF...");
    crate::stamp::save(&mut doc, out).map_err(|e| e.to_string())?;
    Ok(if only_page.is_some() { 1 } else { pages.len() })
}
