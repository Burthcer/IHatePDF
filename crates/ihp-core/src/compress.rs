//! Compress: recompress images to the resolution they are shown at, drop duplicates
//! and unused objects. Mirrors `src/features/compress/compress.worker.ts` (same presets,
//! same photo/graphic rules, same "keep only if under 97%" rule), so results line up.
//!
//! Images this engine can't decode safely (JPEG 2000, CMYK, Lab/Separation, CCITT, JBIG2,
//! odd /Decode arrays) are left untouched and counted in `Report::skipped`; the app then
//! lets the TypeScript engine have a go, so nothing gets worse than in 1.4.0.

use lopdf::{content::Content, Dictionary, Document, Object, ObjectId, Stream};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Pdf(#[from] lopdf::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("This PDF is password-protected: unlock it first.")]
    Encrypted,
    #[error("{0}")]
    Msg(String),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug)]
pub enum Level {
    Low,
    Recommended,
    Extreme,
    /// Fit in this many bytes.
    Custom(u64),
}

#[derive(Clone, Copy, Debug)]
struct Setting {
    dpi: f64,
    quality: f64,
}

fn preset(level: Level) -> Setting {
    match level {
        Level::Low => Setting { dpi: 220.0, quality: 0.85 },
        Level::Extreme => Setting { dpi: 96.0, quality: 0.5 },
        _ => Setting { dpi: 150.0, quality: 0.72 },
    }
}

const COARSE: [(f64, f64); 15] = [
    (300.0, 0.9), (250.0, 0.86), (220.0, 0.82), (200.0, 0.78), (170.0, 0.74), (150.0, 0.7), (130.0, 0.64), (110.0, 0.58),
    (96.0, 0.52), (84.0, 0.46), (72.0, 0.4), (60.0, 0.34), (50.0, 0.28), (40.0, 0.22), (30.0, 0.16),
];

fn ladder() -> Vec<Setting> {
    let mut out = Vec::new();
    for (i, &(dpi, q)) in COARSE.iter().enumerate() {
        out.push(Setting { dpi, quality: q });
        if let Some(&(d2, q2)) = COARSE.get(i + 1) {
            out.push(Setting { dpi: ((dpi + d2) / 2.0).round(), quality: (((q + q2) / 2.0) * 100.0).round() / 100.0 });
        }
    }
    out
}

const GRAPHIC_DPI_BOOST: f64 = 1.4;
const GRAPHIC_DPI_CAP: f64 = 300.0;
const GRAPHIC_QUALITY_BOOST: f64 = 0.12;
const GRAPHIC_MAX_QUALITY: f64 = 0.93;
/// Images needing more than this many decoded bytes (x3 working copies) are left alone.
const MAX_DECODED_BYTES: usize = 1_500_000_000 / 3;

#[derive(Debug, Default, Clone)]
pub struct Report {
    pub original: u64,
    pub output: u64,
    pub pages: usize,
    pub images_total: usize,
    pub images_recompressed: usize,
    /// Images that were big enough to matter but that this engine can't decode (see module docs).
    pub skipped: usize,
    pub too_big: usize,
    pub deduped: usize,
    pub removed: usize,
    pub unchanged: bool,
    pub note: String,
}

pub type Progress<'a> = &'a mut (dyn FnMut(u32, &str) + Send);

// ------------------------------------------------------------------ small helpers

fn name_of(o: &Object) -> Option<&[u8]> {
    o.as_name().ok()
}
fn num_of(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}
fn deref<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    doc.dereference(o).map(|(_, o)| o).unwrap_or(o)
}
fn dict_num(doc: &Document, d: &Dictionary, key: &[u8]) -> Option<f64> {
    d.get(key).ok().and_then(|o| num_of(deref(doc, o)))
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
fn mul(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

// ------------------------------------------------------------------ where images are shown

type Shown = HashMap<ObjectId, (f64, f64)>;

fn walk(doc: &Document, bytes: &[u8], res: &Dictionary, ctm: Matrix, shown: &mut Shown, depth: u32, seen: &mut HashSet<ObjectId>) {
    let Ok(content) = Content::decode(bytes) else { return };
    let mut stack: Vec<Matrix> = Vec::new();
    let mut m = ctm;
    for op in &content.operations {
        match op.operator.as_str() {
            "q" => stack.push(m),
            "Q" => {
                if let Some(p) = stack.pop() {
                    m = p;
                }
            }
            "cm" => {
                let n: Vec<f64> = op.operands.iter().filter_map(num_of).collect();
                if n.len() == 6 {
                    m = mul(&[n[0], n[1], n[2], n[3], n[4], n[5]], &m);
                }
            }
            "Do" => {
                let Some(name) = op.operands.first().and_then(name_of) else { continue };
                let Some(xo) = res.get(b"XObject").ok().map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()) else { continue };
                let Ok(entry) = xo.get(name) else { continue };
                let Ok(id) = entry.as_reference() else { continue };
                let Ok(Object::Stream(s)) = doc.get_object(id) else { continue };
                match s.dict.get(b"Subtype").ok().and_then(name_of) {
                    Some(b"Image") => {
                        let (w, h) = ((m[0].hypot(m[1])), (m[2].hypot(m[3])));
                        let e = shown.entry(id).or_insert((0.0, 0.0));
                        e.0 = e.0.max(w);
                        e.1 = e.1.max(h);
                    }
                    Some(b"Form") if depth < 10 && seen.insert(id) => {
                        let fm = s
                            .dict
                            .get(b"Matrix")
                            .ok()
                            .and_then(|o| o.as_array().ok())
                            .map(|a| a.iter().filter_map(num_of).collect::<Vec<_>>())
                            .filter(|v| v.len() == 6)
                            .map(|v| [v[0], v[1], v[2], v[3], v[4], v[5]])
                            .unwrap_or(IDENTITY);
                        let fres = s.dict.get(b"Resources").ok().map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()).unwrap_or(res);
                        if let Ok(data) = s.decompressed_content() {
                            walk(doc, &data, fres, mul(&fm, &m), shown, depth + 1, seen);
                        }
                        seen.remove(&id);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

fn collect_shown(doc: &Document) -> Shown {
    let mut shown = Shown::new();
    for (_, page) in doc.get_pages() {
        let (res, ids) = match doc.get_page_resources(page) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let res: Option<&Dictionary> = res.or_else(|| ids.iter().find_map(|id| doc.get_dictionary(*id).ok()));
        let Some(res) = res else { continue };
        let bytes = doc.get_page_content(page);
        walk(doc, &bytes, res, IDENTITY, &mut shown, 0, &mut HashSet::new());
    }
    shown
}

// ------------------------------------------------------------------ jobs

struct Job {
    id: ObjectId,
    size: usize,
    width: u32,
    height: u32,
    is_mask: bool,
    shown: Option<(f64, f64)>,
}

fn collect_jobs(doc: &Document) -> Vec<Job> {
    let shown = collect_shown(doc);
    let mut owner: HashMap<ObjectId, ObjectId> = HashMap::new();
    for (id, o) in &doc.objects {
        if let Object::Stream(s) = o {
            if s.dict.get(b"Subtype").ok().and_then(name_of) == Some(b"Image") {
                if let Ok(sm) = s.dict.get(b"SMask").and_then(|o| o.as_reference()) {
                    owner.insert(sm, *id);
                }
            }
        }
    }
    let mut jobs = Vec::new();
    for (id, o) in &doc.objects {
        let Object::Stream(s) = o else { continue };
        let d = &s.dict;
        if d.get(b"Subtype").ok().and_then(name_of) != Some(b"Image") {
            continue;
        }
        if matches!(d.get(b"ImageMask").ok().map(|o| deref(doc, o)), Some(Object::Boolean(true))) {
            continue;
        }
        if matches!(d.get(b"Mask").ok().map(|o| deref(doc, o)), Some(Object::Array(_))) {
            continue;
        }
        let w = dict_num(doc, d, b"Width").unwrap_or(0.0) as u32;
        let h = dict_num(doc, d, b"Height").unwrap_or(0.0) as u32;
        if w < 32 || h < 32 || s.content.len() < 8_000 {
            continue;
        }
        let own = owner.get(id).copied();
        jobs.push(Job { id: *id, size: s.content.len(), width: w, height: h, is_mask: own.is_some(), shown: shown.get(&own.unwrap_or(*id)).copied() });
    }
    jobs.sort_by(|a, b| b.size.cmp(&a.size));
    jobs
}

// ------------------------------------------------------------------ decoding

struct Decoded {
    w: usize,
    h: usize,
    channels: usize, // 1 gray, 3 rgb
    px: Vec<u8>,
}

fn filters(doc: &Document, d: &Dictionary) -> Vec<Vec<u8>> {
    match d.get(b"Filter").ok().map(|o| deref(doc, o)) {
        Some(Object::Name(n)) => vec![n.clone()],
        Some(Object::Array(a)) => a.iter().filter_map(|o| name_of(deref(doc, o)).map(|n| n.to_vec())).collect(),
        _ => vec![],
    }
}

fn is_name(f: &[u8], full: &[u8], abbr: &[u8]) -> bool {
    f == full || f == abbr
}

fn parms<'a>(doc: &'a Document, d: &'a Dictionary) -> Option<&'a Dictionary> {
    match d.get(b"DecodeParms").or_else(|_| d.get(b"DP")).ok().map(|o| deref(doc, o)) {
        Some(Object::Dictionary(p)) => Some(p),
        Some(Object::Array(a)) => a.first().map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()),
        _ => None,
    }
}

fn decode_default(doc: &Document, d: &Dictionary) -> bool {
    match d.get(b"Decode").ok().map(|o| deref(doc, o)) {
        None => true,
        Some(Object::Array(a)) => {
            let v: Vec<f64> = a.iter().filter_map(num_of).collect();
            v.chunks(2).all(|c| c.len() == 2 && c[0] == 0.0 && c[1] == 1.0)
        }
        _ => false,
    }
}

enum Cs {
    Gray,
    Rgb,
    Indexed { base_gray: bool, hival: usize, table: Vec<u8> },
}

fn color_space(doc: &Document, o: &Object, depth: u32) -> Option<Cs> {
    let o = deref(doc, o);
    if depth > 3 {
        return None;
    }
    match o {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"G" | b"CalGray" => Some(Cs::Gray),
            b"DeviceRGB" | b"RGB" | b"CalRGB" => Some(Cs::Rgb),
            _ => None,
        },
        Object::Array(a) => {
            let kind = a.first().and_then(|o| name_of(deref(doc, o)))?;
            match kind {
                b"CalGray" => Some(Cs::Gray),
                b"CalRGB" => Some(Cs::Rgb),
                b"ICCBased" => {
                    let s = deref(doc, a.get(1)?);
                    let Object::Stream(s) = s else { return None };
                    match dict_num(doc, &s.dict, b"N")? as u32 {
                        1 => Some(Cs::Gray),
                        3 => Some(Cs::Rgb),
                        _ => None,
                    }
                }
                b"Indexed" | b"I" => {
                    let base = color_space(doc, a.get(1)?, depth + 1)?;
                    let hival = num_of(deref(doc, a.get(2)?))? as usize;
                    let table = match deref(doc, a.get(3)?) {
                        Object::String(b, _) => b.clone(),
                        Object::Stream(s) => s.decompressed_content().ok()?,
                        _ => return None,
                    };
                    match base {
                        Cs::Gray => Some(Cs::Indexed { base_gray: true, hival, table }),
                        Cs::Rgb => Some(Cs::Indexed { base_gray: false, hival, table }),
                        _ => None,
                    }
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len() * 4);
    let mut dec = flate2::read::ZlibDecoder::new(data);
    match dec.read_to_end(&mut out) {
        Ok(_) => Some(out),
        // Truncated streams still hold usable rows, but a partial image is not worth the risk.
        Err(_) => None,
    }
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (ia, ib, ic) = (a as i32, b as i32, c as i32);
    let p = ia + ib - ic;
    let (pa, pb, pc) = ((p - ia).abs(), (p - ib).abs(), (p - ic).abs());
    if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c }
}

/// Undoes PNG (10-15) and TIFF (2, 8-bit only) predictors.
fn unpredict(data: Vec<u8>, predictor: i64, colors: usize, bpc: usize, columns: usize) -> Option<Vec<u8>> {
    if predictor <= 1 {
        return Some(data);
    }
    let bpp = ((colors * bpc) + 7) / 8;
    let row = (colors * bpc * columns + 7) / 8;
    if predictor == 2 {
        if bpc != 8 {
            return None;
        }
        let mut d = data;
        for r in d.chunks_mut(row) {
            for i in colors..r.len() {
                r[i] = r[i].wrapping_add(r[i - colors]);
            }
        }
        return Some(d);
    }
    if predictor < 10 {
        return None;
    }
    let stride = row + 1;
    let rows = data.len() / stride;
    let mut out = vec![0u8; rows * row];
    for y in 0..rows {
        let ft = data[y * stride];
        let src = &data[y * stride + 1..y * stride + 1 + row];
        let (prev, cur) = out.split_at_mut(y * row);
        let prev = if y > 0 { &prev[(y - 1) * row..] } else { &[][..] };
        let cur = &mut cur[..row];
        for i in 0..row {
            let a = if i >= bpp { cur[i - bpp] } else { 0 };
            let b = if y > 0 { prev[i] } else { 0 };
            let c = if y > 0 && i >= bpp { prev[i - bpp] } else { 0 };
            cur[i] = src[i].wrapping_add(match ft {
                0 => 0,
                1 => a,
                2 => b,
                3 => ((a as u16 + b as u16) / 2) as u8,
                4 => paeth(a, b, c),
                _ => return None,
            });
        }
    }
    Some(out)
}

fn decode_image(doc: &Document, s: &Stream) -> Option<Decoded> {
    let d = &s.dict;
    let w = dict_num(doc, d, b"Width")? as usize;
    let h = dict_num(doc, d, b"Height")? as usize;
    if w.checked_mul(h)?.checked_mul(4)? > MAX_DECODED_BYTES * 3 {
        return None;
    }
    let f = filters(doc, d);
    if f.len() == 1 && is_name(&f[0], b"DCTDecode", b"DCT") {
        if !decode_default(doc, d) {
            return None;
        }
        let mut dec = jpeg_decoder::Decoder::new(&s.content[..]);
        let px = dec.decode().ok()?;
        let info = dec.info()?;
        let channels = match info.pixel_format {
            jpeg_decoder::PixelFormat::L8 => 1,
            jpeg_decoder::PixelFormat::RGB24 => 3,
            _ => return None,
        };
        if info.width as usize != w || info.height as usize != h {
            return Some(Decoded { w: info.width as usize, h: info.height as usize, channels, px });
        }
        return Some(Decoded { w, h, channels, px });
    }
    if f.len() > 1 || (f.len() == 1 && !is_name(&f[0], b"FlateDecode", b"Fl")) {
        return None;
    }
    let bpc = dict_num(doc, d, b"BitsPerComponent")? as usize;
    if !decode_default(doc, d) {
        return None;
    }
    let cs = color_space(doc, d.get(b"ColorSpace").ok().or_else(|| d.get(b"CS").ok())?, 0)?;
    let raw = if f.is_empty() { s.content.clone() } else { inflate(&s.content)? };
    let (colors, eff_bpc) = match cs {
        Cs::Gray => (1, bpc),
        Cs::Rgb => (3, bpc),
        Cs::Indexed { .. } => (1, bpc),
    };
    let data = match parms(doc, d) {
        Some(p) if !f.is_empty() => {
            let pred = dict_num(doc, p, b"Predictor").unwrap_or(1.0) as i64;
            let cols = dict_num(doc, p, b"Columns").unwrap_or(1.0) as usize;
            let pc = dict_num(doc, p, b"Colors").unwrap_or(1.0) as usize;
            let pb = dict_num(doc, p, b"BitsPerComponent").unwrap_or(8.0) as usize;
            unpredict(raw, pred, pc, pb, cols)?
        }
        _ => raw,
    };
    let row_bytes = (colors * eff_bpc * w + 7) / 8;
    if data.len() < row_bytes * h {
        return None;
    }
    // Unpack each row to one byte per component.
    let mut comp = Vec::with_capacity(w * h * colors);
    for y in 0..h {
        let row = &data[y * row_bytes..(y + 1) * row_bytes];
        match eff_bpc {
            8 => comp.extend_from_slice(&row[..w * colors]),
            16 => comp.extend((0..w * colors).map(|i| row[i * 2])),
            1 | 2 | 4 => {
                let per = 8 / eff_bpc;
                let mask = (1u16 << eff_bpc) - 1;
                for i in 0..w * colors {
                    let byte = row[i / per];
                    let shift = 8 - eff_bpc * (i % per + 1);
                    comp.push(((byte as u16 >> shift) & mask) as u8);
                }
            }
            _ => return None,
        }
    }
    match cs {
        Cs::Gray | Cs::Rgb => {
            if eff_bpc < 8 {
                let max = (1u16 << eff_bpc) - 1;
                for v in comp.iter_mut() {
                    *v = ((*v as u16 * 255) / max) as u8;
                }
            }
            Some(Decoded { w, h, channels: colors, px: comp })
        }
        Cs::Indexed { base_gray, hival, table } => {
            let n = if base_gray { 1 } else { 3 };
            let mut px = Vec::with_capacity(w * h * n);
            for &i in &comp {
                let i = (i as usize).min(hival);
                for k in 0..n {
                    px.push(*table.get(i * n + k).unwrap_or(&0));
                }
            }
            Some(Decoded { w, h, channels: n, px })
        }
    }
}

// ------------------------------------------------------------------ analysis

fn is_graphic(img: &Decoded) -> bool {
    let (w, h, c) = (img.w, img.h, img.channels);
    let row_step = (h / 400).max(1);
    let (mut pairs, mut flat, mut edges) = (0u64, 0u64, 0u64);
    for y in (0..h).step_by(row_step) {
        let base = y * w * c;
        for x in 1..w {
            let o = base + x * c;
            let d: i32 = if c == 3 {
                (0..3).map(|k| (img.px[o + k] as i32 - img.px[o + k - 3] as i32).abs()).sum()
            } else {
                3 * (img.px[o] as i32 - img.px[o - 1] as i32).abs()
            };
            pairs += 1;
            if d <= 8 {
                flat += 1;
            } else if d >= 150 {
                edges += 1;
            }
        }
    }
    pairs > 0 && flat as f64 / pairs as f64 >= 0.6 && edges as f64 / pairs as f64 >= 0.003
}

/// Distinct colours, counting stops past 1024.
fn many_colors(img: &Decoded) -> bool {
    let mut set: HashSet<u32> = HashSet::new();
    let c = img.channels;
    for p in img.px.chunks_exact(c) {
        let v = if c == 3 { (p[0] as u32) << 16 | (p[1] as u32) << 8 | p[2] as u32 } else { p[0] as u32 };
        set.insert(v);
        if set.len() > 1024 {
            return true;
        }
    }
    false
}

fn is_grayish(img: &Decoded) -> bool {
    img.channels == 1 || img.px.chunks_exact(3).step_by(97).all(|p| p[0] == p[1] && p[0] == p[2])
}

fn target_dims(job: &Job, s: Setting, graphic: bool) -> (usize, usize) {
    let dpi = if graphic { s.dpi.max((s.dpi * GRAPHIC_DPI_BOOST).min(GRAPHIC_DPI_CAP)) } else { s.dpi };
    let (w, h) = (job.width as f64, job.height as f64);
    let scale = match job.shown {
        Some((sw, sh)) if sw > 1.0 && sh > 1.0 => ((sw / 72.0 * dpi) / w).max((sh / 72.0 * dpi) / h),
        _ => (11.7 * dpi) / w.max(h),
    }
    .min(1.0);
    (((w * scale).round() as usize).max(16), ((h * scale).round() as usize).max(16))
}

// ------------------------------------------------------------------ encoding

struct Encoded {
    bytes: Vec<u8>,
    w: usize,
    h: usize,
    jpeg: bool,
    gray: bool,
    predictor: bool,
}

fn resample(img: &Decoded, w: usize, h: usize) -> Option<Vec<u8>> {
    use fast_image_resize as fir;
    if w == img.w && h == img.h {
        return Some(img.px.clone());
    }
    let pt = if img.channels == 3 { fir::PixelType::U8x3 } else { fir::PixelType::U8 };
    let src = fir::images::ImageRef::new(img.w as u32, img.h as u32, &img.px, pt).ok()?;
    let mut dst = fir::images::Image::new(w as u32, h as u32, pt);
    let opts = fir::ResizeOptions::new().resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::CatmullRom));
    fir::Resizer::new().resize(&src, &mut dst, &opts).ok()?;
    Some(dst.into_vec())
}

/// Flate with PNG predictors chosen per row (the usual "smallest sum of absolute values"
/// rule): flat artwork shrinks far more than with plain Flate. Falls back to no predictor
/// when that happens to be smaller. Returns (bytes, predictor used?).
pub(crate) fn flate_encode(px: &[u8], w: usize, h: usize, channels: usize) -> (Vec<u8>, bool) {
    let row = w * channels;
    let bpp = channels;
    let mut filtered = Vec::with_capacity((row + 1) * h);
    let mut cand: [Vec<u8>; 5] = std::array::from_fn(|_| vec![0u8; row]);
    for y in 0..h {
        let cur = &px[y * row..(y + 1) * row];
        let prev = if y > 0 { &px[(y - 1) * row..y * row] } else { &[][..] };
        for i in 0..row {
            let a = if i >= bpp { cur[i - bpp] } else { 0 };
            let b = if y > 0 { prev[i] } else { 0 };
            let c = if y > 0 && i >= bpp { prev[i - bpp] } else { 0 };
            cand[0][i] = cur[i];
            cand[1][i] = cur[i].wrapping_sub(a);
            cand[2][i] = cur[i].wrapping_sub(b);
            cand[3][i] = cur[i].wrapping_sub(((a as u16 + b as u16) / 2) as u8);
            cand[4][i] = cur[i].wrapping_sub(paeth(a, b, c));
        }
        let best = (0..5)
            .min_by_key(|&k| cand[k].iter().map(|&v| (v as i8).unsigned_abs() as u64).sum::<u64>())
            .unwrap_or(0);
        filtered.push(best as u8);
        filtered.extend_from_slice(&cand[best]);
    }
    let deflate = |data: &[u8]| {
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        let _ = enc.write_all(data);
        enc.finish().unwrap_or_default()
    };
    let with = deflate(&filtered);
    let without = deflate(px);
    if without.len() < with.len() { (without, false) } else { (with, true) }
}

fn jpeg_encode(px: &[u8], w: usize, h: usize, channels: usize, quality: f64, subsample: bool) -> Option<Vec<u8>> {
    use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
    if w > 65535 || h > 65535 {
        return None;
    }
    let mut out = Vec::new();
    let mut enc = Encoder::new(&mut out, ((quality * 100.0).round() as u8).clamp(1, 100));
    enc.set_optimized_huffman_tables(true);
    enc.set_sampling_factor(if subsample && channels == 3 { SamplingFactor::F_2_2 } else { SamplingFactor::F_1_1 });
    enc.encode(px, w as u16, h as u16, if channels == 3 { ColorType::Rgb } else { ColorType::Luma }).ok()?;
    Some(out)
}

fn encode(job: &Job, img: &Decoded, lossy_source: bool, has_filter: bool, s: Setting) -> Option<Encoded> {
    let full_page = job.shown.map_or(false, |(w, h)| w >= 500.0 && h >= 650.0);
    let graphic = !job.is_mask && !full_page && is_graphic(img);
    let (w, h) = target_dims(job, s, graphic);
    let (w, h) = (w.min(img.w), h.min(img.h));
    let downsample = w < img.w || h < img.h;
    let lossy_ok = !job.is_mask && (lossy_source || many_colors(img));
    if !lossy_ok && !downsample && has_filter {
        return None; // lossless and same size: nothing to gain
    }
    let px = resample(img, w, h)?;
    let gray_out = job.is_mask || img.channels == 1 || is_grayish(img);
    // Components actually stored: gray if the picture is gray, else RGB.
    let (store, ch): (Vec<u8>, usize) = if gray_out && img.channels == 3 {
        (px.chunks_exact(3).map(|p| p[0]).collect(), 1)
    } else {
        (px, img.channels)
    };
    if lossy_ok {
        let quality = if graphic { (s.quality + GRAPHIC_QUALITY_BOOST).min(GRAPHIC_MAX_QUALITY) } else { s.quality };
        let jpeg = jpeg_encode(&store, w, h, ch, quality, !graphic && quality < 0.9)?;
        if graphic && w * h <= 12_000_000 {
            let (lossless, predictor) = flate_encode(&store, w, h, ch);
            if lossless.len() < jpeg.len() {
                return Some(Encoded { bytes: lossless, w, h, jpeg: false, gray: ch == 1, predictor });
            }
        }
        return Some(Encoded { bytes: jpeg, w, h, jpeg: true, gray: ch == 1, predictor: false });
    }
    let (bytes, predictor) = flate_encode(&store, w, h, ch);
    Some(Encoded { bytes, w, h, jpeg: false, gray: ch == 1, predictor })
}

fn encode_all(doc: &Document, jobs: &[Job], s: Setting, skipped: &Mutex<HashSet<ObjectId>>, big: &Mutex<HashSet<ObjectId>>, progress: &Mutex<Progress>) -> HashMap<ObjectId, Encoded> {
    let out = Mutex::new(HashMap::new());
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 4);
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(job) = jobs.get(i) else { break };
                if let Ok(mut p) = progress.lock() {
                    (*p)(20 + (i * 65 / jobs.len().max(1)) as u32, &format!("Recompressing image {} of {}...", i + 1, jobs.len()));
                }
                if job.width as usize * job.height as usize * 4 > MAX_DECODED_BYTES {
                    big.lock().unwrap().insert(job.id);
                    continue;
                }
                let Ok(Object::Stream(st)) = doc.get_object(job.id) else { continue };
                let Some(img) = decode_image(doc, st) else {
                    skipped.lock().unwrap().insert(job.id);
                    continue;
                };
                let f = filters(doc, &st.dict);
                let lossy = f.iter().any(|n| is_name(n, b"DCTDecode", b"DCT"));
                if let Some(enc) = encode(job, &img, lossy, !f.is_empty(), s) {
                    if (enc.bytes.len() as f64) < job.size as f64 * 0.97 {
                        out.lock().unwrap().insert(job.id, enc);
                    }
                }
            });
        }
    });
    out.into_inner().unwrap()
}

fn apply(doc: &mut Document, id: ObjectId, enc: Encoded) {
    let keep_cs = doc.get_object(id).ok().and_then(|o| o.as_stream().ok()).and_then(|s| {
        // An ICC profile with the same component count stays attached (no colour shift).
        let cs = s.dict.get(b"ColorSpace").ok()?.clone();
        let o = deref(doc, &cs);
        let arr = o.as_array().ok()?;
        if name_of(deref(doc, arr.first()?))? != b"ICCBased" {
            return None;
        }
        let Object::Stream(p) = deref(doc, arr.get(1)?) else { return None };
        let n = dict_num(doc, &p.dict, b"N")? as usize;
        if n == if enc.gray { 1 } else { 3 } { Some(cs) } else { None }
    });
    let Some(Object::Stream(st)) = doc.objects.get_mut(&id) else { return };
    let d = &mut st.dict;
    d.set("Width", enc.w as i64);
    d.set("Height", enc.h as i64);
    d.set("BitsPerComponent", 8i64);
    d.set("Filter", Object::Name(if enc.jpeg { b"DCTDecode".to_vec() } else { b"FlateDecode".to_vec() }));
    d.set("ColorSpace", keep_cs.unwrap_or_else(|| Object::Name(if enc.gray { b"DeviceGray".to_vec() } else { b"DeviceRGB".to_vec() })));
    for k in ["DecodeParms", "DP", "Decode", "Length", "DL", "Intent"] {
        d.remove(k.as_bytes());
    }
    if !enc.jpeg && enc.predictor {
        let mut p = Dictionary::new();
        p.set("Predictor", 15i64);
        p.set("Colors", if enc.gray { 1i64 } else { 3 });
        p.set("BitsPerComponent", 8i64);
        p.set("Columns", enc.w as i64);
        d.set("DecodeParms", Object::Dictionary(p));
    }
    d.set("Length", enc.bytes.len() as i64);
    st.content = enc.bytes;
    st.allows_compression = false;
}

// ------------------------------------------------------------------ structure

fn remap(o: &mut Object, map: &HashMap<ObjectId, ObjectId>) {
    match o {
        Object::Reference(id) => {
            if let Some(n) = map.get(id) {
                *id = *n;
            }
        }
        Object::Array(a) => a.iter_mut().for_each(|x| remap(x, map)),
        Object::Dictionary(d) => d.iter_mut().for_each(|(_, v)| remap(v, map)),
        Object::Stream(s) => s.dict.iter_mut().for_each(|(_, v)| remap(v, map)),
        _ => {}
    }
}

fn dedupe(doc: &mut Document) -> usize {
    let mut groups: HashMap<(u64, usize), Vec<ObjectId>> = HashMap::new();
    for (id, o) in &doc.objects {
        if let Object::Stream(s) = o {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            s.content.hash(&mut h);
            groups.entry((h.finish(), s.content.len())).or_default().push(*id);
        }
    }
    let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
    for ids in groups.values().filter(|g| g.len() > 1) {
        let mut keep: Vec<ObjectId> = Vec::new();
        for id in ids {
            let (Some(Object::Stream(a)), ) = (doc.objects.get(id), ) else { continue };
            let dup = keep.iter().find(|k| {
                matches!(doc.objects.get(*k), Some(Object::Stream(b)) if b.content == a.content && same_dict(&a.dict, &b.dict))
            });
            match dup {
                Some(k) => {
                    map.insert(*id, *k);
                }
                None => keep.push(*id),
            }
        }
    }
    if map.is_empty() {
        return 0;
    }
    for o in doc.objects.values_mut() {
        remap(o, &map);
    }
    for (_, v) in doc.trailer.iter_mut() {
        remap(v, &map);
    }
    for id in map.keys() {
        doc.objects.remove(id);
    }
    map.len()
}

fn same_dict(a: &Dictionary, b: &Dictionary) -> bool {
    let strip = |d: &Dictionary| {
        let mut d = d.clone();
        d.remove(b"Length");
        d
    };
    strip(a) == strip(b)
}

fn cleanup(doc: &mut Document, level: Level) -> (usize, usize) {
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for p in pages {
        if let Ok(d) = doc.get_dictionary_mut(p) {
            d.remove(b"Thumb");
            d.remove(b"PieceInfo");
        }
    }
    if let Ok(root) = doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
        if let Ok(cat) = doc.get_dictionary_mut(root) {
            cat.remove(b"PieceInfo");
            if matches!(level, Level::Extreme) {
                cat.remove(b"Metadata");
            }
        }
    }
    let deduped = dedupe(doc);
    let removed = doc.prune_objects().len();
    (deduped, removed)
}

fn saved_size(doc: &mut Document) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    doc.save_modern(&mut out)?;
    Ok(out)
}

fn fmt(n: u64) -> String {
    if n >= 1024 * 1024 { format!("{:.2} MB", n as f64 / 1048576.0) } else { format!("{} KB", (n as f64 / 1024.0).round()) }
}

// ------------------------------------------------------------------ main

pub fn compress(input: &Path, output: &Path, level: Level, progress: Progress) -> Result<Report> {
    let original = std::fs::metadata(input)?.len();
    let mut report = Report { original, ..Default::default() };
    if let Level::Custom(target) = level {
        if target == 0 {
            return Err(Error::Msg("Choose a target size.".into()));
        }
        if target >= original {
            std::fs::copy(input, output)?;
            report.output = original;
            report.unchanged = true;
            report.note = format!("The file is already {} — under the {} target, so it's unchanged.", fmt(original), fmt(target));
            return Ok(report);
        }
    }
    progress(5, "Reading document...");
    let mut doc = Document::load(input)?;
    if doc.is_encrypted() {
        return Err(Error::Encrypted);
    }
    report.pages = doc.get_pages().len();
    progress(12, "Removing duplicates and unused objects...");
    let (deduped, removed) = cleanup(&mut doc, level);
    report.deduped = deduped;
    report.removed = removed;
    progress(18, "Measuring images...");
    let jobs = collect_jobs(&doc);
    report.images_total = jobs.len();
    let image_total: usize = jobs.iter().map(|j| j.size).sum();
    let skipped = Mutex::new(HashSet::new());
    let big = Mutex::new(HashSet::new());
    let prog = Mutex::new(progress);

    let mut note = String::new();
    let chosen: HashMap<ObjectId, Encoded>;
    match level {
        Level::Custom(target) => {
            let lad = ladder();
            // The non-image weight, measured once (images count for what they are now).
            let mut probe = doc.clone();
            probe.compress();
            let other = (saved_size(&mut probe)?.len()).saturating_sub(image_total) as u64;
            drop(probe);
            let estimate = |m: &HashMap<ObjectId, Encoded>| {
                other + jobs.iter().map(|j| m.get(&j.id).map_or(j.size, |e| e.bytes.len()) as u64).sum::<u64>()
            };
            let (mut lo, mut hi) = (0i64, lad.len() as i64 - 1);
            let mut best: i64 = -1;
            let mut best_map: Option<HashMap<ObjectId, Encoded>> = None;
            if other < target {
                while lo <= hi {
                    let mid = (lo + hi) / 2;
                    let m = encode_all(&doc, &jobs, lad[mid as usize], &skipped, &big, &prog);
                    if estimate(&m) <= target {
                        best = mid;
                        best_map = Some(m);
                        hi = mid - 1;
                    } else {
                        lo = mid + 1;
                    }
                }
            }
            if best == -1 {
                best = lad.len() as i64 - 1;
            }
            let mut m = match best_map {
                Some(m) => m,
                None => encode_all(&doc, &jobs, lad[best as usize], &skipped, &big, &prog),
            };
            loop {
                let mut trial = doc.clone();
                for (id, enc) in m.drain() {
                    apply(&mut trial, id, enc);
                }
                trial.compress();
                let bytes = saved_size(&mut trial)?;
                let size = bytes.len() as u64;
                let s = lad[best as usize];
                if size <= target || best as usize >= lad.len() - 1 {
                    note = if size <= target {
                        format!(
                            "Target {} reached with images at {} dpi, {}% quality.{}",
                            fmt(target), s.dpi, (s.quality * 100.0).round(),
                            if s.dpi < 100.0 { " At this size small text inside pictures may be hard to read." } else { "" }
                        )
                    } else {
                        format!("Couldn't get down to {} — this is as small as it goes without destroying legibility ({}). Text, fonts and vector graphics can't be shrunk further.", fmt(target), fmt(size))
                    };
                    report.images_recompressed = jobs.len() - skipped.lock().unwrap().len() - big.lock().unwrap().len(); // approximate: all decodable images were tried
                    return finish(report, original, bytes, input, output, note, &skipped, &big);
                }
                best += 1;
                m = encode_all(&doc, &jobs, lad[best as usize], &skipped, &big, &prog);
            }
        }
        _ => {
            chosen = encode_all(&doc, &jobs, preset(level), &skipped, &big, &prog);
        }
    }
    report.images_recompressed = chosen.len();
    for (id, enc) in chosen {
        apply(&mut doc, id, enc);
    }
    doc.compress();
    (*prog.lock().unwrap())(92, "Writing optimized file...");
    let bytes = saved_size(&mut doc)?;
    finish(report, original, bytes, input, output, note, &skipped, &big)
}

#[allow(clippy::too_many_arguments)]
fn finish(mut r: Report, original: u64, bytes: Vec<u8>, input: &Path, output: &Path, note: String, skipped: &Mutex<HashSet<ObjectId>>, big: &Mutex<HashSet<ObjectId>>) -> Result<Report> {
    r.skipped = skipped.lock().unwrap().len();
    r.too_big = big.lock().unwrap().len();
    if bytes.len() as u64 >= original {
        std::fs::copy(input, output)?;
        r.output = original;
        r.unchanged = true;
        r.note = "Nothing in this file could be made smaller — it has no oversized images and no duplicate data. The original is returned unchanged.".into();
        return Ok(r);
    }
    std::fs::write(output, &bytes)?;
    r.output = bytes.len() as u64;
    let plural = |n: usize, w: &str| format!("{n} {w}{}", if n == 1 { "" } else { "s" });
    let parts: Vec<String> = [
        if r.images_recompressed > 0 { format!("{} of {} recompressed", r.images_recompressed, plural(r.images_total, "image")) } else if r.images_total > 0 { "images already optimal".into() } else { String::new() },
        if r.deduped > 0 { format!("{} merged", plural(r.deduped, "duplicate")) } else { String::new() },
        if r.removed > 0 { format!("{} dropped", plural(r.removed, "unused object")) } else { String::new() },
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();
    r.note = [note, parts.join(" · ")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    Ok(r)
}
