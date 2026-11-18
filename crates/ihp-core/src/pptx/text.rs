//! Text boxes and tables: style inheritance (shape, layout, master, defaults), wrapping, alignment,
//! bullets and numbering, line and paragraph spacing, vertical anchoring, table styles.

use super::color::Rgb;
use super::geom::G;
use super::model::*;
use super::render::*;
use crate::compress::Result;
use crate::stamp::f;

#[derive(Clone)]
struct Seg {
    font: usize,
    show: String,
    size: f64,
    width: f64,
}

#[derive(Clone)]
struct Tok {
    segs: Vec<Seg>,
    width: f64,
    color: (Rgb, f64),
    space: bool,
    ul: bool,
    strike: bool,
    shift: f64,
    spc: f64,
    asc: f64,
    desc: f64,
    gap: f64,
    size: f64,
}

enum BKind {
    Disc,
    Square,
    Circle,
    Triangle,
    Diamond,
    Text(String),
}

struct Bullet {
    kind: BKind,
    x: f64,
    color: (Rgb, f64),
    size: f64,
    font: Option<usize>,
}

struct Line {
    toks: Vec<Tok>,
    width: f64,
    x0: f64,
    avail: f64,
    align: String,
    last: bool,
    asc: f64,
    desc: f64,
    pitch: f64,
    gap_before: f64,
    bullet: Option<Bullet>,
}

fn level(chain: &[&LstStyle], lvl: usize) -> PProps {
    let mut it = chain.iter().rev();
    let mut p = it.next().map(|l| l.level(lvl)).unwrap_or_default();
    for l in it {
        p = l.level(lvl).over(&p);
    }
    p
}

fn roman(mut n: i64, upper: bool) -> String {
    let t: [(i64, &str); 13] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];
    let mut s = String::new();
    for (v, r) in t {
        while n >= v {
            s += r;
            n -= v;
        }
    }
    if upper { s.to_uppercase() } else { s }
}

fn alpha(n: i64, upper: bool) -> String {
    let mut n = n.max(1) - 1;
    let mut s = String::new();
    loop {
        s.insert(0, (b'a' + (n % 26) as u8) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    if upper { s.to_uppercase() } else { s }
}

fn number_text(kind: &str, n: i64) -> String {
    match kind {
        "arabicPeriod" => format!("{n}."),
        "arabicParenR" => format!("{n})"),
        "arabicParenBoth" => format!("({n})"),
        "arabicPlain" => format!("{n}"),
        "alphaLcPeriod" => format!("{}.", alpha(n, false)),
        "alphaUcPeriod" => format!("{}.", alpha(n, true)),
        "alphaLcParenR" => format!("{})", alpha(n, false)),
        "alphaUcParenR" => format!("{})", alpha(n, true)),
        "romanLcPeriod" => format!("{}.", roman(n, false)),
        "romanUcPeriod" => format!("{}.", roman(n, true)),
        _ => format!("{n}."),
    }
}

fn bullet_kind(ch: &str, font: Option<&str>) -> BKind {
    let wing = font.map_or(false, |f| f.to_lowercase().contains("wingdings") || f.to_lowercase().contains("symbol"));
    let mut c = ch.chars().next().unwrap_or('\u{2022}');
    let pua = (c as u32) >= 0xF000 && (c as u32) <= 0xF0FF;
    if pua {
        c = char::from_u32(c as u32 & 0xFF).unwrap_or(c);
    }
    let f = font.unwrap_or("").to_lowercase();
    if wing || pua {
        return match c {
            'u' | 'p' | 'q' | '}' | 'w' if f.contains('3') => BKind::Triangle,
            '\u{a7}' | 'n' | 'q' | 'l' if f.contains("wingdings") && c != 'l' => BKind::Square,
            '\u{d8}' | '\u{e8}' | '\u{fc}' if false => BKind::Triangle,
            '\u{d8}' | '\u{e8}' => BKind::Triangle,
            '\u{a7}' => BKind::Square,
            'v' | 'u' | '\u{a8}' => BKind::Diamond,
            'o' => BKind::Circle,
            '\u{b7}' | '\u{2022}' | 'l' | '\u{9f}' => BKind::Disc,
            _ => BKind::Disc,
        };
    }
    match c {
        '\u{2022}' | '\u{b7}' | '\u{25cf}' | '\u{2219}' | '\u{26ab}' | '\u{2b24}' | '\u{25cf}' => BKind::Disc,
        '\u{25aa}' | '\u{25a0}' | '\u{25fc}' | '\u{25ab}' | '\u{25a1}' | '\u{2b1b}' | '\u{2756}' if c != '\u{2756}' => BKind::Square,
        'o' | '\u{25cb}' | '\u{25e6}' => BKind::Circle,
        '\u{25ba}' | '\u{25b6}' | '\u{27a2}' | '\u{27a4}' | '\u{2794}' | '\u{2192}' | '\u{2023}' | '\u{2b9a}' | '\u{2bc8}' | '\u{27a3}' | '\u{2b9e}' | '\u{25b8}' => BKind::Triangle,
        '\u{25c6}' | '\u{2756}' | '\u{25c7}' | '\u{2b25}' => BKind::Diamond,
        _ => BKind::Text(ch.to_string()),
    }
}

pub(super) struct TextCtx<'x> {
    pub hi: Vec<&'x LstStyle>,
    pub lo: Vec<&'x LstStyle>,
    pub font_color: Option<&'x super::color::ColorSpec>,
    pub scale: f64,
    pub reduce: f64,
    pub default_bold: Option<bool>,
    pub default_color: Option<&'x super::color::ColorSpec>,
}

impl<'a> Rt<'a> {
    fn rp_color(&self, rp: &RProps, env: &Env, hyper: bool) -> (Rgb, f64) {
        let _ = hyper;
        match &rp.fill {
            Some(Fill::Solid(c)) => env.color(c, None),
            Some(Fill::Grad(g)) => g.stops.first().map(|s| env.color(&s.1, None)).unwrap_or(([0.0; 3], 1.0)),
            _ => ([0.0; 3], 1.0),
        }
    }

    fn theme_font(&self, env: &Env, face: &str) -> String {
        match face {
            "+mj-lt" | "+mj-ea" | "+mj-cs" => env.theme.major.clone(),
            "+mn-lt" | "+mn-ea" | "+mn-cs" => env.theme.minor.clone(),
            f => f.to_string(),
        }
    }

    /// Lays out paragraphs into lines for a text area `width` wide.
    fn layout(&mut self, paras: &[Para], cx: &TextCtx, env: &Env, width: f64) -> Result<Vec<Line>> {
        let mut lines: Vec<Line> = Vec::new();
        let mut counters: [Option<(String, i64)>; 9] = Default::default();
        for (pi, para) in paras.iter().enumerate() {
            let hi = level(&cx.hi, para.lvl);
            let lo = level(&cx.lo, para.lvl);
            let pp = para.pp.over(&hi);
            let pp_all = pp.over(&lo);
            let first_para = pi == 0;
            // run properties for a run: run > hi chain > font colour > lo chain
            let resolve_rp = |rp: &RProps| -> RProps {
                let mut r = rp.over(&pp.def_r);
                if r.fill.is_none() {
                    if let Some(c) = cx.font_color {
                        r.fill = Some(Fill::Solid(c.clone()));
                    } else if let Some(c) = cx.default_color {
                        r.fill = Some(Fill::Solid(c.clone()));
                    }
                }
                let mut r = r.over(&lo.def_r);
                if r.b.is_none() {
                    r.b = cx.default_bold;
                }
                r
            };
            let marl = pp_all.mar_l.unwrap_or(0.0);
            let indent = pp_all.indent.unwrap_or(0.0);
            let algn = pp_all.algn.clone().unwrap_or_else(|| "l".into());

            // numbering state
            for l in counters.iter_mut().skip(para.lvl + 1) {
                *l = None;
            }
            let bu = pp_all.bu.clone().unwrap_or(Bu::None);
            let has_text = para.runs.iter().any(|r| matches!(r.kind, RunKind::Text) && !r.text.is_empty());
            let mut bullet_text: Option<(BKind, Option<String>)> = None;
            match &bu {
                Bu::None => counters[para.lvl.min(8)] = None,
                Bu::Char(c) => {
                    counters[para.lvl.min(8)] = None;
                    if has_text {
                        bullet_text = Some((bullet_kind(c, pp_all.bu_font.as_deref()), pp_all.bu_font.clone()));
                    }
                }
                Bu::Auto(kind, start) => {
                    let slot = &mut counters[para.lvl.min(8)];
                    let n = match slot {
                        Some((k, n)) if k == kind => {
                            *n += 1;
                            *n
                        }
                        _ => {
                            *slot = Some((kind.clone(), *start));
                            *start
                        }
                    };
                    if has_text {
                        bullet_text = Some((BKind::Text(number_text(kind, n)), pp_all.bu_font.clone()));
                    }
                }
            }

            // tokens of the paragraph
            let mut toks: Vec<(Tok, bool)> = Vec::new(); // (token, is explicit line break)
            let mut first_rp = RProps::default();
            for (ri, run) in para.runs.iter().enumerate() {
                let rp = resolve_rp(&run.rp);
                if ri == 0 {
                    first_rp = rp.clone();
                }
                if matches!(run.kind, RunKind::Br) {
                    let size = rp.sz.unwrap_or(18.0) * cx.scale;
                    toks.push((Tok { segs: vec![], width: 0.0, color: ([0.0; 3], 1.0), space: true, ul: false, strike: false, shift: 0.0, spc: 0.0, asc: 0.0, desc: 0.0, gap: 0.0, size }, true));
                    continue;
                }
                let mut text = run.text.replace('\u{b}', "\n");
                match rp.cap.as_deref() {
                    Some("all") => text = text.to_uppercase(),
                    Some("small") => text = text.to_uppercase(),
                    _ => {}
                }
                let mut size = rp.sz.unwrap_or(18.0) * cx.scale;
                let sup = rp.baseline.unwrap_or(0.0);
                let shift = -sup * size;
                if sup != 0.0 {
                    size *= 0.667;
                }
                let family = self.theme_font(env, rp.latin.as_deref().unwrap_or("+mn-lt"));
                let hyper = run.rp.hyper;
                let color = if hyper { env.color(&super::color::ColorSpec { base: super::color::Base::Scheme("hlink".into()), mods: vec![] }, None) } else { self.rp_color(&rp, env, false) };
                let (bold, italic) = (rp.b.unwrap_or(false), rp.i.unwrap_or(false));
                let ul = hyper || rp.u.as_deref().map_or(false, |u| u != "none");
                let strike = rp.strike.unwrap_or(false);
                let spc = rp.spc.unwrap_or(0.0);
                // words and spaces
                let mut pieces: Vec<(String, bool)> = Vec::new();
                let mut cur = String::new();
                let mut cur_space = false;
                for ch in text.chars() {
                    let sp = ch == ' ' || ch == '\t';
                    if ch == '\n' {
                        if !cur.is_empty() {
                            pieces.push((std::mem::take(&mut cur), cur_space));
                        }
                        pieces.push((String::new(), true));
                        cur_space = false;
                        continue;
                    }
                    if !cur.is_empty() && sp != cur_space {
                        pieces.push((std::mem::take(&mut cur), cur_space));
                    }
                    cur_space = sp;
                    cur.push(if ch == '\t' { ' ' } else { ch });
                }
                if !cur.is_empty() {
                    pieces.push((cur, cur_space));
                }
                for (piece, is_space) in pieces {
                    if piece.is_empty() {
                        // an explicit line break inside the run text
                        toks.push((Tok { segs: vec![], width: 0.0, color, space: true, ul: false, strike: false, shift: 0.0, spc: 0.0, asc: 0.0, desc: 0.0, gap: 0.0, size }, true));
                        continue;
                    }
                    let mut segs = Vec::new();
                    let mut width = 0.0;
                    let (mut asc, mut desc, mut gap) = (0.0f64, 0.0f64, 0.0f64);
                    for (fi, seg_text) in self.fonts.segments(&mut self.doc, &family, bold, italic, &piece)? {
                        let key = (fi, seg_text.clone(), (size * 100.0) as i64);
                        let (show, w) = match self.shape_cache.get(&key) {
                            Some(v) => v.clone(),
                            None => {
                                let v = self.fonts.shape(fi, &seg_text, size)?;
                                self.shape_cache.insert(key, v.clone());
                                v
                            }
                        };
                        let m = self.fonts.metrics(fi);
                        asc = asc.max(m.0 * size);
                        desc = desc.max(m.1 * size);
                        gap = gap.max(m.2 * size);
                        width += w;
                        segs.push(Seg { font: fi, show, size, width: w });
                    }
                    // PowerPoint's single spacing is at least 1.2 x the size, whatever the font's own metrics say
                    if asc + desc + gap < 1.2 * size {
                        gap += 1.2 * size - (asc + desc + gap);
                    }
                    let n = piece.chars().count() as f64;
                    width += spc * n;
                    toks.push((Tok { segs, width, color, space: is_space, ul, strike, shift, spc, asc, desc, gap, size }, false));
                }
            }
            if toks.is_empty() || !has_text {
                // empty paragraph: one line as tall as its end-of-paragraph size
                let size = para.end_rp.sz.or(first_rp.sz).or(pp_all.def_r.sz).unwrap_or(18.0) * cx.scale;
                let family = self.theme_font(env, para.end_rp.latin.as_deref().or(first_rp.latin.as_deref()).unwrap_or("+mn-lt"));
                let segs = self.fonts.segments(&mut self.doc, &family, false, false, "x")?;
                let m = self.fonts.metrics(segs[0].0);
                let gap = (m.2 * size).max(1.2 * size - (m.0 + m.1) * size);
                toks = vec![(Tok { segs: vec![], width: 0.0, color: ([0.0; 3], 1.0), space: true, ul: false, strike: false, shift: 0.0, spc: 0.0, asc: m.0 * size, desc: m.1 * size, gap, size }, false)];
            }

            // bullet geometry
            let bullet_on = bullet_text.is_some();
            let lead_size0 = para.runs.iter().find(|r| !r.text.is_empty()).map(|r| resolve_rp(&r.rp).sz.unwrap_or(18.0) * cx.scale).unwrap_or(18.0);
            let bullet_w = match &bullet_text {
                Some((BKind::Text(s), _)) => s.chars().count() as f64 * lead_size0 * pp_all.bu_sz.unwrap_or(1.0) * 0.55,
                Some(_) => lead_size0 * pp_all.bu_sz.unwrap_or(1.0) * 0.35,
                None => 0.0,
            };
            let first_x = if bullet_on { (marl + indent.min(0.0) + bullet_w).max(if indent < 0.0 { marl } else { marl + indent }) } else { (marl + indent).max(0.0) };
            let rest_x = marl;
            let lead_size = toks.iter().find(|(t, _)| !t.segs.is_empty()).map(|(t, _)| t.size).unwrap_or(18.0);
            let spc_scale = |s: Option<Spc>, size: f64| -> f64 {
                match s {
                    Some(Spc::Pts(p)) => p,
                    Some(Spc::Pct(p)) => p * size * 1.2,
                    None => 0.0,
                }
            };
            let mut gap_before = if first_para { 0.0 } else { spc_scale(pp_all.spc_bef, lead_size) };
            if !first_para {
                if let Some(prev) = lines.last_mut() {
                    prev.gap_before += 0.0;
                }
            }
            // wrap
            let mut cur: Vec<Tok> = Vec::new();
            let mut cur_w = 0.0;
            let mut is_first_line = true;
            let mut push_line = |lines: &mut Vec<Line>, cur: &mut Vec<Tok>, cur_w: &mut f64, last: bool, first: &mut bool, gap_before: &mut f64, this: &mut Self| {
                while cur.last().map_or(false, |t| t.space && t.width > 0.0 && !last_is_break(cur)) {
                    let t = cur.pop().unwrap();
                    *cur_w -= t.width;
                }
                let toks_taken = std::mem::take(cur);
                let (mut asc, mut desc, mut gap, mut size) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
                for t in &toks_taken {
                    asc = asc.max(t.asc);
                    desc = desc.max(t.desc);
                    gap = gap.max(t.gap);
                    size = size.max(t.size);
                }
                if toks_taken.is_empty() {
                    asc = lead_size * 0.9;
                    desc = lead_size * 0.2;
                    size = lead_size;
                }
                let natural = asc + desc + gap;
                let ln = pp_all.ln_spc;
                let reduce = cx.reduce;
                let pitch = match ln {
                    Some(Spc::Pts(p)) => p,
                    Some(Spc::Pct(p)) => natural * (p - reduce).max(0.2),
                    None => natural * (1.0 - reduce).max(0.2),
                };
                let x0 = if *first { first_x } else { rest_x };
                let bullet = if *first {
                    bullet_text.as_ref().map(|(k, font)| {
                        let size_b = size * pp_all.bu_sz.unwrap_or(1.0);
                        let color = match &pp_all.bu_clr {
                            Some(c) => env.color(c, None),
                            None => toks_taken.iter().find(|t| !t.segs.is_empty()).map(|t| t.color).unwrap_or(([0.0; 3], 1.0)),
                        };
                        let fidx = match k {
                            BKind::Text(_) => {
                                let fam = match font.as_deref() {
                                    Some(f) if !f.to_lowercase().contains("wingdings") && !f.starts_with('+') => f.to_string(),
                                    _ => toks_taken.iter().find(|t| !t.segs.is_empty()).map(|_| String::new()).unwrap_or_default(),
                                };
                                let fam = if fam.is_empty() { this.theme_font(env, "+mn-lt") } else { fam };
                                this.fonts.segments(&mut this.doc, &fam, false, false, match k { BKind::Text(t) => t.as_str(), _ => "0" }).ok().and_then(|s| s.first().map(|x| x.0))
                            }
                            _ => None,
                        };
                        if std::env::var("IHP_DEBUG").is_ok() { eprintln!("bullet color {:?} bu_clr {:?} size {}", color, pp_all.bu_clr, size_b); }
                        Bullet { kind: match k { BKind::Text(t) => BKind::Text(t.clone()), BKind::Disc => BKind::Disc, BKind::Square => BKind::Square, BKind::Circle => BKind::Circle, BKind::Triangle => BKind::Triangle, BKind::Diamond => BKind::Diamond }, x: marl + indent.min(0.0), color, size: size_b, font: fidx }
                    })
                } else {
                    None
                };
                lines.push(Line { toks: toks_taken, width: *cur_w, x0, avail: (width - x0).max(1.0), align: algn.clone(), last, asc, desc, pitch, gap_before: std::mem::take(gap_before), bullet });
                *first = false;
                *cur_w = 0.0;
            };
            let _ = &mut push_line;
            let n_toks = toks.len();
            for (ti, (t, brk)) in toks.into_iter().enumerate() {
                if brk {
                    push_line(&mut lines, &mut cur, &mut cur_w, true, &mut is_first_line, &mut gap_before, self);
                    continue;
                }
                let x0 = if is_first_line { first_x } else { rest_x };
                let avail = width - x0;
                if !t.space && cur_w + t.width > avail + 0.01 && cur.iter().any(|c| !c.space) {
                    push_line(&mut lines, &mut cur, &mut cur_w, false, &mut is_first_line, &mut gap_before, self);
                }
                if cur.is_empty() && t.space && !is_first_line && t.width > 0.0 {
                    // a space that wrapped to the start of a line is dropped
                    continue;
                }
                cur_w += t.width;
                cur.push(t);
                let _ = (ti, n_toks);
            }
            push_line(&mut lines, &mut cur, &mut cur_w, true, &mut is_first_line, &mut gap_before, self);
            let aft = spc_scale(pp_all.spc_aft, lead_size);
            if let Some(l) = lines.last_mut() {
                l.pitch += aft;
            }
        }
        Ok(lines)
    }

    /// Draws laid-out lines with their top-left at (x, y) in the text area `width` wide.
    fn emit_lines(&mut self, out: &mut String, lines: &[Line], x: f64, y: f64, width: f64) {
        let mut top = y;
        for l in lines {
            top += l.gap_before;
            let natural_h = l.pitch;
            // baseline: descent kept at the bottom of the line box
            let base = top + natural_h - l.desc - if l.pitch > l.asc + l.desc { 0.0 } else { 0.0 };
            let base = base.max(top + l.asc * 0.5);
            let avail = l.avail;
            let (mut lx, mut extra) = (x + l.x0, 0.0);
            let slack = avail - l.width;
            match l.align.as_str() {
                "ctr" => lx += slack / 2.0,
                "r" => lx += slack,
                "just" | "dist" if !l.last => {
                    let gaps = l.toks.iter().filter(|t| t.space && t.width > 0.0).count();
                    if gaps > 0 && slack > 0.0 {
                        extra = slack / gaps as f64;
                    }
                }
                _ => {}
            }
            let _ = width;
            if let Some(b) = &l.bullet {
                let bx = x + b.x;
                let r = b.size * 0.14;
                let bx = bx + b.size * 0.04;
                let cy = base - b.size * 0.34;
                let col = format!("{} ", super_rgb(b.color.0));
                match &b.kind {
                    BKind::Disc => {
                        let p = ellipse_path(bx + r * 0.9, cy, r * 0.8, r * 0.8);
                        out.push_str(&format!("q {col}{}f Q\n", p));
                    }
                    BKind::Circle => {
                        let p = ellipse_path(bx + r * 0.9, cy, r * 0.8, r * 0.8);
                        out.push_str(&format!("q {} {} w {}S Q\n", super_rgb_stroke(b.color.0), f(b.size * 0.05), p));
                    }
                    BKind::Square => out.push_str(&format!("q {col}{} {} {} {} re f Q\n", f(bx), f(cy - r * 0.8), f(r * 1.6), f(r * 1.6))),
                    BKind::Triangle => out.push_str(&format!("q {col}{} {} m {} {} l {} {} l h f Q\n", f(bx), f(cy - r), f(bx + r * 1.7), f(cy), f(bx), f(cy + r))),
                    BKind::Diamond => out.push_str(&format!("q {col}{} {} m {} {} l {} {} l {} {} l h f Q\n", f(bx), f(cy), f(bx + r), f(cy - r), f(bx + 2.0 * r), f(cy), f(bx + r), f(cy + r))),
                    BKind::Text(t) => {
                        if let Some(fi) = b.font {
                            if let Ok((show, _)) = self.fonts.shape(fi, t, b.size) {
                                out.push_str(&format!("BT /{} {} Tf {} 1 0 0 -1 {} {} Tm {} ET\n", self.fonts.name(fi), f(b.size), super_rgb(b.color.0), f(bx), f(base), show));
                            }
                        }
                    }
                }
            }
            for t in &l.toks {
                let tw = t.width + if t.space && t.width > 0.0 { extra } else { 0.0 };
                if !t.space {
                    let mut px = lx;
                    for s in &t.segs {
                        let gs = if t.color.1 < 0.999 { Some(self.gs_name(t.color.1)) } else { None };
                        out.push_str(&format!("BT /{} {} Tf {} ", self.fonts.name(s.font), f(s.size), super_rgb(t.color.0)));
                        if let Some(g) = gs {
                            out.push_str(&format!("/{g} gs "));
                        }
                        if t.spc != 0.0 {
                            out.push_str(&format!("{} Tc ", f(t.spc)));
                        }
                        out.push_str(&format!("1 0 0 -1 {} {} Tm {} ET\n", f(px), f(base + t.shift), s.show));
                        px += s.width + if t.spc != 0.0 { t.spc * (s.show.len() as f64 / 4.0).max(0.0) * 0.0 } else { 0.0 };
                    }
                }
                if (t.ul || t.strike) && t.width > 0.0 {
                    let th = (t.size / 18.0).max(0.5);
                    if t.ul {
                        out.push_str(&format!("q {} {} {} {} {} re f Q\n", super_rgb(t.color.0), f(lx), f(base + t.size * 0.1 + t.shift), f(tw), f(th)));
                    }
                    if t.strike {
                        out.push_str(&format!("q {} {} {} {} {} re f Q\n", super_rgb(t.color.0), f(lx), f(base - t.size * 0.3 + t.shift), f(tw), f(th)));
                    }
                }
                lx += tw;
            }
            top += natural_h;
        }
    }

    pub(super) fn draw_shape_text(&mut self, out: &mut String, e: &Eff, tx: &TextBody, env: &Env, w: f64, h: f64) -> Result<()> {
        // body properties: shape over layout over master
        let mut body = tx.body.clone();
        let mut chain_hi: Vec<&LstStyle> = vec![&tx.lst];
        let mut is_ph = false;
        if let Some(l) = e.lay.and_then(|s| s.tx.as_ref()) {
            body = body.over(&l.body);
            chain_hi.push(&l.lst);
        }
        if let Some(m) = e.mas.and_then(|s| s.tx.as_ref()) {
            body = body.over(&m.body);
            chain_hi.push(&m.lst);
        }
        if let Some(ph) = &e.sp.ph {
            is_ph = true;
            let t = &env.master.tx;
            chain_hi.push(match ph.ty.as_str() {
                "title" | "ctrTitle" => &t.title,
                "body" | "subTitle" | "obj" => &t.body,
                _ => &t.other,
            });
        }
        let _ = is_ph;
        let lo = vec![&env.deck.default_text];
        let (l_in, t_in, r_in, b_in) = (body.l.unwrap_or(7.2), body.t.unwrap_or(3.6), body.r.unwrap_or(7.2), body.b.unwrap_or(3.6));
        let (rx0, ry0, rx1, ry1) = super::render::text_rect_pub(e.geom(), w, h);
        let (tw, th) = (rx1 - rx0, ry1 - ry0);
        let avail_w = (tw - l_in - r_in).max(1.0);
        let wrap_none = body.wrap.as_deref() == Some("none");
        let layout_w = if wrap_none { 1.0e6 } else { avail_w };
        let font_color = e.style().and_then(|s| s.font_color.as_ref());
        let cx = TextCtx { hi: chain_hi, lo, font_color, scale: body.font_scale.unwrap_or(1.0), reduce: body.ln_reduction.unwrap_or(0.0), default_bold: None, default_color: None };
        let lines = self.layout(&tx.paras, &cx, env, layout_w)?;
        // unwrapped text is positioned by its alignment inside the box
        let lines: Vec<Line> = if wrap_none {
            lines.into_iter().map(|mut l| {
                l.avail = avail_w - l.x0;
                l
            }).collect()
        } else {
            lines
        };
        let total: f64 = lines.iter().map(|l| l.gap_before + l.pitch).sum();
        let avail_h = th - t_in - b_in;
        let y0 = match body.anchor.as_deref() {
            // a shape that resizes to its text keeps its top
            _ if body.autofit.as_deref() == Some("sp") && body.anchor.as_deref() != Some("b") => ry0 + t_in,
            Some("ctr") => ry0 + t_in + (avail_h - total) / 2.0,
            Some("b") => ry0 + t_in + (avail_h - total),
            _ => ry0 + t_in,
        };
        let vert = body.vert.as_deref();
        if matches!(vert, Some("vert") | Some("vert270")) {
            let ang = if vert == Some("vert") { 90.0 } else { -90.0 };
            // rotate the text block around the box centre, swapping its width and height
            let (cx0, cy0) = (w / 2.0, h / 2.0);
            let lw = (th - t_in - b_in).max(1.0);
            let lines2 = self.layout(&tx.paras, &cx, env, lw)?;
            let total2: f64 = lines2.iter().map(|l| l.gap_before + l.pitch).sum();
            let avail2 = tw - l_in - r_in;
            let yy = match body.anchor.as_deref() {
                Some("ctr") => (avail2 - total2) / 2.0,
                Some("b") => avail2 - total2,
                _ => 0.0,
            };
            out.push_str(&format!("q 1 0 0 1 {} {} cm {} cm 1 0 0 1 {} {} cm\n", f(cx0), f(cy0), rot_cm(ang), f(-lw / 2.0), f(-avail2 / 2.0)));
            self.emit_lines(out, &lines2, 0.0, yy, lw);
            out.push_str("Q\n");
            return Ok(());
        }
        out.push_str("q\n");
        self.emit_lines(out, &lines, rx0 + l_in, y0, avail_w);
        out.push_str("Q\n");
        Ok(())
    }

    // -------------------------------------------------------------- tables

    pub(super) fn draw_table(&mut self, out: &mut String, t: &Table, env: &Env, fr: &Frame) -> Result<()> {
        let x = &t.xfrm;
        let (m, _, _) = frame_for(x, fr);
        let ncols = t.cols.len().max(1);
        let cols: Vec<f64> = if t.cols.is_empty() { vec![x.w; 1] } else { t.cols.clone() };
        let style = t.style_id.as_ref().and_then(|id| env.deck.table_styles.get(id).cloned()).or_else(|| t.style_id.as_ref().and_then(|id| builtin_style(id)));
        let nrows = t.rows.len();
        // row heights grow with their text
        let mut heights: Vec<f64> = t.rows.iter().map(|r| r.0).collect();
        let mut laid: Vec<Vec<Option<(Vec<Line>, f64)>>> = Vec::new();
        for (ri, (_, cells)) in t.rows.iter().enumerate() {
            let mut row = Vec::new();
            let mut ci = 0;
            for cell in cells {
                if cell.h_merge || cell.v_merge {
                    row.push(None);
                    ci += 1;
                    continue;
                }
                let span_w: f64 = (0..cell.grid_span.max(1)).map(|k| cols.get(ci + k).copied().unwrap_or(0.0)).sum();
                let part = cell_style(&style, t, ri, ci, nrows, ncols);
                let ml = cell.mar[0].unwrap_or(7.2);
                let mr = cell.mar[1].unwrap_or(7.2);
                let mt = cell.mar[2].unwrap_or(3.6);
                let mb = cell.mar[3].unwrap_or(3.6);
                let color = part.color.clone();
                let cx = TextCtx { hi: vec![&cell.tx.lst], lo: vec![&env.deck.default_text], font_color: None, scale: 1.0, reduce: 0.0, default_bold: part.bold, default_color: color.as_ref() };
                let lines = self.layout(&cell.tx.paras, &cx, env, (span_w - ml - mr).max(1.0))?;
                let th: f64 = lines.iter().map(|l| l.gap_before + l.pitch).sum();
                if cell.row_span <= 1 {
                    heights[ri] = heights[ri].max(th + mt + mb);
                }
                row.push(Some((lines, th)));
                ci += 1;
            }
            laid.push(row);
        }
        out.push_str(&format!("q {}\n", cm(&m)));
        let mut y = 0.0;
        for (ri, (_, cells)) in t.rows.iter().enumerate() {
            let mut cx = 0.0;
            for (ci, cell) in cells.iter().enumerate() {
                let cw = cols.get(ci).copied().unwrap_or(0.0);
                if cell.h_merge || cell.v_merge {
                    cx += cw;
                    continue;
                }
                let span_w: f64 = (0..cell.grid_span.max(1)).map(|k| cols.get(ci + k).copied().unwrap_or(0.0)).sum();
                let span_h: f64 = (0..cell.row_span.max(1)).map(|k| heights.get(ri + k).copied().unwrap_or(0.0)).sum();
                let part = cell_style(&style, t, ri, ci, nrows, ncols);
                let fill = cell.fill.clone().or(part.fill.clone());
                if let Some(fl) = &fill {
                    let rf = env.fill(fl, None);
                    let p = vec![super::geom::GPath { cmds: vec![G::M(cx, y), G::L(cx + span_w, y), G::L(cx + span_w, y + span_h), G::L(cx, y + span_h), G::Z], fill: true, stroke: false }];
                    self.paint_pub(out, &p, span_w, span_h, &rf);
                }
                // borders
                let b = |side: usize| -> Option<Ln> {
                    cell.borders[side].clone().or_else(|| {
                        let idx = match side {
                            0 => if ci == 0 { 0 } else { 5 },
                            1 => if ci + cell.grid_span.max(1) >= ncols { 1 } else { 5 },
                            2 => if ri == 0 { 2 } else { 4 },
                            _ => if ri + cell.row_span.max(1) >= nrows { 3 } else { 4 },
                        };
                        part.borders[idx].clone()
                    })
                };
                for side in 0..4 {
                    if let Some(l) = b(side) {
                        let rl = env.ln(&l, None);
                        let (x0, y0, x1, y1) = match side {
                            0 => (cx, y, cx, y + span_h),
                            1 => (cx + span_w, y, cx + span_w, y + span_h),
                            2 => (cx, y, cx + span_w, y),
                            _ => (cx, y + span_h, cx + span_w, y + span_h),
                        };
                        let p = vec![super::geom::GPath { cmds: vec![G::M(x0, y0), G::L(x1, y1)], fill: false, stroke: true }];
                        self.stroke_pub(out, &p, &rl);
                    }
                }
                // text
                if let Some(Some((lines, th))) = laid.get(ri).and_then(|r| r.get(ci)) {
                    let (ml, mt, mb) = (cell.mar[0].unwrap_or(7.2), cell.mar[2].unwrap_or(3.6), cell.mar[3].unwrap_or(3.6));
                    let avail = span_h - mt - mb;
                    let ty = match cell.anchor.as_deref() {
                        Some("ctr") => y + mt + (avail - th) / 2.0,
                        Some("b") => y + mt + (avail - th),
                        _ => y + mt,
                    };
                    self.emit_lines(out, lines, cx + ml, ty, span_w - ml);
                }
                cx += cw;
            }
            y += heights[ri];
        }
        out.push_str("Q\n");
        Ok(())
    }
}

fn last_is_break(_c: &[Tok]) -> bool {
    false
}

fn super_rgb(c: Rgb) -> String {
    let g = |v: f64| {
        let s = format!("{:.5}", v / 255.0);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    format!("{} {} {} rg", g(c[0]), g(c[1]), g(c[2]))
}
fn super_rgb_stroke(c: Rgb) -> String {
    super_rgb(c).replace(" rg", " RG")
}

fn ellipse_path(cx: f64, cy: f64, rx: f64, ry: f64) -> String {
    const K: f64 = 0.552_284_749_830_793_4;
    format!(
        "{} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c h ",
        f(cx - rx), f(cy),
        f(cx - rx), f(cy - ry * K), f(cx - rx * K), f(cy - ry), f(cx), f(cy - ry),
        f(cx + rx * K), f(cy - ry), f(cx + rx), f(cy - ry * K), f(cx + rx), f(cy),
        f(cx + rx), f(cy + ry * K), f(cx + rx * K), f(cy + ry), f(cx), f(cy + ry),
        f(cx - rx * K), f(cy + ry), f(cx - rx), f(cy + ry * K), f(cx - rx), f(cy)
    )
}

fn rot_cm(deg: f64) -> String {
    let (s, c) = deg.to_radians().sin_cos();
    format!("{} {} {} {} 0 0", f(c), f(s), f(-s), f(c))
}

fn cell_style(style: &Option<TableStyle>, t: &Table, ri: usize, ci: usize, nrows: usize, ncols: usize) -> PartStyle {
    let mut out = PartStyle::default();
    let Some(st) = style else { return out };
    let mut names: Vec<&str> = vec!["wholeTbl"];
    let body_row = if t.first_row { ri.saturating_sub(1) } else { ri };
    if t.band_row && !(t.first_row && ri == 0) {
        names.push(if body_row % 2 == 0 { "band1H" } else { "band2H" });
    }
    if t.band_col {
        names.push(if ci % 2 == 0 { "band1V" } else { "band2V" });
    }
    if t.first_col && ci == 0 {
        names.push("firstCol");
    }
    if t.last_col && ci + 1 == ncols {
        names.push("lastCol");
    }
    if t.last_row && ri + 1 == nrows {
        names.push("lastRow");
    }
    if t.first_row && ri == 0 {
        names.push("firstRow");
    }
    for n in names {
        if let Some(p) = st.parts.get(n) {
            if p.fill.is_some() {
                out.fill = p.fill.clone();
            }
            if p.bold.is_some() {
                out.bold = p.bold;
            }
            if p.color.is_some() {
                out.color = p.color.clone();
            }
            for i in 0..6 {
                if p.borders[i].is_some() {
                    out.borders[i] = p.borders[i].clone();
                }
            }
        }
    }
    out
}

/// "Medium Style 2 - Accent 1", PowerPoint's default, for decks whose tableStyles.xml doesn't carry it.
fn builtin_style(id: &str) -> Option<TableStyle> {
    use super::color::{Base, ColorSpec};
    if id != "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}" {
        return None;
    }
    let sc = |n: &str, mods: &[(&str, f64)]| ColorSpec { base: Base::Scheme(n.into()), mods: mods.iter().map(|(a, b)| (a.to_string(), *b)).collect() };
    let ln = |w: f64, c: ColorSpec| Ln { w: Some(w), fill: Some(Fill::Solid(c)), ..Default::default() };
    let white = |w: f64| ln(w, sc("lt1", &[]));
    let mut ts = TableStyle::default();
    ts.parts.insert("wholeTbl".into(), PartStyle { fill: Some(Fill::Solid(sc("accent1", &[("tint", 20000.0)]))), bold: None, color: Some(sc("dk1", &[])), borders: [Some(white(12700.0 / 12700.0)), Some(white(1.0)), Some(white(1.0)), Some(white(1.0)), Some(white(1.0)), Some(white(1.0))] });
    ts.parts.insert("band1H".into(), PartStyle { fill: Some(Fill::Solid(sc("accent1", &[("tint", 40000.0)]))), ..Default::default() });
    ts.parts.insert("firstRow".into(), PartStyle { fill: Some(Fill::Solid(sc("accent1", &[]))), bold: Some(true), color: Some(sc("lt1", &[])), borders: [None, None, None, Some(white(3.0)), None, None] });
    ts.parts.insert("firstCol".into(), PartStyle { fill: Some(Fill::Solid(sc("accent1", &[]))), bold: Some(true), color: Some(sc("lt1", &[])), borders: Default::default() });
    ts.parts.insert("lastCol".into(), PartStyle { fill: Some(Fill::Solid(sc("accent1", &[]))), bold: Some(true), color: Some(sc("lt1", &[])), borders: Default::default() });
    ts.parts.insert("lastRow".into(), PartStyle { fill: Some(Fill::Solid(sc("accent1", &[]))), bold: Some(true), color: Some(sc("lt1", &[])), borders: [None, None, Some(white(3.0)), None, None, None] });
    Some(ts)
}
