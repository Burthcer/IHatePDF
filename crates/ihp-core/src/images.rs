//! Images to PDF: one page per image, fitted into the page size and margins (same rules as
//! `imagesToPdf.worker.ts`). JPEGs are embedded as they are (no re-encoding); PNGs are stored
//! losslessly as Flate with predictors, alpha as a soft mask.

use crate::compress::{flate_encode, Error, Result};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::io::Write;
use std::path::Path;

const A4: (f64, f64) = (595.28, 841.89);
const LETTER: (f64, f64) = (612.0, 792.0);

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PageSize {
    A4,
    Letter,
    Fit,
}
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

pub struct Options {
    pub page_size: PageSize,
    pub orientation: Orientation,
    pub margin_pt: f64,
}

pub(crate) struct Embedded {
    pub(crate) id: ObjectId,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

/// Embeds a PNG or JPEG as an image XObject.
pub(crate) fn embed_image(doc: &mut Document, bytes: &[u8], png: bool) -> Result<Embedded> {
    if png { embed_png(doc, bytes) } else { embed_jpeg(doc, bytes.to_vec()) }
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

fn image_dict(w: usize, h: usize, cs: &str, filter: &str) -> Dictionary {
    let mut d = Dictionary::new();
    d.set("Type", name("XObject"));
    d.set("Subtype", name("Image"));
    d.set("Width", w as i64);
    d.set("Height", h as i64);
    d.set("ColorSpace", name(cs));
    d.set("BitsPerComponent", 8i64);
    d.set("Filter", name(filter));
    d
}

fn flate_stream(dict: Dictionary, px: &[u8], w: usize, h: usize, ch: usize) -> Stream {
    let (bytes, predictor) = flate_encode(px, w, h, ch);
    let mut d = dict;
    if predictor {
        let mut p = Dictionary::new();
        p.set("Predictor", 15i64);
        p.set("Colors", ch as i64);
        p.set("BitsPerComponent", 8i64);
        p.set("Columns", w as i64);
        d.set("DecodeParms", Object::Dictionary(p));
    }
    d.set("Length", bytes.len() as i64);
    let mut s = Stream::new(d, bytes);
    s.allows_compression = false;
    s
}

fn embed_jpeg(doc: &mut Document, bytes: Vec<u8>) -> Result<Embedded> {
    let mut dec = jpeg_decoder::Decoder::new(&bytes[..]);
    dec.read_info().map_err(|e| Error::Msg(e.to_string()))?;
    let info = dec.info().ok_or_else(|| Error::Msg("Not a JPEG.".into()))?;
    let (cs, cmyk) = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 | jpeg_decoder::PixelFormat::L16 => ("DeviceGray", false),
        jpeg_decoder::PixelFormat::RGB24 => ("DeviceRGB", false),
        jpeg_decoder::PixelFormat::CMYK32 => ("DeviceCMYK", true),
    };
    let mut d = image_dict(info.width as usize, info.height as usize, cs, "DCTDecode");
    if cmyk {
        // Adobe CMYK JPEGs are stored inverted.
        d.set("Decode", Object::Array([1, 0, 1, 0, 1, 0, 1, 0].iter().map(|&v| Object::Integer(v)).collect()));
    }
    d.set("Length", bytes.len() as i64);
    let mut s = Stream::new(d, bytes);
    s.allows_compression = false;
    Ok(Embedded { id: doc.add_object(Object::Stream(s)), w: info.width as f64, h: info.height as f64 })
}

fn embed_png(doc: &mut Document, bytes: &[u8]) -> Result<Embedded> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| Error::Msg(e.to_string()))?;
    let mut buf = vec![0u8; reader.output_buffer_size().ok_or_else(|| Error::Msg("PNG too large.".into()))?];
    let info = reader.next_frame(&mut buf).map_err(|e| Error::Msg(e.to_string()))?;
    let (w, h) = (info.width as usize, info.height as usize);
    let data = &buf[..info.buffer_size()];
    let (color, alpha): (Vec<u8>, Option<Vec<u8>>) = match info.color_type {
        png::ColorType::Grayscale | png::ColorType::Rgb => (data.to_vec(), None),
        png::ColorType::GrayscaleAlpha => (data.chunks_exact(2).map(|p| p[0]).collect(), Some(data.chunks_exact(2).map(|p| p[1]).collect())),
        png::ColorType::Rgba => (data.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect(), Some(data.chunks_exact(4).map(|p| p[3]).collect())),
        png::ColorType::Indexed => return Err(Error::Msg("Unexpected palette PNG.".into())),
    };
    let ch = if matches!(info.color_type, png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha) { 1 } else { 3 };
    let mut d = image_dict(w, h, if ch == 1 { "DeviceGray" } else { "DeviceRGB" }, "FlateDecode");
    if let Some(a) = alpha.filter(|a| a.iter().any(|&v| v != 255)) {
        let sm = flate_stream(image_dict(w, h, "DeviceGray", "FlateDecode"), &a, w, h, 1);
        let sm_id = doc.add_object(Object::Stream(sm));
        d.set("SMask", Object::Reference(sm_id));
    }
    let s = flate_stream(d, &color, w, h, ch);
    Ok(Embedded { id: doc.add_object(Object::Stream(s)), w: w as f64, h: h as f64 })
}

/// `inputs`: (file, is_png). Returns the page count.
pub fn images_to_pdf(inputs: &[(&Path, bool)], opts: &Options, out: &Path, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    if inputs.is_empty() {
        return Err(Error::Msg("No images provided.".into()));
    }
    progress(10, "Creating document...");
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::new();
    for (i, (path, is_png)) in inputs.iter().enumerate() {
        let bytes = std::fs::read(path)?;
        let img = if *is_png { embed_png(&mut doc, &bytes)? } else { embed_jpeg(&mut doc, bytes)? };
        let landscape = img.w > img.h;
        let m = opts.margin_pt;
        let base = if opts.page_size == PageSize::Fit {
            let k = (A4.1 / img.w.max(img.h)).min(1.0);
            (img.w * k + m * 2.0, img.h * k + m * 2.0)
        } else {
            let b = if opts.page_size == PageSize::Letter { LETTER } else { A4 };
            let want_landscape = opts.orientation == Orientation::Landscape || (opts.orientation == Orientation::Auto && landscape);
            if want_landscape { (b.1, b.0) } else { b }
        };
        let (avail_w, avail_h) = (base.0 - m * 2.0, base.1 - m * 2.0);
        let mut scale = (avail_w / img.w).min(avail_h / img.h);
        if opts.page_size != PageSize::Fit {
            scale = scale.min(1.0);
        }
        let (dw, dh) = (img.w * scale, img.h * scale);
        let (x, y) = ((base.0 - dw) / 2.0, (base.1 - dh) / 2.0);
        let content = format!("q {dw:.4} 0 0 {dh:.4} {x:.4} {y:.4} cm /Im0 Do Q");
        let mut cs = Stream::new(Dictionary::new(), content.into_bytes());
        cs.allows_compression = true;
        let cid = doc.add_object(Object::Stream(cs));
        let mut xo = Dictionary::new();
        xo.set("Im0", Object::Reference(img.id));
        let mut res = Dictionary::new();
        res.set("XObject", Object::Dictionary(xo));
        let mut page = Dictionary::new();
        page.set("Type", name("Page"));
        page.set("Parent", Object::Reference(pages_id));
        page.set("MediaBox", Object::Array(vec![0.into(), 0.into(), Object::Real(base.0 as f32), Object::Real(base.1 as f32)]));
        page.set("Resources", Object::Dictionary(res));
        page.set("Contents", Object::Reference(cid));
        kids.push(Object::Reference(doc.add_object(Object::Dictionary(page))));
        progress(10 + ((i + 1) * 75 / inputs.len()) as u32, &format!("Adding image {}/{}...", i + 1, inputs.len()));
    }
    let n = kids.len();
    let mut root = Dictionary::new();
    root.set("Type", name("Pages"));
    root.set("Kids", Object::Array(kids));
    root.set("Count", n as i64);
    doc.objects.insert(pages_id, Object::Dictionary(root));
    let mut cat = Dictionary::new();
    cat.set("Type", name("Catalog"));
    cat.set("Pages", Object::Reference(pages_id));
    let cat_id = doc.add_object(Object::Dictionary(cat));
    doc.trailer.set("Root", Object::Reference(cat_id));
    doc.compress();
    progress(90, "Saving PDF...");
    let mut w = std::io::BufWriter::new(std::fs::File::create(out)?);
    doc.save_modern(&mut w)?;
    w.flush()?;
    Ok(n)
}
