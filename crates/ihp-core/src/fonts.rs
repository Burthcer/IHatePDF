//! Unicode text for tools that draw text into PDFs (Watermark, Page numbers; later Office to PDF, Edit).
//! A TrueType font is shaped with rustybuzz (conjuncts, reordered vowel signs, marks: the same job as
//! fontkit in `src/services/fonts.ts`), cut down to the glyphs used with `subsetter`, and embedded as a
//! Type0 / CIDFontType2 font with Identity-H. Shaping nudges are written as TJ adjustments.
//!
//! Faces (as in the TypeScript app): Liberation Sans for Greek, Cyrillic, Central European and symbols;
//! Noto Sans Devanagari; Noto Sans SC for Chinese and Japanese.

use crate::compress::{Error, Result};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use rustybuzz::{ttf_parser::GlyphId, Face as Buzz, UnicodeBuffer};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use subsetter::GlyphRemapper;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Face {
    Liberation,
    Devanagari,
    Cjk,
}

impl Face {
    /// Files per face: regular, bold, italic, bold italic (scripts without italics reuse upright).
    pub fn variants(self) -> usize {
        match self {
            Face::Liberation => 4,
            _ => 2,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Face::Liberation => "liberation",
            Face::Devanagari => "devanagari",
            Face::Cjk => "cjk",
        }
    }
    pub fn variant(bold: bool, italic: bool) -> usize {
        bold as usize + 2 * italic as usize
    }
}

/// Where font bytes come from: (face, variant index 0..4 before the `% variants()` reuse) -> file bytes.
pub type FontSource<'a> = &'a dyn Fn(Face, usize) -> Option<Vec<u8>>;

fn is_devanagari(c: char) -> bool {
    matches!(c as u32, 0x0900..=0x097F | 0xA8E0..=0xA8FF | 0x1CD0..=0x1CFF)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x2E80..=0x2FDF | 0x3000..=0x30FF | 0x3100..=0x312F | 0x31A0..=0x31FF | 0x3200..=0x9FFF | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x2FA1F)
}

/// The face for `text`, by the scripts it contains (same rule as `faceFor` in fonts.ts).
pub fn face_for(text: &str) -> Face {
    if text.chars().any(is_devanagari) {
        Face::Devanagari
    } else if text.chars().any(is_cjk) {
        Face::Cjk
    } else {
        Face::Liberation
    }
}

pub struct Shaped {
    /// The TJ array, with brackets: `[<0001> -74 <0002>]`.
    pub tj: String,
    /// Advance width in points at the size given to `shape`.
    pub width: f64,
}

pub struct UFont {
    data: Vec<u8>,
    remap: GlyphRemapper,
    /// New glyph id -> advance in 1/1000 em.
    adv: BTreeMap<u16, u16>,
    /// New glyph id -> the text it stands for (ToUnicode).
    uni: BTreeMap<u16, String>,
    upem: f64,
    /// Liberation Sans is laid out without kerning, like the TypeScript tools (pdf-lib does no shaping for it).
    features: Vec<rustybuzz::Feature>,
}

impl UFont {
    pub fn new(data: Vec<u8>, kerning: bool) -> Result<UFont> {
        let upem = Buzz::from_slice(&data, 0).ok_or_else(|| Error::Msg("A font could not be read.".into()))?.units_per_em() as f64;
        let mut remap = GlyphRemapper::new();
        remap.remap(0); // .notdef stays glyph 0
        let features = if kerning { Vec::new() } else { vec![rustybuzz::Feature::new(rustybuzz::ttf_parser::Tag::from_bytes(b"kern"), 0, ..)] };
        Ok(UFont { data, remap, adv: BTreeMap::new(), uni: BTreeMap::new(), upem, features })
    }

    /// Ascender in points at `size` (for placing a baseline-anchored line like the TypeScript tools).
    pub fn ascent(&self, size: f64) -> f64 {
        let f = Buzz::from_slice(&self.data, 0).unwrap();
        f.ascender() as f64 * size / self.upem
    }

    /// Splits at Devanagari/other boundaries: a shaper picks one script per run (fontkit does the same).
    fn runs(text: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut start = 0;
        let mut cur: Option<bool> = None;
        for (i, c) in text.char_indices() {
            let joiner = c == '\u{200C}' || c == '\u{200D}';
            let d = if joiner { cur.unwrap_or(false) } else { is_devanagari(c) };
            if cur.is_some() && cur != Some(d) {
                out.push(&text[start..i]);
                start = i;
            }
            cur = Some(d);
        }
        if start < text.len() {
            out.push(&text[start..]);
        }
        out
    }

    /// Shapes `text` and registers its glyphs for the subset.
    pub fn shape(&mut self, text: &str, size: f64) -> Result<Shaped> {
        let face = Buzz::from_slice(&self.data, 0).ok_or_else(|| Error::Msg("A font could not be read.".into()))?;
        let scale = 1000.0 / self.upem;
        let mut tj = String::from("[");
        let mut pending = 0.0f64; // thousandths to move before the next glyph
        let mut total = 0.0f64; // font units
        for run in Self::runs(text) {
            let mut buf = UnicodeBuffer::new();
            buf.push_str(run);
            buf.guess_segment_properties();
            let out = rustybuzz::shape(&face, &self.features, buf);
            let (infos, pos) = (out.glyph_infos(), out.glyph_positions());
            for (k, (info, p)) in infos.iter().zip(pos).enumerate() {
                let gid = info.glyph_id as u16;
                let nominal = face.glyph_hor_advance(GlyphId(gid)).unwrap_or(0) as f64;
                let new = self.remap.remap(gid);
                self.adv.entry(new).or_insert((nominal * scale).round() as u16);
                if !self.uni.contains_key(&new) {
                    // What this glyph stands for. A cluster of one glyph carries the cluster's text (conjuncts,
                    // ligatures). In a cluster of several (a consonant and its vowel sign) each glyph is
                    // looked up in the font's cmap; a glyph with no entry gets the text only if it is the first.
                    let in_cluster = infos.iter().filter(|i| i.cluster == info.cluster).count();
                    let end = infos[k..].iter().map(|i| i.cluster).find(|&c| c > info.cluster).unwrap_or(run.len() as u32) as usize;
                    let cluster_text = run.get(info.cluster as usize..end).unwrap_or("").to_string();
                    let text = if in_cluster == 1 {
                        cluster_text
                    } else if let Some(c) = reverse_cmap(&face, gid) {
                        c.to_string()
                    } else {
                        // A helper glyph (half form, reph): it gets the characters of the cluster that no
                        // glyph of the cluster is the plain form of, if it is the first such glyph.
                        let plain: Vec<Option<char>> = infos.iter().filter(|i| i.cluster == info.cluster).map(|i| reverse_cmap(&face, i.glyph_id as u16)).collect();
                        let first_unmapped = infos.iter().filter(|i| i.cluster == info.cluster).position(|i| reverse_cmap(&face, i.glyph_id as u16).is_none());
                        let me = infos.iter().filter(|i| i.cluster == info.cluster).position(|i| std::ptr::eq(i, info));
                        if first_unmapped == me {
                            cluster_text.chars().filter(|c| !plain.contains(&Some(*c))).collect()
                        } else {
                            String::new()
                        }
                    };
                    self.uni.insert(new, text);
                }
                let (xo, xa) = (p.x_offset as f64, p.x_advance as f64);
                let before = ((pending - xo * scale) * 100.0).round() / 100.0;
                if before != 0.0 {
                    let _ = write!(tj, "{} ", trim(before));
                }
                let _ = write!(tj, "<{:04X}>", new);
                pending = xo * scale + (nominal - xa) * scale;
                total += xa;
                tj.push(' ');
            }
        }
        tj.push(']');
        Ok(Shaped { tj, width: total * size / self.upem })
    }

    /// Writes the subset font into `doc` as object `id` (reserved earlier with `doc.new_object_id()`).
    pub fn embed(self, doc: &mut Document, id: ObjectId, tag: &str) -> Result<()> {
        let sub = subsetter::subset(&self.data, 0, &self.remap).map_err(|e| Error::Msg(format!("Font subsetting failed: {e}")))?;
        let face = Buzz::from_slice(&self.data, 0).unwrap();
        let k = 1000.0 / self.upem;
        let n = self.remap.num_gids();
        let base = format!("IHPFNT+{tag}");

        let mut ff = Dictionary::new();
        ff.set("Length1", Object::Integer(sub.len() as i64));
        let mut ffs = Stream::new(ff, sub);
        ffs.allows_compression = true;
        let ff_id = doc.add_object(Object::Stream(ffs));

        let bb = face.global_bounding_box();
        let mut desc = Dictionary::new();
        desc.set("Type", name("FontDescriptor"));
        desc.set("FontName", name(&base));
        desc.set("Flags", Object::Integer(4));
        desc.set("FontBBox", Object::Array([bb.x_min, bb.y_min, bb.x_max, bb.y_max].iter().map(|v| Object::Integer((*v as f64 * k).round() as i64)).collect()));
        desc.set("ItalicAngle", Object::Integer(0));
        desc.set("Ascent", Object::Integer((face.ascender() as f64 * k).round() as i64));
        desc.set("Descent", Object::Integer((face.descender() as f64 * k).round() as i64));
        desc.set("CapHeight", Object::Integer((face.capital_height().unwrap_or(face.ascender()) as f64 * k).round() as i64));
        desc.set("StemV", Object::Integer(80));
        desc.set("FontFile2", Object::Reference(ff_id));
        let desc_id = doc.add_object(Object::Dictionary(desc));

        let widths: Vec<Object> = (0..n).map(|g| Object::Integer(*self.adv.get(&g).unwrap_or(&0) as i64)).collect();
        let mut cid = Dictionary::new();
        cid.set("Type", name("Font"));
        cid.set("Subtype", name("CIDFontType2"));
        cid.set("BaseFont", name(&base));
        let mut sys = Dictionary::new();
        sys.set("Registry", Object::string_literal("Adobe"));
        sys.set("Ordering", Object::string_literal("Identity"));
        sys.set("Supplement", Object::Integer(0));
        cid.set("CIDSystemInfo", Object::Dictionary(sys));
        cid.set("FontDescriptor", Object::Reference(desc_id));
        cid.set("CIDToGIDMap", name("Identity"));
        cid.set("DW", Object::Integer(0));
        cid.set("W", Object::Array(vec![Object::Integer(0), Object::Array(widths)]));
        let cid_id = doc.add_object(Object::Dictionary(cid));

        let mut cmap = String::from("/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n");
        // A helper glyph with no text of its own maps to U+FEFF (zero width) so no raw code leaks into extracted text.
        let empty = String::from("\u{FEFF}");
        let entries: Vec<(&u16, &String)> = self.uni.iter().map(|(g, t)| (g, if t.is_empty() { &empty } else { t })).collect();
        for chunk in entries.chunks(100) {
            let _ = writeln!(cmap, "{} beginbfchar", chunk.len());
            for (g, t) in chunk {
                let utf16: String = t.encode_utf16().map(|u| format!("{u:04X}")).collect();
                let _ = writeln!(cmap, "<{g:04X}> <{utf16}>");
            }
            cmap.push_str("endbfchar\n");
        }
        cmap.push_str("endcmap CMapName currentdict /CMap defineresource pop end end");
        let mut cs = Stream::new(Dictionary::new(), cmap.into_bytes());
        cs.allows_compression = true;
        let cmap_id = doc.add_object(Object::Stream(cs));

        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type0"));
        font.set("BaseFont", name(&base));
        font.set("Encoding", name("Identity-H"));
        font.set("DescendantFonts", Object::Array(vec![Object::Reference(cid_id)]));
        font.set("ToUnicode", Object::Reference(cmap_id));
        doc.objects.insert(id, Object::Dictionary(font));
        Ok(())
    }
}

/// The character a glyph is the plain form of, from the font's cmap (None for conjunct and ligature glyphs).
fn reverse_cmap(face: &Buzz, gid: u16) -> Option<char> {
    let cmap = face.tables().cmap?;
    let mut found = None;
    for st in cmap.subtables {
        if !st.is_unicode() {
            continue;
        }
        st.codepoints(|cp| {
            if found.is_none() && st.glyph_index(cp) == Some(GlyphId(gid)) {
                found = char::from_u32(cp);
            }
        });
        if found.is_some() {
            break;
        }
    }
    found
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

fn trim(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The embedded fonts of one job: one per (face, variant), made on first use, written by `finish`.
pub struct Fonts<'a> {
    source: Option<FontSource<'a>>,
    made: BTreeMap<(Face, usize), (UFont, ObjectId)>,
}

impl<'a> Fonts<'a> {
    pub fn new(source: Option<FontSource<'a>>) -> Self {
        Fonts { source, made: BTreeMap::new() }
    }

    /// The font object to reference and the font that shapes for `text`. `None` when no font source exists
    /// (the caller then hands the job to the TypeScript engine).
    pub fn get(&mut self, doc: &mut Document, text: &str, bold: bool, italic: bool) -> Option<(ObjectId, &mut UFont)> {
        let face = face_for(text);
        let variant = Face::variant(bold, italic) % face.variants();
        if !self.made.contains_key(&(face, variant)) {
            let bytes = (self.source?)(face, variant)?;
            let font = UFont::new(bytes, face != Face::Liberation).ok()?;
            let id = doc.new_object_id();
            self.made.insert((face, variant), (font, id));
        }
        let (f, id) = self.made.get_mut(&(face, variant))?;
        Some((*id, f))
    }

    pub fn finish(self, doc: &mut Document) -> Result<()> {
        for ((face, variant), (font, id)) in self.made {
            font.embed(doc, id, &format!("{}{}", face.key(), variant))?;
        }
        Ok(())
    }
}

/// Files in a folder, named as the app's fonts (for the command-line test tools).
pub fn from_dir(dir: &std::path::Path) -> impl Fn(Face, usize) -> Option<Vec<u8>> + '_ {
    move |face, v| {
        let file = match (face, v % face.variants()) {
            (Face::Liberation, 0) => "LiberationSans-Regular.ttf",
            (Face::Liberation, 1) => "LiberationSans-Bold.ttf",
            (Face::Liberation, 2) => "LiberationSans-Italic.ttf",
            (Face::Liberation, _) => "LiberationSans-BoldItalic.ttf",
            (Face::Devanagari, 0) => "NotoSansDevanagari-Regular.ttf",
            (Face::Devanagari, _) => "NotoSansDevanagari-Bold.ttf",
            (Face::Cjk, 0) => "NotoSansSC-Regular.ttf",
            (Face::Cjk, _) => "NotoSansSC-Bold.ttf",
        };
        std::fs::read(dir.join(file)).ok()
    }
}
