//! Page-level tools: merge, extract / reorder / delete / add blank pages (organize and split),
//! split into a .zip, rotate, crop. Mirrors the TypeScript workers (same naming of results,
//! same rules for blank pages, rotation and crop margins).
//!
//! Merge, split and organize build a fresh document and copy each needed page with everything it
//! uses (like pdf-lib's `copyPages`): outlines, named destinations and form fields are not carried
//! over, exactly as before. Rotate and crop edit the document in place and keep everything.

use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::Path;

use crate::compress::{Error, Result};

// ------------------------------------------------------------------ helpers

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

/// An attribute of a page, looking up the page tree (Resources, MediaBox, CropBox, Rotate are inheritable).
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

fn rect_of(doc: &Document, o: Option<Object>) -> Option<[f64; 4]> {
    let Object::Array(a) = o? else { return None };
    let v: Vec<f64> = a.iter().filter_map(|x| num(doc.dereference(x).map(|(_, o)| o).unwrap_or(x))).collect();
    (v.len() == 4).then(|| [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

fn media_box(doc: &Document, page: ObjectId) -> [f64; 4] {
    rect_of(doc, inherited(doc, page, b"MediaBox")).unwrap_or([0.0, 0.0, 595.28, 841.89])
}

/// CropBox ∩ MediaBox (like pdf.js's `view`).
fn visible_box(doc: &Document, page: ObjectId) -> [f64; 4] {
    let m = media_box(doc, page);
    let Some(c) = rect_of(doc, inherited(doc, page, b"CropBox")) else { return m };
    let b = [m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])];
    if b[2] - b[0] < 1.0 || b[3] - b[1] < 1.0 { m } else { b }
}

fn rotation(doc: &Document, page: ObjectId) -> i32 {
    let r = inherited(doc, page, b"Rotate").and_then(|o| num(&o)).unwrap_or(0.0);
    ((((r / 90.0).round() as i32) * 90) % 360 + 360) % 360
}

fn real(v: f64) -> Object {
    Object::Real(v as f32)
}

fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().values().copied().collect()
}

fn load(path: &Path) -> Result<Document> {
    let doc = Document::load(path)?;
    if doc.is_encrypted() {
        return Err(Error::Encrypted);
    }
    Ok(doc)
}

fn save(doc: &mut Document, out: &Path) -> Result<()> {
    let mut w = std::io::BufWriter::new(std::fs::File::create(out)?);
    doc.save_modern(&mut w)?;
    w.flush()?;
    Ok(())
}

fn save_vec(doc: &mut Document) -> Result<Vec<u8>> {
    let mut v = Vec::new();
    doc.save_modern(&mut v)?;
    Ok(v)
}

// ------------------------------------------------------------------ importing pages

/// Copies pages (and everything they use) from one document into another.
struct Importer<'a> {
    src: &'a Document,
    map: HashMap<ObjectId, ObjectId>,
    pages: HashSet<ObjectId>,
    queue: Vec<ObjectId>,
}

impl<'a> Importer<'a> {
    fn new(src: &'a Document) -> Self {
        Importer { src, map: HashMap::new(), pages: page_ids(src).into_iter().collect(), queue: Vec::new() }
    }

    fn map_ref(&mut self, dst: &mut Document, id: ObjectId) -> Option<ObjectId> {
        if let Some(n) = self.map.get(&id) {
            return Some(*n);
        }
        if self.pages.contains(&id) {
            return None; // another page: not part of this copy
        }
        let n = dst.new_object_id();
        self.map.insert(id, n);
        self.queue.push(id);
        Some(n)
    }

    fn copy(&mut self, dst: &mut Document, o: &Object) -> Object {
        match o {
            Object::Reference(id) => match self.map_ref(dst, *id) {
                Some(n) => Object::Reference(n),
                None => Object::Null,
            },
            Object::Array(a) => Object::Array(a.iter().map(|x| self.copy(dst, x)).collect()),
            Object::Dictionary(d) => Object::Dictionary(self.copy_dict(dst, d)),
            Object::Stream(s) => {
                let mut ns = s.clone();
                ns.dict = self.copy_dict(dst, &s.dict);
                Object::Stream(ns)
            }
            other => other.clone(),
        }
    }

    fn copy_dict(&mut self, dst: &mut Document, d: &Dictionary) -> Dictionary {
        let mut out = Dictionary::new();
        for (k, v) in d.iter() {
            // Links into pages that aren't copied would dangle: keep the link text, drop the jump.
            if k == b"Dest" || (k == b"A" && matches!(self.deref_dict_s(v), Some(s) if s == b"GoTo")) {
                continue;
            }
            out.set(k.clone(), self.copy(dst, v));
        }
        out
    }

    fn deref_dict_s(&self, v: &Object) -> Option<Vec<u8>> {
        let (_, o) = self.src.dereference(v).ok()?;
        o.as_dict().ok()?.get(b"S").ok()?.as_name().ok().map(|n| n.to_vec())
    }

    fn drain(&mut self, dst: &mut Document) {
        while let Some(id) = self.queue.pop() {
            let Ok(obj) = self.src.get_object(id) else { continue };
            let new = self.copy(dst, &obj.clone());
            dst.objects.insert(self.map[&id], new);
        }
    }

    /// Copies one page into `dst` (not yet in a page tree); returns its new id and its MediaBox size.
    fn import_page(&mut self, dst: &mut Document, page: ObjectId) -> Result<(ObjectId, (f64, f64))> {
        let new_id = dst.new_object_id();
        self.map.insert(page, new_id);
        let mut d = self.src.get_dictionary(page)?.clone();
        for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
            if !d.has(key) {
                if let Some(v) = inherited(self.src, page, key) {
                    d.set(key.to_vec(), v);
                }
            }
        }
        d.remove(b"Parent");
        let copied = self.copy_dict(dst, &d);
        dst.objects.insert(new_id, Object::Dictionary(copied));
        self.drain(dst);
        let m = media_box(self.src, page);
        Ok((new_id, (m[2] - m[0], m[3] - m[1])))
    }
}

fn blank_page(dst: &mut Document, size: (f64, f64)) -> ObjectId {
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"Page".to_vec()));
    d.set("MediaBox", Object::Array(vec![0.into(), 0.into(), real(size.0), real(size.1)]));
    d.set("Resources", Object::Dictionary(Dictionary::new()));
    dst.add_object(Object::Dictionary(d))
}

fn set_rotation(dst: &mut Document, page: ObjectId, extra: i32) {
    if extra == 0 {
        return;
    }
    let cur = dst.get_dictionary(page).ok().and_then(|d| d.get(b"Rotate").ok()).and_then(num).unwrap_or(0.0) as i32;
    let new = (((cur + extra) % 360) + 360) % 360;
    if let Ok(d) = dst.get_dictionary_mut(page) {
        d.set("Rotate", new as i64);
    }
}

/// A fresh document whose page tree holds `pages` in order.
fn new_doc() -> Document {
    Document::with_version("1.7")
}

fn finish_tree(dst: &mut Document, pages: &[ObjectId]) {
    let pages_id = dst.new_object_id();
    for p in pages {
        if let Ok(d) = dst.get_dictionary_mut(*p) {
            d.set("Parent", Object::Reference(pages_id));
            d.set("Type", Object::Name(b"Page".to_vec()));
        }
    }
    let mut root = Dictionary::new();
    root.set("Type", Object::Name(b"Pages".to_vec()));
    root.set("Kids", Object::Array(pages.iter().map(|p| Object::Reference(*p)).collect()));
    root.set("Count", pages.len() as i64);
    dst.objects.insert(pages_id, Object::Dictionary(root));
    let mut cat = Dictionary::new();
    cat.set("Type", Object::Name(b"Catalog".to_vec()));
    cat.set("Pages", Object::Reference(pages_id));
    let cat_id = dst.add_object(Object::Dictionary(cat));
    dst.trailer.set("Root", Object::Reference(cat_id));
    dst.max_id = dst.objects.keys().map(|k| k.0).max().unwrap_or(0);
}

// ------------------------------------------------------------------ merge

/// Joins the PDFs in order; returns the page count.
pub fn merge(inputs: &[&Path], out: &Path, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    if inputs.len() < 2 {
        return Err(Error::Msg("At least two PDF files are required for merging.".into()));
    }
    let mut dst = new_doc();
    let mut all: Vec<ObjectId> = Vec::new();
    for (i, path) in inputs.iter().enumerate() {
        progress(10 + (i * 80 / inputs.len()) as u32, &format!("Importing pages from file {} of {}...", i + 1, inputs.len()));
        let src = load(path).map_err(|e| Error::Msg(format!("File {} couldn't be read: {e}", i + 1)))?;
        let mut imp = Importer::new(&src);
        for page in page_ids(&src) {
            all.push(imp.import_page(&mut dst, page)?.0);
        }
    }
    progress(95, "Writing the merged PDF...");
    finish_tree(&mut dst, &all);
    dst.compress();
    save(&mut dst, out)?;
    Ok(all.len())
}

// ------------------------------------------------------------------ organize / split

#[derive(Clone, Copy, Debug)]
pub struct PageSpec {
    /// 0-based source page, or None for a blank page (sized like its neighbour).
    pub index: Option<usize>,
    /// Degrees to add.
    pub rotate: i32,
}

/// New document from chosen pages of `src` (reordering, repeats and blank pages allowed).
fn build(src: &Document, src_pages: &[ObjectId], specs: &[PageSpec]) -> Result<Document> {
    let mut dst = new_doc();
    let mut imp = Importer::new(src);
    let mut ids: Vec<ObjectId> = Vec::new();
    let mut sizes: Vec<(f64, f64)> = Vec::new();
    for spec in specs {
        match spec.index {
            Some(i) => {
                // A page used twice is copied twice (its content is shared).
                imp.map.remove(&src_pages[i]);
                let (id, size) = imp.import_page(&mut dst, src_pages[i])?;
                ids.push(id);
                sizes.push(size);
            }
            None => {
                ids.push((0, 0));
                sizes.push((0.0, 0.0));
            }
        }
    }
    let mut last = (595.28, 841.89);
    // Blank pages take the size of the next real page, else the previous one.
    let next_real: Vec<Option<(f64, f64)>> = (0..specs.len()).map(|i| (i + 1..specs.len()).find(|&j| specs[j].index.is_some()).map(|j| sizes[j])).collect();
    for (i, spec) in specs.iter().enumerate() {
        if spec.index.is_none() {
            ids[i] = blank_page(&mut dst, next_real[i].unwrap_or(last));
        } else {
            last = sizes[i];
        }
        set_rotation(&mut dst, ids[i], spec.rotate);
    }
    finish_tree(&mut dst, &ids);
    dst.compress();
    Ok(dst)
}

pub fn page_count(input: &Path) -> Result<usize> {
    Ok(load(input)?.get_pages().len())
}

/// Organize: the pages in `specs` as a new PDF. Returns the page count.
pub fn organize(input: &Path, out: &Path, specs: &[PageSpec], progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(15, "Loading source PDF document...");
    let src = load(input)?;
    let pages = page_ids(&src);
    let specs: Vec<PageSpec> = specs.iter().copied().filter(|s| s.index.map_or(true, |i| i < pages.len())).collect();
    if specs.is_empty() || specs.iter().all(|s| s.index.is_none()) {
        return Err(Error::Msg("Cannot create an empty PDF. At least one page must remain.".into()));
    }
    progress(55, &format!("Copying {} pages...", specs.len()));
    let mut doc = build(&src, &pages, &specs)?;
    progress(85, "Writing the document...");
    save(&mut doc, out)?;
    Ok(specs.len())
}

fn label(g: &[usize]) -> String {
    let (a, b) = (g[0] + 1, g[g.len() - 1] + 1);
    if a == b { format!("p{a}") } else { format!("p{a}-{b}") }
}

/// Splits into one PDF per group, stored in a .zip (names like `base_01_p1-3.pdf`). Returns the page count.
pub fn split_zip(input: &Path, out_zip: &Path, base: &str, groups: &[Vec<usize>], progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(10, "Loading source PDF document...");
    let src = load(input)?;
    let pages = page_ids(&src);
    let valid: Vec<Vec<usize>> = groups.iter().map(|g| g.iter().copied().filter(|&i| i < pages.len()).collect::<Vec<_>>()).filter(|g| !g.is_empty()).collect();
    if valid.is_empty() {
        return Err(Error::Msg("No valid pages selected.".into()));
    }
    let pad = valid.len().to_string().len();
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(std::fs::File::create(out_zip)?));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut count = 0;
    for (i, g) in valid.iter().enumerate() {
        progress(10 + (i * 85 / valid.len()) as u32, &format!("Writing file {} of {}...", i + 1, valid.len()));
        let specs: Vec<PageSpec> = g.iter().map(|&p| PageSpec { index: Some(p), rotate: 0 }).collect();
        let mut part = build(&src, &pages, &specs)?;
        let name = format!("{base}_{:0pad$}_{}.pdf", i + 1, label(g), pad = pad);
        zip.start_file(name, opts).map_err(|e| Error::Msg(e.to_string()))?;
        zip.write_all(&save_vec(&mut part)?)?;
        count += g.len();
    }
    zip.finish().map_err(|e| Error::Msg(e.to_string()))?;
    Ok(count)
}

/// One PDF from the given 0-based pages (a split with a single group or ranges). Returns the page count.
pub fn split_one(input: &Path, out: &Path, indices: &[usize], progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    let specs: Vec<PageSpec> = indices.iter().map(|&i| PageSpec { index: Some(i), rotate: 0 }).collect();
    progress(60, &format!("Extracting {} pages...", indices.len()));
    let src = load(input)?;
    let pages = page_ids(&src);
    let specs: Vec<PageSpec> = specs.into_iter().filter(|s| s.index.map_or(false, |i| i < pages.len())).collect();
    if specs.is_empty() {
        return Err(Error::Msg("No valid pages selected to extract.".into()));
    }
    let mut doc = build(&src, &pages, &specs)?;
    save(&mut doc, out)?;
    Ok(specs.len())
}

// ------------------------------------------------------------------ rotate / crop (in place)

/// Adds `global` degrees to every page plus per-page `rotations` (0-based index, degrees).
pub fn rotate(input: &Path, out: &Path, rotations: &[(usize, i32)], global: i32, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(15, "Loading PDF document...");
    let mut doc = load(input)?;
    let pages = page_ids(&doc);
    progress(40, "Applying page orientation adjustments...");
    let per: HashMap<usize, i32> = rotations.iter().copied().collect();
    for (i, id) in pages.iter().enumerate() {
        let delta = (global + per.get(&i).copied().unwrap_or(0)) % 360;
        if delta != 0 {
            let cur = inherited(&doc, *id, b"Rotate").and_then(|o| num(&o)).unwrap_or(0.0) as i32;
            let new = ((cur + delta) % 360 + 360) % 360;
            doc.get_dictionary_mut(*id)?.set("Rotate", new as i64);
        }
    }
    progress(80, "Saving rotated document...");
    save(&mut doc, out)?;
    Ok(pages.len())
}

const MM_TO_PT: f64 = 72.0 / 25.4;

/// Margins in mm as the user sees the page (top = top of the displayed page).
pub fn crop(input: &Path, out: &Path, top: f64, right: f64, bottom: f64, left: f64, indices: Option<&[usize]>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(15, "Loading PDF document...");
    let mut doc = load(input)?;
    let pages = page_ids(&doc);
    let targets: Option<HashSet<usize>> = indices.map(|v| v.iter().copied().collect());
    progress(40, "Adjusting page crop boxes...");
    let (t, r, b, l) = (top.max(0.0) * MM_TO_PT, right.max(0.0) * MM_TO_PT, bottom.max(0.0) * MM_TO_PT, left.max(0.0) * MM_TO_PT);
    for (i, id) in pages.iter().enumerate() {
        if targets.as_ref().map_or(false, |s| !s.contains(&i)) {
            continue;
        }
        let [x0, y0, x1, y1] = visible_box(&doc, *id);
        // displayed side -> user-space side
        let (left_, top_, right_, bottom_) = match rotation(&doc, *id) {
            90 => (t, r, b, l),
            180 => (r, b, l, t),
            270 => (b, l, t, r),
            _ => (l, t, r, b),
        };
        let w = (x1 - x0 - left_ - right_).max(1.0);
        let h = (y1 - y0 - top_ - bottom_).max(1.0);
        let (cx, cy) = (x0 + left_, y0 + bottom_);
        doc.get_dictionary_mut(*id)?.set("CropBox", Object::Array(vec![real(cx), real(cy), real(cx + w), real(cy + h)]));
    }
    progress(80, "Saving cropped document...");
    save(&mut doc, out)?;
    Ok(pages.len())
}
