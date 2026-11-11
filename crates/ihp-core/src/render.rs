//! Page rendering with PDFium (pdfium.dll next to the app): PDF to JPG/PNG, one image or a .zip.

use crate::compress::{Error, Result};
use pdfium_render::prelude::*;
use std::io::Write;
use std::path::Path;

/// Pages bigger than this many pixels are scaled down (memory safety, like the page-side cap).
const MAX_PIXELS: f64 = 150_000_000.0;

fn msg<E: std::fmt::Display>(e: E) -> Error {
    Error::Msg(e.to_string())
}

pub fn bind(dll: &Path) -> Result<Pdfium> {
    let b = Pdfium::bind_to_library(dll).map_err(msg)?;
    Ok(Pdfium::new(b))
}

fn encode_jpeg(rgb: &[u8], w: usize, h: usize, quality: f64) -> Result<Vec<u8>> {
    use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
    if w > 65535 || h > 65535 {
        return Err(Error::Msg("Page is too large for a JPEG.".into()));
    }
    let mut out = Vec::new();
    let mut enc = Encoder::new(&mut out, ((quality * 100.0).round() as u8).clamp(1, 100));
    enc.set_optimized_huffman_tables(true);
    enc.set_sampling_factor(if quality < 0.8 { SamplingFactor::F_2_2 } else { SamplingFactor::F_1_1 });
    enc.encode(rgb, w as u16, h as u16, ColorType::Rgb).map_err(msg)?;
    Ok(out)
}

fn encode_png(rgba: &[u8], w: usize, h: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut wr = enc.write_header().map_err(msg)?;
        wr.write_image_data(rgba).map_err(msg)?;
    }
    Ok(out)
}

/// Renders `pages` (1-based) of `input` at `dpi`. One page: the image itself; several: a .zip
/// (`{base}_page_{n}.{ext}`). Returns the number of pages rendered.
pub fn render_pages(dll: &Path, input: &Path, pages: &[usize], dpi: f64, png: bool, quality: f64, base: &str, out: &Path, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    let pdfium = shared(dll)?;
    let doc = pdfium.load_pdf_from_file(input, None).map_err(msg)?;
    let count = doc.pages().len() as usize;
    let todo: Vec<usize> = pages.iter().copied().filter(|&p| p >= 1 && p <= count).collect();
    if todo.is_empty() {
        return Err(Error::Msg("No rendered pages to export.".into()));
    }
    let ext = if png { "png" } else { "jpg" };
    let pad = todo.iter().max().unwrap().to_string().len();
    let mut zip = (todo.len() > 1).then(|| zip::ZipWriter::new(std::io::BufWriter::new(std::fs::File::create(out).unwrap())));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (k, &n) in todo.iter().enumerate() {
        progress((k * 90 / todo.len()) as u32, &format!("Rendering page {n}..."));
        let page = doc.pages().get((n - 1) as i32).map_err(msg)?;
        let (pw, ph) = (page.width().value as f64, page.height().value as f64);
        let mut scale = dpi / 72.0;
        if pw * ph * scale * scale > MAX_PIXELS {
            scale = (MAX_PIXELS / (pw * ph)).sqrt();
        }
        let clear = if png { PdfColor::new(0, 0, 0, 0) } else { PdfColor::WHITE };
        let cfg = PdfRenderConfig::new().scale_page_by_factor(scale as f32).set_clear_color(clear).render_form_data(true);
        let bitmap = page.render_with_config(&cfg).map_err(msg)?;
        let (w, h) = (bitmap.width() as usize, bitmap.height() as usize);
        let raw = bitmap.as_raw_bytes(); // BGRA
        let bytes = if png {
            let mut rgba = Vec::with_capacity(w * h * 4);
            for p in raw.chunks_exact(4) {
                rgba.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
            }
            encode_png(&rgba, w, h)?
        } else {
            let mut rgb = Vec::with_capacity(w * h * 3);
            for p in raw.chunks_exact(4) {
                rgb.extend_from_slice(&[p[2], p[1], p[0]]);
            }
            encode_jpeg(&rgb, w, h, quality)?
        };
        match zip.as_mut() {
            Some(z) => {
                z.start_file(format!("{base}_page_{n:0pad$}.{ext}", pad = pad), opts).map_err(msg)?;
                z.write_all(&bytes)?;
            }
            None => std::fs::write(out, &bytes)?,
        }
    }
    if let Some(z) = zip {
        z.finish().map_err(msg)?;
    }
    Ok(todo.len())
}

fn shared(dll: &Path) -> Result<&'static Pdfium> {
    use std::sync::OnceLock;
    static P: OnceLock<std::result::Result<Pdfium, String>> = OnceLock::new();
    P.get_or_init(|| bind(dll).map_err(|e| e.to_string())).as_ref().map_err(|e| Error::Msg(e.clone()))
}

use std::path::PathBuf;
use std::sync::Mutex;

/// A few recently used documents stay open, so a big file isn't parsed again for every thumbnail.
struct Open(Vec<(PathBuf, PdfDocument<'static>)>);
// PDFium calls are serialised by pdfium-render's `thread_safe` feature.
unsafe impl Send for Open {}
static OPEN: Mutex<Open> = Mutex::new(Open(Vec::new()));
const KEEP_OPEN: usize = 3;

/// Runs `f` on the (cached) open document for `path`.
fn with_doc<R>(dll: &Path, path: &Path, f: impl FnOnce(&PdfDocument<'static>) -> Result<R>) -> Result<R> {
    let pdfium = shared(dll)?;
    let mut cache = OPEN.lock().unwrap();
    let pos = match cache.0.iter().position(|(p, _)| p == path) {
        Some(i) => i,
        None => {
            let doc = pdfium.load_pdf_from_file(path, None).map_err(msg)?;
            if cache.0.len() >= KEEP_OPEN {
                cache.0.remove(0);
            }
            cache.0.push((path.to_path_buf(), doc));
            cache.0.len() - 1
        }
    };
    f(&cache.0[pos].1)
}

/// Closes a cached document (call before deleting the file: Windows won't delete an open one).
pub fn forget(path: &Path) {
    if let Ok(mut c) = OPEN.lock() {
        c.0.retain(|(p, _)| p != path);
    }
}

/// (page count, [w, h, rotation] for pages `start..start+count`): displayed size in points, after /Rotate.
pub fn page_infos(dll: &Path, input: &Path, start: usize, count: usize) -> Result<(usize, Vec<[f32; 3]>)> {
    with_doc(dll, input, |doc| {
        let total = doc.pages().len() as usize;
        let mut out = Vec::new();
        for i in start..(start + count).min(total) {
            let page = doc.pages().get(i as i32).map_err(msg)?;
            let rot = match page.rotation().map_err(msg)? {
                PdfPageRenderRotation::None => 0.0,
                PdfPageRenderRotation::Degrees90 => 90.0,
                PdfPageRenderRotation::Degrees180 => 180.0,
                PdfPageRenderRotation::Degrees270 => 270.0,
            };
            out.push([page.width().value, page.height().value, rot]);
        }
        Ok((total, out))
    })
}

/// One page as a JPEG `width_px` wide (white background).
pub fn thumbnail(dll: &Path, input: &Path, index: usize, width_px: u32, quality: f64) -> Result<Vec<u8>> {
    with_doc(dll, input, |doc| {
        let page = doc.pages().get(index as i32).map_err(msg)?;
        let cfg = PdfRenderConfig::new().set_target_width(width_px as i32).set_clear_color(PdfColor::WHITE);
        let bitmap = page.render_with_config(&cfg).map_err(msg)?;
        let (w, h) = (bitmap.width() as usize, bitmap.height() as usize);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for p in bitmap.as_raw_bytes().chunks_exact(4) {
            rgb.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        encode_jpeg(&rgb, w, h, quality)
    })
}

/// One page rendered at `scale` with black boxes burned into the pixels (viewer-space points,
/// origin top-left of the page as displayed): [x, y, w, h]. Returns (jpeg, width_px, height_px).
pub fn render_redacted(dll: &Path, input: &Path, index: usize, scale: f32, boxes: &[[f64; 4]], quality: f64) -> Result<(Vec<u8>, usize, usize)> {
    with_doc(dll, input, |doc| {
    let page = doc.pages().get(index as i32).map_err(msg)?;
    let cfg = PdfRenderConfig::new().scale_page_by_factor(scale).set_clear_color(PdfColor::WHITE).render_form_data(true);
    let bitmap = page.render_with_config(&cfg).map_err(msg)?;
    let (w, h) = (bitmap.width() as usize, bitmap.height() as usize);
    let mut rgb = Vec::with_capacity(w * h * 3);
    for p in bitmap.as_raw_bytes().chunks_exact(4) {
        rgb.extend_from_slice(&[p[2], p[1], p[0]]);
    }
    for b in boxes {
        let s = scale as f64;
        let x0 = ((b[0] * s).floor().max(0.0) as usize).min(w);
        let y0 = ((b[1] * s).floor().max(0.0) as usize).min(h);
        let x1 = (((b[0] + b[2]) * s).ceil().max(0.0) as usize).min(w);
        let y1 = (((b[1] + b[3]) * s).ceil().max(0.0) as usize).min(h);
        for y in y0..y1 {
            rgb[(y * w + x0) * 3..(y * w + x1) * 3].fill(0);
        }
    }
    Ok((encode_jpeg(&rgb, w, h, quality)?, w, h))
    })
}

pub enum Probe {
    /// The PDF opened: its page count.
    Pages(usize),
    /// Needs a password (or the given one was wrong).
    Password,
}

/// Page count and whether the file needs a password, without drawing anything.
pub fn probe(dll: &Path, input: &Path, password: Option<&str>) -> Result<Probe> {
    if password.is_none() {
        if let Ok(n) = with_doc(dll, input, |d| Ok(d.pages().len() as usize)) {
            return Ok(Probe::Pages(n));
        }
    }
    let pdfium = shared(dll)?;
    match pdfium.load_pdf_from_file(input, password) {
        Ok(doc) => Ok(Probe::Pages(doc.pages().len() as usize)),
        Err(PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)) => Ok(Probe::Password),
        Err(e) => Err(msg(e)),
    }
}

/// Repair: PDFium reads damaged files tolerantly (it rebuilds a broken xref and skips what it can't
/// read); saving the open document writes a fresh, consistent file with the original text and
/// graphics. Returns the page count of the repaired copy.
pub fn repair(dll: &Path, input: &Path, out: &Path) -> Result<usize> {
    let pdfium = shared(dll)?;
    let n = {
        let doc = pdfium.load_pdf_from_file(input, None).map_err(msg)?;
        let n = doc.pages().len() as usize;
        if n == 0 {
            return Err(Error::Msg("No readable pages were recovered from this file.".into()));
        }
        doc.save_to_file(out).map_err(msg)?;
        n
    };
    // The copy must read back with the same pages.
    let again = pdfium.load_pdf_from_file(out, None).map_err(msg)?;
    if again.pages().len() as usize != n {
        return Err(Error::Msg("The repaired copy lost pages.".into()));
    }
    Ok(n)
}

// ------------------------------------------------------------------ text runs (PDF to Word / Excel / Markdown)

pub struct RunOut {
    pub text: String,
    pub x: f32,
    /// Baseline, top-down (viewer space).
    pub y: f32,
    pub w: f32,
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub font: String,
    pub mono: bool,
    pub serif: bool,
}

pub struct PageRuns {
    pub width: f32,
    pub height: f32,
    pub runs: Vec<RunOut>,
    /// [x0, y0, x1, y1] in viewer space.
    pub images: Vec<[f32; 4]>,
}

fn strip_subset(name: &str) -> String {
    let b = name.as_bytes();
    if b.len() > 7 && b[6] == b'+' && b[..6].iter().all(|c| c.is_ascii_uppercase()) { name[7..].to_string() } else { name.to_string() }
}

/// Text runs and picture boxes of pages start..start+count, in viewer space (origin top-left).
/// Rotated pages return an error: the caller then uses the pdf.js route.
pub fn page_runs(dll: &Path, input: &Path, start: usize, count: usize) -> Result<Vec<PageRuns>> {
    with_doc(dll, input, |doc| {
        let total = doc.pages().len() as usize;
        let mut out = Vec::new();
        for i in start..(start + count).min(total) {
            let page = doc.pages().get(i as i32).map_err(msg)?;
            if !matches!(page.rotation().map_err(msg)?, PdfPageRenderRotation::None) {
                return Err(Error::Msg("rotated page".into()));
            }
            let (pw, ph) = (page.width().value, page.height().value);
            let mut runs: Vec<RunOut> = Vec::new();
            let text = page.text().map_err(msg)?;
            // Runs: neighbouring characters with the same font, size and baseline.
            let mut cur: Option<(RunOut, f32)> = None; // (run, right edge)
            for ch in text.chars().iter() {
                if ch.is_generated().unwrap_or(false) {
                    continue;
                }
                let Some(c) = ch.unicode_char() else { continue };
                if c == '\r' || c == '\n' || c == '\u{2}' {
                    if let Some((r, _)) = cur.take() { runs.push(r); }
                    continue;
                }
                let angle = ch.angle_degrees().unwrap_or(0.0).abs();
                if angle > 5.0 && (angle - 360.0).abs() > 5.0 {
                    if let Some((r, _)) = cur.take() { runs.push(r); }
                    continue;
                }
                let size = ch.scaled_font_size().value;
                let (ox, oy) = ch.origin().map(|(x, y)| (x.value, y.value)).unwrap_or((0.0, 0.0));
                let (left, right) = ch.loose_bounds().map(|b| (b.left().value, b.right().value)).unwrap_or((ox, ox + size * 0.5));
                let font = strip_subset(&ch.font_name());
                let lower = font.to_lowercase();
                let bold = ch.font_weight().map_or(false, |w| matches!(w, PdfFontWeight::Weight700Bold | PdfFontWeight::Weight800 | PdfFontWeight::Weight900) || matches!(w, PdfFontWeight::Custom(v) if v >= 700)) || ["bold", "black", "heavy", "semibold", "demi"].iter().any(|k| lower.contains(k));
                let italic = ch.font_is_italic() || lower.contains("italic") || lower.contains("oblique");
                let mono = ch.font_is_fixed_pitch() || ["mono", "courier", "consol", "code"].iter().any(|k| lower.contains(k));
                let serif = !mono && ((["times", "serif", "roman", "georgia", "garamond", "cambria", "minion", "book"].iter().any(|k| lower.contains(k)) && !lower.contains("sans")) || ch.font_is_serif());
                let y = ph - oy;
                let joins = cur.as_ref().map_or(false, |(r, edge)| r.font == font && (r.size - size).abs() < 0.1 && (r.y - y).abs() < size * 0.1 && (left - edge).abs() < size * 0.04 && r.bold == bold && r.italic == italic);
                if joins {
                    let (r, edge) = cur.as_mut().unwrap();
                    r.text.push(c);
                    r.w = right - r.x;
                    *edge = right;
                } else {
                    if let Some((r, _)) = cur.take() { runs.push(r); }
                    cur = Some((RunOut { text: c.to_string(), x: ox, y, w: right - ox, size, bold, italic, font, mono, serif }, right));
                }
            }
            if let Some((r, _)) = cur.take() { runs.push(r); }
            // Pictures: boxes of image objects (at least 24 pt each way, no near-duplicates).
            let mut images: Vec<[f32; 4]> = Vec::new();
            for obj in page.objects().iter() {
                if obj.as_image_object().is_none() {
                    continue;
                }
                let Ok(b) = obj.bounds() else { continue };
                let bx = [b.left().value.max(0.0), (ph - b.top().value).max(0.0), b.right().value.min(pw), (ph - b.bottom().value).min(ph)];
                if bx[2] - bx[0] < 24.0 || bx[3] - bx[1] < 24.0 {
                    continue;
                }
                if images.iter().any(|o| (o[0] - bx[0]).abs() < 1.0 && (o[1] - bx[1]).abs() < 1.0 && (o[2] - bx[2]).abs() < 1.0 && (o[3] - bx[3]).abs() < 1.0) {
                    continue;
                }
                images.push(bx);
            }
            out.push(PageRuns { width: pw, height: ph, runs, images });
        }
        Ok(out)
    })
}

/// Plain text of pages start..start+count (for Compare's word diff).
pub fn page_texts(dll: &Path, input: &Path, start: usize, count: usize) -> Result<Vec<String>> {
    with_doc(dll, input, |doc| {
        let total = doc.pages().len() as usize;
        let mut out = Vec::new();
        for i in start..(start + count).min(total) {
            let page = doc.pages().get(i as i32).map_err(msg)?;
            out.push(page.text().map_err(msg)?.all());
        }
        Ok(out)
    })
}
