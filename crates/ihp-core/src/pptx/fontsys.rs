//! Fonts for the slide text: the deck's own typefaces from the machine's fonts folder when they are there
//! (PowerPoint's output uses them), then the standard 14 when the text fits WinAnsi, then the bundled
//! Liberation/Noto faces. System fonts are embedded as subsets, like `fonts.rs` does for the bundled ones.

use crate::compress::{Error, Result};
use crate::fonts::{face_for, Face, FontSource, UFont};
use crate::stamp::{font_dict, pdf_string, Font as Std};
use lopdf::{Document, Object, ObjectId};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

pub enum Backing {
    Std(Std, bool /* dictionary written */),
    Uni(Option<UFont>, ObjectId),
}

pub struct Entry {
    pub backing: Backing,
    pub data: Option<std::sync::Arc<Vec<u8>>>,
    /// Ascent, descent and line gap in em.
    pub metrics: (f64, f64, f64),
    pub tag: String,
}

#[derive(Default)]
struct SysIndex {
    /// (lower-case family, variant) -> file
    files: HashMap<(String, usize), PathBuf>,
}

fn dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(w) = std::env::var("WINDIR") {
        v.push(PathBuf::from(w).join("Fonts"));
    }
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        v.push(PathBuf::from(&l).join("Microsoft").join("Windows").join("Fonts"));
        // Fonts Office downloaded for the user's decks (Google Fonts and others), one folder per family
        let cloud = PathBuf::from(&l).join("Microsoft").join("FontCache").join("4").join("CloudFonts");
        if let Ok(rd) = std::fs::read_dir(&cloud) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    v.push(e.path());
                }
            }
        }
    }
    for root in ["C:\\Program Files\\Microsoft Office\\root\\vfs\\Fonts", "C:\\Program Files (x86)\\Microsoft Office\\root\\vfs\\Fonts", "C:\\Program Files\\Microsoft Office\\root\\vfs\\FontsFolder"] {
        v.push(PathBuf::from(root));
        v.push(PathBuf::from(root).join("private"));
    }
    v.push(PathBuf::from("/usr/share/fonts"));
    v
}

fn be16(b: &[u8], o: usize) -> usize {
    u16::from_be_bytes([b[o], b[o + 1]]) as usize
}
fn be32(b: &[u8], o: usize) -> usize {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize
}

/// Family and style names of a font file, read from its `name` table only; None for CFF fonts and non-fonts.
fn read_names(path: &std::path::Path) -> Option<(String, String)> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).ok()?;
    let mut base = 0usize;
    if &head[0..4] == b"ttcf" {
        let mut off = [0u8; 4];
        f.seek(SeekFrom::Start(12)).ok()?;
        f.read_exact(&mut off).ok()?;
        base = u32::from_be_bytes(off) as usize;
        f.seek(SeekFrom::Start(base as u64)).ok()?;
        f.read_exact(&mut head).ok()?;
    }
    let n = be16(&head, 4);
    let mut dir = vec![0u8; n * 16];
    f.read_exact(&mut dir).ok()?;
    let (mut name_off, mut name_len, mut glyf) = (0, 0, false);
    for i in 0..n {
        let r = &dir[i * 16..i * 16 + 16];
        match &r[0..4] {
            b"name" => {
                name_off = be32(r, 8);
                name_len = be32(r, 12);
            }
            b"glyf" => glyf = true,
            _ => {}
        }
    }
    let _ = base;
    if !glyf || name_len == 0 || name_len > 1 << 20 {
        return None;
    }
    f.seek(SeekFrom::Start(name_off as u64)).ok()?;
    let mut buf = vec![0u8; name_len];
    f.read_exact(&mut buf).ok()?;
    let table = ttf_parser::name::Table::parse(&buf)?;
    let get = |id: u16| {
        let all = || table.names.into_iter().filter(|n| n.name_id == id && n.is_unicode());
        all().find(|n| n.language_id == 0x409).and_then(|n| n.to_string()).or_else(|| all().find_map(|n| n.to_string()))
    };
    let family = get(1)?;
    let style = get(2).unwrap_or_else(|| "Regular".into());
    Some((family, style))
}

impl SysIndex {
    fn build() -> SysIndex {
        let mut idx = SysIndex::default();
        for d in dirs() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
                if !matches!(ext.as_str(), "ttf" | "ttc" | "otf") {
                    continue;
                }
                if let Some((fam, style)) = read_names(&p) {
                    let s = style.to_lowercase();
                    let variant = (s.contains("bold") as usize) + 2 * (s.contains("italic") || s.contains("oblique")) as usize;
                    idx.files.entry((fam.to_lowercase(), variant)).or_insert(p);
                }
            }
        }
        idx
    }
}

pub struct FontSys<'a> {
    sys: Option<SysIndex>,
    source: Option<FontSource<'a>>,
    pub entries: Vec<Entry>,
    by_key: HashMap<String, Option<usize>>,
    cover: HashMap<(usize, char), bool>,
    /// The deck's body font: what PowerPoint draws a typeface it doesn't have with.
    pub default_family: String,
}

fn classify(family: &str) -> &'static str {
    let l = family.to_lowercase();
    if ["courier", "consolas", "mono", "menlo", "lucida console", "typewriter", "code"].iter().any(|k| l.contains(k)) {
        "mono"
    } else if ["times", "georgia", "garamond", "cambria", "serif", "minion", "palatino", "book", "baskerville", "century", "constantia", "roman"].iter().any(|k| l.contains(k)) && !l.contains("sans") {
        "serif"
    } else {
        "sans"
    }
}

impl<'a> FontSys<'a> {
    pub fn new(source: Option<FontSource<'a>>) -> FontSys<'a> {
        FontSys { sys: None, source, entries: Vec::new(), by_key: HashMap::new(), cover: HashMap::new(), default_family: String::new() }
    }

    fn sys(&mut self) -> &SysIndex {
        self.sys.get_or_insert_with(SysIndex::build)
    }

    fn add_uni(&mut self, doc: &mut Document, data: Vec<u8>, tag: String) -> Option<usize> {
        let face = ttf_parser::Face::parse(&data, 0).ok()?;
        let upem = face.units_per_em() as f64;
        let metrics = (face.ascender() as f64 / upem, -(face.descender() as f64) / upem, face.line_gap() as f64 / upem);
        let font = UFont::new(data.clone(), true).ok()?;
        let id = doc.new_object_id();
        self.entries.push(Entry { backing: Backing::Uni(Some(font), id), data: Some(std::sync::Arc::new(data)), metrics, tag });
        Some(self.entries.len() - 1)
    }

    /// The font object for (family, bold, italic), made on first use.
    fn font_for(&mut self, doc: &mut Document, family: &str, bold: bool, italic: bool) -> Option<usize> {
        let variant = bold as usize + 2 * italic as usize;
        let key = format!("{}|{}", family.to_lowercase(), variant);
        if let Some(r) = self.by_key.get(&key) {
            return *r;
        }
        let lower = family.to_lowercase();
        let mut found: Option<usize> = None;
        let file = {
            let idx = self.sys();
            // The exact variant, then the closest one the family has.
            [variant, variant & 1, variant & 2, 0].iter().find_map(|v| idx.files.get(&(lower.clone(), *v)).cloned())
        };
        if std::env::var("IHP_DEBUG").is_ok() {
            eprintln!("font {family:?} variant {variant} -> {file:?}");
        }
        if let Some(p) = file {
            if let Ok(data) = std::fs::read(&p) {
                found = self.add_uni(doc, data, format!("{}{}", family.replace(' ', ""), variant));
            }
        }
        if found.is_none() && !self.default_family.is_empty() && self.default_family.to_lowercase() != lower && classify(family) == "sans" {
            let dl = self.default_family.to_lowercase();
            let file = {
                let idx = self.sys();
                [variant, variant & 1, variant & 2, 0].iter().find_map(|v| idx.files.get(&(dl.clone(), *v)).cloned())
            };
            if let Some(p) = file {
                if let Ok(data) = std::fs::read(&p) {
                    found = self.add_uni(doc, data, format!("{}{}", self.default_family.replace(' ', ""), variant));
                }
            }
        }
        if found.is_none() {
            // A stand-in of the same kind from the machine, then the standard 14.
            let subs: &[&str] = match classify(family) {
                "serif" => &["times new roman", "cambria", "georgia"],
                "mono" => &["consolas", "courier new"],
                _ => &["arial", "segoe ui", "calibri"],
            };
            for s in subs {
                let file = {
                    let idx = self.sys();
                    [variant, variant & 1, variant & 2, 0].iter().find_map(|v| idx.files.get(&(s.to_string(), *v)).cloned())
                };
                if let Some(p) = file {
                    if let Ok(data) = std::fs::read(&p) {
                        found = self.add_uni(doc, data, format!("{}{}", s.replace(' ', ""), variant));
                        if found.is_some() {
                            break;
                        }
                    }
                }
            }
        }
        if found.is_none() {
            let std = Std::standard(classify(family), bold, italic);
            let metrics = match classify(family) {
                "serif" => (0.891, 0.216, 0.0),
                "mono" => (0.832, 0.300, 0.0),
                _ => (0.905, 0.212, 0.033),
            };
            self.entries.push(Entry { backing: Backing::Std(std, false), data: None, metrics, tag: String::new() });
            found = Some(self.entries.len() - 1);
        }
        self.by_key.insert(key, found);
        found
    }

    /// A bundled face (Liberation, Noto Devanagari/CJK) for characters nothing else has.
    fn bundled(&mut self, doc: &mut Document, ch: char, bold: bool, italic: bool) -> Option<usize> {
        let face = face_for(&ch.to_string());
        let variant = Face::variant(bold, italic) % face.variants();
        let key = format!("@{}|{}", face.key(), variant);
        if let Some(r) = self.by_key.get(&key) {
            return *r;
        }
        let r = (self.source?)(face, variant).and_then(|data| self.add_uni(doc, data, format!("{}{}", face.key(), variant)));
        self.by_key.insert(key, r);
        r
    }

    fn covers(&mut self, i: usize, ch: char) -> bool {
        if let Some(&c) = self.cover.get(&(i, ch)) {
            return c;
        }
        let c = match &self.entries[i].backing {
            Backing::Std(s, _) => s.encode(&ch.to_string()).is_some(),
            Backing::Uni(..) => self.entries[i].data.as_ref().and_then(|d| ttf_parser::Face::parse(d, 0).ok()).map_or(false, |f| f.glyph_index(ch).is_some()),
        };
        self.cover.insert((i, ch), c);
        c
    }

    /// Splits `text` into (font index, text) segments: the requested family where it has the character, otherwise the fallbacks.
    pub fn segments(&mut self, doc: &mut Document, family: &str, bold: bool, italic: bool, text: &str) -> Result<Vec<(usize, String)>> {
        let mut out: Vec<(usize, String)> = Vec::new();
        let primary = self.font_for(doc, family, bold, italic);
        for ch in text.chars() {
            let mut pick = primary.filter(|&p| ch == ' ' || self.covers(p, ch));
            if pick.is_none() {
                // A stand-in sans font from the machine, then the bundled faces.
                let sans = self.font_for(doc, "Arial", bold, italic);
                pick = sans.filter(|&p| self.covers(p, ch));
            }
            if pick.is_none() {
                pick = self.bundled(doc, ch, bold, italic).filter(|&p| self.covers(p, ch));
            }
            let pick = pick.or(primary).ok_or(Error::NeedsUnicodeFont)?;
            match out.last_mut() {
                Some(l) if l.0 == pick => l.1.push(ch),
                _ => out.push((pick, ch.to_string())),
            }
        }
        Ok(out)
    }

    /// Show operator text and width for a segment.
    pub fn shape(&mut self, i: usize, text: &str, size: f64) -> Result<(String, f64)> {
        let text = text.replace(['\t', '\r', '\n'], " ");
        match &mut self.entries[i].backing {
            Backing::Std(s, _) => {
                let b = s.encode(&text).ok_or(Error::NeedsUnicodeFont)?;
                Ok((format!("{} Tj", pdf_string(&b)), s.width(&b, size)))
            }
            Backing::Uni(Some(u), _) => {
                let sh = u.shape(&text, size)?;
                Ok((format!("{} TJ", sh.tj), sh.width))
            }
            Backing::Uni(None, _) => Err(Error::NeedsUnicodeFont),
        }
    }

    pub fn name(&self, i: usize) -> String {
        format!("TF{i}")
    }

    /// Font resources for every font used, embedding the subsets.
    pub fn finish(self, doc: &mut Document) -> Result<lopdf::Dictionary> {
        let mut res = lopdf::Dictionary::new();
        for (i, e) in self.entries.into_iter().enumerate() {
            match e.backing {
                Backing::Std(s, _) => {
                    res.set(format!("TF{i}"), font_dict(&s));
                }
                Backing::Uni(Some(u), id) => {
                    u.embed(doc, id, &e.tag)?;
                    res.set(format!("TF{i}"), Object::Reference(id));
                }
                Backing::Uni(None, _) => {}
            }
        }
        Ok(res)
    }

    pub fn metrics(&self, i: usize) -> (f64, f64, f64) {
        self.entries[i].metrics
    }
}

pub fn _unused(_: ObjectId) {}
