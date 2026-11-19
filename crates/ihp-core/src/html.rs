//! HTML to PDF, the PDF-writing half: draws the display list the browser captured
//! (`src/features/htmlToPdf/captureLayout.ts`) like `htmlToPdf.worker.ts` does with pdf-lib:
//! rectangles, lines, PNG pictures and every word as real text at its laid-out position, in
//! the matching standard font (Helvetica/Times/Courier family, weight, style) or, when the text
//! has characters outside WinAnsi, an embedded Unicode face (`fonts.rs`). The layout capture stays in the browser.

use crate::compress::{Error, Result};
use crate::fonts::{FontSource, Fonts};
use crate::images::{embed_image, Embedded};
use crate::stamp::{f, font_dict, pdf_string, Font};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

fn bad(what: &str) -> Error {
    Error::Msg(format!("display list: bad {what}"))
}

fn num(v: &Value, k: &str) -> Result<f64> {
    v[k].as_f64().filter(|n| n.is_finite()).ok_or_else(|| bad(k))
}

/// `color()` of the worker: parseInt(hex, 16) split into r, g, b.
fn color(v: &Value, k: &str) -> Result<[f64; 3]> {
    let s = v[k].as_str().ok_or_else(|| bad(k))?;
    let n = u32::from_str_radix(s.trim_start_matches('#'), 16).map_err(|_| bad(k))?;
    Ok([((n >> 16) & 255) as f64 / 255.0, ((n >> 8) & 255) as f64 / 255.0, (n & 255) as f64 / 255.0])
}

fn rgb(c: [f64; 3], stroke: bool) -> String {
    format!("{} {} {} {}", f(c[0]), f(c[1]), f(c[2]), if stroke { "RG" } else { "rg" })
}

/// How one style (family, bold, italic) is written.
enum Face {
    Std(Font),
    /// Embedded font object (shaped by `Fonts`, looked up again per text).
    Uni(ObjectId),
}

fn is_png(b: &[u8]) -> bool {
    b.starts_with(&[0x89, b'P', b'N', b'G'])
}

pub fn html_to_pdf(payload: &Value, images: &[Vec<u8>], out: &Path, fonts: Option<FontSource>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    let pages = payload["pages"].as_array().ok_or_else(|| bad("pages"))?;
    if pages.is_empty() {
        return Err(Error::Msg("no pages".into()));
    }
    let (w, h) = (num(payload, "pageWidthPt")?, num(payload, "pageHeightPt")?);
    let mut doc = Document::with_version("1.7");

    progress(10, "Preparing fonts...");
    // Text per style, in first-use order: the characters decide standard or embedded, like fontForText().
    let mut styles: Vec<(String, bool, bool, String)> = Vec::new();
    let mut style_of: HashMap<(String, bool, bool), usize> = HashMap::new();
    for p in pages {
        for it in p["items"].as_array().ok_or_else(|| bad("items"))? {
            if it["t"] == "text" {
                let family = it["family"].as_str().ok_or_else(|| bad("family"))?;
                if !["sans", "serif", "mono"].contains(&family) {
                    return Err(bad("family"));
                }
                let (bold, italic) = (it["bold"].as_bool().ok_or_else(|| bad("bold"))?, it["italic"].as_bool().ok_or_else(|| bad("italic"))?);
                let text = it["text"].as_str().ok_or_else(|| bad("text"))?;
                let idx = *style_of.entry((family.to_string(), bold, italic)).or_insert_with(|| {
                    styles.push((family.to_string(), bold, italic, String::new()));
                    styles.len() - 1
                });
                styles[idx].3.push_str(text);
            }
        }
    }
    let mut uni = Fonts::new(fonts);
    let mut faces: Vec<Face> = Vec::new();
    for (family, bold, italic, text) in &styles {
        let cleaned = text.replace(['\r', '\n', '\t'], " ");
        let std = Font::standard(family, *bold, *italic);
        if cleaned.chars().all(|c| std.encode(&c.to_string()).is_some()) {
            faces.push(Face::Std(std));
        } else {
            let (id, _) = uni.get(&mut doc, &cleaned, *bold, *italic).ok_or(Error::NeedsUnicodeFont)?;
            faces.push(Face::Uni(id));
        }
    }

    let mut embedded: HashMap<usize, Option<(usize, Embedded)>> = HashMap::new();
    let mut image_ids: Vec<ObjectId> = Vec::new();
    let mut contents: Vec<String> = Vec::new();
    let mut extg = false;
    for (pi, page) in pages.iter().enumerate() {
        progress(20 + (pi * 70 / pages.len()) as u32, &format!("Drawing page {} of {}...", pi + 1, pages.len()));
        let mut c = String::new();
        for it in page["items"].as_array().unwrap() {
            match it["t"].as_str() {
                Some("rect") => {
                    let (x, y, rw, rh) = (num(it, "x")?, num(it, "y")?, num(it, "w")?, num(it, "h")?);
                    let fill = color(it, "fill")?;
                    let opacity = num(it, "opacity")?;
                    if rw > 0.0 && rh > 0.0 {
                        let gs = if opacity < 1.0 {
                            extg = true;
                            format!("/GS{} gs ", (opacity.clamp(0.0, 1.0) * 1000.0).round() as u32)
                        } else {
                            String::new()
                        };
                        c.push_str(&format!("q {} {}{} {} {} {} re f Q\n", rgb(fill, false), gs, f(x), f(h - y - rh), f(rw), f(rh)));
                    }
                }
                Some("line") => {
                    let (x1, y1, x2, y2, lw) = (num(it, "x1")?, num(it, "y1")?, num(it, "x2")?, num(it, "y2")?, num(it, "width")?);
                    let col = color(it, "color")?;
                    let dash = if it["dashed"].as_bool().ok_or_else(|| bad("dashed"))? { format!("[{} {}] 0 d ", f(lw * 3.0), f(lw * 2.0)) } else { String::new() };
                    c.push_str(&format!("q {} {} w {}0 J {} {} m {} {} l S Q\n", rgb(col, true), f(lw), dash, f(x1), f(h - y1), f(x2), f(h - y2)));
                }
                Some("image") => {
                    let (x, y, iw, ih) = (num(it, "x")?, num(it, "y")?, num(it, "w")?, num(it, "h")?);
                    let index = it["index"].as_u64().ok_or_else(|| bad("index"))? as usize;
                    if !embedded.contains_key(&index) {
                        // pdf-lib's embedPng fails on anything else and the worker then skips the picture.
                        let e = match images.get(index) {
                            Some(b) if is_png(b) => {
                                let e = embed_image(&mut doc, b, true)?;
                                image_ids.push(e.id);
                                Some((image_ids.len() - 1, e))
                            }
                            _ => None,
                        };
                        embedded.insert(index, e);
                    }
                    if let Some((n, _)) = &embedded[&index] {
                        c.push_str(&format!("q {} 0 0 {} {} {} cm /Im{} Do Q\n", f(iw), f(ih), f(x), f(h - y - ih), n));
                    }
                }
                Some("text") => {
                    let family = it["family"].as_str().unwrap();
                    let (bold, italic) = (it["bold"].as_bool().unwrap(), it["italic"].as_bool().unwrap());
                    let si = style_of[&(family.to_string(), bold, italic)];
                    let (x, y, size) = (num(it, "x")?, num(it, "y")?, num(it, "size")?);
                    let col = color(it, "color")?;
                    let text = it["text"].as_str().unwrap();
                    let show = match &faces[si] {
                        Face::Std(font) => {
                            let b = font.encode(text).ok_or(Error::NeedsUnicodeFont)?;
                            format!("{} Tj", pdf_string(&b))
                        }
                        Face::Uni(_) => {
                            let (_, u) = uni.get(&mut doc, &styles[si].3.replace(['\r', '\n', '\t'], " "), bold, italic).ok_or(Error::NeedsUnicodeFont)?;
                            format!("{} TJ", u.shape(text, size)?.tj)
                        }
                    };
                    c.push_str(&format!("BT /F{} {} Tf {} {} {} Td {} ET\n", si, f(size), rgb(col, false), f(x), f(h - y), show));
                }
                _ => return Err(bad("item")),
            }
        }
        contents.push(c);
    }

    progress(95, "Saving PDF...");
    let mut font_res = Dictionary::new();
    for (i, face) in faces.iter().enumerate() {
        font_res.set(format!("F{i}"), match face {
            Face::Std(font) => font_dict(font),
            Face::Uni(id) => Object::Reference(*id),
        });
    }
    uni.finish(&mut doc)?;
    let mut xo = Dictionary::new();
    for (i, id) in image_ids.iter().enumerate() {
        xo.set(format!("Im{i}"), Object::Reference(*id));
    }
    let mut res = Dictionary::new();
    res.set("Font", Object::Dictionary(font_res));
    res.set("XObject", Object::Dictionary(xo));
    if extg {
        let mut gs = Dictionary::new();
        for p in 0..=1000u32 {
            let key = format!("/GS{p} gs");
            if contents.iter().any(|c| c.contains(&key)) {
                let mut d = Dictionary::new();
                d.set("Type", Object::Name(b"ExtGState".to_vec()));
                d.set("ca", Object::Real(p as f32 / 1000.0));
                gs.set(format!("GS{p}"), Object::Dictionary(d));
            }
        }
        res.set("ExtGState", Object::Dictionary(gs));
    }
    let res_id = doc.add_object(Object::Dictionary(res));

    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for content in &contents {
        let mut cs = Stream::new(Dictionary::new(), content.clone().into_bytes());
        cs.allows_compression = true;
        let cid = doc.add_object(Object::Stream(cs));
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages_id));
        page.set("MediaBox", Object::Array(vec![0.into(), 0.into(), Object::Real(w as f32), Object::Real(h as f32)]));
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
    if let Some(title) = payload["title"].as_str().filter(|t| !t.is_empty()) {
        let mut b = vec![0xFE, 0xFF];
        for u in title.encode_utf16() {
            b.extend(u.to_be_bytes());
        }
        let mut info = Dictionary::new();
        info.set("Title", Object::String(b, StringFormat::Hexadecimal));
        let id = doc.add_object(Object::Dictionary(info));
        doc.trailer.set("Info", Object::Reference(id));
    }
    doc.compress();
    let mut wr = std::io::BufWriter::new(std::fs::File::create(out)?);
    doc.save_modern(&mut wr)?;
    wr.flush()?;
    progress(100, "Done.");
    Ok(n)
}

/// The staged job file from the page: u32 LE JSON length, the payload JSON (with `imageLens`), then the
/// PNG bytes of every picture one after another.
pub fn unpack(bytes: &[u8]) -> Result<(Value, Vec<Vec<u8>>)> {
    let n = bytes.get(..4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize).ok_or_else(|| bad("job file"))?;
    let json = bytes.get(4..4 + n).ok_or_else(|| bad("job file"))?;
    let v: Value = serde_json::from_slice(json).map_err(|e| Error::Msg(e.to_string()))?;
    let mut at = 4 + n;
    let mut imgs = Vec::new();
    for l in v["imageLens"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let l = l.as_u64().ok_or_else(|| bad("imageLens"))? as usize;
        imgs.push(bytes.get(at..at + l).ok_or_else(|| bad("job file"))?.to_vec());
        at += l;
    }
    Ok((v, imgs))
}
