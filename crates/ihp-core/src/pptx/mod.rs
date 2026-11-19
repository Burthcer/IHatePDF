//! PowerPoint (.pptx) to PDF. A DrawingML renderer: theme colours and styles, master/layout/placeholder
//! inheritance, preset and custom geometry, gradients, transparency, shadows, pictures, tables, SmartArt
//! drawings and text laid out with the deck's own fonts when the machine has them. Checked page by page
//! against PowerPoint's own PDF export (scripts/test-pptx-real.ts).
//!
//! Anything this engine can't read returns an error and the app runs the TypeScript engine instead.

mod chart;
mod color;
mod fontsys;
mod geom;
mod model;
mod render;
mod text;

use crate::compress::{Error, Result};
use crate::fonts::FontSource;
use lopdf::{Dictionary, Document, Object, Stream};
use model::{Bg, Deck, Pkg};
use render::{Env, Frame, Rt, ID};
use std::io::Write;
use std::path::Path;

/// Converts a deck; a bug (a panic) in the renderer becomes an error so the caller can use the TypeScript engine.
pub fn pptx_to_pdf(input: &Path, out: &Path, fonts: Option<FontSource>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| convert(input, out, fonts, progress))).unwrap_or_else(|_| Err(Error::Msg("The presentation could not be converted by the fast engine.".into())))
}

fn convert(input: &Path, out: &Path, fonts: Option<FontSource>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(10, "Unzipping presentation archive...");
    let mut pkg = Pkg::open(input)?;
    progress(30, "Reading the slides...");
    let deck = Deck::load(&mut pkg)?;
    progress(50, "Initializing PDF generation engine...");
    let mut rt = Rt::new(Document::with_version("1.7"), fontsys::FontSys::new(fonts), pkg);

    let shown: Vec<usize> = (0..deck.slides.len()).filter(|&i| !deck.slides[i].hidden).collect();
    let mut pages: Vec<String> = Vec::new();
    for (n, &si) in shown.iter().enumerate() {
        let slide = &deck.slides[si];
        let layout = &deck.layouts[slide.layout];
        let master = &deck.masters[layout.master];
        let theme = &deck.themes[master.theme];
        let map = slide.part.clr_map_ovr.as_ref().or(layout.part.clr_map_ovr.as_ref()).unwrap_or(&master.clr_map);
        rt.fonts.default_family = theme.minor.clone();
        let env = Env { theme, map, master, layout: Some(layout), deck: &deck };
        let mut c = format!("q 1 0 0 -1 0 {} cm\n", crate::stamp::f(deck.h));
        let frame = Frame { m: ID };
        // background: slide, then layout, then master
        let bg = slide.part.bg.as_ref().or(layout.part.bg.as_ref()).or(master.part.bg.as_ref());
        let rfill = match bg {
            Some(Bg::Fill(f)) => Some(env.fill(f, None)),
            Some(Bg::Ref(idx, col)) => env.style_fill(*idx, col.as_ref()),
            None => None,
        };
        let page_rect = vec![geom::GPath { cmds: vec![geom::G::M(0.0, 0.0), geom::G::L(deck.w, 0.0), geom::G::L(deck.w, deck.h), geom::G::L(0.0, deck.h), geom::G::Z], fill: true, stroke: false }];
        let white = render::RFill::Solid([255.0, 255.0, 255.0], 1.0);
        rt.paint_pub(&mut c, &page_rect, deck.w, deck.h, &render::RFill::Solid([255.0, 255.0, 255.0], 1.0));
        if let Some(f) = &rfill {
            if !matches!(f, render::RFill::None) {
                rt.paint_pub(&mut c, &page_rect, deck.w, deck.h, f);
            }
        }
        let _ = white;
        if layout.part.show_master_sp && slide.part.show_master_sp {
            let menv = Env { theme, map, master, layout: None, deck: &deck };
            rt.draw_items(&mut c, &master.part.shapes, &menv, &frame, None, None, true)?;
        }
        if slide.part.show_master_sp {
            rt.draw_items(&mut c, &layout.part.shapes, &env, &frame, None, Some(&master.part.shapes), true)?;
        }
        rt.draw_items(&mut c, &slide.part.shapes, &env, &frame, Some(&layout.part.shapes), Some(&master.part.shapes), false)?;
        c.push_str("Q\n");
        pages.push(c);
        progress(50 + (((n + 1) * 40) / shown.len().max(1)) as u32, &format!("Rendered slide {}/{}", n + 1, shown.len()));
    }
    if pages.is_empty() {
        return Err(Error::Msg("No slides found — this may not be a valid .pptx file.".into()));
    }

    progress(95, "Assembling final PDF document...");
    let Rt { mut doc, fonts, gs_res, sh_res, xo_res, .. } = rt;
    let font_res = fonts.finish(&mut doc)?;
    let mut res = Dictionary::new();
    res.set("Font", Object::Dictionary(font_res));
    res.set("ExtGState", Object::Dictionary(gs_res));
    res.set("Shading", Object::Dictionary(sh_res));
    res.set("XObject", Object::Dictionary(xo_res));
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
        page.set("MediaBox", Object::Array(vec![0.into(), 0.into(), Object::Real(deck.w as f32), Object::Real(deck.h as f32)]));
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
