//! Preset and custom geometry as path commands in points (origin top-left, y down). The preset list is the
//! commonly used part of DrawingML's `presetShapeDefinitions`; anything else is drawn as its bounding rectangle.

use super::model::{CPath, Geom, PCmd};
use std::collections::HashMap;
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub enum G {
    M(f64, f64),
    L(f64, f64),
    C(f64, f64, f64, f64, f64, f64),
    Z,
}

pub struct GPath {
    pub cmds: Vec<G>,
    pub fill: bool,
    pub stroke: bool,
}

fn gp(cmds: Vec<G>) -> Vec<GPath> {
    vec![GPath { cmds, fill: true, stroke: true }]
}

fn poly(pts: &[(f64, f64)]) -> Vec<G> {
    let mut v: Vec<G> = pts.iter().enumerate().map(|(i, p)| if i == 0 { G::M(p.0, p.1) } else { G::L(p.0, p.1) }).collect();
    v.push(G::Z);
    v
}

const K: f64 = 0.552_284_749_830_793_4;

fn ellipse_cmds(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<G> {
    vec![
        G::M(cx - rx, cy),
        G::C(cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry),
        G::C(cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy),
        G::C(cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry),
        G::C(cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy),
        G::Z,
    ]
}

/// Appends an elliptical arc (visual start angle and swing in degrees, clockwise, y down) from the current point.
pub fn arc_to(out: &mut Vec<G>, cur: (f64, f64), wr: f64, hr: f64, st: f64, sw: f64) -> (f64, f64) {
    if wr <= 0.0 || hr <= 0.0 || sw == 0.0 {
        return cur;
    }
    let param = |a_deg: f64| -> f64 {
        let a = a_deg * PI / 180.0;
        (a.sin() * wr).atan2(a.cos() * hr)
    };
    let t1 = param(st);
    let mut t2 = param(st + sw);
    if sw > 0.0 {
        while t2 < t1 {
            t2 += 2.0 * PI;
        }
        while t2 - t1 > sw.abs() * PI / 180.0 + PI {
            t2 -= 2.0 * PI;
        }
    } else {
        while t2 > t1 {
            t2 -= 2.0 * PI;
        }
        while t1 - t2 > sw.abs() * PI / 180.0 + PI {
            t2 += 2.0 * PI;
        }
    }
    let (cx, cy) = (cur.0 - wr * t1.cos(), cur.1 - hr * t1.sin());
    let n = (((t2 - t1).abs() / (PI / 2.0)).ceil() as usize).max(1);
    let step = (t2 - t1) / n as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let mut t = t1;
    let mut end = cur;
    for _ in 0..n {
        let (c0, s0, c1, s1) = (t.cos(), t.sin(), (t + step).cos(), (t + step).sin());
        let p1 = (cx + wr * (c0 - k * s0), cy + hr * (s0 + k * c0));
        let p2 = (cx + wr * (c1 + k * s1), cy + hr * (s1 - k * c1));
        end = (cx + wr * c1, cy + hr * s1);
        out.push(G::C(p1.0, p1.1, p2.0, p2.1, end.0, end.1));
        t += step;
    }
    end
}

/// Custom geometry scaled to the shape box.
pub fn custom(paths: &[CPath], w: f64, h: f64) -> Vec<GPath> {
    let mut out = Vec::new();
    for p in paths {
        let (sx, sy) = (if p.w > 0.0 { w / p.w } else { 1.0 / 12700.0 }, if p.h > 0.0 { h / p.h } else { 1.0 / 12700.0 });
        let mut cmds = Vec::new();
        let mut cur = (0.0, 0.0);
        let mut start = (0.0, 0.0);
        for c in &p.cmds {
            match *c {
                PCmd::M(x, y) => {
                    cur = (x * sx, y * sy);
                    start = cur;
                    cmds.push(G::M(cur.0, cur.1));
                }
                PCmd::L(x, y) => {
                    cur = (x * sx, y * sy);
                    cmds.push(G::L(cur.0, cur.1));
                }
                PCmd::C(a, b, c2, d, e, f) => {
                    cur = (e * sx, f * sy);
                    cmds.push(G::C(a * sx, b * sy, c2 * sx, d * sy, cur.0, cur.1));
                }
                PCmd::Q(a, b, c2, d) => {
                    let (x0, y0) = cur;
                    let (qx, qy, ex, ey) = (a * sx, b * sy, c2 * sx, d * sy);
                    cmds.push(G::C(x0 + 2.0 / 3.0 * (qx - x0), y0 + 2.0 / 3.0 * (qy - y0), ex + 2.0 / 3.0 * (qx - ex), ey + 2.0 / 3.0 * (qy - ey), ex, ey));
                    cur = (ex, ey);
                }
                PCmd::Arc(wr, hr, st, sw) => {
                    cur = arc_to(&mut cmds, cur, wr * sx, hr * sy, st, sw);
                }
                PCmd::Z => {
                    cmds.push(G::Z);
                    cur = start;
                }
            }
        }
        out.push(GPath { cmds, fill: p.fill, stroke: p.stroke });
    }
    out
}

fn star(n: usize, ratio: f64, w: f64, h: f64) -> Vec<G> {
    let mut pts = Vec::new();
    for i in 0..n * 2 {
        let a = -PI / 2.0 + i as f64 * PI / n as f64;
        let r = if i % 2 == 0 { 1.0 } else { ratio };
        pts.push((r * a.cos(), r * a.sin()));
    }
    let (minx, maxx) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
    let (miny, maxy) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
    let mapped: Vec<(f64, f64)> = pts.iter().map(|p| ((p.0 - minx) / (maxx - minx) * w, (p.1 - miny) / (maxy - miny) * h)).collect();
    poly(&mapped)
}

/// Right-pointing arrow in a w x h box; `rot` turns it to the other directions.
fn arrow_right(w: f64, h: f64, a1: f64, a2: f64) -> Vec<(f64, f64)> {
    let ss = w.min(h);
    let sh = h * a1 / 200000.0;
    let dx = (ss * a2 / 100000.0).min(w);
    let vc = h / 2.0;
    vec![(0.0, vc - sh), (w - dx, vc - sh), (w - dx, 0.0), (w, vc), (w - dx, h), (w - dx, vc + sh), (0.0, vc + sh)]
}

fn adj(av: &HashMap<String, f64>, k: &str, d: f64) -> f64 {
    av.get(k).copied().unwrap_or(d)
}

fn round_rect(w: f64, h: f64, r: [f64; 4]) -> Vec<G> {
    // radii: top-left, top-right, bottom-right, bottom-left
    let mut v = vec![G::M(r[0], 0.0), G::L(w - r[1], 0.0)];
    if r[1] > 0.0 {
        v.push(G::C(w - r[1] * (1.0 - K), 0.0, w, r[1] * (1.0 - K), w, r[1]));
    }
    v.push(G::L(w, h - r[2]));
    if r[2] > 0.0 {
        v.push(G::C(w, h - r[2] * (1.0 - K), w - r[2] * (1.0 - K), h, w - r[2], h));
    }
    v.push(G::L(r[3], h));
    if r[3] > 0.0 {
        v.push(G::C(r[3] * (1.0 - K), h, 0.0, h - r[3] * (1.0 - K), 0.0, h - r[3]));
    }
    v.push(G::L(0.0, r[0]));
    if r[0] > 0.0 {
        v.push(G::C(0.0, r[0] * (1.0 - K), r[0] * (1.0 - K), 0.0, r[0], 0.0));
    }
    v.push(G::Z);
    v
}

pub fn preset(name: &str, av: &HashMap<String, f64>, w: f64, h: f64) -> Vec<GPath> {
    let ss = w.min(h);
    let (vc, hc) = (h / 2.0, w / 2.0);
    match name {
        "rect" | "flowChartProcess" | "flowChartAlternateProcess" | "textBox" => gp(poly(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)])),
        "roundRect" | "flowChartAlternateProcess2" => {
            let r = ss * adj(av, "adj", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            gp(round_rect(w, h, [r; 4]))
        }
        "round1Rect" => {
            let r = ss * adj(av, "adj", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            gp(round_rect(w, h, [0.0, r, 0.0, 0.0]))
        }
        "round2SameRect" => {
            let r1 = ss * adj(av, "adj1", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            let r2 = ss * adj(av, "adj2", 0.0).clamp(0.0, 50000.0) / 100000.0;
            gp(round_rect(w, h, [r1, r1, r2, r2]))
        }
        "round2DiagRect" => {
            let r1 = ss * adj(av, "adj1", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            let r2 = ss * adj(av, "adj2", 0.0).clamp(0.0, 50000.0) / 100000.0;
            gp(round_rect(w, h, [r1, r2, r1, r2]))
        }
        "snip1Rect" => {
            let c = ss * adj(av, "adj", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            gp(poly(&[(0.0, 0.0), (w - c, 0.0), (w, c), (w, h), (0.0, h)]))
        }
        "snip2SameRect" => {
            let c1 = ss * adj(av, "adj1", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            let c2 = ss * adj(av, "adj2", 0.0).clamp(0.0, 50000.0) / 100000.0;
            gp(poly(&[(c1, 0.0), (w - c1, 0.0), (w, c1), (w, h - c2), (w - c2, h), (c2, h), (0.0, h - c2), (0.0, c1)]))
        }
        "ellipse" | "flowChartConnector" | "flowChartSummingJunction" | "flowChartOr" => gp(ellipse_cmds(hc, vc, hc, vc)),
        "triangle" => gp(poly(&[(0.0, h), (w * adj(av, "adj", 50000.0) / 100000.0, 0.0), (w, h)])),
        "rtTriangle" => gp(poly(&[(0.0, h), (0.0, 0.0), (w, h)])),
        "diamond" | "flowChartDecision" => gp(poly(&[(0.0, vc), (hc, 0.0), (w, vc), (hc, h)])),
        "parallelogram" | "flowChartData" => {
            let o = ss * adj(av, "adj", 25000.0).clamp(0.0, 100000.0 * w / ss.max(1e-6)) / 100000.0;
            gp(poly(&[(0.0, h), (o, 0.0), (w, 0.0), (w - o, h)]))
        }
        "trapezoid" | "flowChartManualOperation" => {
            let o = if name == "trapezoid" { ss * adj(av, "adj", 25000.0).clamp(0.0, 50000.0 * w / ss.max(1e-6)) / 100000.0 } else { w * 0.1 };
            if name == "flowChartManualOperation" {
                gp(poly(&[(0.0, 0.0), (w, 0.0), (w - o, h), (o, h)]))
            } else {
                gp(poly(&[(0.0, h), (o, 0.0), (w - o, 0.0), (w, h)]))
            }
        }
        "pentagon" | "flowChartPreparation" if name == "pentagon" => {
            let pts: Vec<(f64, f64)> = (0..5).map(|i| (-PI / 2.0 + i as f64 * 2.0 * PI / 5.0)).map(|a| (a.cos(), a.sin())).collect();
            let (minx, maxx) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
            let (miny, maxy) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
            gp(poly(&pts.iter().map(|p| ((p.0 - minx) / (maxx - minx) * w, (p.1 - miny) / (maxy - miny) * h)).collect::<Vec<_>>()))
        }
        "hexagon" | "flowChartPreparation" => {
            let o = ss * adj(av, "adj", 25000.0).clamp(0.0, 50000.0 * w / ss.max(1e-6)) / 100000.0;
            gp(poly(&[(0.0, vc), (o, 0.0), (w - o, 0.0), (w, vc), (w - o, h), (o, h)]))
        }
        "octagon" => {
            let o = ss * adj(av, "adj", 29289.0).clamp(0.0, 50000.0) / 100000.0;
            gp(poly(&[(0.0, o), (o, 0.0), (w - o, 0.0), (w, o), (w, h - o), (w - o, h), (o, h), (0.0, h - o)]))
        }
        "plus" | "mathPlus" => {
            let o = ss * adj(av, "adj", if name == "plus" { 25000.0 } else { 23520.0 }).clamp(0.0, 50000.0) / 100000.0;
            gp(poly(&[(o, 0.0), (w - o, 0.0), (w - o, o), (w, o), (w, h - o), (w - o, h - o), (w - o, h), (o, h), (o, h - o), (0.0, h - o), (0.0, o), (o, o)]))
        }
        "star4" => gp(star(4, adj(av, "adj", 12500.0) / 50000.0, w, h)),
        "star5" => gp(star(5, adj(av, "adj", 19098.0) / 50000.0, w, h)),
        "star6" => gp(star(6, adj(av, "adj", 28868.0) / 50000.0, w, h)),
        "star7" => gp(star(7, adj(av, "adj", 34601.0) / 50000.0, w, h)),
        "star8" => gp(star(8, adj(av, "adj", 37500.0) / 50000.0, w, h)),
        "star10" => gp(star(10, adj(av, "adj", 42533.0) / 50000.0, w, h)),
        "star12" => gp(star(12, adj(av, "adj", 37500.0) / 50000.0, w, h)),
        "star16" => gp(star(16, adj(av, "adj", 37500.0) / 50000.0, w, h)),
        "star24" => gp(star(24, adj(av, "adj", 37500.0) / 50000.0, w, h)),
        "star32" => gp(star(32, adj(av, "adj", 37500.0) / 50000.0, w, h)),
        "rightArrow" => gp(poly(&arrow_right(w, h, adj(av, "adj1", 50000.0), adj(av, "adj2", 50000.0)))),
        "leftArrow" => {
            let p = arrow_right(w, h, adj(av, "adj1", 50000.0), adj(av, "adj2", 50000.0));
            gp(poly(&p.iter().map(|q| (w - q.0, q.1)).collect::<Vec<_>>()))
        }
        "downArrow" => {
            let p = arrow_right(h, w, adj(av, "adj1", 50000.0), adj(av, "adj2", 50000.0));
            gp(poly(&p.iter().map(|q| (q.1, q.0)).collect::<Vec<_>>()))
        }
        "upArrow" => {
            let p = arrow_right(h, w, adj(av, "adj1", 50000.0), adj(av, "adj2", 50000.0));
            gp(poly(&p.iter().map(|q| (q.1, h - q.0)).collect::<Vec<_>>()))
        }
        "leftRightArrow" => {
            let a1 = adj(av, "adj1", 50000.0);
            let a2 = adj(av, "adj2", 50000.0);
            let sh = h * a1 / 200000.0;
            let dx = (ss * a2 / 100000.0).min(w / 2.0);
            gp(poly(&[(0.0, vc), (dx, 0.0), (dx, vc - sh), (w - dx, vc - sh), (w - dx, 0.0), (w, vc), (w - dx, h), (w - dx, vc + sh), (dx, vc + sh), (dx, h)]))
        }
        "upDownArrow" => {
            let a1 = adj(av, "adj1", 50000.0);
            let a2 = adj(av, "adj2", 50000.0);
            let sh = w * a1 / 200000.0;
            let dy = (ss * a2 / 100000.0).min(h / 2.0);
            gp(poly(&[(hc, 0.0), (w, dy), (hc + sh, dy), (hc + sh, h - dy), (w, h - dy), (hc, h), (0.0, h - dy), (hc - sh, h - dy), (hc - sh, dy), (0.0, dy)]))
        }
        "chevron" => {
            let o = ss * adj(av, "adj", 50000.0).clamp(0.0, 100000.0 * w / ss.max(1e-6)) / 100000.0;
            gp(poly(&[(0.0, 0.0), (w - o, 0.0), (w, vc), (w - o, h), (0.0, h), (o, vc)]))
        }
        "homePlate" => {
            let o = ss * adj(av, "adj", 50000.0).clamp(0.0, 100000.0 * w / ss.max(1e-6)) / 100000.0;
            gp(poly(&[(0.0, 0.0), (w - o, 0.0), (w, vc), (w - o, h), (0.0, h)]))
        }
        "notchedRightArrow" => {
            let mut p = arrow_right(w, h, adj(av, "adj1", 50000.0), adj(av, "adj2", 50000.0));
            let sh = h * adj(av, "adj1", 50000.0) / 200000.0;
            p.insert(6, (ss * 0.2_f64.min(0.3), vc));
            let _ = sh;
            gp(poly(&p))
        }
        "donut" => {
            let t = ss * adj(av, "adj", 25000.0).clamp(0.0, 50000.0) / 100000.0;
            let mut c = ellipse_cmds(hc, vc, hc, vc);
            let inner = ellipse_cmds(hc, vc, (hc - t).max(0.0), (vc - t).max(0.0));
            // opposite winding so the hole stays empty under the non-zero rule
            let mut rev = vec![G::M(hc + (hc - t).max(0.0), vc)];
            let (rx, ry) = ((hc - t).max(0.0), (vc - t).max(0.0));
            rev.push(G::C(hc + rx, vc - ry * K, hc + rx * K, vc - ry, hc, vc - ry));
            rev.push(G::C(hc - rx * K, vc - ry, hc - rx, vc - ry * K, hc - rx, vc));
            rev.push(G::C(hc - rx, vc + ry * K, hc - rx * K, vc + ry, hc, vc + ry));
            rev.push(G::C(hc + rx * K, vc + ry, hc + rx, vc + ry * K, hc + rx, vc));
            rev.push(G::Z);
            let _ = inner;
            c.extend(rev);
            gp(c)
        }
        "can" | "flowChartMagneticDisk" => {
            let ry = h * adj(av, "adj", 25000.0).clamp(0.0, 50000.0) / 100000.0 / 2.0 * if name == "can" { 1.0 } else { 0.0 } + if name == "can" { 0.0 } else { h * 0.1 };
            let mut body = vec![G::M(0.0, ry), G::C(0.0, ry - ry * K, hc - hc * K, 0.0, hc, 0.0), G::C(hc + hc * K, 0.0, w, ry - ry * K, w, ry), G::L(w, h - ry), G::C(w, h - ry + ry * K, hc + hc * K, h, hc, h), G::C(hc - hc * K, h, 0.0, h - ry + ry * K, 0.0, h - ry), G::Z];
            let lip = vec![G::M(0.0, ry), G::C(0.0, ry + ry * K, hc - hc * K, 2.0 * ry, hc, 2.0 * ry), G::C(hc + hc * K, 2.0 * ry, w, ry + ry * K, w, ry)];
            let mut v = GPath { cmds: std::mem::take(&mut body), fill: true, stroke: true };
            let l = GPath { cmds: lip, fill: false, stroke: true };
            v.stroke = true;
            vec![v, l]
        }
        "flowChartTerminator" => gp(round_rect(w, h, [h / 2.0; 4])),
        "flowChartPredefinedProcess" => vec![
            GPath { cmds: poly(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]), fill: true, stroke: true },
            GPath { cmds: vec![G::M(w * 0.125, 0.0), G::L(w * 0.125, h), G::M(w * 0.875, 0.0), G::L(w * 0.875, h)], fill: false, stroke: true },
        ],
        "flowChartDocument" => gp(vec![G::M(0.0, 0.0), G::L(w, 0.0), G::L(w, h * 0.8), G::C(w * 0.75, h * 0.6, w * 0.65, h * 0.7, w * 0.5, h * 0.85), G::C(w * 0.3, h * 1.05, w * 0.15, h * 1.0, 0.0, h * 0.85), G::Z]),
        "foldedCorner" => {
            let c = ss * adj(av, "adj", 16667.0).clamp(0.0, 50000.0) / 100000.0;
            vec![
                GPath { cmds: poly(&[(0.0, 0.0), (w, 0.0), (w, h - c), (w - c, h), (0.0, h)]), fill: true, stroke: true },
                GPath { cmds: poly(&[(w - c, h), (w - c * 0.9, h - c * 0.9), (w, h - c)]), fill: true, stroke: true },
            ]
        }
        "frame" => {
            let t = ss * adj(av, "adj1", 12500.0).clamp(0.0, 50000.0) / 100000.0;
            let mut c = poly(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]);
            c.extend(poly(&[(t, t), (t, h - t), (w - t, h - t), (w - t, t)]));
            gp(c)
        }
        "bevel" => {
            let t = ss * adj(av, "adj", 12500.0).clamp(0.0, 50000.0) / 100000.0;
            vec![
                GPath { cmds: poly(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]), fill: true, stroke: true },
                GPath { cmds: poly(&[(t, t), (w - t, t), (w - t, h - t), (t, h - t)]), fill: false, stroke: true },
                GPath { cmds: vec![G::M(0.0, 0.0), G::L(t, t), G::M(w, 0.0), G::L(w - t, t), G::M(w, h), G::L(w - t, h - t), G::M(0.0, h), G::L(t, h - t)], fill: false, stroke: true },
            ]
        }
        "cube" => {
            let d = ss * adj(av, "adj", 25000.0).clamp(0.0, 100000.0) / 100000.0;
            vec![
                GPath { cmds: poly(&[(0.0, d), (w - d, d), (w - d, h), (0.0, h)]), fill: true, stroke: true },
                GPath { cmds: poly(&[(0.0, d), (d, 0.0), (w, 0.0), (w - d, d)]), fill: true, stroke: true },
                GPath { cmds: poly(&[(w - d, d), (w, 0.0), (w, h - d), (w - d, h)]), fill: true, stroke: true },
            ]
        }
        "heart" => gp(vec![
            G::M(hc, h),
            G::C(w * 0.1, h * 0.7, 0.0, h * 0.45, 0.0, h * 0.28),
            G::C(0.0, h * 0.08, w * 0.2, 0.0, w * 0.32, 0.0),
            G::C(w * 0.42, 0.0, hc, h * 0.1, hc, h * 0.25),
            G::C(hc, h * 0.1, w * 0.58, 0.0, w * 0.68, 0.0),
            G::C(w * 0.8, 0.0, w, h * 0.08, w, h * 0.28),
            G::C(w, h * 0.45, w * 0.9, h * 0.7, hc, h),
            G::Z,
        ]),
        "cloud" => {
            let mut v = vec![G::M(w * 0.2, h * 0.75)];
            let bumps = [(0.05, 0.62, 0.10, 0.45), (0.12, 0.30, 0.30, 0.28), (0.42, 0.06, 0.58, 0.10), (0.72, 0.12, 0.84, 0.28), (0.97, 0.42, 0.93, 0.60), (0.88, 0.85, 0.72, 0.85), (0.62, 0.98, 0.45, 0.90), (0.35, 0.98, 0.20, 0.75)];
            for (cx, cy, ex, ey) in bumps {
                v.push(G::C(w * cx, h * cy, w * cx, h * cy, w * ex, h * ey));
            }
            v.push(G::Z);
            gp(v)
        }
        "lightningBolt" => gp(poly(&[(w * 0.38, 0.0), (w * 0.6, h * 0.27), (w * 0.5, h * 0.29), (w * 0.75, h * 0.55), (w * 0.62, h * 0.57), (w, h), (w * 0.35, h * 0.65), (w * 0.47, h * 0.62), (0.0, h * 0.33), (w * 0.2, h * 0.3)])),
        "moon" => {
            let a = adj(av, "adj", 50000.0).clamp(0.0, 87500.0) / 100000.0;
            let x = w * a;
            gp(vec![G::M(w, 0.0), G::C(w * 0.45, 0.0, 0.0, h * 0.22, 0.0, vc), G::C(0.0, h * 0.78, w * 0.45, h, w, h), G::C(w - x * 0.2, h * 0.8, w - x * 0.2, h * 0.2, w, 0.0), G::Z])
        }
        "sun" => {
            let mut v = ellipse_cmds(hc, vc, w * 0.25, h * 0.25);
            for i in 0..8 {
                let a = i as f64 * PI / 4.0;
                let (c, s) = (a.cos(), a.sin());
                let (px, py) = (-s, c);
                v.extend(poly(&[(hc + c * w * 0.33 + px * w * 0.05, vc + s * h * 0.33 + py * h * 0.05), (hc + c * w * 0.5, vc + s * h * 0.5), (hc + c * w * 0.33 - px * w * 0.05, vc + s * h * 0.33 - py * h * 0.05)]));
            }
            gp(v)
        }
        "smileyFace" => vec![
            GPath { cmds: ellipse_cmds(hc, vc, hc, vc), fill: true, stroke: true },
            GPath { cmds: ellipse_cmds(w * 0.34, h * 0.38, w * 0.05, h * 0.07), fill: true, stroke: true },
            GPath { cmds: ellipse_cmds(w * 0.66, h * 0.38, w * 0.05, h * 0.07), fill: true, stroke: true },
            GPath { cmds: vec![G::M(w * 0.25, h * 0.62), G::C(w * 0.38, h * 0.82, w * 0.62, h * 0.82, w * 0.75, h * 0.62)], fill: false, stroke: true },
        ],
        "wedgeRectCallout" | "wedgeRoundRectCallout" | "wedgeEllipseCallout" => {
            let ax = hc + w * adj(av, "adj1", -20833.0) / 100000.0;
            let ay = vc + h * adj(av, "adj2", 62500.0) / 100000.0;
            if name == "wedgeEllipseCallout" {
                let mut v = ellipse_cmds(hc, vc, hc, vc);
                v.extend(poly(&[(hc - w * 0.12, vc + h * 0.4), (ax, ay), (hc + w * 0.02, vc + h * 0.49)]));
                gp(v)
            } else {
                let mut v = if name == "wedgeRectCallout" { poly(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]) } else { round_rect(w, h, [ss * 0.1667; 4]) };
                let (bx0, bx1) = (w * 0.2, w * 0.4);
                if ay > h {
                    v.extend(poly(&[(bx0, h), (ax, ay), (bx1, h)]));
                } else if ay < 0.0 {
                    v.extend(poly(&[(bx0, 0.0), (ax, ay), (bx1, 0.0)]));
                } else if ax < 0.0 {
                    v.extend(poly(&[(0.0, h * 0.2), (ax, ay), (0.0, h * 0.4)]));
                } else {
                    v.extend(poly(&[(w, h * 0.2), (ax, ay), (w, h * 0.4)]));
                }
                gp(v)
            }
        }
        "leftBracket" | "rightBracket" => {
            let r = ss * adj(av, "adj", 8333.0) / 100000.0;
            let left = name == "leftBracket";
            let (a, b) = if left { (w, 0.0) } else { (0.0, w) };
            vec![GPath { cmds: vec![G::M(a, 0.0), G::C(a + (b - a) * 0.2, 0.0, b, r * 0.2, b, r), G::L(b, h - r), G::C(b, h - r * 0.2, a + (b - a) * 0.2, h, a, h)], fill: false, stroke: true }]
        }
        "leftBrace" | "rightBrace" => {
            let left = name == "leftBrace";
            let (a, b) = if left { (w, 0.0) } else { (0.0, w) };
            let m = (a + b) / 2.0;
            vec![GPath { cmds: vec![G::M(a, 0.0), G::C(m, 0.0, m, h * 0.1, m, h * 0.25), G::L(m, vc - h * 0.1), G::C(m, vc - h * 0.03, b, vc - h * 0.02, b, vc), G::C(b, vc + h * 0.02, m, vc + h * 0.03, m, vc + h * 0.1), G::L(m, h * 0.75), G::C(m, h * 0.9, m, h, a, h)], fill: false, stroke: true }]
        }
        "line" | "straightConnector1" => vec![GPath { cmds: vec![G::M(0.0, 0.0), G::L(w, h)], fill: false, stroke: true }],
        "bentConnector2" => vec![GPath { cmds: vec![G::M(0.0, 0.0), G::L(w, 0.0), G::L(w, h)], fill: false, stroke: true }],
        "bentConnector3" | "bentConnector4" | "bentConnector5" => {
            let x = w * adj(av, "adj1", 50000.0) / 100000.0;
            vec![GPath { cmds: vec![G::M(0.0, 0.0), G::L(x, 0.0), G::L(x, h), G::L(w, h)], fill: false, stroke: true }]
        }
        "curvedConnector2" => vec![GPath { cmds: vec![G::M(0.0, 0.0), G::C(w * 0.55, 0.0, w, h * 0.45, w, h)], fill: false, stroke: true }],
        "curvedConnector3" | "curvedConnector4" | "curvedConnector5" => {
            let x = w * adj(av, "adj1", 50000.0) / 100000.0;
            vec![GPath { cmds: vec![G::M(0.0, 0.0), G::C(x * 0.5, 0.0, x, h * 0.25, x, vc), G::C(x, h * 0.75, x + (w - x) * 0.5, h, w, h)], fill: false, stroke: true }]
        }
        "arc" | "pie" | "chord" | "blockArc" => {
            let a1 = adj(av, "adj1", if name == "blockArc" { 10800000.0 } else if name == "arc" { 16200000.0 } else { 0.0 }) / 60000.0;
            let a2 = adj(av, "adj2", if name == "blockArc" { 0.0 } else if name == "arc" { 0.0 } else { 16200000.0 }) / 60000.0;
            let mut sw = a2 - a1;
            while sw <= 0.0 {
                sw += 360.0;
            }
            let rad = |a: f64| a * PI / 180.0;
            let param = |a: f64| (rad(a).sin() * hc).atan2(rad(a).cos() * vc);
            let t1 = param(a1);
            let start = (hc + hc * t1.cos(), vc + vc * t1.sin());
            let mut cmds = vec![G::M(start.0, start.1)];
            let end = arc_to(&mut cmds, start, hc, vc, a1, sw);
            match name {
                "arc" => vec![GPath { cmds, fill: false, stroke: true }],
                "pie" => {
                    cmds.insert(0, G::M(hc, vc));
                    cmds.insert(1, G::L(start.0, start.1));
                    cmds.remove(2);
                    cmds.push(G::Z);
                    gp(cmds)
                }
                "chord" => {
                    let _ = end;
                    cmds.push(G::Z);
                    gp(cmds)
                }
                _ => {
                    let t = ss * adj(av, "adj3", 25000.0) / 100000.0;
                    let (irx, iry) = ((hc - t).max(0.0), (vc - t).max(0.0));
                    let ip = (hc + irx * rad(a1 + sw).cos(), vc + iry * rad(a1 + sw).sin());
                    cmds.push(G::L(ip.0, ip.1));
                    arc_to(&mut cmds, ip, irx, iry, a1 + sw, -sw);
                    cmds.push(G::Z);
                    gp(cmds)
                }
            }
        }
        _ => gp(poly(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)])),
    }
}

pub fn paths(g: &Geom, w: f64, h: f64) -> Vec<GPath> {
    match g {
        Geom::Prst(n, av) => preset(n, av, w, h),
        Geom::Cust(p) => custom(p, w, h),
    }
}
