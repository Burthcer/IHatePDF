//! DrawingML colours: `srgbClr`, `schemeClr` (through the colour map), `sysClr`, `prstClr` and their transforms.

use roxmltree::Node;
use std::collections::HashMap;

pub type Rgb = [f64; 3]; // 0..255

#[derive(Clone, Debug)]
pub enum Base {
    Rgb(Rgb),
    Scheme(String),
    /// `phClr`: the colour of whatever references the style (fillRef, lnRef...).
    Ph,
}

#[derive(Clone, Debug)]
pub struct ColorSpec {
    pub base: Base,
    pub mods: Vec<(String, f64)>,
}

/// What a colour needs to resolve: the theme's colours, the slide's colour map and the placeholder colour.
pub struct ColorCtx<'a> {
    pub scheme: &'a HashMap<String, Rgb>,
    pub map: &'a HashMap<String, String>,
    pub ph: Option<(Rgb, f64)>,
}

pub fn hex(h: &str) -> Rgb {
    let v = |i: usize| h.get(i..i + 2).and_then(|s| u8::from_str_radix(s, 16).ok()).unwrap_or(0) as f64;
    [v(0), v(2), v(4)]
}

fn preset(name: &str) -> Option<Rgb> {
    Some(match name {
        "black" => [0.0, 0.0, 0.0],
        "white" => [255.0, 255.0, 255.0],
        "red" => [255.0, 0.0, 0.0],
        "green" => [0.0, 128.0, 0.0],
        "blue" => [0.0, 0.0, 255.0],
        "yellow" => [255.0, 255.0, 0.0],
        "gray" | "grey" => [128.0, 128.0, 128.0],
        "ltGray" | "ltGrey" => [211.0, 211.0, 211.0],
        "dkGray" | "dkGrey" => [169.0, 169.0, 169.0],
        "orange" => [255.0, 165.0, 0.0],
        "cyan" => [0.0, 255.0, 255.0],
        "magenta" => [255.0, 0.0, 255.0],
        "brown" => [165.0, 42.0, 42.0],
        "purple" => [128.0, 0.0, 128.0],
        "pink" => [255.0, 192.0, 203.0],
        "dkRed" => [139.0, 0.0, 0.0],
        "dkGreen" => [0.0, 100.0, 0.0],
        "dkBlue" => [0.0, 0.0, 139.0],
        "navy" => [0.0, 0.0, 128.0],
        "gold" => [255.0, 215.0, 0.0],
        "silver" => [192.0, 192.0, 192.0],
        "lime" => [0.0, 255.0, 0.0],
        "teal" => [0.0, 128.0, 128.0],
        "maroon" => [128.0, 0.0, 0.0],
        "olive" => [128.0, 128.0, 0.0],
        _ => return None,
    })
}

/// The colour child of `parent` (`<a:solidFill>`, `<a:gs>`, `<a:ln>`...): the first of the five colour elements.
pub fn parse_color(parent: Node) -> Option<ColorSpec> {
    let c = parent.children().find(|n| n.is_element() && matches!(n.tag_name().name(), "srgbClr" | "schemeClr" | "sysClr" | "prstClr" | "scrgbClr" | "hslClr"))?;
    parse_color_el(c)
}

/// A colour element itself (`<a:srgbClr .../>`).
pub fn parse_color_el(c: Node) -> Option<ColorSpec> {
    if !matches!(c.tag_name().name(), "srgbClr" | "schemeClr" | "sysClr" | "prstClr" | "scrgbClr" | "hslClr") {
        return None;
    }
    let val = c.attribute("val").unwrap_or("");
    let base = match c.tag_name().name() {
        "srgbClr" => Base::Rgb(hex(val)),
        "sysClr" => Base::Rgb(c.attribute("lastClr").map(hex).unwrap_or(match val {
            "window" => [255.0, 255.0, 255.0],
            _ => [0.0, 0.0, 0.0],
        })),
        "prstClr" => Base::Rgb(preset(val).unwrap_or([0.0, 0.0, 0.0])),
        "scrgbClr" => {
            let g = |k: &str| (c.attribute(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 100000.0 * 255.0).clamp(0.0, 255.0);
            Base::Rgb([g("r"), g("g"), g("b")])
        }
        "schemeClr" if val == "phClr" => Base::Ph,
        _ => Base::Scheme(val.to_string()),
    };
    let mods = c
        .children()
        .filter(|n| n.is_element())
        .map(|n| (n.tag_name().name().to_string(), n.attribute("val").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)))
        .collect();
    Some(ColorSpec { base, mods })
}

fn to_lin(c: f64) -> f64 {
    let c = c / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn from_lin(c: f64) -> f64 {
    let c = c.clamp(0.0, 1.0);
    255.0 * if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn rgb_to_hsl(c: Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (c[0] / 255.0, c[1] / 255.0, c[2] / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-12 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r { (g - b) / d + if g < b { 6.0 } else { 0.0 } } else if max == g { (b - r) / d + 2.0 } else { (r - g) / d + 4.0 };
    (h * 60.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> Rgb {
    if s == 0.0 {
        let v = l * 255.0;
        return [v, v, v];
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let h = h.rem_euclid(360.0) / 360.0;
    let f = |mut t: f64| {
        t = t.rem_euclid(1.0);
        let v = if t < 1.0 / 6.0 { p + (q - p) * 6.0 * t } else if t < 0.5 { q } else if t < 2.0 / 3.0 { p + (q - p) * (2.0 / 3.0 - t) * 6.0 } else { p };
        v * 255.0
    };
    [f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0)]
}

/// Final colour and alpha (0..1).
pub fn resolve(spec: &ColorSpec, ctx: &ColorCtx) -> (Rgb, f64) {
    let (mut rgb, mut alpha) = match &spec.base {
        Base::Rgb(c) => (*c, 1.0),
        Base::Ph => ctx.ph.unwrap_or(([0.0, 0.0, 0.0], 1.0)),
        Base::Scheme(name) => {
            let key = ctx.map.get(name).map(|s| s.as_str()).unwrap_or(name.as_str());
            let key = match key {
                "tx1" => "dk1",
                "bg1" => "lt1",
                "tx2" => "dk2",
                "bg2" => "lt2",
                k => k,
            };
            (ctx.scheme.get(key).copied().unwrap_or([0.0, 0.0, 0.0]), 1.0)
        }
    };
    for (name, v) in &spec.mods {
        let f = v / 100000.0;
        match name.as_str() {
            "alpha" => alpha = f,
            "alphaMod" => alpha *= f,
            "alphaOff" => alpha += f,
            "lumMod" | "lumOff" | "satMod" | "satOff" | "hueMod" | "hueOff" | "lum" | "sat" | "hue" => {
                let (mut h, mut s, mut l) = rgb_to_hsl(rgb);
                match name.as_str() {
                    "lumMod" => l *= f,
                    "lumOff" => l += f,
                    "lum" => l = f,
                    "satMod" => s *= f,
                    "satOff" => s += f,
                    "sat" => s = f,
                    "hueMod" => h *= f,
                    "hueOff" => h += v / 60000.0,
                    _ => h = v / 60000.0,
                }
                rgb = hsl_to_rgb(h, s.clamp(0.0, 1.0), l.clamp(0.0, 1.0));
            }
            "tint" => rgb = [0, 1, 2].map(|i| from_lin(to_lin(rgb[i]) * f + (1.0 - f))),
            "shade" => rgb = [0, 1, 2].map(|i| from_lin(to_lin(rgb[i]) * f)),
            "comp" => {
                let (h, s, l) = rgb_to_hsl(rgb);
                rgb = hsl_to_rgb(h + 180.0, s, l);
            }
            "inv" => rgb = [0, 1, 2].map(|i| 255.0 - rgb[i]),
            "gray" => {
                let g = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
                rgb = [g, g, g];
            }
            "red" => rgb[0] = f * 255.0,
            "green" => rgb[1] = f * 255.0,
            "blue" => rgb[2] = f * 255.0,
            "redMod" => rgb[0] *= f,
            "greenMod" => rgb[1] *= f,
            "blueMod" => rgb[2] *= f,
            "redOff" => rgb[0] += f * 255.0,
            "greenOff" => rgb[1] += f * 255.0,
            "blueOff" => rgb[2] += f * 255.0,
            _ => {}
        }
    }
    ([0, 1, 2].map(|i| rgb[i].clamp(0.0, 255.0)), alpha.clamp(0.0, 1.0))
}
