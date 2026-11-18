//! Slides to PDF page content: backgrounds, the master/layout/slide shape stack, fills (solid, PDF shadings,
//! pictures), lines with dashes and arrowheads, transparency, shadows, text and tables. Everything is drawn
//! in a y-down point space (the page gets one flip), like the slide's own coordinates.

use super::color::{resolve, ColorCtx, Rgb};
use super::fontsys::FontSys;
use super::geom::{self, GPath, G};
use super::model::*;
use crate::compress::{Error, Result};
use crate::images::{embed_image, Embedded};
use crate::stamp::f;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashMap;

pub type Mat = [f64; 6];
pub const ID: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// "Apply m, then n".
pub fn mul(m: &Mat, n: &Mat) -> Mat {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}
fn tr(x: f64, y: f64) -> Mat {
    [1.0, 0.0, 0.0, 1.0, x, y]
}
fn sc(x: f64, y: f64) -> Mat {
    [x, 0.0, 0.0, y, 0.0, 0.0]
}
fn rot(deg: f64) -> Mat {
    let (s, c) = (deg * std::f64::consts::PI / 180.0).sin_cos();
    [c, s, -s, c, 0.0, 0.0]
}
fn app(m: &Mat, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}
pub fn cm(m: &Mat) -> String {
    format!("{} {} {} {} {} {} cm", f(m[0]), f(m[1]), f(m[2]), f(m[3]), f(m[4]), f(m[5]))
}

// ------------------------------------------------------------------ resolved paint

#[derive(Clone, Debug)]
pub enum RFill {
    None,
    Solid(Rgb, f64),
    Grad { stops: Vec<(f64, Rgb, f64)>, alpha: f64, lin: Option<(f64, bool)>, path: Option<(String, [f64; 4])> },
    Blip(Blip, Option<(Rgb, Rgb)>),
    Patt(String, Rgb, Rgb),
}

#[derive(Clone, Debug)]
pub struct RLn {
    pub w: f64,
    pub fill: RFill,
    pub dash: Option<String>,
    pub cap: Option<String>,
    pub join: Option<String>,
    pub head: Option<Arrow>,
    pub tail: Option<Arrow>,
}

/// Where a part's colours come from.
pub struct Env<'e> {
    pub theme: &'e Theme,
    pub map: &'e HashMap<String, String>,
    pub master: &'e Master,
    pub layout: Option<&'e Layout>,
    pub deck: &'e Deck,
}

impl Env<'_> {
    fn cctx(&self, ph: Option<(Rgb, f64)>) -> ColorCtx<'_> {
        ColorCtx { scheme: &self.theme.colors, map: self.map, ph }
    }
    pub fn color(&self, c: &super::color::ColorSpec, ph: Option<(Rgb, f64)>) -> (Rgb, f64) {
        resolve(c, &self.cctx(ph))
    }
    pub fn fill(&self, f: &Fill, ph: Option<(Rgb, f64)>) -> RFill {
        match f {
            Fill::None | Fill::Group => RFill::None,
            Fill::Solid(c) => {
                let (rgb, a) = self.color(c, ph);
                RFill::Solid(rgb, a)
            }
            Fill::Grad(g) => {
                let stops: Vec<(f64, Rgb, f64)> = g.stops.iter().map(|(p, c)| {
                    let (rgb, a) = self.color(c, ph);
                    (*p, rgb, a)
                }).collect();
                RFill::Grad { stops, alpha: 1.0, lin: g.lin, path: g.path.clone() }
            }
            Fill::Blip(b) => RFill::Blip(b.clone(), b.duotone.as_ref().map(|(a, c)| (self.color(a, ph).0, self.color(c, ph).0))),
            Fill::Patt(p, fg, bg) => RFill::Patt(p.clone(), self.color(fg, ph).0, self.color(bg, ph).0),
        }
    }
    /// A theme style entry (`fillRef idx`): 1..=3 fills, 1001.. background fills.
    pub fn style_fill(&self, idx: usize, c: Option<&super::color::ColorSpec>) -> Option<RFill> {
        let ph = c.map(|c| self.color(c, None));
        let f = if idx >= 1001 { self.theme.bg_fills.get(idx - 1001)? } else { self.theme.fills.get(idx.checked_sub(1)?)? };
        Some(self.fill(f, ph))
    }
    pub fn ln(&self, l: &Ln, ph: Option<(Rgb, f64)>) -> RLn {
        RLn { w: l.w.unwrap_or(0.75), fill: l.fill.as_ref().map(|f| self.fill(f, ph)).unwrap_or(RFill::None), dash: l.dash.clone(), cap: l.cap.clone(), join: l.join.clone(), head: l.head.clone(), tail: l.tail.clone() }
    }
}

// ------------------------------------------------------------------ renderer state

pub struct Rt<'a> {
    pub doc: Document,
    pub fonts: FontSys<'a>,
    pub pkg: Pkg,
    gstates: HashMap<String, String>,
    pub gs_res: Dictionary,
    pub sh_res: Dictionary,
    pub xo_res: Dictionary,
    images: HashMap<String, Option<(String, Embedded)>>,
    n_sh: usize,
    pub shape_cache: HashMap<(usize, String, i64), (String, f64)>,
}

pub struct Frame {
    /// child space -> page space
    pub m: Mat,
}

impl<'a> Rt<'a> {
    pub fn new(doc: Document, fonts: FontSys<'a>, pkg: Pkg) -> Rt<'a> {
        Rt { doc, fonts, pkg, gstates: HashMap::new(), gs_res: Dictionary::new(), sh_res: Dictionary::new(), xo_res: Dictionary::new(), images: HashMap::new(), n_sh: 0, shape_cache: HashMap::new() }
    }

    fn gs(&mut self, alpha: f64) -> String {
        let key = format!("{:.3}", alpha);
        if let Some(n) = self.gstates.get(&key) {
            return n.clone();
        }
        let name = format!("GS{}", self.gstates.len());
        let mut d = Dictionary::new();
        d.set("Type", Object::Name(b"ExtGState".to_vec()));
        d.set("ca", Object::Real(alpha as f32));
        d.set("CA", Object::Real(alpha as f32));
        let id = self.doc.add_object(Object::Dictionary(d));
        self.gs_res.set(name.clone(), Object::Reference(id));
        self.gstates.insert(key, name.clone());
        name
    }

    fn image(&mut self, path: &str, hint: (f64, f64)) -> Option<(String, f64, f64)> {
        if !self.images.contains_key(path) {
            let r = (|| {
                let bytes = self.pkg.read(path)?;
                let (data, png) = to_embeddable(&bytes, hint)?;
                let e = embed_image(&mut self.doc, &data, png).ok()?;
                let name = format!("Im{}", self.images.len());
                self.xo_res.set(name.clone(), Object::Reference(e.id));
                Some((name, e))
            })();
            self.images.insert(path.to_string(), r);
        }
        self.images.get(path).and_then(|o| o.as_ref()).map(|(n, e)| (n.clone(), e.w, e.h))
    }

    fn blend_gs(&mut self, mode: &str) -> String {
        let key = format!("bm:{mode}");
        if let Some(n) = self.gstates.get(&key) {
            return n.clone();
        }
        let name = format!("GB{}", self.gstates.len());
        let mut d = Dictionary::new();
        d.set("Type", Object::Name(b"ExtGState".to_vec()));
        d.set("BM", Object::Name(mode.as_bytes().to_vec()));
        let id = self.doc.add_object(Object::Dictionary(d));
        self.gs_res.set(name.clone(), Object::Reference(id));
        self.gstates.insert(key, name.clone());
        name
    }

    /// A picture, recoloured when the blip asks for it (duotone, greyscale, brightness/contrast).
    fn image_fx(&mut self, path: &str, duo: Option<&(Rgb, Rgb)>, b: &Blip, hint: (f64, f64)) -> Option<(String, f64, f64)> {
        if duo.is_none() && !b.gray && b.bright == 0.0 && b.contrast == 0.0 {
            return self.image(path, hint);
        }
        let key = format!("{path}|{:?}|{}|{}|{}", duo, b.gray, b.bright, b.contrast);
        if !self.images.contains_key(&key) {
            let r = (|| {
                let bytes = self.pkg.read(path)?;
                let (data, _) = to_embeddable(&bytes, hint)?;
                let (w, h, mut px) = decode_rgb(&data)?;
                for p in px.chunks_exact_mut(3) {
                    let lum = (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64) / 255.0;
                    let mut c = [p[0] as f64, p[1] as f64, p[2] as f64];
                    if let Some((c1, c2)) = duo {
                        c = [0, 1, 2].map(|i| c1[i] + (c2[i] - c1[i]) * lum);
                    } else if b.gray {
                        c = [lum * 255.0; 3];
                    }
                    if b.bright != 0.0 || b.contrast != 0.0 {
                        let k = 1.0 + b.contrast;
                        c = c.map(|v| ((v / 255.0 - 0.5) * k + 0.5 + b.bright) * 255.0);
                    }
                    for i in 0..3 {
                        p[i] = c[i].clamp(0.0, 255.0) as u8;
                    }
                }
                let mut png_bytes = Vec::new();
                {
                    let mut enc = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
                    enc.set_color(png::ColorType::Rgb);
                    enc.set_depth(png::BitDepth::Eight);
                    enc.write_header().ok()?.write_image_data(&px).ok()?;
                }
                let e = embed_image(&mut self.doc, &png_bytes, true).ok()?;
                let name = format!("Im{}", self.images.len());
                self.xo_res.set(name.clone(), Object::Reference(e.id));
                Some((name, e))
            })();
            self.images.insert(key.clone(), r);
        }
        self.images.get(&key).and_then(|o| o.as_ref()).map(|(n, e)| (n.clone(), e.w, e.h))
    }

    /// An ExtGState whose luminosity soft mask is the given (grey) shading.
    fn soft_mask(&mut self, shading: &str, w: f64, h: f64) -> String {
        let mut res = Dictionary::new();
        let mut shd = Dictionary::new();
        if let Ok(o) = self.sh_res.get(shading.as_bytes()) {
            shd.set(shading, o.clone());
        }
        res.set("Shading", Object::Dictionary(shd));
        let mut fd = Dictionary::new();
        fd.set("Type", Object::Name(b"XObject".to_vec()));
        fd.set("Subtype", Object::Name(b"Form".to_vec()));
        let m = (w.max(h) * 3.0).max(2000.0);
        fd.set("BBox", Object::Array([-m, -m, m, m].iter().map(|v| Object::Real(*v as f32)).collect()));
        let mut grp = Dictionary::new();
        grp.set("S", Object::Name(b"Transparency".to_vec()));
        grp.set("CS", Object::Name(b"DeviceGray".to_vec()));
        fd.set("Group", Object::Dictionary(grp));
        fd.set("Resources", Object::Dictionary(res));
        let mut st = Stream::new(fd, format!("/{shading} sh").into_bytes());
        st.allows_compression = true;
        let form = self.doc.add_object(Object::Stream(st));
        let mut mask = Dictionary::new();
        mask.set("Type", Object::Name(b"Mask".to_vec()));
        mask.set("S", Object::Name(b"Luminosity".to_vec()));
        mask.set("G", Object::Reference(form));
        let mut gs = Dictionary::new();
        gs.set("Type", Object::Name(b"ExtGState".to_vec()));
        gs.set("SMask", Object::Dictionary(mask));
        let id = self.doc.add_object(Object::Dictionary(gs));
        let name = format!("GM{}", self.n_sh);
        self.n_sh += 1;
        self.gs_res.set(name.clone(), Object::Reference(id));
        name
    }

    /// An axial or radial shading with a stitched colour function; returns its resource name.
    fn shading(&mut self, radial: bool, coords: Vec<f64>, stops: &[(f64, Rgb)]) -> String {
        let mut st: Vec<(f64, Rgb)> = stops.to_vec();
        if st[0].0 > 0.0 {
            st.insert(0, (0.0, st[0].1));
        }
        if st.last().unwrap().0 < 1.0 {
            st.push((1.0, st.last().unwrap().1));
        }
        let col = |c: Rgb| Object::Array(c.iter().map(|v| Object::Real((*v / 255.0) as f32)).collect());
        let seg = |a: Rgb, b: Rgb, doc: &mut Document| {
            let mut d = Dictionary::new();
            d.set("FunctionType", 2);
            d.set("Domain", Object::Array(vec![0.into(), 1.into()]));
            d.set("C0", col(a));
            d.set("C1", col(b));
            d.set("N", 1);
            doc.add_object(Object::Dictionary(d))
        };
        let func = if st.len() == 2 {
            seg(st[0].1, st[1].1, &mut self.doc)
        } else {
            let funcs: Vec<Object> = st.windows(2).map(|w| Object::Reference(seg(w[0].1, w[1].1, &mut self.doc))).collect();
            let mut bounds = Vec::new();
            let mut last = 0.0;
            for w in &st[1..st.len() - 1] {
                let p = w.0.max(last + 1e-6).min(1.0 - 1e-6);
                bounds.push(Object::Real(p as f32));
                last = p;
            }
            let mut d = Dictionary::new();
            d.set("FunctionType", 3);
            d.set("Domain", Object::Array(vec![0.into(), 1.into()]));
            d.set("Functions", Object::Array(funcs));
            d.set("Bounds", Object::Array(bounds));
            d.set("Encode", Object::Array((0..st.len() - 1).flat_map(|_| [Object::Integer(0), Object::Integer(1)]).collect()));
            self.doc.add_object(Object::Dictionary(d))
        };
        let mut sh = Dictionary::new();
        sh.set("ShadingType", if radial { 3 } else { 2 });
        sh.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        sh.set("Coords", Object::Array(coords.iter().map(|v| Object::Real(*v as f32)).collect()));
        sh.set("Function", Object::Reference(func));
        sh.set("Extend", Object::Array(vec![Object::Boolean(true), Object::Boolean(true)]));
        let id = self.doc.add_object(Object::Dictionary(sh));
        self.n_sh += 1;
        let name = format!("SH{}", self.n_sh);
        self.sh_res.set(name.clone(), Object::Reference(id));
        name
    }
}

// ------------------------------------------------------------------ paths

fn path_ops(p: &GPath) -> String {
    let mut s = String::new();
    for c in &p.cmds {
        match *c {
            G::M(x, y) => s += &format!("{} {} m ", f(x), f(y)),
            G::L(x, y) => s += &format!("{} {} l ", f(x), f(y)),
            G::C(a, b, c2, d, e, g) => s += &format!("{} {} {} {} {} {} c ", f(a), f(b), f(c2), f(d), f(e), f(g)),
            G::Z => s += "h ",
        }
    }
    s
}

fn rgb_op(c: Rgb, stroke: bool) -> String {
    let g = |v: f64| {
        let s = format!("{:.5}", v / 255.0);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    format!("{} {} {} {}", g(c[0]), g(c[1]), g(c[2]), if stroke { "RG" } else { "rg" })
}

fn dash_array(name: &str, w: f64) -> Option<Vec<f64>> {
    let u = |v: &[f64]| Some(v.iter().map(|x| x * w.max(0.5)).collect());
    if let Some(r) = name.strip_prefix("cust:") {
        let mut it = r.split(':').filter_map(|v| v.parse::<f64>().ok());
        let (d, s) = (it.next()?, it.next()?);
        return u(&[d, s]);
    }
    match name {
        "dash" => u(&[4.0, 3.0]),
        "sysDash" => u(&[3.0, 1.0]),
        "dot" => u(&[1.0, 3.0]),
        "sysDot" => u(&[1.0, 1.0]),
        "dashDot" => u(&[4.0, 3.0, 1.0, 3.0]),
        "sysDashDot" => u(&[3.0, 1.0, 1.0, 1.0]),
        "lgDash" => u(&[8.0, 3.0]),
        "lgDashDot" => u(&[8.0, 3.0, 1.0, 3.0]),
        "lgDashDotDot" => u(&[8.0, 3.0, 1.0, 3.0, 1.0, 3.0]),
        "sysDashDotDot" => u(&[3.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
        _ => None,
    }
}

// ------------------------------------------------------------------ painting one shape

struct Paint<'p> {
    fill: &'p RFill,
    ln: Option<&'p RLn>,
    shadow: Option<(Rgb, f64, f64, f64, f64)>, // colour, alpha, dx, dy, blur
}

impl<'a> Rt<'a> {
    fn lin_coords(w: f64, h: f64, ang: f64) -> Vec<f64> {
        let a = ang.to_radians();
        let (dx, dy) = (a.cos(), a.sin());
        let len = (w * dx).abs() + (h * dy).abs();
        let (cx, cy) = (w / 2.0, h / 2.0);
        vec![cx - dx * len / 2.0, cy - dy * len / 2.0, cx + dx * len / 2.0, cy + dy * len / 2.0]
    }

    /// Fills the current clip region (already set by the caller) of a w x h box in local space.
    fn paint_fill(&mut self, out: &mut String, fill: &RFill, w: f64, h: f64) {
        match fill {
            RFill::None => {}
            RFill::Solid(c, a) => {
                // handled by the caller with `f` so that alpha works; here for clip-based fills
                let gs = (*a < 0.999).then(|| self.gs(*a));
                if let Some(g) = gs {
                    out.push_str(&format!("/{g} gs "));
                }
                out.push_str(&format!("{} 0 0 {} 0 0 re f\n", rgb_op(*c, false), "0"));
            }
            RFill::Grad { stops, alpha, lin, path } => {
                if *alpha < 0.999 {
                    let g = self.gs(*alpha);
                    out.push_str(&format!("/{g} gs "));
                }
                let rgb_stops: Vec<(f64, Rgb)> = stops.iter().map(|s| (s.0, s.1)).collect();
                let varying = stops.iter().any(|s| (s.2 - stops[0].2).abs() > 0.01);
                let (radial, coords) = if let Some((_, rect)) = path {
                    let (cx, cy) = (w * (rect[0] + (1.0 - rect[2])) / 2.0, h * (rect[1] + (1.0 - rect[3])) / 2.0);
                    let r = [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)].iter().map(|(x, y)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt()).fold(0.0, f64::max);
                    (true, vec![cx, cy, 0.0, cx, cy, r.max(1.0)])
                } else {
                    (false, Self::lin_coords(w, h, lin.map(|l| l.0).unwrap_or(0.0)))
                };
                if varying {
                    // per-stop transparency: a luminosity soft mask made from the same gradient in grey
                    let grey: Vec<(f64, Rgb)> = stops.iter().map(|s| (s.0, [s.2 * 255.0; 3])).collect();
                    let mask = self.shading(radial, coords.clone(), &grey);
                    let gs = self.soft_mask(&mask, w, h);
                    out.push_str(&format!("/{gs} gs "));
                } else if stops[0].2 < 0.999 {
                    let g = self.gs(stops[0].2);
                    out.push_str(&format!("/{g} gs "));
                }
                let name = self.shading(radial, coords, &rgb_stops);
                out.push_str(&format!("/{name} sh\n"));
            }
            RFill::Blip(b, duo) => {
                if let Some((name, iw, ih)) = b.path.as_deref().and_then(|p| self.image_fx(p, duo.as_ref(), b, (w, h))) {
                    let (l, t, r, bt) = (b.src[0], b.src[1], b.src[2], b.src[3]);
                    let fw = w / (1.0 - l - r).max(0.01);
                    let fh = h / (1.0 - t - bt).max(0.01);
                    let (ox, oy) = (-l * fw, -t * fh);
                    if b.alpha < 0.999 {
                        let g = self.gs(b.alpha);
                        out.push_str(&format!("/{g} gs "));
                    }
                    if let Some([tx, ty, sx, sy]) = b.tile {
                        let (tw, th) = (iw * 0.75 * sx, ih * 0.75 * sy);
                        if tw > 1.0 && th > 1.0 && (w / tw + 1.0) * (h / th + 1.0) < 6000.0 {
                            let mut yy = ty;
                            while yy < h {
                                let mut xx = tx;
                                while xx < w {
                                    out.push_str(&format!("q {} 0 0 {} {} {} cm /{name} Do Q\n", f(tw), f(-th), f(xx), f(yy + th)));
                                    xx += tw;
                                }
                                yy += th;
                            }
                            return;
                        }
                    }
                    // image space is the unit square, y up: flip into the y-down frame
                    out.push_str(&format!("q {} {} {} {} {} {} cm /{name} Do Q\n", f(fw), "0", "0", f(-fh), f(ox), f(oy + fh)));
                }
            }
            RFill::Patt(_, fg, bg) => {
                let c = [(fg[0] + bg[0]) / 2.0, (fg[1] + bg[1]) / 2.0, (fg[2] + bg[2]) / 2.0];
                out.push_str(&format!("{} 0 0 {} {} re f\n", rgb_op(c, false), "0", "0"));
            }
        }
    }

    /// Draws `paths` (local space, matrix `m` already applied by the caller) with fill, line and shadow.
    fn paint(&mut self, out: &mut String, paths: &[GPath], w: f64, h: f64, p: &Paint) {
        // shadow: the shape's silhouette offset, in the shadow colour (blur approximated by a few widened passes)
        if let Some((c, a, dx, dy, blur)) = p.shadow {
            let layers = if blur > 1.0 { 4 } else { 1 };
            for k in 0..layers {
                let widen = if layers > 1 { blur * (k as f64 + 1.0) / layers as f64 } else { 0.0 };
                let alpha = a / layers as f64 * if layers > 1 { 1.3 } else { 1.0 };
                let g = self.gs(alpha.clamp(0.0, 1.0));
                out.push_str(&format!("q /{g} gs {} 1 0 0 1 {} {} cm {} {} w 1 j ", rgb_op(c, false), f(dx), f(dy), rgb_op(c, true), f(widen)));
                for gp in paths.iter().filter(|g| g.fill) {
                    out.push_str(&path_ops(gp));
                    out.push_str(if widen > 0.0 { "B " } else { "f " });
                }
                out.push_str("Q\n");
            }
        }
        match p.fill {
            RFill::None => {}
            RFill::Solid(c, a) => {
                out.push_str("q ");
                if *a < 0.999 {
                    let g = self.gs(*a);
                    out.push_str(&format!("/{g} gs "));
                }
                out.push_str(&rgb_op(*c, false));
                out.push(' ');
                for gp in paths.iter().filter(|g| g.fill) {
                    out.push_str(&path_ops(gp));
                    out.push_str("f ");
                }
                out.push_str("Q\n");
            }
            other => {
                for gp in paths.iter().filter(|g| g.fill) {
                    out.push_str("q ");
                    out.push_str(&path_ops(gp));
                    out.push_str("W n\n");
                    let o = other.clone();
                    self.paint_fill(out, &o, w, h);
                    out.push_str("Q\n");
                }
            }
        }
        if let Some(l) = p.ln {
            let (lc, la) = match &l.fill {
                RFill::Solid(c, a) => (*c, *a),
                RFill::Grad { stops, .. } => (stops[0].1, stops[0].2),
                RFill::Patt(_, fg, _) => (*fg, 1.0),
                _ => return,
            };
            let lw = l.w.max(0.0);
            if lw <= 0.0 {
                return;
            }
            out.push_str("q ");
            if la < 0.999 {
                let g = self.gs(la);
                out.push_str(&format!("/{g} gs "));
            }
            out.push_str(&format!("{} {} w ", rgb_op(lc, true), f(lw)));
            out.push_str(match l.cap.as_deref() {
                Some("rnd") => "1 J ",
                Some("sq") => "2 J ",
                _ => "0 J ",
            });
            out.push_str(match l.join.as_deref() {
                Some("round") => "1 j ",
                Some("bevel") => "2 j ",
                _ => "0 j ",
            });
            if let Some(d) = l.dash.as_deref().and_then(|d| dash_array(d, lw)) {
                out.push_str(&format!("[{}] 0 d ", d.iter().map(|v| f(*v)).collect::<Vec<_>>().join(" ")));
            }
            for gp in paths.iter().filter(|g| g.stroke) {
                out.push_str(&path_ops(gp));
                out.push_str("S ");
            }
            out.push_str("Q\n");
            // arrowheads on the first open path
            if let Some(open) = paths.iter().find(|g| !g.cmds.iter().any(|c| matches!(c, G::Z))) {
                if let Some(a) = &l.tail {
                    if let Some((pt, dir)) = end_tangent(open, true) {
                        out.push_str(&arrowhead(a, pt, dir, lw, lc, la));
                    }
                }
                if let Some(a) = &l.head {
                    if let Some((pt, dir)) = end_tangent(open, false) {
                        out.push_str(&arrowhead(a, pt, dir, lw, lc, la));
                    }
                }
            }
        }
    }
}

/// Point and outward direction at the end (or start) of a path.
fn end_tangent(p: &GPath, end: bool) -> Option<((f64, f64), (f64, f64))> {
    let mut pts: Vec<(f64, f64)> = Vec::new();
    for c in &p.cmds {
        match *c {
            G::M(x, y) | G::L(x, y) => pts.push((x, y)),
            G::C(a, b, _, _, e, g) => {
                pts.push((a, b));
                pts.push((e, g));
            }
            G::Z => {}
        }
    }
    if pts.len() < 2 {
        return None;
    }
    let (pt, from) = if end { (pts[pts.len() - 1], pts[pts.len() - 2]) } else { (pts[0], pts[1]) };
    let (dx, dy) = (pt.0 - from.0, pt.1 - from.1);
    let l = dx.hypot(dy);
    if l < 1e-9 {
        // control point coincides with the end: look further back
        let q = if end { pts[pts.len().saturating_sub(3)] } else { pts[(2).min(pts.len() - 1)] };
        let (dx, dy) = (pt.0 - q.0, pt.1 - q.1);
        let l = dx.hypot(dy).max(1e-9);
        return Some((pt, (dx / l, dy / l)));
    }
    Some((pt, (dx / l, dy / l)))
}

fn arrowhead(a: &Arrow, pt: (f64, f64), dir: (f64, f64), lw: f64, c: Rgb, alpha: f64) -> String {
    let k = |s: &str| match s {
        "sm" => 2.0,
        "lg" => 5.0,
        _ => 3.0,
    };
    let lw = lw.max(1.0);
    let (aw, al) = (k(&a.w) * lw, k(&a.len) * lw);
    let (nx, ny) = (-dir.1, dir.0);
    let tip = pt;
    let base = (pt.0 - dir.0 * al, pt.1 - dir.1 * al);
    let pts: Vec<(f64, f64)> = match a.kind.as_str() {
        "triangle" => vec![tip, (base.0 + nx * aw / 2.0, base.1 + ny * aw / 2.0), (base.0 - nx * aw / 2.0, base.1 - ny * aw / 2.0)],
        "stealth" => vec![tip, (base.0 + nx * aw / 2.0, base.1 + ny * aw / 2.0), (pt.0 - dir.0 * al * 0.65, pt.1 - dir.1 * al * 0.65), (base.0 - nx * aw / 2.0, base.1 - ny * aw / 2.0)],
        "diamond" => {
            let mid = (pt.0 - dir.0 * al / 2.0, pt.1 - dir.1 * al / 2.0);
            vec![tip, (mid.0 + nx * aw / 2.0, mid.1 + ny * aw / 2.0), base, (mid.0 - nx * aw / 2.0, mid.1 - ny * aw / 2.0)]
        }
        "arrow" => {
            let mut s = format!("q {} {} w 1 j ", rgb_op(c, true), f(lw));
            let l = (base.0 + nx * aw / 2.0, base.1 + ny * aw / 2.0);
            let r = (base.0 - nx * aw / 2.0, base.1 - ny * aw / 2.0);
            s += &format!("{} {} m {} {} l {} {} l S Q\n", f(l.0), f(l.1), f(tip.0), f(tip.1), f(r.0), f(r.1));
            return s;
        }
        "oval" => {
            let ctr = (pt.0 - dir.0 * al / 2.0, pt.1 - dir.1 * al / 2.0);
            let mut s = format!("q {} ", rgb_op(c, false));
            let p = GPath { cmds: ellipse_g(ctr.0, ctr.1, al / 2.0, aw / 2.0), fill: true, stroke: false };
            s += &path_ops(&p);
            s += "f Q\n";
            return s;
        }
        _ => return String::new(),
    };
    let p = GPath { cmds: pts.iter().enumerate().map(|(i, q)| if i == 0 { G::M(q.0, q.1) } else { G::L(q.0, q.1) }).chain(std::iter::once(G::Z)).collect(), fill: true, stroke: false };
    let _ = alpha;
    format!("q {} {}f Q\n", rgb_op(c, false), path_ops(&p))
}

fn ellipse_g(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<G> {
    const K: f64 = 0.552_284_749_830_793_4;
    vec![G::M(cx - rx, cy), G::C(cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry), G::C(cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy), G::C(cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry), G::C(cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy), G::Z]
}

// ------------------------------------------------------------------ the shape stack

pub struct Eff<'e> {
    pub sp: &'e Sp,
    pub lay: Option<&'e Sp>,
    pub mas: Option<&'e Sp>,
}

fn norm_ty(t: &str) -> &str {
    match t {
        "ctrTitle" => "title",
        "subTitle" => "body",
        "obj" | "tbl" | "chart" | "dgm" | "media" | "clipArt" | "pic" => "body",
        t => t,
    }
}

fn find_ph<'x>(items: &'x [Item], ph: &Ph, by_idx_only: bool) -> Option<&'x Sp> {
    for it in items {
        match it {
            Item::Sp(s) => {
                if let Some(p) = &s.ph {
                    let idx_match = ph.idx.is_some() && p.idx == ph.idx && ph.idx != Some(0);
                    let ty_match = !by_idx_only && norm_ty(&p.ty) == norm_ty(&ph.ty) && (ph.idx.is_none() || p.idx.is_none() || ph.idx == Some(0) || p.idx == Some(0) || ph.idx == p.idx);
                    if idx_match || ty_match {
                        return Some(s);
                    }
                }
            }
            Item::Grp(_, ch) => {
                if let Some(s) = find_ph(ch, ph, by_idx_only) {
                    return Some(s);
                }
            }
            _ => {}
        }
    }
    None
}

impl<'e> Eff<'e> {
    pub fn xfrm(&self) -> Option<&'e Xfrm> {
        self.sp.xfrm.as_ref().or_else(|| self.lay.and_then(|l| l.xfrm.as_ref())).or_else(|| self.mas.and_then(|m| m.xfrm.as_ref()))
    }
    pub fn geom(&self) -> Option<&'e Geom> {
        self.sp.geom.as_ref().or_else(|| self.lay.and_then(|l| l.geom.as_ref())).or_else(|| self.mas.and_then(|m| m.geom.as_ref()))
    }
    pub fn fill(&self) -> Option<&'e Fill> {
        self.sp.fill.as_ref().or_else(|| self.lay.and_then(|l| l.fill.as_ref())).or_else(|| self.mas.and_then(|m| m.fill.as_ref()))
    }
    pub fn ln(&self) -> Ln {
        let mut l = self.sp.ln.clone();
        for o in [self.lay, self.mas].into_iter().flatten() {
            let b = &o.ln;
            l.w = l.w.or(b.w);
            l.fill = l.fill.or_else(|| b.fill.clone());
            l.dash = l.dash.or_else(|| b.dash.clone());
            l.cap = l.cap.or_else(|| b.cap.clone());
            l.join = l.join.or_else(|| b.join.clone());
            l.head = l.head.or_else(|| b.head.clone());
            l.tail = l.tail.or_else(|| b.tail.clone());
        }
        l
    }
    pub fn style(&self) -> Option<&'e StyleRefs> {
        self.sp.style.as_ref().or_else(|| self.lay.and_then(|l| l.style.as_ref())).or_else(|| self.mas.and_then(|m| m.style.as_ref()))
    }
}

fn text_rect(g: Option<&Geom>, w: f64, h: f64) -> (f64, f64, f64, f64) {
    if let Some(Geom::Prst(n, av)) = g {
        let ss = w.min(h);
        match n.as_str() {
            "ellipse" | "flowChartConnector" => return (w * 0.1464, h * 0.1464, w * 0.8536, h * 0.8536),
            "roundRect" => {
                let r = ss * av.get("adj").copied().unwrap_or(16667.0).clamp(0.0, 50000.0) / 100000.0;
                let i = r * 0.29289;
                return (i, i, w - i, h - i);
            }
            "diamond" | "flowChartDecision" => return (w / 4.0, h / 4.0, w * 0.75, h * 0.75),
            "triangle" => return (w / 4.0, h / 2.0, w * 0.75, h),
            "parallelogram" => return (w * 0.1, 0.0, w * 0.9, h),
            "hexagon" => return (w * 0.1, h * 0.1, w * 0.9, h * 0.9),
            "octagon" => return (w * 0.1464, h * 0.1464, w * 0.8536, h * 0.8536),
            _ => {}
        }
    }
    (0.0, 0.0, w, h)
}

/// Shape matrix: local (0..w, 0..h) -> page, with group scale folded into w/h.
fn shape_frame(x: &Xfrm, fr: &Frame) -> (Mat, f64, f64) {
    let (cx, cy) = (x.x + x.w / 2.0, x.y + x.h / 2.0);
    let (pcx, pcy) = app(&fr.m, cx, cy);
    let sx = fr.m[0].hypot(fr.m[1]);
    let sy = fr.m[2].hypot(fr.m[3]);
    let det = fr.m[0] * fr.m[3] - fr.m[1] * fr.m[2];
    let group_rot = fr.m[1].atan2(fr.m[0]).to_degrees();
    let (w, h) = (x.w * sx, x.h * sy);
    let mut fx = if x.flip_h { -1.0 } else { 1.0 };
    let fy = if x.flip_v { -1.0 } else { 1.0 };
    let mut r = x.rot;
    if det < 0.0 {
        fx = -fx;
        r = -r;
    }
    let m = mul(&mul(&mul(&tr(-w / 2.0, -h / 2.0), &sc(fx, fy)), &rot(r + group_rot)), &tr(pcx, pcy));
    (m, w, h)
}

impl<'a> Rt<'a> {
    pub fn draw_items(&mut self, out: &mut String, items: &[Item], env: &Env, fr: &Frame, layout_items: Option<&[Item]>, master_items: Option<&[Item]>, skip_ph: bool) -> Result<()> {
        for it in items {
            match it {
                Item::Sp(sp) => {
                    if sp.hidden || (skip_ph && sp.ph.is_some()) {
                        continue;
                    }
                    let (lay, mas) = match &sp.ph {
                        Some(ph) => {
                            let lay = layout_items.and_then(|l| find_ph(l, ph, false));
                            let mas = master_items.and_then(|m| find_ph(m, &Ph { ty: ph.ty.clone(), idx: None }, false));
                            (lay, mas)
                        }
                        None => (None, None),
                    };
                    self.draw_sp(out, &Eff { sp, lay, mas }, env, &Frame { m: fr.m })?;
                }
                Item::Pic(p) => self.draw_pic(out, p, env, &Frame { m: fr.m })?,
                Item::Grp(x, children) => {
                    let ch = x.ch.unwrap_or([x.x, x.y, x.w, x.h]);
                    let (sx, sy) = (if ch[2] != 0.0 { x.w / ch[2] } else { 1.0 }, if ch[3] != 0.0 { x.h / ch[3] } else { 1.0 });
                    let mut m = mul(&mul(&tr(-ch[0], -ch[1]), &sc(sx, sy)), &tr(x.x, x.y));
                    if x.rot != 0.0 || x.flip_h || x.flip_v {
                        let (cx, cy) = (x.x + x.w / 2.0, x.y + x.h / 2.0);
                        let g = mul(&mul(&mul(&tr(-cx, -cy), &sc(if x.flip_h { -1.0 } else { 1.0 }, if x.flip_v { -1.0 } else { 1.0 })), &rot(x.rot)), &tr(cx, cy));
                        m = mul(&m, &g);
                    }
                    let m = mul(&m, &fr.m);
                    self.draw_items(out, children, env, &Frame { m }, layout_items, master_items, skip_ph)?;
                }
                Item::Table(t) => self.draw_table(out, t, env, &Frame { m: fr.m })?,
                Item::Chart(..) => {}
            }
        }
        Ok(())
    }
}

impl<'a> Rt<'a> {
    fn eff_paint(&self, e: &Eff, env: &Env) -> (RFill, Option<RLn>, Option<(Rgb, f64, f64, f64, f64)>) {
        let st = e.style();
        let ph_color = |c: &Option<super::color::ColorSpec>| c.as_ref().map(|c| env.color(c, None));
        let fill = match e.fill() {
            Some(f) => env.fill(f, None),
            None => match st.and_then(|s| s.fill.as_ref()) {
                Some((idx, c)) => env.style_fill(*idx, c.as_ref()).unwrap_or(RFill::None),
                None => RFill::None,
            },
        };
        let mut ln = e.ln();
        let mut line: Option<RLn> = None;
        if let Some((idx, c)) = st.and_then(|s| s.ln.as_ref()) {
            if let Some(base) = idx.checked_sub(1).and_then(|i| env.theme.lines.get(i)) {
                let ph = ph_color(c);
                ln.w = ln.w.or(base.w);
                ln.fill = ln.fill.or_else(|| base.fill.clone());
                ln.dash = ln.dash.or_else(|| base.dash.clone());
                ln.cap = ln.cap.or_else(|| base.cap.clone());
                ln.join = ln.join.or_else(|| base.join.clone());
                let rl = env.ln(&ln, ph);
                line = Some(rl);
            }
        }
        if line.is_none() && ln.fill.is_some() {
            line = Some(env.ln(&ln, None));
        }
        let shadow = e.sp.effects.shadow.clone().or_else(|| if e.sp.effects.explicit { None } else { st.and_then(|s| s.effect).and_then(|i| i.checked_sub(1)).and_then(|i| env.theme.effects.get(i)).and_then(|e| e.shadow.clone()) }).map(|s| {
            let (rgb, a) = env.color(&s.color, None);
            let ang = s.dir.to_radians();
            (rgb, a, s.dist * ang.cos(), s.dist * ang.sin(), s.blur)
        });
        (fill, line, shadow)
    }

    fn draw_sp(&mut self, out: &mut String, e: &Eff, env: &Env, fr: &Frame) -> Result<()> {
        let Some(x) = e.xfrm() else { return Ok(()) };
        let (m, w, h) = shape_frame(x, fr);
        if w <= 0.0 && h <= 0.0 {
            return Ok(());
        }
        let (fill, line, shadow) = self.eff_paint(e, env);
        let geom = e.geom();
        let connector = e.sp.connector;
        let has_text = e.sp.tx.as_ref().map_or(false, |t| t.paras.iter().any(|p| p.runs.iter().any(|r| !r.text.is_empty())));
        let is_ph_empty = false;
        let paths = match (geom, e.sp.ph.is_some() || e.sp.text_box) {
            (Some(g), _) => geom::paths(g, w, h),
            (None, true) if e.sp.fill.is_none() && !matches!(fill, RFill::Solid(..) | RFill::Grad { .. } | RFill::Blip(..)) => Vec::new(),
            (None, _) => geom::preset("rect", &HashMap::new(), w, h),
        };
        out.push_str(&format!("q {}\n", cm(&m)));
        let is_line = connector || matches!(geom, Some(Geom::Prst(n, _)) if n == "line" || n.contains("Connector"));
        let fill_eff = if is_line { RFill::None } else { fill };
        if !is_ph_empty {
            let paint = Paint { fill: &fill_eff, ln: line.as_ref(), shadow: if matches!(fill_eff, RFill::None) && line.is_none() { None } else { shadow } };
            self.paint(out, &paths, w, h, &paint);
            if let Some((blend, of)) = &e.sp.effects.overlay {
                let rf = env.fill(of, None);
                let mode = match blend.as_str() {
                    "mult" => "Multiply",
                    "screen" => "Screen",
                    "darken" => "Darken",
                    "lighten" => "Lighten",
                    _ => "Normal",
                };
                let gs = self.blend_gs(mode);
                out.push_str(&format!("q /{gs} gs\n"));
                self.paint(out, &paths, w, h, &Paint { fill: &rf, ln: None, shadow: None });
                out.push_str("Q\n");
            }
        }
        if let Some(tx) = &e.sp.tx {
            if has_text {
                self.draw_shape_text(out, e, tx, env, w, h)?;
            }
        }
        out.push_str("Q\n");
        Ok(())
    }

    fn draw_pic(&mut self, out: &mut String, p: &Pic, env: &Env, fr: &Frame) -> Result<()> {
        let (m, w, h) = shape_frame(&p.xfrm, fr);
        let paths = match &p.geom {
            Some(g) => geom::paths(g, w, h),
            None => geom::preset("rect", &HashMap::new(), w, h),
        };
        let line = if p.ln.fill.is_some() { Some(env.ln(&p.ln, None)) } else { None };
        out.push_str(&format!("q {}\n", cm(&m)));
        if let Some(s) = &p.effects.shadow {
            let (rgb, a) = env.color(&s.color, None);
            let ang = s.dir.to_radians();
            let none = RFill::Solid(rgb, a);
            let paint = Paint { fill: &none, ln: None, shadow: None };
            let mut o = String::new();
            self.paint(&mut o, &paths, w, h, &Paint { fill: paint.fill, ln: None, shadow: None });
            out.push_str(&format!("q 1 0 0 1 {} {} cm {}Q\n", f(s.dist * ang.cos()), f(s.dist * ang.sin()), o));
        }
        let fill = RFill::Blip(p.blip.clone(), p.blip.duotone.as_ref().map(|(a, c)| (env.color(a, None).0, env.color(c, None).0)));
        self.paint(out, &paths, w, h, &Paint { fill: &fill, ln: line.as_ref(), shadow: None });
        out.push_str("Q\n");
        Ok(())
    }
}

pub fn text_rect_pub(g: Option<&Geom>, w: f64, h: f64) -> (f64, f64, f64, f64) {
    text_rect(g, w, h)
}

pub fn frame_for(x: &Xfrm, fr: &Frame) -> (Mat, f64, f64) {
    shape_frame(x, fr)
}

impl<'a> Rt<'a> {
    pub fn gs_name(&mut self, alpha: f64) -> String {
        self.gs(alpha)
    }
    pub fn paint_pub(&mut self, out: &mut String, paths: &[GPath], w: f64, h: f64, fill: &RFill) {
        self.paint(out, paths, w, h, &Paint { fill, ln: None, shadow: None });
    }
    pub fn stroke_pub(&mut self, out: &mut String, paths: &[GPath], ln: &RLn) {
        self.paint(out, paths, 0.0, 0.0, &Paint { fill: &RFill::None, ln: Some(ln), shadow: None });
    }
}

/// RGB pixels of a PNG or JPEG.
fn decode_rgb(bytes: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    if bytes.len() > 1 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        let mut d = jpeg_decoder::Decoder::new(bytes);
        let px = d.decode().ok()?;
        let info = d.info()?;
        let (w, h) = (info.width as usize, info.height as usize);
        let rgb = match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => px,
            jpeg_decoder::PixelFormat::L8 => px.iter().flat_map(|v| [*v, *v, *v]).collect(),
            jpeg_decoder::PixelFormat::CMYK32 => px.chunks_exact(4).flat_map(|c| [255 - c[0].max(c[3]).min(255), 255 - c[1].max(c[3]).min(255), 255 - c[2].max(c[3]).min(255)]).collect(),
            _ => return None,
        };
        return Some((w, h, rgb));
    }
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut rd = dec.read_info().ok()?;
    let mut buf = vec![0; rd.output_buffer_size()?];
    let info = rd.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let rgb: Vec<u8> = match info.color_type {
        png::ColorType::Rgb => buf[..w * h * 3].to_vec(),
        png::ColorType::Rgba => buf[..w * h * 4].chunks_exact(4).flat_map(|c| [c[0], c[1], c[2]]).collect(),
        png::ColorType::Grayscale => buf[..w * h].iter().flat_map(|v| [*v, *v, *v]).collect(),
        png::ColorType::GrayscaleAlpha => buf[..w * h * 2].chunks_exact(2).flat_map(|c| [c[0], c[0], c[0]]).collect(),
        _ => return None,
    };
    Some((w, h, rgb))
}

/// Bytes the PDF writer can embed: PNG and JPEG as they are; SVG rasterised at about 3x its drawn size;
/// GIF, BMP, TIFF and WebP re-encoded as PNG. Returns (bytes, is_png).
fn to_embeddable(bytes: &[u8], hint: (f64, f64)) -> Option<(Vec<u8>, bool)> {
    if bytes.len() > 1 && bytes[0] == 0x89 && bytes[1] == 0x50 {
        return Some((bytes.to_vec(), true));
    }
    if bytes.len() > 1 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        return Some((bytes.to_vec(), false));
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_lowercase();
    if head.contains("<svg") || head.trim_start().starts_with("<?xml") {
        let tree = resvg::usvg::Tree::from_data(bytes, &resvg::usvg::Options::default()).ok()?;
        let size = tree.size();
        let (sw, sh) = (size.width() as f64, size.height() as f64);
        if sw <= 0.0 || sh <= 0.0 {
            return None;
        }
        let k = (3.0 * (hint.0 / sw).max(hint.1 / sh)).clamp(1.0, 8.0);
        let (pw, ph) = (((sw * k).ceil() as u32).clamp(1, 3000), ((sh * k).ceil() as u32).clamp(1, 3000));
        let mut pm = resvg::tiny_skia::Pixmap::new(pw, ph)?;
        resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(pw as f32 / size.width(), ph as f32 / size.height()), &mut pm.as_mut());
        let mut rgba = Vec::with_capacity(pm.data().len());
        for p in pm.pixels() {
            let c = p.demultiply();
            rgba.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
        }
        return Some((encode_png_rgba(&rgba, pw, ph)?, true));
    }
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    Some((encode_png_rgba(img.as_raw(), w, h)?, true))
}

fn encode_png_rgba(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(rgba).ok()?;
    }
    Some(out)
}
