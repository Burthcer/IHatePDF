//! The presentation as plain owned data: theme, masters, layouts, slides with their shape trees. Reading
//! only; drawing is in render.rs. Names follow DrawingML (a:, p:), matched by local name.

use super::color::{hex, parse_color, ColorSpec, Rgb};
use crate::compress::{Error, Result};
use roxmltree::{Document, Node};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

pub const EMU: f64 = 12700.0;

pub fn ch<'a, 'b>(n: Node<'a, 'b>, name: &str) -> Option<Node<'a, 'b>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}
pub fn chs<'a, 'b: 'a>(n: Node<'a, 'b>, name: &'a str) -> impl Iterator<Item = Node<'a, 'b>> + 'a {
    n.children().filter(move |c| c.is_element() && c.tag_name().name() == name)
}
fn af(n: Node, k: &str) -> Option<f64> {
    n.attribute(k).and_then(|v| v.parse::<f64>().ok())
}
fn ab(n: Node, k: &str) -> Option<bool> {
    n.attribute(k).map(|v| v == "1" || v == "true")
}

// ------------------------------------------------------------------ package

pub struct Pkg {
    z: zip::ZipArchive<std::fs::File>,
    pub names: Vec<String>,
}

impl Pkg {
    pub fn open(path: &Path) -> Result<Pkg> {
        let z = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|e| Error::Msg(e.to_string()))?;
        let names = (0..z.len()).map(|i| z.name_for_index(i).and_then(|n| n.ok()).map(|n| n.to_string()).unwrap_or_default()).collect();
        Ok(Pkg { z, names })
    }
    pub fn has(&self, n: &str) -> bool {
        self.names.iter().any(|x| x == n)
    }
    pub fn read(&mut self, name: &str) -> Option<Vec<u8>> {
        let mut e = self.z.by_name(name).ok()?;
        let mut v = Vec::with_capacity(e.size() as usize);
        e.read_to_end(&mut v).ok()?;
        Some(v)
    }
    pub fn text(&mut self, name: &str) -> Option<String> {
        self.read(name).map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    /// Relationships of a part: id -> (type suffix, absolute part path).
    pub fn rels(&mut self, part: &str) -> HashMap<String, (String, String)> {
        let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
        let path = format!("{dir}/_rels/{file}.rels");
        let mut out = HashMap::new();
        let Some(xml) = self.text(&path) else { return out };
        let Ok(doc) = Document::parse(&xml) else { return out };
        for r in doc.descendants().filter(|n| n.tag_name().name() == "Relationship") {
            let (Some(id), Some(ty), Some(target)) = (r.attribute("Id"), r.attribute("Type"), r.attribute("Target")) else { continue };
            if r.attribute("TargetMode") == Some("External") {
                continue;
            }
            out.insert(id.to_string(), (ty.rsplit('/').next().unwrap_or(ty).to_string(), resolve_path(dir, target)));
        }
        out
    }
}

fn resolve_path(dir: &str, target: &str) -> String {
    if let Some(t) = target.strip_prefix('/') {
        return t.to_string();
    }
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    parts.join("/")
}

// ------------------------------------------------------------------ fills, lines, effects

#[derive(Clone, Debug, Default)]
pub struct Xfrm {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rot: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    /// Group child space: chOff x, y, chExt w, h.
    pub ch: Option<[f64; 4]>,
}

#[derive(Clone, Debug)]
pub struct Grad {
    pub stops: Vec<(f64, ColorSpec)>,
    pub lin: Option<(f64, bool)>,
    pub path: Option<(String, [f64; 4])>,
}

#[derive(Clone, Debug)]
pub struct Blip {
    pub path: Option<String>,
    pub src: [f64; 4],
    /// `tile`: x/y offset in pt and x/y scale.
    pub tile: Option<[f64; 4]>,
    pub alpha: f64,
    /// `duotone`: shadow and highlight colours.
    pub duotone: Option<(ColorSpec, ColorSpec)>,
    pub gray: bool,
    pub bright: f64,
    pub contrast: f64,
}

fn tile_of(n: Node) -> Option<[f64; 4]> {
    ch(n, "tile").map(|t| [af(t, "tx").unwrap_or(0.0) / EMU, af(t, "ty").unwrap_or(0.0) / EMU, af(t, "sx").unwrap_or(100000.0) / 100000.0, af(t, "sy").unwrap_or(100000.0) / 100000.0])
}

/// Blip effects of an `a:blip` element.
fn blip_effects(b: Option<Node>) -> (f64, Option<(ColorSpec, ColorSpec)>, bool, f64, f64) {
    let Some(b) = b else { return (1.0, None, false, 0.0, 0.0) };
    let alpha = ch(b, "alphaModFix").and_then(|a| af(a, "amt")).map(|v| v / 100000.0).unwrap_or(1.0);
    let duo = ch(b, "duotone").and_then(|d| {
        let mut cs = d.children().filter(|n| n.is_element()).filter_map(|n| {
            let wrap = n;
            // each child is itself a colour element: parse it through a one-child view
            super::color::parse_color_el(wrap)
        });
        Some((cs.next()?, cs.next()?))
    });
    let lum = ch(b, "lum");
    (alpha, duo, ch(b, "grayscl").is_some(), lum.and_then(|l| af(l, "bright")).unwrap_or(0.0) / 100000.0, lum.and_then(|l| af(l, "contrast")).unwrap_or(0.0) / 100000.0)
}

#[derive(Clone, Debug)]
pub enum Fill {
    None,
    Solid(ColorSpec),
    Grad(Grad),
    Blip(Blip),
    Patt(String, ColorSpec, ColorSpec),
    /// `grpFill`: whatever the enclosing group says (taken as none).
    Group,
}

#[derive(Clone, Debug, Default)]
pub struct Arrow {
    pub kind: String,
    pub w: String,
    pub len: String,
}

#[derive(Clone, Debug, Default)]
pub struct Ln {
    pub w: Option<f64>,
    pub fill: Option<Fill>,
    pub dash: Option<String>,
    pub cap: Option<String>,
    pub join: Option<String>,
    pub head: Option<Arrow>,
    pub tail: Option<Arrow>,
}

#[derive(Clone, Debug)]
pub struct Shadow {
    pub blur: f64,
    pub dist: f64,
    pub dir: f64,
    pub color: ColorSpec,
    pub sx: f64,
    pub sy: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Effects {
    pub shadow: Option<Shadow>,
    /// `fillOverlay`: blend mode and fill drawn over the shape's own fill.
    pub overlay: Option<(String, Box<Fill>)>,
    /// An `effectLst` element is present (even an empty one switches the theme's effects off).
    pub explicit: bool,
}

pub fn parse_xfrm(n: Node) -> Xfrm {
    let mut x = Xfrm::default();
    if let Some(o) = ch(n, "off") {
        x.x = af(o, "x").unwrap_or(0.0) / EMU;
        x.y = af(o, "y").unwrap_or(0.0) / EMU;
    }
    if let Some(e) = ch(n, "ext") {
        x.w = af(e, "cx").unwrap_or(0.0) / EMU;
        x.h = af(e, "cy").unwrap_or(0.0) / EMU;
    }
    x.rot = af(n, "rot").unwrap_or(0.0) / 60000.0;
    x.flip_h = ab(n, "flipH").unwrap_or(false);
    x.flip_v = ab(n, "flipV").unwrap_or(false);
    if let (Some(o), Some(e)) = (ch(n, "chOff"), ch(n, "chExt")) {
        x.ch = Some([af(o, "x").unwrap_or(0.0) / EMU, af(o, "y").unwrap_or(0.0) / EMU, af(e, "cx").unwrap_or(0.0) / EMU, af(e, "cy").unwrap_or(0.0) / EMU]);
    }
    x
}

fn rect_attrs(n: Node, names: [&str; 4]) -> [f64; 4] {
    [0, 1, 2, 3].map(|i| af(n, names[i]).unwrap_or(0.0) / 100000.0)
}

/// The fill element among the children of `parent` (`spPr`, `bgPr`, `tcPr`, `fillStyleLst` entry...).
pub fn parse_fill(parent: Node, rels: &HashMap<String, (String, String)>) -> Option<Fill> {
    for n in parent.children().filter(|n| n.is_element()) {
        return Some(match n.tag_name().name() {
            "noFill" => Fill::None,
            "solidFill" => Fill::Solid(parse_color(n)?),
            "grpFill" => Fill::Group,
            "gradFill" => {
                let mut stops: Vec<(f64, ColorSpec)> = Vec::new();
                if let Some(l) = ch(n, "gsLst") {
                    for gs in chs(l, "gs") {
                        if let Some(c) = parse_color(gs) {
                            stops.push((af(gs, "pos").unwrap_or(0.0) / 100000.0, c));
                        }
                    }
                }
                if stops.is_empty() {
                    continue;
                }
                stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                let lin = ch(n, "lin").map(|l| (af(l, "ang").unwrap_or(0.0) / 60000.0, ab(l, "scaled").unwrap_or(false)));
                let path = ch(n, "path").map(|p| (p.attribute("path").unwrap_or("circle").to_string(), ch(p, "fillToRect").map(|r| rect_attrs(r, ["l", "t", "r", "b"])).unwrap_or([0.5, 0.5, 0.5, 0.5])));
                Fill::Grad(Grad { stops, lin: if path.is_some() { None } else { lin.or(Some((0.0, false))) }, path })
            }
            "blipFill" => {
                let blip = ch(n, "blip");
                let path = blip.and_then(blip_embed).and_then(|id| rels.get(id)).map(|r| r.1.clone());
                let (alpha, duotone, gray, bright, contrast) = blip_effects(blip);
                let src = ch(n, "srcRect").map(|r| rect_attrs(r, ["l", "t", "r", "b"])).unwrap_or([0.0; 4]);
                Fill::Blip(Blip { path, src, tile: tile_of(n), alpha, duotone, gray, bright, contrast })
            }
            "pattFill" => Fill::Patt(n.attribute("prst").unwrap_or("").to_string(), ch(n, "fgClr").and_then(parse_color)?, ch(n, "bgClr").and_then(parse_color)?),
            _ => continue,
        });
    }
    None
}

pub fn parse_ln(n: Node, rels: &HashMap<String, (String, String)>) -> Ln {
    let arrow = |e: Option<Node>| {
        e.and_then(|a| {
            let k = a.attribute("type").unwrap_or("none");
            (k != "none").then(|| Arrow { kind: k.to_string(), w: a.attribute("w").unwrap_or("med").to_string(), len: a.attribute("len").unwrap_or("med").to_string() })
        })
    };
    let dash = ch(n, "prstDash").and_then(|d| d.attribute("val")).map(|s| s.to_string()).or_else(|| {
        ch(n, "custDash").map(|c| {
            // Approximated by the first dash/space pair, as a preset name.
            let d = chs(c, "ds").next();
            let (dv, sv) = d.map(|d| (af(d, "d").unwrap_or(100000.0), af(d, "sp").unwrap_or(100000.0))).unwrap_or((100000.0, 100000.0));
            format!("cust:{}:{}", dv / 100000.0, sv / 100000.0)
        })
    });
    Ln {
        w: af(n, "w").map(|v| v / EMU),
        fill: parse_fill(n, rels),
        dash,
        cap: n.attribute("cap").map(|s| s.to_string()),
        join: if ch(n, "round").is_some() { Some("round".into()) } else if ch(n, "bevel").is_some() { Some("bevel".into()) } else if ch(n, "miter").is_some() { Some("miter".into()) } else { None },
        head: arrow(ch(n, "headEnd")),
        tail: arrow(ch(n, "tailEnd")),
    }
}

pub fn parse_effects(n: Node) -> Effects {
    let mut e = Effects::default();
    if let Some(l) = ch(n, "effectLst") {
        e.explicit = true;
        if let Some(o) = ch(l, "fillOverlay") {
            if let Some(f) = parse_fill_of_parent(o) {
                e.overlay = Some((o.attribute("blend").unwrap_or("over").to_string(), Box::new(f)));
            }
        }
        if let Some(s) = ch(l, "outerShdw") {
            if let Some(color) = parse_color(s) {
                e.shadow = Some(Shadow { blur: af(s, "blurRad").unwrap_or(0.0) / EMU, dist: af(s, "dist").unwrap_or(0.0) / EMU, dir: af(s, "dir").unwrap_or(0.0) / 60000.0, color, sx: af(s, "sx").unwrap_or(100000.0) / 100000.0, sy: af(s, "sy").unwrap_or(100000.0) / 100000.0 });
            }
        }
    }
    e
}

// ------------------------------------------------------------------ geometry

#[derive(Clone, Debug)]
pub enum PCmd {
    M(f64, f64),
    L(f64, f64),
    C(f64, f64, f64, f64, f64, f64),
    Q(f64, f64, f64, f64),
    /// wR, hR, start angle, swing (degrees)
    Arc(f64, f64, f64, f64),
    Z,
}

#[derive(Clone, Debug)]
pub struct CPath {
    pub w: f64,
    pub h: f64,
    pub fill: bool,
    pub stroke: bool,
    pub cmds: Vec<PCmd>,
}

#[derive(Clone, Debug)]
pub enum Geom {
    Prst(String, HashMap<String, f64>),
    Cust(Vec<CPath>),
}

fn parse_geom(sp_pr: Node) -> Option<Geom> {
    if let Some(p) = ch(sp_pr, "prstGeom") {
        let mut av = HashMap::new();
        if let Some(l) = ch(p, "avLst") {
            for g in chs(l, "gd") {
                if let (Some(name), Some(f)) = (g.attribute("name"), g.attribute("fmla")) {
                    if let Some(v) = f.strip_prefix("val ").and_then(|v| v.trim().parse::<f64>().ok()) {
                        av.insert(name.to_string(), v);
                    }
                }
            }
        }
        return Some(Geom::Prst(p.attribute("prst").unwrap_or("rect").to_string(), av));
    }
    let c = ch(sp_pr, "custGeom")?;
    let mut paths = Vec::new();
    for p in chs(ch(c, "pathLst")?, "path") {
        let pt = |n: Node| -> (f64, f64) {
            let q = ch(n, "pt");
            q.map(|q| (af(q, "x").unwrap_or(0.0), af(q, "y").unwrap_or(0.0))).unwrap_or((0.0, 0.0))
        };
        let pts = |n: Node| -> Vec<(f64, f64)> { chs(n, "pt").map(|q| (af(q, "x").unwrap_or(0.0), af(q, "y").unwrap_or(0.0))).collect() };
        let mut cmds = Vec::new();
        for s in p.children().filter(|n| n.is_element()) {
            match s.tag_name().name() {
                "moveTo" => {
                    let (x, y) = pt(s);
                    cmds.push(PCmd::M(x, y));
                }
                "lnTo" => {
                    let (x, y) = pt(s);
                    cmds.push(PCmd::L(x, y));
                }
                "cubicBezTo" => {
                    let v = pts(s);
                    if v.len() == 3 {
                        cmds.push(PCmd::C(v[0].0, v[0].1, v[1].0, v[1].1, v[2].0, v[2].1));
                    }
                }
                "quadBezTo" => {
                    let v = pts(s);
                    if v.len() == 2 {
                        cmds.push(PCmd::Q(v[0].0, v[0].1, v[1].0, v[1].1));
                    }
                }
                "arcTo" => cmds.push(PCmd::Arc(af(s, "wR").unwrap_or(0.0), af(s, "hR").unwrap_or(0.0), af(s, "stAng").unwrap_or(0.0) / 60000.0, af(s, "swAng").unwrap_or(0.0) / 60000.0)),
                "close" => cmds.push(PCmd::Z),
                _ => {}
            }
        }
        paths.push(CPath { w: af(p, "w").unwrap_or(0.0), h: af(p, "h").unwrap_or(0.0), fill: p.attribute("fill") != Some("none"), stroke: p.attribute("stroke") != Some("0") && p.attribute("stroke") != Some("false"), cmds });
    }
    Some(Geom::Cust(paths))
}

// ------------------------------------------------------------------ text

#[derive(Clone, Debug, Default)]
pub struct RProps {
    pub sz: Option<f64>,
    pub b: Option<bool>,
    pub i: Option<bool>,
    pub u: Option<String>,
    pub strike: Option<bool>,
    pub baseline: Option<f64>,
    pub cap: Option<String>,
    pub spc: Option<f64>,
    pub fill: Option<Fill>,
    pub latin: Option<String>,
    pub ea: Option<String>,
    pub cs: Option<String>,
    pub hyper: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum Spc {
    Pct(f64),
    Pts(f64),
}

#[derive(Clone, Debug)]
pub enum Bu {
    None,
    Char(String),
    Auto(String, i64),
}

#[derive(Clone, Debug, Default)]
pub struct PProps {
    pub mar_l: Option<f64>,
    pub indent: Option<f64>,
    pub algn: Option<String>,
    pub ln_spc: Option<Spc>,
    pub spc_bef: Option<Spc>,
    pub spc_aft: Option<Spc>,
    pub bu: Option<Bu>,
    pub bu_clr: Option<ColorSpec>,
    pub bu_sz: Option<f64>,
    pub bu_font: Option<String>,
    pub def_r: RProps,
}

impl PProps {
    /// `self` over `base`: fields set here win.
    pub fn over(&self, base: &PProps) -> PProps {
        PProps {
            mar_l: self.mar_l.or(base.mar_l),
            indent: self.indent.or(base.indent),
            algn: self.algn.clone().or_else(|| base.algn.clone()),
            ln_spc: self.ln_spc.or(base.ln_spc),
            spc_bef: self.spc_bef.or(base.spc_bef),
            spc_aft: self.spc_aft.or(base.spc_aft),
            bu: self.bu.clone().or_else(|| base.bu.clone()),
            bu_clr: self.bu_clr.clone().or_else(|| base.bu_clr.clone()),
            bu_sz: self.bu_sz.or(base.bu_sz),
            bu_font: self.bu_font.clone().or_else(|| base.bu_font.clone()),
            def_r: self.def_r.over(&base.def_r),
        }
    }
}

impl RProps {
    pub fn over(&self, base: &RProps) -> RProps {
        RProps {
            sz: self.sz.or(base.sz),
            b: self.b.or(base.b),
            i: self.i.or(base.i),
            u: self.u.clone().or_else(|| base.u.clone()),
            strike: self.strike.or(base.strike),
            baseline: self.baseline.or(base.baseline),
            cap: self.cap.clone().or_else(|| base.cap.clone()),
            spc: self.spc.or(base.spc),
            fill: self.fill.clone().or_else(|| base.fill.clone()),
            latin: self.latin.clone().or_else(|| base.latin.clone()),
            ea: self.ea.clone().or_else(|| base.ea.clone()),
            cs: self.cs.clone().or_else(|| base.cs.clone()),
            hyper: self.hyper || base.hyper,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LstStyle {
    pub def: Option<PProps>,
    pub lvls: [Option<PProps>; 9],
}

impl LstStyle {
    pub fn level(&self, l: usize) -> PProps {
        let base = self.def.clone().unwrap_or_default();
        match &self.lvls[l.min(8)] {
            Some(p) => p.over(&base),
            None => base,
        }
    }
}

#[derive(Clone, Debug)]
pub enum RunKind {
    Text,
    Br,
}

#[derive(Clone, Debug)]
pub struct Run {
    pub kind: RunKind,
    pub text: String,
    pub rp: RProps,
}

#[derive(Clone, Debug, Default)]
pub struct Para {
    pub lvl: usize,
    pub pp: PProps,
    pub runs: Vec<Run>,
    pub end_rp: RProps,
}

#[derive(Clone, Debug, Default)]
pub struct BodyPr {
    pub l: Option<f64>,
    pub t: Option<f64>,
    pub r: Option<f64>,
    pub b: Option<f64>,
    pub anchor: Option<String>,
    pub wrap: Option<String>,
    pub rot: f64,
    pub vert: Option<String>,
    pub font_scale: Option<f64>,
    pub ln_reduction: Option<f64>,
    pub autofit: Option<String>,
}

impl BodyPr {
    pub fn over(&self, base: &BodyPr) -> BodyPr {
        BodyPr {
            l: self.l.or(base.l),
            t: self.t.or(base.t),
            r: self.r.or(base.r),
            b: self.b.or(base.b),
            anchor: self.anchor.clone().or_else(|| base.anchor.clone()),
            wrap: self.wrap.clone().or_else(|| base.wrap.clone()),
            rot: if self.rot != 0.0 { self.rot } else { base.rot },
            vert: self.vert.clone().or_else(|| base.vert.clone()),
            font_scale: self.font_scale.or(base.font_scale),
            ln_reduction: self.ln_reduction.or(base.ln_reduction),
            autofit: self.autofit.clone().or_else(|| base.autofit.clone()),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TextBody {
    pub body: BodyPr,
    pub lst: LstStyle,
    pub paras: Vec<Para>,
}

fn spc(n: Option<Node>) -> Option<Spc> {
    let n = n?;
    if let Some(p) = ch(n, "spcPct") {
        return af(p, "val").map(|v| Spc::Pct(v / 100000.0));
    }
    ch(n, "spcPts").and_then(|p| af(p, "val")).map(|v| Spc::Pts(v / 100.0))
}

pub fn parse_rpr(n: Node, rels: &HashMap<String, (String, String)>) -> RProps {
    let face = |k: &str| ch(n, k).and_then(|f| f.attribute("typeface")).map(|s| s.to_string());
    RProps {
        sz: af(n, "sz").map(|v| v / 100.0),
        b: ab(n, "b"),
        i: ab(n, "i"),
        u: n.attribute("u").map(|s| s.to_string()),
        strike: n.attribute("strike").map(|s| s != "noStrike"),
        baseline: af(n, "baseline").map(|v| v / 100000.0),
        cap: n.attribute("cap").map(|s| s.to_string()),
        spc: af(n, "spc").map(|v| v / 100.0),
        fill: parse_fill(n, rels),
        latin: face("latin"),
        ea: face("ea"),
        cs: face("cs"),
        hyper: ch(n, "hlinkClick").is_some(),
    }
}

pub fn parse_ppr(n: Node, rels: &HashMap<String, (String, String)>) -> PProps {
    let bu = if ch(n, "buNone").is_some() {
        Some(Bu::None)
    } else if let Some(c) = ch(n, "buChar") {
        Some(Bu::Char(c.attribute("char").unwrap_or("•").to_string()))
    } else {
        ch(n, "buAutoNum").map(|a| Bu::Auto(a.attribute("type").unwrap_or("arabicPeriod").to_string(), af(a, "startAt").unwrap_or(1.0) as i64))
    };
    PProps {
        mar_l: af(n, "marL").map(|v| v / EMU),
        indent: af(n, "indent").map(|v| v / EMU),
        algn: n.attribute("algn").map(|s| s.to_string()),
        ln_spc: spc(ch(n, "lnSpc")),
        spc_bef: spc(ch(n, "spcBef")),
        spc_aft: spc(ch(n, "spcAft")),
        bu,
        bu_clr: ch(n, "buClr").and_then(parse_color),
        bu_sz: ch(n, "buSzPct").and_then(|s| af(s, "val")).map(|v| v / 100000.0),
        bu_font: ch(n, "buFont").and_then(|f| f.attribute("typeface")).map(|s| s.to_string()),
        def_r: ch(n, "defRPr").map(|d| parse_rpr(d, rels)).unwrap_or_default(),
    }
}

pub fn parse_lst(n: Node, rels: &HashMap<String, (String, String)>) -> LstStyle {
    let mut l = LstStyle::default();
    l.def = ch(n, "defPPr").map(|d| parse_ppr(d, rels));
    for i in 0..9 {
        l.lvls[i] = ch(n, &format!("lvl{}pPr", i + 1)).map(|d| parse_ppr(d, rels));
    }
    l
}

pub fn parse_body(tx: Node, rels: &HashMap<String, (String, String)>) -> TextBody {
    let mut tb = TextBody::default();
    if let Some(b) = ch(tx, "bodyPr") {
        let e = |k: &str| af(b, k).map(|v| v / EMU);
        tb.body = BodyPr {
            l: e("lIns"),
            t: e("tIns"),
            r: e("rIns"),
            b: e("bIns"),
            anchor: b.attribute("anchor").map(|s| s.to_string()),
            wrap: b.attribute("wrap").map(|s| s.to_string()),
            rot: af(b, "rot").unwrap_or(0.0) / 60000.0,
            vert: b.attribute("vert").map(|s| s.to_string()),
            ..Default::default()
        };
        if let Some(a) = ch(b, "normAutofit") {
            tb.body.autofit = Some("norm".into());
            tb.body.font_scale = af(a, "fontScale").map(|v| v / 100000.0);
            tb.body.ln_reduction = af(a, "lnSpcReduction").map(|v| v / 100000.0);
        } else if ch(b, "spAutoFit").is_some() {
            tb.body.autofit = Some("sp".into());
        } else if ch(b, "noAutofit").is_some() {
            tb.body.autofit = Some("none".into());
        }
    }
    if let Some(l) = ch(tx, "lstStyle") {
        tb.lst = parse_lst(l, rels);
    }
    for p in chs(tx, "p") {
        let ppr = ch(p, "pPr");
        let mut para = Para { lvl: ppr.and_then(|x| af(x, "lvl")).unwrap_or(0.0) as usize, pp: ppr.map(|x| parse_ppr(x, rels)).unwrap_or_default(), ..Default::default() };
        for r in p.children().filter(|n| n.is_element()) {
            match r.tag_name().name() {
                "r" | "fld" => {
                    let rp = ch(r, "rPr").map(|x| parse_rpr(x, rels)).unwrap_or_default();
                    let text = ch(r, "t").map(|t| t.text().unwrap_or("").to_string()).unwrap_or_default();
                    para.runs.push(Run { kind: RunKind::Text, text, rp });
                }
                "br" => para.runs.push(Run { kind: RunKind::Br, text: String::new(), rp: ch(r, "rPr").map(|x| parse_rpr(x, rels)).unwrap_or_default() }),
                "endParaRPr" => para.end_rp = parse_rpr(r, rels),
                _ => {}
            }
        }
        tb.paras.push(para);
    }
    tb
}

// ------------------------------------------------------------------ shapes

#[derive(Clone, Debug, Default)]
pub struct StyleRefs {
    pub ln: Option<(usize, Option<ColorSpec>)>,
    pub fill: Option<(usize, Option<ColorSpec>)>,
    pub effect: Option<usize>,
    pub font_color: Option<ColorSpec>,
}

#[derive(Clone, Debug)]
pub struct Ph {
    pub ty: String,
    pub idx: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct Sp {
    pub name: String,
    pub ph: Option<Ph>,
    pub xfrm: Option<Xfrm>,
    pub geom: Option<Geom>,
    pub fill: Option<Fill>,
    pub ln: Ln,
    pub style: Option<StyleRefs>,
    pub effects: Effects,
    pub tx: Option<TextBody>,
    /// dsp:txXfrm for SmartArt text: the text rectangle in the same space as xfrm.
    pub tx_xfrm: Option<Xfrm>,
    pub connector: bool,
    pub hidden: bool,
    pub text_box: bool,
}

#[derive(Clone, Debug)]
pub struct Pic {
    pub xfrm: Xfrm,
    pub blip: Blip,
    pub geom: Option<Geom>,
    pub ln: Ln,
    pub effects: Effects,
}

#[derive(Clone, Debug, Default)]
pub struct Cell {
    pub tx: TextBody,
    pub fill: Option<Fill>,
    pub borders: [Option<Ln>; 4], // L, R, T, B
    pub mar: [Option<f64>; 4],
    pub anchor: Option<String>,
    pub grid_span: usize,
    pub row_span: usize,
    pub h_merge: bool,
    pub v_merge: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Table {
    pub xfrm: Xfrm,
    pub cols: Vec<f64>,
    pub rows: Vec<(f64, Vec<Cell>)>,
    pub style_id: Option<String>,
    pub first_row: bool,
    pub last_row: bool,
    pub first_col: bool,
    pub last_col: bool,
    pub band_row: bool,
    pub band_col: bool,
}

#[derive(Clone, Debug)]
pub enum Item {
    Sp(Sp),
    Pic(Pic),
    Grp(Xfrm, Vec<Item>),
    Table(Table),
    /// A chart: its frame, and the chart part (drawn by chart.rs).
    Chart(Xfrm, String),
}

pub struct Ctx<'a> {
    pub rels: &'a HashMap<String, (String, String)>,
}

fn parse_style(n: Node) -> StyleRefs {
    let r = |name: &str| ch(n, name).map(|l| (af(l, "idx").unwrap_or(0.0) as usize, parse_color(l)));
    StyleRefs { ln: r("lnRef"), fill: r("fillRef"), effect: ch(n, "effectRef").and_then(|e| af(e, "idx")).map(|v| v as usize), font_color: ch(n, "fontRef").and_then(parse_color) }
}

fn parse_sp(n: Node, rels: &HashMap<String, (String, String)>, connector: bool) -> Sp {
    let mut sp = Sp { connector, ..Default::default() };
    if let Some(nv) = n.children().find(|c| c.is_element() && c.tag_name().name().starts_with("nv")) {
        if let Some(c) = ch(nv, "cNvPr").or_else(|| nv.children().find(|c| c.is_element() && c.tag_name().name() == "cNvPr")) {
            sp.name = c.attribute("name").unwrap_or("").to_string();
            sp.hidden = ab(c, "hidden").unwrap_or(false);
        }
        if let Some(c) = ch(nv, "cNvSpPr") {
            sp.text_box = ab(c, "txBox").unwrap_or(false);
        }
        if let Some(ph) = ch(nv, "nvPr").and_then(|p| ch(p, "ph")) {
            sp.ph = Some(Ph { ty: ph.attribute("type").unwrap_or("body").to_string(), idx: af(ph, "idx").map(|v| v as i64) });
        }
    }
    if let Some(pr) = ch(n, "spPr") {
        sp.xfrm = ch(pr, "xfrm").map(parse_xfrm);
        sp.geom = parse_geom(pr);
        sp.fill = parse_fill(pr, rels);
        sp.ln = ch(pr, "ln").map(|l| parse_ln(l, rels)).unwrap_or_default();
        sp.effects = parse_effects(pr);
    }
    sp.style = ch(n, "style").map(parse_style);
    if let Some(tx) = ch(n, "txBody") {
        sp.tx = Some(parse_body(tx, rels));
    }
    if let Some(t) = ch(n, "txXfrm") {
        sp.tx_xfrm = Some(parse_xfrm(t));
    }
    sp
}

/// Shape tree children -> items. `diagram` resolves SmartArt drawing parts through the slide's relationships.
pub fn parse_tree(parent: Node, rels: &HashMap<String, (String, String)>, pkg: &mut Pkg) -> Vec<Item> {
    let mut out = Vec::new();
    for n in parent.children().filter(|c| c.is_element()) {
        match n.tag_name().name() {
            "sp" => out.push(Item::Sp(parse_sp(n, rels, false))),
            "cxnSp" => out.push(Item::Sp(parse_sp(n, rels, true))),
            "pic" => {
                let pr = ch(n, "spPr");
                let fill = ch(n, "blipFill").and_then(|b| {
                    let wrap = b.parent().unwrap();
                    let _ = wrap;
                    parse_fill(n, rels).filter(|f| matches!(f, Fill::Blip(_)))
                });
                if let (Some(Fill::Blip(blip)), Some(pr)) = (fill, pr) {
                    if let Some(x) = ch(pr, "xfrm") {
                        out.push(Item::Pic(Pic { xfrm: parse_xfrm(x), blip, geom: parse_geom(pr), ln: ch(pr, "ln").map(|l| parse_ln(l, rels)).unwrap_or_default(), effects: parse_effects(pr) }));
                    }
                }
            }
            "grpSp" => {
                if let Some(pr) = ch(n, "grpSpPr") {
                    let x = ch(pr, "xfrm").map(parse_xfrm).unwrap_or_default();
                    out.push(Item::Grp(x, parse_tree(n, rels, pkg)));
                }
            }
            "AlternateContent" => {
                let pick = ch(n, "Fallback").or_else(|| ch(n, "Choice"));
                if let Some(p) = pick {
                    out.extend(parse_tree(p, rels, pkg));
                }
            }
            "graphicFrame" => {
                let x = ch(n, "xfrm").map(parse_xfrm).unwrap_or_default();
                let Some(data) = ch(n, "graphic").and_then(|g| ch(g, "graphicData")) else { continue };
                if let Some(t) = ch(data, "tbl") {
                    out.push(Item::Table(parse_table(t, x, rels)));
                } else if let Some(c) = ch(data, "chart") {
                    if let Some(path) = c.attributes().find(|a| a.name() == "id").and_then(|a| rels.get(a.value())) {
                        out.push(Item::Chart(x, path.1.clone()));
                    }
                } else if let Some(d) = ch(data, "relIds") {
                    // SmartArt: PowerPoint stores the laid-out shapes in a drawing part named in the data model.
                    let dm = d.attributes().find(|a| a.name() == "dm").and_then(|a| rels.get(a.value())).map(|r| r.1.clone());
                    let drawing = dm.and_then(|p| pkg.text(&p)).and_then(|xml| {
                        let doc = Document::parse(&xml).ok()?;
                        let rid = doc.descendants().find(|n| n.tag_name().name() == "dataModelExt")?.attribute("relId")?.to_string();
                        rels.get(&rid).map(|r| r.1.clone())
                    });
                    if let Some(path) = drawing {
                        if let Some(xml) = pkg.text(&path) {
                            if let Ok(doc) = Document::parse(&xml) {
                                let drels = pkg.rels(&path);
                                if let Some(tree) = doc.descendants().find(|n| n.tag_name().name() == "spTree") {
                                    let items = parse_tree(tree, &drels, pkg);
                                    // Shapes inside the drawing are in the frame's own space.
                                    let mut g = x.clone();
                                    g.ch = Some([0.0, 0.0, x.w, x.h]);
                                    out.push(Item::Grp(g, items));
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_table(t: Node, xfrm: Xfrm, rels: &HashMap<String, (String, String)>) -> Table {
    let mut tb = Table { xfrm, ..Default::default() };
    if let Some(p) = ch(t, "tblPr") {
        tb.first_row = ab(p, "firstRow").unwrap_or(false);
        tb.last_row = ab(p, "lastRow").unwrap_or(false);
        tb.first_col = ab(p, "firstCol").unwrap_or(false);
        tb.last_col = ab(p, "lastCol").unwrap_or(false);
        tb.band_row = ab(p, "bandRow").unwrap_or(false);
        tb.band_col = ab(p, "bandCol").unwrap_or(false);
        tb.style_id = ch(p, "tableStyleId").and_then(|s| s.text()).map(|s| s.trim().to_string());
    }
    if let Some(g) = ch(t, "tblGrid") {
        tb.cols = chs(g, "gridCol").map(|c| af(c, "w").unwrap_or(0.0) / EMU).collect();
    }
    for tr in chs(t, "tr") {
        let mut cells = Vec::new();
        for tc in chs(tr, "tc") {
            let mut c = Cell { grid_span: af(tc, "gridSpan").unwrap_or(1.0) as usize, row_span: af(tc, "rowSpan").unwrap_or(1.0) as usize, h_merge: ab(tc, "hMerge").unwrap_or(false), v_merge: ab(tc, "vMerge").unwrap_or(false), ..Default::default() };
            if let Some(tx) = ch(tc, "txBody") {
                c.tx = parse_body(tx, rels);
            }
            if let Some(pr) = ch(tc, "tcPr") {
                c.fill = parse_fill(pr, rels);
                for (i, name) in ["lnL", "lnR", "lnT", "lnB"].iter().enumerate() {
                    c.borders[i] = ch(pr, name).map(|l| parse_ln(l, rels));
                }
                for (i, k) in ["marL", "marR", "marT", "marB"].iter().enumerate() {
                    c.mar[i] = af(pr, k).map(|v| v / EMU);
                }
                c.anchor = pr.attribute("anchor").map(|s| s.to_string());
            }
            cells.push(c);
        }
        tb.rows.push((af(tr, "h").unwrap_or(0.0) / EMU, cells));
    }
    tb
}

// ------------------------------------------------------------------ table styles

#[derive(Clone, Debug, Default)]
pub struct PartStyle {
    pub fill: Option<Fill>,
    pub bold: Option<bool>,
    pub color: Option<ColorSpec>,
    /// left, right, top, bottom, insideH, insideV
    pub borders: [Option<Ln>; 6],
}

#[derive(Clone, Debug, Default)]
pub struct TableStyle {
    pub parts: HashMap<String, PartStyle>,
}

pub fn parse_table_styles(xml: &str, rels: &HashMap<String, (String, String)>) -> HashMap<String, TableStyle> {
    let mut out = HashMap::new();
    let Ok(doc) = Document::parse(xml) else { return out };
    for st in doc.descendants().filter(|n| n.tag_name().name() == "tblStyle") {
        let Some(id) = st.attribute("styleId") else { continue };
        let mut ts = TableStyle::default();
        for part in st.children().filter(|n| n.is_element() && n.tag_name().name() != "tblBg") {
            let mut ps = PartStyle::default();
            if let Some(tc) = ch(part, "tcStyle") {
                if let Some(f) = ch(tc, "fill") {
                    ps.fill = parse_fill(f, rels);
                }
                if let Some(b) = ch(tc, "tcBdr") {
                    for (i, k) in ["left", "right", "top", "bottom", "insideH", "insideV"].iter().enumerate() {
                        ps.borders[i] = ch(b, k).and_then(|x| ch(x, "ln")).map(|l| parse_ln(l, rels));
                    }
                }
            }
            if let Some(tx) = ch(part, "tcTxStyle") {
                ps.bold = tx.attribute("b").map(|v| v == "on");
                ps.color = parse_color(tx);
            }
            ts.parts.insert(part.tag_name().name().to_string(), ps);
        }
        out.insert(id.to_string(), ts);
    }
    out
}

// ------------------------------------------------------------------ theme, masters, layouts, slides

#[derive(Clone, Debug, Default)]
pub struct Theme {
    pub colors: HashMap<String, Rgb>,
    pub major: String,
    pub minor: String,
    pub fills: Vec<Fill>,
    pub lines: Vec<Ln>,
    pub effects: Vec<Effects>,
    pub bg_fills: Vec<Fill>,
}

pub fn parse_theme(xml: &str, rels: &HashMap<String, (String, String)>) -> Theme {
    let mut t = Theme { major: "Calibri Light".into(), minor: "Calibri".into(), ..Default::default() };
    for (k, v) in [("dk1", [0.0, 0.0, 0.0]), ("lt1", [255.0, 255.0, 255.0]), ("dk2", [68.0, 84.0, 106.0]), ("lt2", [231.0, 230.0, 230.0]), ("accent1", [68.0, 114.0, 196.0]), ("accent2", [237.0, 125.0, 49.0]), ("accent3", [165.0, 165.0, 165.0]), ("accent4", [255.0, 192.0, 0.0]), ("accent5", [91.0, 155.0, 213.0]), ("accent6", [112.0, 173.0, 71.0]), ("hlink", [5.0, 99.0, 193.0]), ("folHlink", [149.0, 79.0, 114.0])] {
        t.colors.insert(k.to_string(), v);
    }
    let Ok(doc) = Document::parse(xml) else { return t };
    if let Some(cs) = doc.descendants().find(|n| n.tag_name().name() == "clrScheme") {
        for c in cs.children().filter(|n| n.is_element()) {
            let name = c.tag_name().name().to_string();
            if let Some(v) = c.children().find(|n| n.is_element()) {
                let hexv = v.attribute("val").filter(|_| v.tag_name().name() == "srgbClr").or_else(|| v.attribute("lastClr"));
                if let Some(h) = hexv {
                    t.colors.insert(name, hex(h));
                }
            }
        }
    }
    if let Some(fs) = doc.descendants().find(|n| n.tag_name().name() == "fontScheme") {
        if let Some(f) = ch(fs, "majorFont").and_then(|m| ch(m, "latin")).and_then(|l| l.attribute("typeface")) {
            t.major = f.to_string();
        }
        if let Some(f) = ch(fs, "minorFont").and_then(|m| ch(m, "latin")).and_then(|l| l.attribute("typeface")) {
            t.minor = f.to_string();
        }
    }
    if let Some(fm) = doc.descendants().find(|n| n.tag_name().name() == "fmtScheme") {
        let fills = |name: &str| -> Vec<Fill> {
            ch(fm, name).map(|l| l.children().filter(|n| n.is_element()).filter_map(|n| {
                // each entry is itself the fill element: wrap by parsing its parent's single child
                parse_fill_el(n, rels)
            }).collect()).unwrap_or_default()
        };
        t.fills = fills("fillStyleLst");
        t.bg_fills = fills("bgFillStyleLst");
        if let Some(l) = ch(fm, "lnStyleLst") {
            t.lines = chs(l, "ln").map(|n| parse_ln(n, rels)).collect();
        }
        if let Some(l) = ch(fm, "effectStyleLst") {
            t.effects = chs(l, "effectStyle").map(parse_effects).collect();
        }
    }
    t
}

/// A fill element on its own (`<a:solidFill>`...), as found in a theme's style lists.
fn parse_fill_el(n: Node, rels: &HashMap<String, (String, String)>) -> Option<Fill> {
    // parse_fill looks at the children of a parent; emulate by handling the node directly.
    let wrap = |f: Fill| Some(f);
    match n.tag_name().name() {
        "noFill" => wrap(Fill::None),
        "solidFill" => parse_color(n).map(Fill::Solid),
        _ => {
            // gradFill / blipFill / pattFill: reuse parse_fill on a synthetic parent isn't possible with roxmltree,
            // so read the node through a one-element iteration.
            parse_fill_of(n, rels)
        }
    }
}

fn parse_fill_of(n: Node, rels: &HashMap<String, (String, String)>) -> Option<Fill> {
    match n.tag_name().name() {
        "gradFill" => {
            let mut stops: Vec<(f64, ColorSpec)> = Vec::new();
            if let Some(l) = ch(n, "gsLst") {
                for gs in chs(l, "gs") {
                    if let Some(c) = parse_color(gs) {
                        stops.push((af(gs, "pos").unwrap_or(0.0) / 100000.0, c));
                    }
                }
            }
            if stops.is_empty() {
                return None;
            }
            stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let lin = ch(n, "lin").map(|l| (af(l, "ang").unwrap_or(0.0) / 60000.0, ab(l, "scaled").unwrap_or(false)));
            let path = ch(n, "path").map(|p| (p.attribute("path").unwrap_or("circle").to_string(), ch(p, "fillToRect").map(|r| rect_attrs(r, ["l", "t", "r", "b"])).unwrap_or([0.5, 0.5, 0.5, 0.5])));
            Some(Fill::Grad(Grad { stops, lin: if path.is_some() { None } else { lin.or(Some((0.0, false))) }, path }))
        }
        "blipFill" => {
            let blip = ch(n, "blip");
            let path = blip.and_then(blip_embed).and_then(|id| rels.get(id)).map(|r| r.1.clone());
            let (alpha, duotone, gray, bright, contrast) = blip_effects(blip);
            Some(Fill::Blip(Blip { path, src: [0.0; 4], tile: tile_of(n), alpha, duotone, gray, bright, contrast }))
        }
        "pattFill" => Some(Fill::Patt(n.attribute("prst").unwrap_or("").to_string(), ch(n, "fgClr").and_then(parse_color)?, ch(n, "bgClr").and_then(parse_color)?)),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub enum Bg {
    Fill(Fill),
    /// `bgRef idx` with its colour.
    Ref(usize, Option<ColorSpec>),
}

#[derive(Clone, Debug, Default)]
pub struct Part {
    pub shapes: Vec<Item>,
    pub bg: Option<Bg>,
    pub clr_map_ovr: Option<HashMap<String, String>>,
    pub show_master_sp: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TxStyles {
    pub title: LstStyle,
    pub body: LstStyle,
    pub other: LstStyle,
}

#[derive(Clone, Debug, Default)]
pub struct Master {
    pub part: Part,
    pub clr_map: HashMap<String, String>,
    pub tx: TxStyles,
    pub theme: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Layout {
    pub part: Part,
    pub master: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Slide {
    pub part: Part,
    pub layout: usize,
    pub hidden: bool,
}

pub struct Deck {
    pub w: f64,
    pub h: f64,
    pub themes: Vec<Theme>,
    pub masters: Vec<Master>,
    pub layouts: Vec<Layout>,
    pub slides: Vec<Slide>,
    pub default_text: LstStyle,
    pub table_styles: HashMap<String, TableStyle>,
}

fn parse_part(xml: &str, part: &str, pkg: &mut Pkg) -> Option<(Part, HashMap<String, (String, String)>, Option<TxStyles>, Option<HashMap<String, String>>)> {
    let doc = Document::parse(xml).ok()?;
    let rels = pkg.rels(part);
    let root = doc.root_element();
    let csld = ch(root, "cSld")?;
    let mut p = Part { show_master_sp: root.attribute("showMasterSp") != Some("0"), ..Default::default() };
    if let Some(bg) = ch(csld, "bg") {
        if let Some(pr) = ch(bg, "bgPr") {
            p.bg = parse_fill(pr, &rels).map(Bg::Fill);
        } else if let Some(r) = ch(bg, "bgRef") {
            p.bg = Some(Bg::Ref(af(r, "idx").unwrap_or(1001.0) as usize, parse_color(r)));
        }
    }
    if let Some(tree) = ch(csld, "spTree") {
        p.shapes = parse_tree(tree, &rels, pkg);
    }
    let read_map = |n: Node| -> HashMap<String, String> { n.attributes().map(|a| (a.name().to_string(), a.value().to_string())).collect() };
    let mut clr_map = None;
    if let Some(m) = ch(root, "clrMap") {
        clr_map = Some(read_map(m));
    }
    if let Some(o) = ch(root, "clrMapOvr").and_then(|o| ch(o, "overrideClrMapping")) {
        p.clr_map_ovr = Some(read_map(o));
    }
    let tx = ch(root, "txStyles").map(|t| TxStyles {
        title: ch(t, "titleStyle").map(|n| parse_lst(n, &rels)).unwrap_or_default(),
        body: ch(t, "bodyStyle").map(|n| parse_lst(n, &rels)).unwrap_or_default(),
        other: ch(t, "otherStyle").map(|n| parse_lst(n, &rels)).unwrap_or_default(),
    });
    p.shapes.shrink_to_fit();
    Some((p, rels, tx, clr_map))
}

impl Deck {
    pub fn load(pkg: &mut Pkg) -> Result<Deck> {
        let none = || Error::Msg("No slides found — this may not be a valid .pptx file.".into());
        let pres = pkg.text("ppt/presentation.xml").ok_or_else(none)?;
        let pdoc = Document::parse(&pres).map_err(|e| Error::Msg(e.to_string()))?;
        let prels = pkg.rels("ppt/presentation.xml");
        let root = pdoc.root_element();
        let (w, h) = ch(root, "sldSz").map(|s| (af(s, "cx").unwrap_or(12192000.0) / EMU, af(s, "cy").unwrap_or(6858000.0) / EMU)).unwrap_or((960.0, 540.0));
        let default_text = ch(root, "defaultTextStyle").map(|n| parse_lst(n, &prels)).unwrap_or_default();

        let mut deck = Deck { w, h, themes: vec![], masters: vec![], layouts: vec![], slides: vec![], default_text, table_styles: HashMap::new() };
        if let Some(ts) = prels.values().find(|r| r.0 == "tableStyles").and_then(|r| pkg.text(&r.1)) {
            deck.table_styles = parse_table_styles(&ts, &prels);
        }
        let mut master_ix: HashMap<String, usize> = HashMap::new();
        let mut layout_ix: HashMap<String, usize> = HashMap::new();

        let slide_ids: Vec<String> = ch(root, "sldIdLst").map(|l| l.children().filter(|n| n.is_element()).filter_map(|s| s.attributes().find(|a| a.name() == "id" && a.namespace().is_some()).map(|a| a.value().to_string())).collect()).unwrap_or_default();
        let mut slide_paths: Vec<(String, bool)> = slide_ids.iter().filter_map(|id| prels.get(id).map(|r| (r.1.clone(), false))).collect();
        if slide_paths.is_empty() {
            let mut v: Vec<(u64, String)> = pkg.names.iter().filter_map(|n| n.strip_prefix("ppt/slides/slide").and_then(|r| r.strip_suffix(".xml")).and_then(|d| d.parse::<u64>().ok()).map(|k| (k, n.clone()))).collect();
            v.sort();
            slide_paths = v.into_iter().map(|(_, n)| (n, false)).collect();
        }
        if slide_paths.is_empty() {
            return Err(none());
        }

        for (spath, _) in slide_paths {
            let Some(xml) = pkg.text(&spath) else { continue };
            let Some((mut part, srels, _, _)) = parse_part(&xml, &spath, pkg) else { continue };
            let hidden = Document::parse(&xml).ok().map(|d| d.root_element().attribute("show") == Some("0")).unwrap_or(false);
            part.show_master_sp = Document::parse(&xml).ok().map(|d| d.root_element().attribute("showMasterSp") != Some("0")).unwrap_or(true);
            let lpath = srels.values().find(|r| r.0 == "slideLayout").map(|r| r.1.clone());
            let layout = match lpath {
                Some(lp) => {
                    if let Some(&i) = layout_ix.get(&lp) {
                        i
                    } else {
                        let lxml = pkg.text(&lp).unwrap_or_default();
                        let (lpart, lrels, _, _) = parse_part(&lxml, &lp, pkg).unwrap_or_default_part();
                        let mp = lrels.values().find(|r| r.0 == "slideMaster").map(|r| r.1.clone());
                        let master = match mp {
                            Some(mp) => {
                                if let Some(&i) = master_ix.get(&mp) {
                                    i
                                } else {
                                    let mxml = pkg.text(&mp).unwrap_or_default();
                                    let (mpart, mrels, tx, map) = parse_part(&mxml, &mp, pkg).unwrap_or_default_part();
                                    let theme_path = mrels.values().find(|r| r.0 == "theme").map(|r| r.1.clone());
                                    let theme = theme_path.and_then(|tp| pkg.text(&tp).map(|x| (x, tp))).map(|(x, tp)| {
                                        let trels = pkg.rels(&tp);
                                        parse_theme(&x, &trels)
                                    });
                                    deck.themes.push(theme.unwrap_or_else(|| parse_theme("", &HashMap::new())));
                                    deck.masters.push(Master { part: mpart, clr_map: map.unwrap_or_else(default_map), tx: tx.unwrap_or_default(), theme: deck.themes.len() - 1 });
                                    master_ix.insert(mp, deck.masters.len() - 1);
                                    deck.masters.len() - 1
                                }
                            }
                            None => {
                                if deck.masters.is_empty() {
                                    deck.themes.push(parse_theme("", &HashMap::new()));
                                    deck.masters.push(Master { part: Part::default(), clr_map: default_map(), tx: TxStyles::default(), theme: 0 });
                                }
                                0
                            }
                        };
                        deck.layouts.push(Layout { part: lpart, master });
                        layout_ix.insert(lp, deck.layouts.len() - 1);
                        deck.layouts.len() - 1
                    }
                }
                None => {
                    if deck.masters.is_empty() {
                        deck.themes.push(parse_theme("", &HashMap::new()));
                        deck.masters.push(Master { part: Part::default(), clr_map: default_map(), tx: TxStyles::default(), theme: 0 });
                    }
                    deck.layouts.push(Layout { part: Part { show_master_sp: true, ..Default::default() }, master: 0 });
                    deck.layouts.len() - 1
                }
            };
            deck.slides.push(Slide { part, layout, hidden });
        }
        if deck.slides.is_empty() {
            return Err(none());
        }
        Ok(deck)
    }
}

fn default_map() -> HashMap<String, String> {
    [("bg1", "lt1"), ("tx1", "dk1"), ("bg2", "lt2"), ("tx2", "dk2"), ("accent1", "accent1"), ("accent2", "accent2"), ("accent3", "accent3"), ("accent4", "accent4"), ("accent5", "accent5"), ("accent6", "accent6"), ("hlink", "hlink"), ("folHlink", "folHlink")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

trait OrDefaultPart {
    fn unwrap_or_default_part(self) -> (Part, HashMap<String, (String, String)>, Option<TxStyles>, Option<HashMap<String, String>>);
}
impl OrDefaultPart for Option<(Part, HashMap<String, (String, String)>, Option<TxStyles>, Option<HashMap<String, String>>)> {
    fn unwrap_or_default_part(self) -> (Part, HashMap<String, (String, String)>, Option<TxStyles>, Option<HashMap<String, String>>) {
        self.unwrap_or_else(|| (Part { show_master_sp: true, ..Default::default() }, HashMap::new(), None, None))
    }
}

/// The first fill element among the children of `n` (for `fillOverlay` and similar wrappers), with no relationships.
fn parse_fill_of_parent(n: Node) -> Option<Fill> {
    let none = HashMap::new();
    for c in n.children().filter(|c| c.is_element()) {
        if let Some(f) = parse_fill_el(c, &none) {
            return Some(f);
        }
    }
    None
}

/// The relationship id of a blip's picture: its SVG when it has one (drawn sharper), else its own raster.
fn blip_embed<'a>(b: Node<'a, '_>) -> Option<&'a str> {
    let own = b.attributes().find(|a| a.name() == "embed").map(|a| a.value());
    let svg = b.descendants().find(|n| n.is_element() && n.tag_name().name() == "svgBlip").and_then(|n| n.attributes().find(|a| a.name() == "embed").map(|a| a.value()));
    svg.or(own)
}
