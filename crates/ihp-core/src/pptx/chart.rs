//! Charts (`c:chartSpace` parts): clustered/stacked bars and columns, lines, areas and pies with title, legend,
//! axes, gridlines and data labels, laid out the way PowerPoint's default chart style does. Drawn in the
//! chart frame's own coordinates (0..w, 0..h, y down).

use super::color::Rgb;
use super::geom::{GPath, G};
use super::model::*;
use super::render::*;
use crate::compress::Result;
use crate::stamp::f;
use roxmltree::{Document, Node};
use std::collections::HashMap;

struct Ser {
    name: String,
    cats: Vec<String>,
    vals: Vec<Option<f64>>,
    color: Option<Rgb>,
    pt_colors: HashMap<usize, Rgb>,
    marker: bool,
}

fn num(n: Option<Node>) -> Option<f64> {
    n.and_then(|n| n.attribute("val")).and_then(|v| v.parse().ok())
}

fn text_of(n: Node) -> String {
    n.descendants().filter(|d| d.is_element() && d.tag_name().name() == "t").filter_map(|t| t.text()).collect::<Vec<_>>().join("")
}

fn size_of(n: Option<Node>, default: f64) -> f64 {
    n.and_then(|n| n.descendants().find(|d| d.is_element() && d.tag_name().name() == "defRPr")).and_then(|d| d.attribute("sz")).and_then(|v| v.parse::<f64>().ok()).map(|v| v / 100.0).unwrap_or(default)
}

fn fmt_tick(v: f64, code: &str) -> String {
    if code.contains('%') {
        return format!("{}%", trim(v * 100.0));
    }
    let s = trim(v);
    if code.contains(',') && v.abs() >= 1000.0 {
        let int = v.trunc() as i64;
        let mut out = String::new();
        for (i, c) in int.abs().to_string().chars().rev().enumerate() {
            if i > 0 && i % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        let out: String = out.chars().rev().collect();
        return if v < 0.0 { format!("-{out}") } else { out };
    }
    s
}

fn trim(v: f64) -> String {
    let s = format!("{:.2}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Axis from 0 (or the data minimum when negative) to a round maximum, about 8 to 10 intervals.
fn nice_axis(min: f64, max: f64, fixed: (Option<f64>, Option<f64>, Option<f64>)) -> (f64, f64, f64) {
    let lo = fixed.0.unwrap_or(if min < 0.0 { min } else { 0.0 });
    let hi_data = fixed.1.unwrap_or(max.max(lo + 1e-9));
    let span = (hi_data - lo).max(1e-9);
    let step = fixed.2.unwrap_or_else(|| {
        let raw = span / 10.0;
        let mag = 10f64.powf(raw.log10().floor());
        let n = raw / mag;
        mag * if n <= 1.0 { 1.0 } else if n <= 2.0 { 2.0 } else if n <= 5.0 { 5.0 } else { 10.0 }
    });
    let lo = if fixed.0.is_some() { lo } else { (lo / step).floor() * step };
    let hi = if fixed.1.is_some() { hi_data } else { ((hi_data / step).ceil() * step).max(lo + step) };
    (lo, hi, step)
}

impl<'a> Rt<'a> {
    fn chart_text(&mut self, out: &mut String, env: &Env, text: &str, x: f64, y: f64, size: f64, color: Rgb, align: char, bold: bool) -> Result<f64> {
        let family = env.theme.minor.clone();
        let mut width = 0.0;
        let mut parts: Vec<(usize, String, f64)> = Vec::new();
        for (fi, seg) in self.fonts.segments(&mut self.doc, &family, bold, false, text)? {
            let (show, w) = self.fonts.shape(fi, &seg, size)?;
            width += w;
            parts.push((fi, show, w));
        }
        let mut px = match align {
            'c' => x - width / 2.0,
            'r' => x - width,
            _ => x,
        };
        for (fi, show, w) in parts {
            out.push_str(&format!("BT /{} {} Tf {} 1 0 0 -1 {} {} Tm {} ET\n", self.fonts.name(fi), f(size), rg(color), f(px), f(y), show));
            px += w;
        }
        Ok(width)
    }

    fn chart_width(&mut self, env: &Env, text: &str, size: f64) -> f64 {
        let family = env.theme.minor.clone();
        let Ok(segs) = self.fonts.segments(&mut self.doc, &family, false, false, text) else { return text.len() as f64 * size * 0.5 };
        segs.into_iter().map(|(fi, s)| self.fonts.shape(fi, &s, size).map(|r| r.1).unwrap_or(0.0)).sum()
    }

    pub(super) fn draw_chart(&mut self, out: &mut String, x: &Xfrm, path: &str, env: &Env, fr: &Frame) -> Result<()> {
        let Some(xml) = self.pkg.text(path) else { return Ok(()) };
        let Ok(doc) = Document::parse(&xml) else { return Ok(()) };
        let (m, w, h) = frame_for(x, fr);
        let root = doc.root_element();
        let Some(chart) = ch(root, "chart") else { return Ok(()) };
        let Some(plot) = ch(chart, "plotArea") else { return Ok(()) };
        let kind_node = plot.children().find(|n| n.is_element() && matches!(n.tag_name().name(), "barChart" | "bar3DChart" | "lineChart" | "line3DChart" | "pieChart" | "pie3DChart" | "doughnutChart" | "areaChart" | "area3DChart"));
        let Some(kn) = kind_node else { return Ok(()) };
        let kind = kn.tag_name().name().to_string();

        // series
        let accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
        let auto = |i: usize| -> Rgb {
            let spec = super::color::ColorSpec { base: super::color::Base::Scheme(accents[i % 6].into()), mods: if i >= 6 { vec![("lumMod".into(), if (i / 6) % 2 == 1 { 60000.0 } else { 80000.0 })] } else { vec![] } };
            env.color(&spec, None).0
        };
        let none = HashMap::new();
        let solid = |n: Option<Node>| -> Option<Rgb> {
            let pr = n?;
            match parse_fill(pr, &none) {
                Some(Fill::Solid(c)) => Some(env.color(&c, None).0),
                _ => None,
            }
        };
        let mut sers: Vec<Ser> = Vec::new();
        for s in chs(kn, "ser") {
            let name = ch(s, "tx").map(|t| t.descendants().filter(|d| d.is_element() && d.tag_name().name() == "v").filter_map(|v| v.text()).collect::<Vec<_>>().join("")).unwrap_or_default();
            let cats: Vec<String> = ch(s, "cat").map(|c| c.descendants().filter(|d| d.is_element() && d.tag_name().name() == "pt").map(|p| text_of_v(p)).collect()).unwrap_or_default();
            let mut vals: Vec<Option<f64>> = Vec::new();
            if let Some(v) = ch(s, "val") {
                let n = v.descendants().find(|d| d.is_element() && d.tag_name().name() == "ptCount").and_then(|p| num(Some(p))).unwrap_or(0.0) as usize;
                vals = vec![None; n];
                for p in v.descendants().filter(|d| d.is_element() && d.tag_name().name() == "pt") {
                    let i = p.attribute("idx").and_then(|i| i.parse::<usize>().ok()).unwrap_or(0);
                    if i < vals.len() {
                        vals[i] = text_of_v(p).parse().ok();
                    }
                }
            }
            let sp = ch(s, "spPr");
            let color = solid(sp).or_else(|| sp.and_then(|p| ch(p, "ln")).and_then(|l| solid(Some(l))));
            let mut pt_colors = HashMap::new();
            for d in chs(s, "dPt") {
                if let (Some(i), Some(c)) = (num(ch(d, "idx")), solid(ch(d, "spPr"))) {
                    pt_colors.insert(i as usize, c);
                }
            }
            let marker = ch(s, "marker").and_then(|m| ch(m, "symbol")).and_then(|s| s.attribute("val")).map_or(true, |v| v != "none");
            sers.push(Ser { name, cats, vals, color, pt_colors, marker });
        }
        if sers.is_empty() {
            return Ok(());
        }
        let ncat = sers.iter().map(|s| s.vals.len()).max().unwrap_or(0).max(1);
        let cats: Vec<String> = (0..ncat).map(|i| sers.iter().find_map(|s| s.cats.get(i).cloned()).unwrap_or_else(|| format!("{}", i + 1))).collect();
        let pie = kind.starts_with("pie") || kind.starts_with("doughnut");
        let show_val = kn.descendants().any(|d| d.is_element() && d.tag_name().name() == "showVal" && d.attribute("val") == Some("1"));
        let show_pct = kn.descendants().any(|d| d.is_element() && d.tag_name().name() == "showPercent" && d.attribute("val") == Some("1"));
        let text_col: Rgb = [89.0, 89.0, 89.0];

        out.push_str(&format!("q {}\n", cm(&m)));
        let (mut top, mut bottom, mut left, mut right) = (6.0, h - 6.0, 6.0, w - 6.0);
        // title
        if chart.children().any(|n| n.is_element() && n.tag_name().name() == "autoTitleDeleted" && n.attribute("val") == Some("1")) == false {
            if let Some(t) = ch(chart, "title") {
                let txt = text_of(t);
                if !txt.is_empty() {
                    let size = size_of(Some(t), 14.0);
                    self.chart_text(out, env, &txt, w / 2.0, top + size * 1.0, size, [64.0, 64.0, 64.0], 'c', false)?;
                    top += size * 1.7 + 6.0;
                }
            }
        }
        // legend
        let legend = ch(chart, "legend").filter(|l| ch(*l, "delete").and_then(|d| d.attribute("val")) != Some("1"));
        if let Some(l) = legend {
            let pos = ch(l, "legendPos").and_then(|p| p.attribute("val")).unwrap_or("r");
            let size = size_of(ch(l, "txPr"), 10.0);
            let entries: Vec<(String, Rgb)> = if pie { cats.iter().enumerate().map(|(i, c)| (c.clone(), sers[0].pt_colors.get(&i).copied().unwrap_or_else(|| auto(i)))).collect() } else { sers.iter().enumerate().map(|(i, s)| (s.name.clone(), s.color.unwrap_or_else(|| auto(i)))).collect() };
            let widths: Vec<f64> = entries.iter().map(|e| self.chart_width(env, &e.0, size) + size * 1.4 + 10.0).collect();
            if pos == "b" || pos == "t" {
                let total: f64 = widths.iter().sum();
                let y = if pos == "b" { bottom - size * 0.4 } else { top + size };
                let mut x0 = (w - total) / 2.0;
                for (e, wd) in entries.iter().zip(&widths) {
                    self.chart_rect(out, x0, y - size * 0.75, size * 0.7, size * 0.7, e.1);
                    self.chart_text(out, env, &e.0, x0 + size * 1.0, y, size, text_col, 'l', false)?;
                    x0 += wd;
                }
                if pos == "b" { bottom -= size * 1.8 } else { top += size * 1.8 }
            } else {
                let colw = widths.iter().cloned().fold(0.0, f64::max);
                let x0 = if pos == "r" { right - colw } else { left };
                let total_h = entries.len() as f64 * size * 1.6;
                let mut y = (top + bottom) / 2.0 - total_h / 2.0 + size;
                for e in &entries {
                    self.chart_rect(out, x0, y - size * 0.75, size * 0.7, size * 0.7, e.1);
                    self.chart_text(out, env, &e.0, x0 + size * 1.0, y, size, text_col, 'l', false)?;
                    y += size * 1.6;
                }
                if pos == "r" { right -= colw + 8.0 } else { left += colw + 8.0 }
            }
        }

        if pie {
            let vals: Vec<f64> = sers[0].vals.iter().map(|v| v.unwrap_or(0.0).max(0.0)).collect();
            let total: f64 = vals.iter().sum::<f64>().max(1e-9);
            let (cx, cy) = ((left + right) / 2.0, (top + bottom) / 2.0);
            let r = ((right - left).min(bottom - top) / 2.0 - 4.0).max(10.0);
            let first = ch(kn, "firstSliceAng").and_then(|a| num(Some(a))).unwrap_or(0.0);
            let mut ang = -90.0 + first;
            for (i, v) in vals.iter().enumerate() {
                let sweep = v / total * 360.0;
                let color = sers[0].pt_colors.get(&i).copied().unwrap_or_else(|| auto(i));
                let mut cmds = vec![G::M(cx, cy)];
                let start = (cx + r * ang.to_radians().cos(), cy + r * ang.to_radians().sin());
                cmds.push(G::L(start.0, start.1));
                super::geom::arc_to(&mut cmds, start, r, r, ang, sweep);
                cmds.push(G::Z);
                self.paint_pub(out, &[GPath { cmds: cmds.clone(), fill: true, stroke: false }], r * 2.0, r * 2.0, &RFill::Solid(color, 1.0));
                self.stroke_pub(out, &[GPath { cmds, fill: false, stroke: true }], &RLn { w: 1.0, fill: RFill::Solid([255.0, 255.0, 255.0], 1.0), dash: None, cap: None, join: None, head: None, tail: None });
                if (show_pct || show_val) && *v > 0.0 {
                    let mid = (ang + sweep / 2.0).to_radians();
                    let txt = if show_pct { format!("{}%", (v / total * 100.0).round()) } else { trim(*v) };
                    self.chart_text(out, env, &txt, cx + r * 0.65 * mid.cos(), cy + r * 0.65 * mid.sin() + 4.0, 12.0, [0.0, 0.0, 0.0], 'c', false)?;
                }
                ang += sweep;
            }
            out.push_str("Q\n");
            return Ok(());
        }

        // axes
        let val_ax = ch(plot, "valAx");
        let cat_ax = ch(plot, "catAx");
        let size_v = size_of(val_ax.and_then(|a| ch(a, "txPr")), 10.0);
        let size_c = size_of(cat_ax.and_then(|a| ch(a, "txPr")), 10.0);
        let horizontal = ch(kn, "barDir").and_then(|d| d.attribute("val")) == Some("bar");
        let grouping = ch(kn, "grouping").and_then(|g| g.attribute("val")).unwrap_or("clustered").to_string();
        let stacked = grouping == "stacked" || grouping == "percentStacked";
        let percent = grouping == "percentStacked";
        let is_bar = kind.starts_with("bar");
        let is_area = kind.starts_with("area");
        // value range
        let (mut dmin, mut dmax) = (f64::MAX, f64::MIN);
        for i in 0..ncat {
            if stacked {
                let tot: f64 = sers.iter().map(|s| s.vals.get(i).copied().flatten().unwrap_or(0.0)).sum();
                dmax = dmax.max(if percent { 1.0 } else { tot });
                dmin = dmin.min(sers.iter().map(|s| s.vals.get(i).copied().flatten().unwrap_or(0.0)).fold(0.0, f64::min));
            } else {
                for s in &sers {
                    if let Some(Some(v)) = s.vals.get(i) {
                        dmax = dmax.max(*v);
                        dmin = dmin.min(*v);
                    }
                }
            }
        }
        if dmin == f64::MAX {
            dmin = 0.0;
            dmax = 1.0;
        }
        let sc = val_ax.and_then(|a| ch(a, "scaling"));
        let (lo, hi, step) = nice_axis(dmin, dmax, (sc.and_then(|s| num(ch(s, "min"))), sc.and_then(|s| num(ch(s, "max"))), val_ax.and_then(|a| num(ch(a, "majorUnit")))));
        let code = val_ax.and_then(|a| ch(a, "numFmt")).and_then(|n| n.attribute("formatCode")).unwrap_or("General").to_string();
        let ticks: Vec<f64> = (0..=(((hi - lo) / step).round() as usize)).map(|k| lo + k as f64 * step).collect();
        let tick_labels: Vec<String> = ticks.iter().map(|t| fmt_tick(if percent { *t } else { *t }, if percent { "0%" } else { &code })).collect();
        let max_lab = tick_labels.iter().map(|t| self.chart_width(env, t, size_v)).fold(0.0, f64::max);
        let max_cat = cats.iter().map(|c| self.chart_width(env, c, size_c)).fold(0.0, f64::max);
        let (px0, px1, py0, py1);
        if horizontal {
            px0 = left + max_cat + 10.0;
            px1 = right - 8.0;
            py0 = top + 6.0;
            py1 = bottom - size_v - 10.0;
        } else {
            px0 = left + max_lab + 10.0;
            px1 = right - 8.0;
            py0 = top + 8.0;
            py1 = bottom - size_c - 10.0;
        }
        let (pw, ph) = (px1 - px0, py1 - py0);
        let grid = RLn { w: 0.75, fill: RFill::Solid([150.0, 150.0, 150.0], 1.0), dash: None, cap: None, join: None, head: None, tail: None };
        let to_v = |v: f64| -> f64 { if horizontal { px0 + (v - lo) / (hi - lo) * pw } else { py1 - (v - lo) / (hi - lo) * ph } };
        for (t, lab) in ticks.iter().zip(&tick_labels) {
            let p = to_v(*t);
            let line = if horizontal { vec![G::M(p, py0), G::L(p, py1)] } else { vec![G::M(px0, p), G::L(px1, p)] };
            self.stroke_pub(out, &[GPath { cmds: line, fill: false, stroke: true }], &grid);
            if horizontal {
                self.chart_text(out, env, lab, p, py1 + size_v + 5.0, size_v, text_col, 'c', false)?;
            } else {
                self.chart_text(out, env, lab, px0 - 6.0, p + size_v * 0.35, size_v, text_col, 'r', false)?;
            }
        }
        let band = if horizontal { ph } else { pw } / ncat as f64;
        for (i, c) in cats.iter().enumerate() {
            let mid = (i as f64 + 0.5) * band;
            if horizontal {
                self.chart_text(out, env, c, px0 - 6.0, py0 + mid + size_c * 0.35, size_c, text_col, 'r', false)?;
            } else {
                self.chart_text(out, env, c, px0 + mid, py1 + size_c + 6.0, size_c, text_col, 'c', false)?;
            }
        }
        let axis = RLn { w: 0.75, fill: RFill::Solid([191.0, 191.0, 191.0], 1.0), dash: None, cap: None, join: None, head: None, tail: None };
        let base = to_v(0.0f64.max(lo));
        let axis_line = if horizontal { vec![G::M(base, py0), G::L(base, py1)] } else { vec![G::M(px0, base), G::L(px1, base)] };
        self.stroke_pub(out, &[GPath { cmds: axis_line, fill: false, stroke: true }], &axis);

        let gap = ch(kn, "gapWidth").and_then(|g| num(Some(g))).unwrap_or(150.0) / 100.0;
        let overlap = ch(kn, "overlap").and_then(|g| num(Some(g))).unwrap_or(0.0) / 100.0;
        let n = sers.len();
        if is_bar {
            let bw = if stacked { band / (1.0 + gap) } else { band / (n as f64 - (n as f64 - 1.0) * overlap + gap) };
            for i in 0..ncat {
                let mut acc = 0.0;
                let col_total: f64 = sers.iter().map(|s| s.vals.get(i).copied().flatten().unwrap_or(0.0)).sum::<f64>().max(1e-9);
                for (si, s) in sers.iter().enumerate() {
                    let Some(Some(v0)) = s.vals.get(i) else { continue };
                    let v = if percent { v0 / col_total } else { *v0 };
                    let color = s.pt_colors.get(&i).copied().or(s.color).unwrap_or_else(|| auto(si));
                    let (a, b) = if stacked { (acc, acc + v) } else { (0.0f64.max(lo), v) };
                    acc += v;
                    let off = if stacked { (band - bw) / 2.0 } else { (band - bw * (n as f64 - (n as f64 - 1.0) * overlap)) / 2.0 + si as f64 * bw * (1.0 - overlap) };
                    let (va, vb) = (to_v(a), to_v(b));
                    if horizontal {
                        self.chart_rect(out, va.min(vb), py0 + i as f64 * band + off, (vb - va).abs(), bw, color);
                    } else {
                        self.chart_rect(out, px0 + i as f64 * band + off, va.min(vb), bw, (vb - va).abs(), color);
                    }
                    if show_val && !stacked {
                        let txt = trim(*v0);
                        if horizontal {
                            self.chart_text(out, env, &txt, vb + 3.0, py0 + i as f64 * band + off + bw / 2.0 + 4.0, 10.0, [0.0; 3], 'l', false)?;
                        } else {
                            self.chart_text(out, env, &txt, px0 + i as f64 * band + off + bw / 2.0, vb - 3.0, 10.0, [0.0; 3], 'c', false)?;
                        }
                    }
                }
            }
        } else {
            // lines and areas: points at the middle of each category band
            let mut acc = vec![0.0; ncat];
            for (si, s) in sers.iter().enumerate() {
                let color = s.color.unwrap_or_else(|| auto(si));
                let pts: Vec<(f64, f64)> = (0..ncat).filter_map(|i| s.vals.get(i).copied().flatten().map(|v| (px0 + (i as f64 + 0.5) * band, to_v(if stacked { acc[i] + v } else { v }), ))).collect();
                if stacked {
                    for i in 0..ncat {
                        acc[i] += s.vals.get(i).copied().flatten().unwrap_or(0.0);
                    }
                }
                if pts.len() < 2 {
                    continue;
                }
                let mut cmds: Vec<G> = pts.iter().enumerate().map(|(i, p)| if i == 0 { G::M(p.0, p.1) } else { G::L(p.0, p.1) }).collect();
                if is_area {
                    let mut a = cmds.clone();
                    a.push(G::L(pts.last().unwrap().0, base));
                    a.push(G::L(pts[0].0, base));
                    a.push(G::Z);
                    self.paint_pub(out, &[GPath { cmds: a, fill: true, stroke: false }], pw, ph, &RFill::Solid(color, 0.85));
                } else {
                    let ln = RLn { w: 2.25, fill: RFill::Solid(color, 1.0), dash: None, cap: Some("rnd".into()), join: Some("round".into()), head: None, tail: None };
                    self.stroke_pub(out, &[GPath { cmds: std::mem::take(&mut cmds), fill: false, stroke: true }], &ln);
                    if s.marker {
                        for p in &pts {
                            let c = super::geom::preset("ellipse", &HashMap::new(), 5.0, 5.0);
                            let shifted: Vec<GPath> = c.into_iter().map(|gp| GPath { cmds: gp.cmds.iter().map(|g| match *g { G::M(x, y) => G::M(x + p.0 - 2.5, y + p.1 - 2.5), G::L(x, y) => G::L(x + p.0 - 2.5, y + p.1 - 2.5), G::C(a, b, c2, d, e, g2) => G::C(a + p.0 - 2.5, b + p.1 - 2.5, c2 + p.0 - 2.5, d + p.1 - 2.5, e + p.0 - 2.5, g2 + p.1 - 2.5), G::Z => G::Z }).collect(), fill: true, stroke: false }).collect();
                            self.paint_pub(out, &shifted, 5.0, 5.0, &RFill::Solid(color, 1.0));
                        }
                    }
                }
            }
        }
        out.push_str("Q\n");
        Ok(())
    }

    fn chart_rect(&mut self, out: &mut String, x: f64, y: f64, w: f64, h: f64, c: Rgb) {
        let p = GPath { cmds: vec![G::M(x, y), G::L(x + w, y), G::L(x + w, y + h), G::L(x, y + h), G::Z], fill: true, stroke: false };
        self.paint_pub(out, &[p], w, h, &RFill::Solid(c, 1.0));
    }
}

fn text_of_v(p: Node) -> String {
    p.descendants().find(|d| d.is_element() && d.tag_name().name() == "v").and_then(|v| v.text()).unwrap_or("").to_string()
}

fn rg(c: Rgb) -> String {
    let g = |v: f64| {
        let s = format!("{:.5}", v / 255.0);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    format!("{} {} {} rg", g(c[0]), g(c[1]), g(c[2]))
}
