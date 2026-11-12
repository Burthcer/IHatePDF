//! Excel (.xlsx) to PDF. A port of `src/features/excelToPdf/xlsxToPdf.worker.ts`: the TypeScript engine reads
//! the workbook with SheetJS (`XLSX.read` + `sheet_to_json({header:1, raw:false, blankrows:false})`) and draws
//! every sheet as a plain gridded table. This file reads the package by hand the way SheetJS 0.18.5 does
//! (shared strings, cellXfs/numFmts, dimension, row/cell regex scan) and formats cells with a port of SheetJS's
//! SSF number formatter, then lays the pages out with the same numbers.
//!
//! Anything this engine can't reproduce exactly returns an error and the app runs the TypeScript engine:
//! formats SSF's rarer branches handle (fractions, phone numbers, Buddhist/Hijri dates, 1904 dates, ...),
//! workbooks that aren't plain OOXML worksheets (.xls, .ods, .xlsb, chart sheets), numbers JavaScript prints in
//! exponent form, cells with a line break (the TypeScript engine stops with an error there).

use crate::compress::{Error, Result};
use crate::fonts::{FontSource, Fonts};
use crate::stamp::{f, font_dict, pdf_string, Font};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use regex::Regex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::LazyLock;

macro_rules! re {
    ($name:ident, $p:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).unwrap());
    };
}

fn unsup<T>(m: &str) -> Result<T> {
    Err(Error::Msg(format!("xlsx: {m}")))
}

// ------------------------------------------------------------------ JavaScript number text

fn inc_digits(s: &str) -> String {
    let mut b: Vec<u8> = s.bytes().collect();
    let mut i = b.len();
    loop {
        if i == 0 {
            b.insert(0, b'1');
            break;
        }
        i -= 1;
        if b[i] == b'9' {
            b[i] = b'0';
        } else {
            b[i] += 1;
            break;
        }
    }
    String::from_utf8(b).unwrap()
}

/// `"" + x` for a finite number (exponent forms are left to the TypeScript engine).
fn js_num(x: f64) -> Result<String> {
    if !x.is_finite() {
        return unsup("non-finite number");
    }
    if x == 0.0 {
        return Ok("0".into());
    }
    let a = x.abs();
    if !(1e-6..1e21).contains(&a) {
        return unsup("number in exponent notation");
    }
    Ok(format!("{x}"))
}

/// `x.toFixed(d)`: exact decimal expansion, ties away from zero (Rust's own rounding is ties-to-even).
fn to_fixed(x: f64, d: usize) -> Result<String> {
    if !x.is_finite() || x.abs() >= 1e21 {
        return unsup("toFixed range");
    }
    let neg = x < 0.0;
    let s = format!("{:.*}", d + 25, x.abs());
    let (ip, fp) = s.split_once('.').unwrap();
    let mut digits = format!("{}{}", ip, &fp[..d]);
    if fp.as_bytes()[d] >= b'5' {
        digits = inc_digits(&digits);
    }
    let (i2, f2) = digits.split_at(digits.len() - d);
    let mut o = if d > 0 { format!("{i2}.{f2}") } else { i2.to_string() };
    if neg {
        o.insert(0, '-');
    }
    Ok(o)
}

/// The first `p` significant digits of `a` (> 0), rounded half up, and the decimal exponent.
fn round_sig(a: f64, p: usize) -> (String, i32) {
    let s = format!("{:.*e}", p + 25, a);
    let (m, e) = s.split_once('e').unwrap();
    let mut e: i32 = e.parse().unwrap();
    let digits: String = m.chars().filter(|c| *c != '.').collect();
    let mut keep = digits[..p].to_string();
    if digits.as_bytes()[p] >= b'5' {
        keep = inc_digits(&keep);
        if keep.len() > p {
            keep.truncate(p);
            e += 1;
        }
    }
    (keep, e)
}

fn to_precision(x: f64, p: usize) -> Result<String> {
    if !x.is_finite() {
        return unsup("non-finite number");
    }
    let sign = if x < 0.0 { "-" } else { "" };
    if x == 0.0 {
        return Ok(if p > 1 { format!("0.{}", "0".repeat(p - 1)) } else { "0".into() });
    }
    let (d, e) = round_sig(x.abs(), p);
    let body = if e < -6 || e >= p as i32 {
        let rest = if p > 1 { format!(".{}", &d[1..]) } else { String::new() };
        format!("{}{}e{}{}", &d[..1], rest, if e >= 0 { "+" } else { "-" }, e.abs())
    } else if e == p as i32 - 1 {
        d
    } else if e >= 0 {
        format!("{}.{}", &d[..(e + 1) as usize], &d[(e + 1) as usize..])
    } else {
        format!("0.{}{}", "0".repeat((-(e + 1)) as usize), d)
    };
    Ok(format!("{sign}{body}"))
}

fn to_exponential(x: f64, fd: usize) -> Result<String> {
    if !x.is_finite() {
        return unsup("non-finite number");
    }
    let sign = if x < 0.0 { "-" } else { "" };
    if x == 0.0 {
        return Ok(format!("0{}e+0", if fd > 0 { format!(".{}", "0".repeat(fd)) } else { String::new() }));
    }
    let (d, e) = round_sig(x.abs(), fd + 1);
    let rest = if fd > 0 { format!(".{}", &d[1..]) } else { String::new() };
    Ok(format!("{sign}{}{rest}e{}{}", &d[..1], if e >= 0 { "+" } else { "-" }, e.abs()))
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn fill(c: &str, n: i64) -> String {
    c.repeat(n.max(0) as usize)
}

fn pad0(v: &str, d: usize) -> String {
    if v.len() >= d { v.to_string() } else { format!("{}{}", "0".repeat(d - v.len()), v) }
}

// ------------------------------------------------------------------ SSF: General

re!(STRIP_DEC, r"(?:\.0*|(\.\d*[1-9])0+)$");
re!(NORM_EXP1, r"(?:\.0*|(\.\d*[1-9])0+)[Ee]");
re!(NORM_EXP2, r"(E[+-])(\d)$");

fn strip_decimal(o: &str) -> String {
    if !o.contains('.') {
        return o.to_string();
    }
    STRIP_DEC.replace(o, "$1").into_owned()
}

fn normalize_exp(o: &str) -> String {
    if !o.contains('E') {
        return o.to_string();
    }
    let a = NORM_EXP1.replace(o, "${1}E").into_owned();
    NORM_EXP2.replace(&a, "${1}0${2}").into_owned()
}

fn small_exp(v: f64) -> Result<String> {
    let w = if v < 0.0 { 12 } else { 11 };
    let o = strip_decimal(&to_fixed(v, 12)?);
    if o.len() <= w {
        return Ok(o);
    }
    let o = to_precision(v, 10)?;
    if o.len() <= w {
        return Ok(o);
    }
    to_exponential(v, 5)
}

fn large_exp(v: f64) -> Result<String> {
    let o = strip_decimal(&to_fixed(v, 11)?);
    if o.len() > if v < 0.0 { 12 } else { 11 } || o == "0" || o == "-0" {
        to_precision(v, 6)
    } else {
        Ok(o)
    }
}

fn general_num(v: f64) -> Result<String> {
    if v == 0.0 {
        return Ok("0".into());
    }
    let vv = (v.abs().ln() * std::f64::consts::LOG10_E).floor();
    let o = if (-4.0..=-1.0).contains(&vv) {
        to_precision(v, (10.0 + vv) as usize)?
    } else if vv.abs() <= 9.0 {
        small_exp(v)?
    } else if vv == 10.0 {
        to_fixed(v, 10)?.chars().take(12).collect()
    } else {
        large_exp(v)?
    };
    Ok(strip_decimal(&normalize_exp(&o.to_uppercase())))
}

fn is_i32(v: f64) -> bool {
    v == (v as i32) as f64 && v.abs() < 2147483648.0
}

fn general(v: f64) -> Result<String> {
    if !v.is_finite() {
        return unsup("non-finite number");
    }
    if is_i32(v) { Ok(format!("{}", v as i32)) } else { general_num(v) }
}

fn isgeneral(s: &str) -> bool {
    s.len() >= 7 && s.as_bytes()[..7].eq_ignore_ascii_case(b"general")
}
fn isgeneral_at(fc: &[char], i: usize) -> bool {
    fc.len() >= i + 7 && fc[i..i + 7].iter().collect::<String>().eq_ignore_ascii_case("general")
}

// ------------------------------------------------------------------ SSF: numbers

re!(DEC1, r"^#*0*\.([0#]+)");
re!(FRAC1, r"# (\?+)( ?)/( ?)(\d+)");
re!(ALL00, r"^00+$");
re!(ALL_HQ, r"^[#?]+$");
re!(HASH0, r"^#+0+$");
re!(ZDOT, r"^(0*)\.(#*)$");
re!(COMMA3, r"^#{1,3},##0\.?$");
re!(COMMA_DEC, r"^#,##0\.([#0]*0)$");
re!(COMMA_RUN, r"^#,#*,#0");
re!(DASHED, r"^([0#]+)(\\?-([0#]+))+$");
re!(ANY_FRAC, r"^([#0?]+)( ?)/( ?)([#0?]+)|^# ([#0?]+)( ?)/( ?)([#0?]+)");
re!(ALL_NUM, r"^[#0?]+$");
re!(INT_DEC, r"^([#0?]+)\.([#0]+)$");
re!(Z00000, r"^00,000\.([#0]*0)$");
re!(TRAIL_DOT, r"\.(\d*)$");
re!(NODOT, r"^([^.]+)$");
re!(ENDDOT, r"\.$");
re!(TRAILZ, r"\.(\d*[1-9])0*$");
re!(INTONLY, r"^(-?\d*)$");
re!(ZEROLEAD, r"^0\.");
re!(NOTZERO_TRAIL, r"([^0])0+$");
re!(EXP_LEAD, r"^#+0.0E\+0$");
re!(EXP_P00, r"E\+00$");
re!(EXP_LOWE_DIG, r"e[+-]\d$");
re!(EXP_MINUS, r"E-");
re!(EXP_LOWE_PLUS, r"e\+");

fn hashq(s: &str) -> String {
    s.chars().filter(|&c| c != '#').map(|c| if c == '?' { ' ' } else { c }).collect()
}

fn commaify(s: &str) -> String {
    let w = 3;
    if s.len() <= w {
        return s.to_string();
    }
    let mut j = s.len() % w;
    let mut o = s[..j].to_string();
    while j != s.len() {
        if !o.is_empty() {
            o.push(',');
        }
        o.push_str(&s[j..j + w]);
        j += w;
    }
    o
}

/// JS `fmt.substr(start, len)` for ASCII text.
fn substr(s: &str, start: i64, len: Option<i64>) -> String {
    let n = s.len() as i64;
    let st = if start < 0 { (n + start).max(0) } else { start.min(n) };
    let l = len.map_or(n - st, |l| l.max(0).min(n - st));
    s[st as usize..(st + l) as usize].to_string()
}

fn rnd(val: f64, d: usize) -> Result<String> {
    let dd = 10f64.powi(d as i32);
    js_num(js_round(val * dd) / dd)
}

fn pad0r(v: f64, d: usize) -> Result<String> {
    let r = if v.abs() > 4294967296.0 { js_round(v) } else { js_round(v) };
    Ok(pad0(&js_num(r)?, d))
}

fn dec(val: f64, d: usize) -> f64 {
    let frac = val - val.floor();
    let dd = 10f64.powi(d as i32);
    let r = js_round(frac * dd);
    if (d as i64) < format!("{r}").len() as i64 { 0.0 } else { r }
}
fn carry(val: f64, d: usize) -> f64 {
    let r = js_round((val - val.floor()) * 10f64.powi(d as i32));
    if (d as i64) < format!("{r}").len() as i64 { 1.0 } else { 0.0 }
}

fn write_num_cm(fmt: &str, val: f64) -> Result<String> {
    let mut idx = fmt.len() - 1;
    while idx > 0 && fmt.as_bytes()[idx - 1] == b',' {
        idx -= 1;
    }
    write_num(&fmt[..idx], val / 10f64.powi(3 * (fmt.len() - idx) as i32))
}

fn write_num_pct(fmt: &str, val: f64) -> Result<String> {
    let sfmt = fmt.replace('%', "");
    let mul = fmt.len() - sfmt.len();
    Ok(write_num(&sfmt, val * 10f64.powi(2 * mul as i32))? + &"%".repeat(mul))
}

fn write_num_exp(fmt: &str, val: f64) -> Result<String> {
    if EXP_LEAD.is_match(fmt) {
        return unsup("engineering exponent format");
    }
    let (Some(e), Some(p)) = (fmt.find('E'), fmt.find('.')) else { return unsup("exponent format") };
    if e < p + 1 {
        return unsup("exponent format");
    }
    let mut o = to_exponential(val, e - p - 1)?;
    if EXP_P00.is_match(fmt) && EXP_LOWE_DIG.is_match(&o) {
        let last = o.pop().unwrap();
        o.push('0');
        o.push(last);
    }
    if EXP_MINUS.is_match(fmt) && EXP_LOWE_PLUS.is_match(&o) {
        o = EXP_LOWE_PLUS.replace(&o, "e").into_owned();
    }
    Ok(o.replacen('e', "E", 1))
}

fn write_num_int(fmt: &str, val: f64) -> Result<String> {
    if fmt.ends_with(',') {
        return write_num_cm(fmt, val);
    }
    if fmt.contains('%') {
        return write_num_pct(fmt, val);
    }
    if fmt.contains('E') {
        return write_num_exp(fmt, val);
    }
    if fmt.starts_with('$') {
        let skip = if fmt.as_bytes().get(1) == Some(&b' ') { 2 } else { 1 };
        return Ok(format!("${}", write_num_int(&fmt[skip..], val)?));
    }
    let aval = val.abs();
    let sign = if val < 0.0 { "-" } else { "" };
    if ALL00.is_match(fmt) {
        return Ok(format!("{sign}{}", pad0(&js_num(aval)?, fmt.len())));
    }
    if ALL_HQ.is_match(fmt) {
        let o = if val == 0.0 { String::new() } else { js_num(val)? };
        return Ok(if o.len() > fmt.len() { o } else { format!("{}{o}", hashq(&fmt[..fmt.len() - o.len()])) });
    }
    if FRAC1.is_match(fmt) {
        return unsup("fraction format");
    }
    if HASH0.is_match(fmt) {
        let z = fmt.find('0').unwrap();
        return Ok(format!("{sign}{}", pad0(&js_num(aval)?, fmt.len() - z)));
    }
    if let Some(r) = DEC1.captures(fmt) {
        let hq = hashq(&r[1]);
        let mut o = js_num(val)?;
        o = NODOT.replace(&o, format!("${{1}}.{hq}")).into_owned();
        o = ENDDOT.replace(&o, format!(".{hq}")).into_owned();
        let hql = hq.len() as i64;
        o = TRAIL_DOT.replace(&o, |c: &regex::Captures| format!(".{}{}", &c[1], fill("0", hql - c[1].len() as i64))).into_owned();
        return Ok(if fmt.contains("0.") { o } else { ZEROLEAD.replace(&o, ".").into_owned() });
    }
    let fmt2 = {
        static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#+([0.])").unwrap());
        LEAD.replace(fmt, "$1").into_owned()
    };
    let fmt = fmt2.as_str();
    if let Some(r) = ZDOT.captures(fmt) {
        let mut o = js_num(aval)?;
        o = TRAILZ.replace(&o, ".$1").into_owned();
        o = INTONLY.replace(&o, "$1.").into_owned();
        o = ZEROLEAD.replace(&o, if r[1].is_empty() { "." } else { "0." }).into_owned();
        return Ok(format!("{sign}{o}"));
    }
    if COMMA3.is_match(fmt) {
        return Ok(format!("{sign}{}", commaify(&js_num(aval)?)));
    }
    if let Some(r) = COMMA_DEC.captures(fmt) {
        return if val < 0.0 { Ok(format!("-{}", write_num_int(fmt, -val)?)) } else { Ok(format!("{}.{}", commaify(&js_num(val)?), "0".repeat(r[1].len()))) };
    }
    if COMMA_RUN.is_match(fmt) {
        static C2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#,#*,").unwrap());
        return write_num_int(&C2.replace(fmt, ""), val);
    }
    if DASHED.is_match(fmt) {
        return unsup("dashed number format");
    }
    if fmt.contains("(###) ###") {
        return unsup("phone number format");
    }
    if ANY_FRAC.is_match(fmt) {
        return unsup("fraction format");
    }
    if ALL_NUM.is_match(fmt) {
        let o = js_num(val)?;
        return Ok(if fmt.len() <= o.len() { o } else { format!("{}{o}", hashq(&fmt[..fmt.len() - o.len()])) });
    }
    if INT_DEC.is_match(fmt) && !fmt.contains('?') {
        // JavaScript's int variant uses ^([#0]+)\.([#0]+)$
        let r = INT_DEC.captures(fmt).unwrap();
        let o0 = to_fixed(val, r[2].len().min(10))?;
        let o = NOTZERO_TRAIL.replace(&o0, "$1").into_owned();
        let ri = o.find('.').map_or(-1, |i| i as i64);
        let lres = fmt.find('.').unwrap() as i64 - ri;
        let rres = fmt.len() as i64 - o.len() as i64 - lres;
        return Ok(hashq(&(substr(fmt, 0, Some(lres)) + &o + &substr(fmt, fmt.len() as i64 - rres, None))));
    }
    if Z00000.is_match(fmt) {
        return unsup("00,000 format");
    }
    match fmt {
        "###,###" | "##,###" | "#,###" => {
            let x = commaify(&js_num(aval)?);
            return Ok(if x != "0" { format!("{sign}{x}") } else { String::new() });
        }
        _ => {
            if let Some(i) = fmt.rfind('.') {
                if fmt[i..].chars().skip(1).all(|c| "0#?".contains(c)) {
                    return Ok(write_num_int(&fmt[..i], val)? + &hashq(&fmt[i..]));
                }
            }
        }
    }
    unsup("number format")
}

fn write_num_flt(fmt: &str, val: f64) -> Result<String> {
    if fmt.ends_with(',') {
        return write_num_cm(fmt, val);
    }
    if fmt.contains('%') {
        return write_num_pct(fmt, val);
    }
    if fmt.contains('E') {
        return write_num_exp(fmt, val);
    }
    if fmt.starts_with('$') {
        let skip = if fmt.as_bytes().get(1) == Some(&b' ') { 2 } else { 1 };
        return Ok(format!("${}", write_num_flt(&fmt[skip..], val)?));
    }
    let aval = val.abs();
    let sign = if val < 0.0 { "-" } else { "" };
    if ALL00.is_match(fmt) {
        return Ok(format!("{sign}{}", pad0r(aval, fmt.len())?));
    }
    if ALL_HQ.is_match(fmt) {
        let mut o = pad0r(val, 0)?;
        if o == "0" {
            o = String::new();
        }
        return Ok(if o.len() > fmt.len() { o } else { format!("{}{o}", hashq(&fmt[..fmt.len() - o.len()])) });
    }
    if FRAC1.is_match(fmt) {
        return unsup("fraction format");
    }
    if HASH0.is_match(fmt) {
        let z = fmt.find('0').unwrap();
        return Ok(format!("{sign}{}", pad0r(aval, fmt.len() - z)?));
    }
    if let Some(r) = DEC1.captures(fmt) {
        let hq = hashq(&r[1]);
        let mut o = rnd(val, r[1].len())?;
        o = NODOT.replace(&o, format!("${{1}}.{hq}")).into_owned();
        o = ENDDOT.replace(&o, format!(".{hq}")).into_owned();
        let hql = hq.len() as i64;
        o = TRAIL_DOT.replace(&o, |c: &regex::Captures| format!(".{}{}", &c[1], fill("0", hql - c[1].len() as i64))).into_owned();
        return Ok(if fmt.contains("0.") { o } else { ZEROLEAD.replace(&o, ".").into_owned() });
    }
    let fmt2 = {
        static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#+([0.])").unwrap());
        LEAD.replace(fmt, "$1").into_owned()
    };
    let fmt = fmt2.as_str();
    if let Some(r) = ZDOT.captures(fmt) {
        let mut o = rnd(aval, r[2].len())?;
        o = TRAILZ.replace(&o, ".$1").into_owned();
        o = INTONLY.replace(&o, "$1.").into_owned();
        o = ZEROLEAD.replace(&o, if r[1].is_empty() { "." } else { "0." }).into_owned();
        return Ok(format!("{sign}{o}"));
    }
    if COMMA3.is_match(fmt) {
        return Ok(format!("{sign}{}", commaify(&pad0r(aval, 0)?)));
    }
    if let Some(r) = COMMA_DEC.captures(fmt) {
        if val < 0.0 {
            return Ok(format!("-{}", write_num_flt(fmt, -val)?));
        }
        let n = r[1].len();
        let whole = js_num(val.floor() + carry(val, n))?;
        return Ok(format!("{}.{}", commaify(&whole), pad0(&js_num(dec(val, n))?, n)));
    }
    if COMMA_RUN.is_match(fmt) {
        static C2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#,#*,").unwrap());
        return write_num_flt(&C2.replace(fmt, ""), val);
    }
    if DASHED.is_match(fmt) {
        return unsup("dashed number format");
    }
    if fmt.contains("(###) ###") {
        return unsup("phone number format");
    }
    if ANY_FRAC.is_match(fmt) {
        return unsup("fraction format");
    }
    if ALL_NUM.is_match(fmt) {
        let o = pad0r(val, 0)?;
        return Ok(if fmt.len() <= o.len() { o } else { format!("{}{o}", hashq(&fmt[..fmt.len() - o.len()])) });
    }
    if let Some(r) = INT_DEC.captures(fmt) {
        let o0 = to_fixed(val, r[2].len().min(10))?;
        let o = NOTZERO_TRAIL.replace(&o0, "$1").into_owned();
        let ri = o.find('.').map_or(-1, |i| i as i64);
        let lres = fmt.find('.').unwrap() as i64 - ri;
        let rres = fmt.len() as i64 - o.len() as i64 - lres;
        return Ok(hashq(&(substr(fmt, 0, Some(lres)) + &o + &substr(fmt, fmt.len() as i64 - rres, None))));
    }
    if Z00000.is_match(fmt) {
        return unsup("00,000 format");
    }
    match fmt {
        "###,##0.00" => return write_num_flt("#,##0.00", val),
        "###,###" | "##,###" | "#,###" => {
            let x = commaify(&pad0r(aval, 0)?);
            return Ok(if x != "0" { format!("{sign}{x}") } else { String::new() });
        }
        "###,###.00" => return Ok(ZEROLEAD.replace(&write_num_flt("###,##0.00", val)?, ".").into_owned()),
        "#,###.00" => return Ok(ZEROLEAD.replace(&write_num_flt("#,##0.00", val)?, ".").into_owned()),
        _ => {}
    }
    unsup("number format")
}

fn write_num(fmt: &str, val: f64) -> Result<String> {
    if is_i32(val) { write_num_int(fmt, val) } else { write_num_flt(fmt, val) }
}

// ------------------------------------------------------------------ SSF: dates

struct Dt {
    d: i64,
    u: f64,
    y: i64,
    m: i64,
    dd: i64,
    h: i64,
    mi: i64,
    s: i64,
    q: i64,
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_date_code(v: f64) -> Option<Dt> {
    if !(0.0..=2958465.0).contains(&v) {
        return None;
    }
    let mut date = v as i64;
    let mut time = (86400.0 * (v - date as f64)).floor() as i64;
    let mut u = 86400.0 * (v - date as f64) - time as f64;
    let mut dd_ = date;
    if u.abs() < 1e-6 {
        u = 0.0;
    }
    if u > 0.9999 {
        u = 0.0;
        time += 1;
        if time == 86400 {
            time = 0;
            date += 1;
            dd_ += 1;
        }
    }
    let (y, m, d, dow);
    if date == 60 {
        (y, m, d, dow) = (1900, 2, 29, 3);
    } else if date == 0 {
        (y, m, d, dow) = (1900, 1, 0, 6);
    } else {
        if date > 60 {
            date -= 1;
        }
        let (yy, mm, dy) = civil_from_days(days_from_civil(1900, 1, 1) + date - 1);
        let mut w = date.rem_euclid(7);
        if date < 60 {
            w = (w + 6) % 7;
        }
        (y, m, d, dow) = (yy, mm, dy, w);
    }
    let s = time % 60;
    let t = time / 60;
    Some(Dt { d: dd_, u, y, m, dd: d, mi: t % 60, h: t / 60, s, q: dow })
}

const DAYS: [(&str, &str); 7] = [("Sun", "Sunday"), ("Mon", "Monday"), ("Tue", "Tuesday"), ("Wed", "Wednesday"), ("Thu", "Thursday"), ("Fri", "Friday"), ("Sat", "Saturday")];
const MONTHS: [(&str, &str, &str); 12] = [
    ("J", "Jan", "January"), ("F", "Feb", "February"), ("M", "Mar", "March"), ("A", "Apr", "April"), ("M", "May", "May"), ("J", "Jun", "June"),
    ("J", "Jul", "July"), ("A", "Aug", "August"), ("S", "Sep", "September"), ("O", "Oct", "October"), ("N", "Nov", "November"), ("D", "Dec", "December"),
];

fn write_date(t: char, fmt: &str, val: &Dt, ss0: usize) -> Result<String> {
    let fl = fmt.chars().count();
    let (out, outl): (i64, usize) = match t {
        'y' => match fl {
            1 | 2 => (val.y % 100, 2),
            _ => (val.y % 10000, 4),
        },
        'm' => match fl {
            1 | 2 => (val.m, fl),
            3 => return Ok(MONTHS[(val.m - 1) as usize].1.into()),
            5 => return Ok(MONTHS[(val.m - 1) as usize].0.into()),
            _ => return Ok(MONTHS[(val.m - 1) as usize].2.into()),
        },
        'd' => match fl {
            1 | 2 => (val.dd, fl),
            3 => return Ok(DAYS[val.q as usize].0.into()),
            _ => return Ok(DAYS[val.q as usize].1.into()),
        },
        'h' => match fl {
            1 | 2 => (1 + (val.h + 11) % 12, fl),
            _ => return unsup("hour format"),
        },
        'H' => match fl {
            1 | 2 => (val.h, fl),
            _ => return unsup("hour format"),
        },
        'M' => match fl {
            1 | 2 => (val.mi, fl),
            _ => return unsup("minute format"),
        },
        's' => {
            if !matches!(fmt, "s" | "ss" | ".0" | ".00" | ".000") {
                return unsup("second format");
            }
            if val.u == 0.0 && (fmt == "s" || fmt == "ss") {
                return Ok(pad0(&val.s.to_string(), fl));
            }
            let tt: f64 = if ss0 >= 2 { if ss0 == 3 { 1000.0 } else { 100.0 } } else if ss0 == 1 { 10.0 } else { 1.0 };
            let mut ss = js_round(tt * (val.s as f64 + val.u));
            if ss >= 60.0 * tt {
                ss = 0.0;
            }
            if fmt == "s" {
                return if ss == 0.0 { Ok("0".into()) } else { js_num(ss / tt) };
            }
            let o = pad0(&js_num(ss)?, 2 + ss0);
            if fmt == "ss" {
                return Ok(o[..2].to_string());
            }
            return Ok(format!(".{}", substr(&o, 2, Some(fl as i64 - 1))));
        }
        'Z' => {
            let o = match fmt {
                "[h]" | "[hh]" => val.d * 24 + val.h,
                "[m]" | "[mm]" => (val.d * 24 + val.h) * 60 + val.mi,
                "[s]" | "[ss]" => ((val.d * 24 + val.h) * 60 + val.mi) * 60 + js_round(val.s as f64 + val.u) as i64,
                _ => return unsup("abs time format"),
            };
            (o, if fl == 3 { 1 } else { 2 })
        }
        'e' => (val.y, 1),
        _ => return unsup("date field"),
    };
    Ok(if outl > 0 { pad0(&out.to_string(), outl) } else { String::new() })
}

fn fmt_is_date(fmt: &str) -> bool {
    let fc: Vec<char> = fmt.chars().collect();
    let n = fc.len();
    let at = |i: usize| fc.get(i).copied().unwrap_or('\0');
    let mut i = 0;
    while i < n {
        let c = fc[i];
        match c {
            'G' => {
                if isgeneral_at(&fc, i) {
                    i += 6;
                }
                i += 1;
            }
            '"' => {
                i += 1;
                while i < n && fc[i] != '"' {
                    i += 1;
                }
                i += 1;
            }
            '\\' | '_' => i += 2,
            '@' => i += 1,
            'B' | 'b' => {
                if at(i + 1) == '1' || at(i + 1) == '2' {
                    return true;
                }
                return true;
            }
            'M' | 'D' | 'Y' | 'H' | 'S' | 'E' | 'm' | 'd' | 'y' | 'h' | 's' | 'e' | 'g' => return true,
            'A' | 'a' | '上' => {
                let s3: String = fc[i..(i + 3).min(n)].iter().collect::<String>().to_uppercase();
                let s5: String = fc[i..(i + 5).min(n)].iter().collect::<String>().to_uppercase();
                if s3 == "A/P" || s5 == "AM/PM" || s5 == "上午/下午" {
                    return true;
                }
                i += 1;
            }
            '[' => {
                let mut o = String::from("[");
                loop {
                    let ch = at(i);
                    i += 1;
                    if ch == ']' || i >= n {
                        break;
                    }
                    o.push(fc[i]);
                }
                static ABS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[HhMmSs\u{0E0A}\u{0E19}\u{0E17}]*\]").unwrap());
                if ABS.is_match(&o) {
                    return true;
                }
            }
            '.' | '0' | '#' => {
                i += 1;
                while i < n && ("0#?.,E+-%".contains(fc[i]) || (fc[i] == '\\' && at(i + 1) == '-' && "0#".contains(at(i + 2)))) {
                    i += 1;
                }
            }
            '?' => {
                i += 1;
                while at(i) == c {
                    i += 1;
                }
            }
            '*' => {
                i += 1;
                if at(i) == ' ' || at(i) == '*' {
                    i += 1;
                }
            }
            '(' | ')' => i += 1,
            '1'..='9' => {
                i += 1;
                while i < n && fc[i].is_ascii_digit() {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    false
}

// ------------------------------------------------------------------ SSF: format strings

struct Tk {
    t: char,
    v: String,
}
fn tk(t: char, v: impl Into<String>) -> Tk {
    Tk { t, v: v.into() }
}

fn eval_fmt(fmt: &str, v: f64, flen: usize) -> Result<String> {
    let fc: Vec<char> = fmt.chars().collect();
    let n = fc.len();
    let at = |i: usize| fc.get(i).copied();
    let mut out: Vec<Tk> = Vec::new();
    let mut i = 0usize;
    let mut lst = 't';
    let mut dt: Option<Dt> = None;
    let mut dt_tried = false;
    let mut hr = 'H';
    macro_rules! need_dt {
        () => {
            if !dt_tried {
                dt = parse_date_code(v);
                dt_tried = true;
            }
        };
    }
    while i < n {
        let c0 = fc[i];
        match c0 {
            'G' => {
                if !isgeneral_at(&fc, i) {
                    return unsup("format character");
                }
                out.push(tk('G', "General"));
                i += 7;
            }
            '"' => {
                let mut o = String::new();
                i += 1;
                while i < n && fc[i] != '"' {
                    o.push(fc[i]);
                    i += 1;
                }
                out.push(tk('t', o));
                i += 1;
            }
            '\\' => {
                i += 1;
                let w = at(i);
                let t = if matches!(w, Some('(') | Some(')')) { w.unwrap() } else { 't' };
                out.push(tk(t, w.map(|c| c.to_string()).unwrap_or_default()));
                i += 1;
            }
            '_' => {
                out.push(tk('t', " "));
                i += 2;
            }
            '@' => return unsup("text placeholder with a number"),
            'B' | 'b' => return unsup("Buddhist/Hijri date"),
            'M' | 'D' | 'Y' | 'H' | 'S' | 'E' | 'm' | 'd' | 'y' | 'h' | 's' | 'e' | 'g' => {
                let mut c = c0.to_ascii_lowercase();
                if v < 0.0 {
                    return Ok(String::new());
                }
                need_dt!();
                if dt.is_none() {
                    return Ok(String::new());
                }
                let mut o = c.to_string();
                i += 1;
                while i < n && fc[i].to_ascii_lowercase() == c {
                    o.push(c);
                    i += 1;
                }
                if c == 'm' && lst.to_ascii_lowercase() == 'h' {
                    c = 'M';
                }
                if c == 'h' {
                    c = hr;
                }
                out.push(tk(c, o));
                lst = c;
            }
            'A' | 'a' | '上' => {
                need_dt!();
                let s3: String = fc[i..(i + 3).min(n)].iter().collect::<String>().to_uppercase();
                let s5: String = fc[i..(i + 5).min(n)].iter().collect::<String>().to_uppercase();
                let mut q = tk(c0, c0.to_string());
                if s3 == "A/P" {
                    if let Some(d) = &dt {
                        q.v = (if d.h >= 12 { "P" } else { "A" }).into();
                    }
                    q.t = 'T';
                    hr = 'h';
                    i += 3;
                } else if s5 == "AM/PM" {
                    if let Some(d) = &dt {
                        q.v = (if d.h >= 12 { "PM" } else { "AM" }).into();
                    }
                    q.t = 'T';
                    i += 5;
                    hr = 'h';
                } else if s5 == "上午/下午" {
                    if let Some(d) = &dt {
                        q.v = (if d.h >= 12 { "下午" } else { "上午" }).into();
                    }
                    q.t = 'T';
                    i += 5;
                    hr = 'h';
                } else {
                    q.t = 't';
                    i += 1;
                }
                if dt.is_none() && q.t == 'T' {
                    return Ok(String::new());
                }
                lst = c0;
                out.push(q);
            }
            '[' => {
                let mut o = String::from("[");
                loop {
                    let ch = at(i);
                    i += 1;
                    if ch == Some(']') || i >= n {
                        break;
                    }
                    o.push(fc[i]);
                }
                if !o.ends_with(']') {
                    return unsup("unterminated [ block");
                }
                static ABS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[HhMmSs\u{0E0A}\u{0E19}\u{0E17}]*\]").unwrap());
                static CUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$([^\-\[\]]*)").unwrap());
                if ABS.is_match(&o) {
                    need_dt!();
                    if dt.is_none() {
                        return Ok(String::new());
                    }
                    out.push(tk('Z', o.to_lowercase()));
                    lst = o.chars().nth(1).unwrap_or('t');
                } else if o.contains('$') {
                    let cur = CUR.captures(&o).map(|m| m[1].to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "$".into());
                    if !fmt_is_date(fmt) {
                        out.push(tk('t', cur));
                    }
                }
            }
            '.' | '0' | '#' => {
                if c0 == '.' && dt.is_some() {
                    let mut o = String::from(".");
                    i += 1;
                    while i < n && fc[i] == '0' {
                        o.push('0');
                        i += 1;
                    }
                    out.push(tk('s', o));
                } else {
                    let mut o = c0.to_string();
                    i += 1;
                    while i < n && "0#?.,E+-%".contains(fc[i]) {
                        o.push(fc[i]);
                        i += 1;
                    }
                    out.push(tk('n', o));
                }
            }
            '?' => {
                let mut o = c0.to_string();
                i += 1;
                while at(i) == Some(c0) {
                    o.push(c0);
                    i += 1;
                }
                out.push(tk('?', o));
                lst = c0;
            }
            '*' => {
                i += 1;
                if matches!(at(i), Some(' ') | Some('*')) {
                    i += 1;
                }
            }
            '(' | ')' => {
                out.push(tk(if flen == 1 { 't' } else { c0 }, c0.to_string()));
                i += 1;
            }
            '1'..='9' => {
                let mut o = c0.to_string();
                i += 1;
                while i < n && fc[i].is_ascii_digit() {
                    o.push(fc[i]);
                    i += 1;
                }
                out.push(tk('D', o));
            }
            ' ' => {
                out.push(tk(' ', " "));
                i += 1;
            }
            '$' => {
                out.push(tk('t', "$"));
                i += 1;
            }
            _ => {
                if !",$-+/():!^&'~{}<>=€acfijklopqrtuvwxzP".contains(c0) {
                    return unsup("format character");
                }
                out.push(tk('t', c0.to_string()));
                i += 1;
            }
        }
    }

    // Scan for date/time parts
    let mut bt = 0;
    let mut ss0 = 0usize;
    lst = 't';
    for k in (0..out.len()).rev() {
        match out[k].t {
            'h' | 'H' => {
                out[k].t = hr;
                lst = 'h';
                if bt < 1 {
                    bt = 1;
                }
            }
            's' => {
                if let Some(p) = out[k].v.find(".0") {
                    if out[k].v[p..].chars().skip(1).all(|c| c == '0') {
                        ss0 = ss0.max(out[k].v.len() - p - 1);
                    }
                }
                if bt < 3 {
                    bt = 3;
                }
                lst = 's';
            }
            'd' | 'y' | 'M' | 'e' => lst = out[k].t,
            'm' => {
                if lst == 's' {
                    out[k].t = 'M';
                    if bt < 2 {
                        bt = 2;
                    }
                }
            }
            'Z' => {
                if bt < 1 && out[k].v.contains(['H', 'h']) {
                    bt = 1;
                }
                if bt < 2 && out[k].v.contains(['M', 'm']) {
                    bt = 2;
                }
                if bt < 3 && out[k].v.contains(['S', 's']) {
                    bt = 3;
                }
            }
            _ => {}
        }
    }
    if let Some(d) = dt.as_mut() {
        match bt {
            1 => {
                if d.u >= 0.5 {
                    d.u = 0.0;
                    d.s += 1;
                }
                if d.s >= 60 {
                    d.s = 0;
                    d.mi += 1;
                }
                if d.mi >= 60 {
                    d.mi = 0;
                    d.h += 1;
                }
            }
            2 => {
                if d.u >= 0.5 {
                    d.u = 0.0;
                    d.s += 1;
                }
                if d.s >= 60 {
                    d.s = 0;
                    d.mi += 1;
                }
            }
            _ => {}
        }
    }

    // Replace fields
    let mut nstr = String::new();
    let mut k = 0usize;
    while k < out.len() {
        match out[k].t {
            't' | 'T' | ' ' | 'D' => {}
            'X' => {
                out[k].v = String::new();
                out[k].t = ';';
            }
            'd' | 'm' | 'y' | 'h' | 'H' | 'M' | 's' | 'e' | 'b' | 'Z' => {
                let d = dt.as_ref().ok_or_else(|| Error::Msg("xlsx: date field without a date".into()))?;
                out[k].v = write_date(out[k].t, &out[k].v, d, ss0)?;
                out[k].t = 't';
            }
            'n' | '?' => {
                let mut jj = k + 1;
                while jj < out.len() {
                    let c = out[jj].t;
                    let next = out.get(jj + 1);
                    let cond = c == '?'
                        || c == 'D'
                        || ((c == ' ' || c == 't') && next.is_some_and(|nx| nx.t == '?' || (nx.t == 't' && nx.v == "/")))
                        || (out[k].t == '(' && (c == ' ' || c == 'n' || c == ')'))
                        || (c == 't' && (out[jj].v == "/" || (out[jj].v == " " && next.is_some_and(|nx| nx.t == '?'))));
                    if !cond {
                        break;
                    }
                    let add = out[jj].v.clone();
                    out[k].v.push_str(&add);
                    out[jj] = tk(';', "");
                    jj += 1;
                }
                nstr.push_str(&out[k].v);
                k = jj - 1;
            }
            'G' => {
                out[k].t = 't';
                out[k].v = general(v)?;
            }
            _ => {}
        }
        k += 1;
    }
    if !nstr.is_empty() {
        let myv = if v < 0.0 && flen > 1 { -v } else { v };
        let mut ostr = write_num(&nstr, myv)?;
        if myv < 0.0 && out.first().is_some_and(|t| t.t == 't') {
            ostr = ostr[1..].to_string();
            out[0].v = format!("-{}", out[0].v);
        }
        let ob = ostr.as_bytes();
        let mut jj = ostr.len() as i64 - 1;
        let mut decpt = out.len();
        for (ix, t) in out.iter().enumerate() {
            if t.t != 't' && t.v.contains('.') {
                decpt = ix;
                break;
            }
        }
        let mut lasti = out.len();
        let has_e = ostr.contains('E');
        if decpt == out.len() && !has_e {
            for ix in (0..out.len()).rev() {
                if !"n?".contains(out[ix].t) {
                    continue;
                }
                let vl = out[ix].v.len() as i64;
                if jj >= vl - 1 {
                    jj -= vl;
                    out[ix].v = substr(&ostr, jj + 1, Some(vl));
                } else if jj < 0 {
                    out[ix].v = String::new();
                } else {
                    out[ix].v = substr(&ostr, 0, Some(jj + 1));
                    jj = -1;
                }
                out[ix].t = 't';
                lasti = ix;
            }
            if jj >= 0 && lasti < out.len() {
                out[lasti].v = substr(&ostr, 0, Some(jj + 1)) + &out[lasti].v;
            }
        } else if decpt != out.len() && !has_e {
            jj = ostr.find('.').map_or(-1, |p| p as i64) - 1;
            let mut ix = decpt as i64;
            while ix >= 0 {
                let u = ix as usize;
                if !"n?".contains(out[u].t) {
                    ix -= 1;
                    continue;
                }
                let dot = out[u].v.find('.').map(|p| p as i64);
                let mut j = if dot.is_some() && u == decpt { dot.unwrap() - 1 } else { out[u].v.len() as i64 - 1 };
                let mut vv = substr(&out[u].v, j + 1, None);
                while j >= 0 {
                    let ch = out[u].v.as_bytes()[j as usize];
                    if jj >= 0 && (ch == b'0' || ch == b'#') {
                        vv = format!("{}{}", ob[jj as usize] as char, vv);
                        jj -= 1;
                    }
                    j -= 1;
                }
                out[u].v = vv;
                out[u].t = 't';
                lasti = u;
                ix -= 1;
            }
            if jj >= 0 && lasti < out.len() {
                out[lasti].v = substr(&ostr, 0, Some(jj + 1)) + &out[lasti].v;
            }
            jj = ostr.find('.').map_or(-1, |p| p as i64) + 1;
            for u in decpt..out.len() {
                if !("n?(".contains(out[u].t)) && u != decpt {
                    continue;
                }
                let dot = out[u].v.find('.').map(|p| p as i64);
                let mut j = if dot.is_some() && u == decpt { dot.unwrap() + 1 } else { 0 };
                let mut vv = substr(&out[u].v, 0, Some(j));
                while j < out[u].v.len() as i64 {
                    if (jj as usize) < ostr.len() {
                        vv.push(ob[jj as usize] as char);
                        jj += 1;
                    }
                    j += 1;
                }
                out[u].v = vv;
                out[u].t = 't';
            }
        }
    }
    for ix in 0..out.len() {
        if "n?".contains(out[ix].t) {
            let myv = if flen > 1 && v < 0.0 && ix > 0 && out[ix - 1].v == "-" { -v } else { v };
            out[ix].v = write_num(&out[ix].v, myv)?;
            out[ix].t = 't';
        }
    }
    Ok(out.iter().map(|t| t.v.as_str()).collect())
}

fn split_fmt(fmt: &str) -> Result<Vec<String>> {
    let fc: Vec<char> = fmt.chars().collect();
    let mut out = Vec::new();
    let mut in_str = false;
    let mut j = 0;
    let mut i = 0;
    while i < fc.len() {
        match fc[i] {
            '"' => in_str = !in_str,
            '_' | '*' | '\\' => i += 1,
            ';' => {
                out.push(fc[j..i].iter().collect::<String>());
                j = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(fc[j.min(fc.len())..].iter().collect::<String>());
    if in_str {
        return unsup("unterminated string in a number format");
    }
    Ok(out)
}

re!(CFREGEX2, r"\[(=|>=?|<[>=]?)(-?\d+(?:\.\d*)?)\]");
re!(CF_ANY, r"\[[=<>]");

fn chkcond(v: f64, m: &Option<regex::Captures>) -> bool {
    let Some(m) = m else { return false };
    let th: f64 = m[2].parse().unwrap_or(f64::NAN);
    match &m[1] {
        "=" => v == th,
        ">" => v > th,
        "<" => v < th,
        "<>" => v != th,
        ">=" => v >= th,
        "<=" => v <= th,
        _ => false,
    }
}

/// (section count, chosen section) for a number.
fn choose_fmt(f: &str, v: f64) -> Result<(usize, String)> {
    let mut fmt = split_fmt(f)?;
    let mut l = fmt.len();
    let lat = fmt[l - 1].contains('@');
    if l < 4 && lat {
        l -= 1;
    }
    if fmt.len() > 4 {
        return unsup("more than four format sections");
    }
    fmt = match fmt.len() {
        1 => {
            if lat { vec!["General".into(), "General".into(), "General".into(), fmt[0].clone()] } else { vec![fmt[0].clone(), fmt[0].clone(), fmt[0].clone(), "@".into()] }
        }
        2 => {
            if lat { vec![fmt[0].clone(), fmt[0].clone(), fmt[0].clone(), fmt[1].clone()] } else { vec![fmt[0].clone(), fmt[1].clone(), fmt[0].clone(), "@".into()] }
        }
        3 => {
            if lat { vec![fmt[0].clone(), fmt[1].clone(), fmt[0].clone(), fmt[2].clone()] } else { vec![fmt[0].clone(), fmt[1].clone(), fmt[2].clone(), "@".into()] }
        }
        _ => fmt,
    };
    let ff = if v > 0.0 { &fmt[0] } else if v < 0.0 { &fmt[1] } else { &fmt[2] };
    if !fmt[0].contains('[') && !fmt[1].contains('[') {
        return Ok((l, ff.clone()));
    }
    if CF_ANY.is_match(&fmt[0]) || CF_ANY.is_match(&fmt[1]) {
        let m1 = CFREGEX2.captures(&fmt[0]);
        let m2 = CFREGEX2.captures(&fmt[1]);
        return Ok(if chkcond(v, &m1) {
            (l, fmt[0].clone())
        } else if chkcond(v, &m2) {
            (l, fmt[1].clone())
        } else {
            (l, fmt[if m1.is_some() && m2.is_some() { 2 } else { 1 }].clone())
        });
    }
    Ok((l, ff.clone()))
}

enum V {
    N(f64),
    S(String),
    B(bool),
}

fn table_fmt(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "m/d/yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        56 => "\"上午/下午 \"hh\"時\"mm\"分\"ss\"秒 \"",
        _ => return None,
    })
}

/// SSFImplicit: what an id means when neither the file nor the base table defines it.
fn implicit_fmt(id: u32) -> &'static str {
    match id {
        5 => "\"$\"#,##0_);\\(\"$\"#,##0\\)",
        6 => "\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",
        7 => "\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",
        8 => "\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",
        27..=31 | 36 | 50..=58 | 71 | 72 => "m/d/yy",
        32..=35 | 77 => "h:mm:ss",
        41 => "_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",
        42 => "_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",
        43 => "_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",
        44 => "_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)",
        59 => "0",
        60 => "0.00",
        61 => "#,##0",
        62 => "#,##0.00",
        63 => "\"$\"#,##0_);\\(\"$\"#,##0\\)",
        64 => "\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",
        65 => "\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",
        66 => "\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",
        67 => "0%",
        68 => "0.00%",
        69 => "# ?/?",
        70 => "# ??/??",
        73 => "d-mmm-yy",
        74 => "d-mmm",
        75 => "mmm-yy",
        76 => "h:mm",
        78 => "m/d/yy h:mm",
        79 => "mm:ss",
        80 => "[h]:mm:ss",
        81 => "mmss.0",
        _ => "General",
    }
}

/// `safe_format` of SheetJS for a cell whose style has number format `id`.
fn format_value(id: u32, v: &V, custom: &HashMap<u32, String>) -> Result<String> {
    if id == 0 {
        return match v {
            V::N(n) => general(*n),
            V::S(s) => Ok(s.clone()),
            V::B(b) => Ok(if *b { "TRUE" } else { "FALSE" }.into()),
        };
    }
    let sfmt: String = custom.get(&id).cloned().or_else(|| table_fmt(id).map(String::from)).unwrap_or_else(|| implicit_fmt(id).to_string());
    if isgeneral(&sfmt) {
        return match v {
            V::N(n) => general(*n),
            V::S(s) => Ok(s.clone()),
            V::B(b) => Ok(if *b { "TRUE" } else { "FALSE" }.into()),
        };
    }
    match v {
        V::N(n) => {
            let (l, ff) = choose_fmt(&sfmt, *n)?;
            if isgeneral(&ff) {
                return general(*n);
            }
            eval_fmt(&ff, *n, l)
        }
        V::S(_) | V::B(_) => {
            let text = match v {
                V::S(s) => s.clone(),
                V::B(b) => if *b { "TRUE" } else { "FALSE" }.into(),
                _ => unreachable!(),
            };
            let parts = split_fmt(&sfmt)?;
            let lat = parts[parts.len() - 1].contains('@');
            let ff = if parts.len() == 4 || lat { parts[parts.len() - 1].clone() } else { "@".into() };
            if isgeneral(&ff) || ff == "@" {
                return Ok(text);
            }
            unsup("text in a number-formatted cell")
        }
    }
}

// ------------------------------------------------------------------ reading the package

re!(TAG_ATTR, r#"([^"\s?>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^'">\s]+))"#);

/// SheetJS `parsexmltag` (attributes only): name without prefix, original case and lower case.
fn attrs(tag: &str) -> HashMap<String, String> {
    let mut z = HashMap::new();
    let body = tag.find(|c: char| c == ' ' || c == '\n' || c == '\r').map_or("", |p| &tag[p..]);
    for m in TAG_ATTR.captures_iter(body) {
        let q = m[1].trim().to_string();
        let v = m.get(2).or(m.get(3)).or(m.get(4)).map_or("", |x| x.as_str()).to_string();
        let k = match q.find(':') {
            None => q.find('_').filter(|p| *p > 0).map_or(q.clone(), |p| q[..p].to_string()),
            Some(j) => {
                let pre = if j == 5 && q.starts_with("xmlns") { "xmlns" } else { "" };
                format!("{pre}{}", &q[j + 1..])
            }
        };
        z.insert(k.to_lowercase(), v.clone());
        z.insert(k, v);
    }
    z
}

re!(ENT, r"(?i)&(?:quot|apos|gt|lt|amp|#x?([0-9a-f]+));");
re!(CODE, r"(?i)_x([0-9a-f]{4})_");

fn unescape_xml(s: &str) -> String {
    if let Some(i) = s.find("<![CDATA[") {
        let j = s.find("]]>").unwrap_or(s.len());
        let tail = if j + 3 <= s.len() { &s[j + 3..] } else { "" };
        let mid = if i + 9 <= j { &s[i + 9..j] } else { "" };
        return unescape_xml(&s[..i]) + mid + &unescape_xml(tail);
    }
    let a = ENT.replace_all(s, |c: &regex::Captures| {
        let whole = c[0].to_lowercase();
        match whole.as_str() {
            "&quot;" => "\"".to_string(),
            "&apos;" => "'".to_string(),
            "&gt;" => ">".to_string(),
            "&lt;" => "<".to_string(),
            "&amp;" => "&".to_string(),
            _ => {
                let hex = whole.contains('x');
                let n = u32::from_str_radix(&c[1], if hex { 16 } else { 10 }).unwrap_or(0);
                char::from_u32(n).map(|ch| ch.to_string()).unwrap_or_default()
            }
        }
    });
    CODE.replace_all(&a, |c: &regex::Captures| char::from_u32(u32::from_str_radix(&c[1], 16).unwrap_or(0)).map(|ch| ch.to_string()).unwrap_or_default()).into_owned()
}

type Zip = zip::ZipArchive<std::fs::File>;

fn read_text(z: &mut Zip, name: &str) -> Option<String> {
    let mut e = z.by_name(name).ok()?;
    let mut v = Vec::with_capacity(e.size() as usize);
    e.read_to_end(&mut v).ok()?;
    let s = String::from_utf8_lossy(&v).into_owned();
    Some(s.strip_prefix('\u{FEFF}').map(String::from).unwrap_or(s))
}

re!(SST0, r"(?s)<(?:\w+:)?sst([^>]*)>(.*)</(?:\w+:)?sst>");
re!(SST1, r"<(?:\w+:)?(?:si|sstItem)>");
re!(SST2, r"</(?:\w+:)?(?:si|sstItem)>");
re!(SI_PLAIN, r"^\s*<(?:\w+:)?t[^>]*>");
re!(SI_T_END, r"</(?:\w+:)?t>");
re!(SI_R, r"<(?:\w+:)?r>");
re!(SI_PH, r"(?s)<(?:\w+:)?rPh.*?>(.*?)</(?:\w+:)?rPh>");
re!(SI_T, r"<(?:\w+:)?t[^>]*>([^<]*)</(?:\w+:)?t>");
re!(ANY_TAG, r"<[^>]*>");

/// parse_si: None when the item has neither a plain `<t>` nor rich runs (SheetJS leaves the text undefined).
fn parse_si(x: &str) -> Option<String> {
    if x.is_empty() {
        return Some(String::new());
    }
    if SI_PLAIN.is_match(x) {
        let after = &x[x.find('>').unwrap() + 1..];
        let first = SI_T_END.split(after).next().unwrap_or("");
        return Some(unescape_xml(first));
    }
    if SI_R.is_match(x) {
        let no_ph = SI_PH.replace_all(x, "");
        let joined: String = SI_T.find_iter(&no_ph).map(|m| m.as_str()).collect();
        return Some(unescape_xml(&ANY_TAG.replace_all(&joined, "")));
    }
    None
}

fn parse_sst(data: &str) -> Vec<Option<String>> {
    let Some(m) = SST0.captures(data) else { return Vec::new() };
    let body = SST1.replace_all(m.get(2).unwrap().as_str(), "");
    SST2.split(&body).map(|p| parse_si(p.trim())).collect()
}

re!(NUMFMTS, r"(?s)<(?:\w+:)?numFmts[^>]*>.*?</(?:\w+:)?numFmts>");
re!(NUMFMT, r"<(?:\w+:)?numFmt\b[^>]*>");
re!(CELLXFS, r"(?s)<(?:\w+:)?cellXfs[^>]*>.*?</(?:\w+:)?cellXfs>");
re!(XF, r"<(?:\w+:)?xf\b[^>]*>");

struct Styles {
    /// None when styles.xml has no cellXfs (SheetJS then formats nothing).
    xfs: Option<Vec<Option<u32>>>,
    custom: HashMap<u32, String>,
}

fn parse_styles(data: &str) -> Result<Styles> {
    static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
    let data = COMMENT.replace_all(data, "").into_owned();
    let mut custom = HashMap::new();
    if let Some(m) = NUMFMTS.find(&data) {
        for t in NUMFMT.find_iter(m.as_str()) {
            let a = attrs(t.as_str());
            let (Some(code), Some(id)) = (a.get("formatcode"), a.get("numfmtid")) else { continue };
            let id: u32 = id.trim().parse().map_err(|_| Error::Msg("xlsx: numFmtId".into()))?;
            if id > 0 {
                if id > 0x188 {
                    return unsup("number format id above 392");
                }
                custom.insert(id, unescape_xml(code));
            }
        }
    }
    let xfs = CELLXFS.find(&data).map(|m| {
        XF.find_iter(m.as_str())
            .map(|t| attrs(t.as_str()).get("numfmtid").and_then(|v| v.trim().parse::<u32>().ok()))
            .collect::<Vec<_>>()
    });
    if let Some(x) = &xfs {
        if x.iter().flatten().any(|&id| id > 0x188) {
            return unsup("number format id above 392");
        }
    }
    Ok(Styles { xfs, custom })
}

fn col_name(c: usize) -> String {
    let mut s = String::new();
    let mut col = c + 1;
    while col > 0 {
        s.insert(0, (b'A' + ((col - 1) % 26) as u8) as char);
        col = (col - 1) / 26;
    }
    s
}

/// SheetJS `safe_decode_range`, returned as (start row, start col, end row, end col).
fn decode_range(s: &str) -> (i64, i64, i64, i64) {
    let (a, b) = s.split_once(':').unwrap_or((s, s));
    let dec = |x: &str| {
        let mut c = 0i64;
        let mut i = 0;
        let bytes = x.as_bytes();
        while i < bytes.len() && bytes[i].is_ascii_uppercase() {
            c = c * 26 + (bytes[i] - 64) as i64;
            i += 1;
        }
        let mut r = 0i64;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            r = r * 10 + (bytes[i] - 48) as i64;
            i += 1;
        }
        (r - 1, c - 1)
    };
    let (sr, sc) = dec(a);
    let (er, ec) = dec(b);
    (sr, sc, er, ec)
}

struct Grid {
    range: Option<(i64, i64, i64, i64)>,
    /// "B7" -> (text, has a value). Errors and empty shared strings have none.
    cells: HashMap<String, (String, bool)>,
}

re!(SHEETDATA, r"(?s)<(?:\w+:)?sheetData[^>]*>(.*)</(?:\w+:)?sheetData>");
re!(DIMENSION, r"<(?:\w*:)?dimension");
re!(DIM_REF, r#""(\w*:\w*)""#);
re!(ROW_END, r"</(?:\w+:)?row>");
re!(CELL_SPLIT, r"<(?:\w+:)?c[ /> ]");
re!(CELL_R, r#"r=["']([^"']*)["']"#);
re!(MATCH_V, r"(?s)<(?:\w+:)?v(?: xml:space=.preserve.)?(?:[^>]*)>(.*?)</(?:\w+:)?v>");
re!(MATCH_F, r"(?s)<(?:\w+:)?f(?: xml:space=.preserve.)?(?:[^>]*)>(.*?)</(?:\w+:)?f>");
re!(IS_TAG, r"(?s)<(?:\w+:)?is>(.*?)</(?:\w+:)?is>");

fn js_parse_float(s: &str) -> Option<f64> {
    static PF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))").unwrap());
    PF.captures(s).and_then(|c| c[1].parse::<f64>().ok())
}

fn parse_sheet(data: &str, strs: &[Option<String>], styles: &Styles) -> Result<Grid> {
    let (data1, data2, sdata) = match SHEETDATA.captures(data) {
        Some(m) => {
            let w = m.get(0).unwrap();
            (&data[..w.start()], &data[w.end()..], Some(m.get(1).unwrap().as_str()))
        }
        None => (data, data, None),
    };
    let _ = data2;
    let mut range = None;
    if let Some(p) = DIMENSION.find(data1).map(|m| m.start()).filter(|p| *p > 0) {
        let end = (p + 50).min(data1.len());
        let mut e = end;
        while !data1.is_char_boundary(e) {
            e -= 1;
        }
        if let Some(c) = DIM_REF.captures(&data1[p..e]) {
            let d = decode_range(&c[1]);
            if d.0 <= d.2 && d.1 <= d.3 && d.0 >= 0 && d.1 >= 0 {
                range = Some(d);
            }
        }
    }
    let mut guess = (2000000i64, 2000000i64, 0i64, 0i64);
    let mut cells: HashMap<String, (String, bool)> = HashMap::new();
    if let Some(sdata) = sdata {
        let mut tagr = 0i64;
        let mut tagc;
        for chunk in ROW_END.split(sdata) {
            let x = chunk.trim();
            if x.is_empty() {
                continue;
            }
            let b = x.as_bytes();
            let (mut rstart, mut ri) = (0usize, 0usize);
            while ri < b.len() {
                match b[ri] {
                    b'>' if ri == 0 || b[ri - 1] != b'/' => {
                        ri += 1;
                        break;
                    }
                    b'<' => rstart = ri,
                    _ => {}
                }
                ri += 1;
            }
            if rstart >= ri {
                break;
            }
            let tag = attrs(&x[rstart..ri]);
            tagr = match tag.get("r") {
                Some(r) => r.trim().parse::<i64>().map_err(|_| Error::Msg("xlsx: row number".into()))?,
                None => tagr + 1,
            };
            tagc = -1;
            guess.0 = guess.0.min(tagr - 1);
            guess.2 = guess.2.max(tagr - 1);
            let mut pieces: Vec<&str> = CELL_SPLIT.split(&x[ri..]).collect();
            let skip = pieces.iter().position(|p| !p.trim().starts_with('<')).unwrap_or(pieces.len());
            pieces.drain(..skip);
            for piece in pieces {
                let x = piece.trim();
                if x.is_empty() {
                    continue;
                }
                let cref = CELL_R.captures(x).map(|c| c[1].to_string());
                if let Some(d) = &cref {
                    let mut idx = 0i64;
                    for ch in d.chars() {
                        let cc = ch as i64 - 64;
                        if !(1..=26).contains(&cc) {
                            break;
                        }
                        idx = 26 * idx + cc;
                    }
                    tagc = idx - 1;
                } else {
                    tagc += 1;
                }
                let xs = format!("<c {}{}", if x.starts_with('<') { ">" } else { "" }, x);
                let gt = xs.find('>').map_or(xs.len(), |p| p + 1);
                let tag = attrs(&xs[..gt]);
                let d = &xs[gt..];
                let key = tag.get("r").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| format!("{}{}", col_name(tagc.max(0) as usize), tagr));
                let mut pv: Option<String> = MATCH_V.captures(d).map(|c| c[1].to_string()).filter(|s| !s.is_empty()).map(|s| unescape_xml(&s));
                let has_f = MATCH_F.captures(d).map_or(false, |c| !c[1].is_empty());
                let t = tag.get("t").cloned();
                if t.is_none() && pv.is_none() {
                    if !has_f {
                        // an empty `<f .../>` of a shared formula would still need the parent formula
                        if d.contains("<f") && MATCH_F.captures(d).is_none() && Regex::new(r"<f[^>]*/>").unwrap().is_match(d) {
                            return unsup("shared formula without a cached value");
                        }
                    }
                    // SheetJS gives such a cell the value 0, then skips it (0 == "").
                    guess.1 = guess.1.min(tagc);
                    guess.3 = guess.3.max(tagc);
                    continue;
                }
                guess.1 = guess.1.min(tagc);
                guess.3 = guess.3.max(tagc);
                let ty = t.unwrap_or_else(|| "n".into());
                let ty = if ty.is_empty() { "n".to_string() } else { ty };
                let value: V;
                let mut has_value = true;
                let mut text_override: Option<String> = None;
                match ty.as_str() {
                    "n" => {
                        let Some(s) = pv.take() else { continue };
                        let Some(n) = js_parse_float(&s) else { return unsup("number cell that is not a number") };
                        value = V::N(n);
                    }
                    "s" => {
                        let Some(s) = pv.take() else { continue };
                        let idx = js_parse_float(&s).map(|n| n as usize);
                        let Some(item) = idx.and_then(|i| strs.get(i)) else { return unsup("shared string index out of range") };
                        match item {
                            Some(t) => value = V::S(t.clone()),
                            None => {
                                value = V::S(String::new());
                                has_value = false;
                                text_override = Some(String::new());
                            }
                        }
                    }
                    "str" => value = V::S(pv.take().unwrap_or_default()),
                    "inlineStr" => {
                        let t = IS_TAG.captures(d).map(|c| parse_si(&c[1]));
                        match t {
                            Some(Some(s)) => value = V::S(s),
                            Some(None) => {
                                value = V::S(String::new());
                                has_value = false;
                                text_override = Some(String::new());
                            }
                            None => value = V::S(String::new()),
                        }
                    }
                    "b" => value = V::B(matches!(pv.as_deref(), Some("1") | Some("true") | Some("TRUE"))),
                    "e" => {
                        value = V::S(String::new());
                        has_value = false;
                        text_override = Some(String::new());
                    }
                    _ => return unsup("cell type"),
                }
                let fmtid = match (&styles.xfs, tag.get("s")) {
                    (Some(xfs), Some(s)) => s.trim().parse::<usize>().ok().and_then(|i| xfs.get(i).copied().flatten()).unwrap_or(0),
                    _ => 0,
                };
                let text = match text_override {
                    Some(t) => t,
                    None => format_value(fmtid, &value, &styles.custom)?,
                };
                cells.insert(key, (text, has_value));
            }
        }
    }
    if range.is_none() && guess.3 >= guess.1 && guess.2 >= guess.0 {
        range = Some((guess.0, guess.1, guess.2, guess.3));
    }
    Ok(Grid { range, cells })
}

struct Workbook {
    sheets: Vec<(String, Vec<Vec<String>>)>,
}

re!(SHEET_TAG, r"<(?:\w+:)?sheet\b[^>]*>");
re!(REL_TAG, r"<Relationship\b[^>]*>");
re!(CT_OVERRIDE, r"<Override\b[^>]*>");
re!(WORKBOOK_PR, r"<(?:\w+:)?workbookPr\b[^>]*>");
re!(XL_PREFIX, r"/?xl/");

fn read_workbook(input: &Path) -> Result<Workbook> {
    let mut z: Zip = zip::ZipArchive::new(std::fs::File::open(input)?).map_err(|e| Error::Msg(e.to_string()))?;
    if z.by_name("META-INF/manifest.xml").is_ok() || z.by_name("objectdata.xml").is_ok() || z.by_name("Index/Document.iwa").is_ok() {
        return unsup("not an OOXML workbook");
    }
    let ct = read_text(&mut z, "[Content_Types].xml").ok_or_else(|| Error::Msg("xlsx: no [Content_Types].xml".into()))?;
    let (mut wb_part, mut sst_part, mut sty_part) = (None, None, None);
    for o in CT_OVERRIDE.find_iter(&ct) {
        let a = attrs(o.as_str());
        let (Some(pn), Some(ty)) = (a.get("partname"), a.get("contenttype")) else { continue };
        let pn = pn.trim_start_matches('/').to_string();
        match ty.as_str() {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            | "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
            | "application/vnd.ms-excel.addin.macroEnabled.main+xml"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml" => {
                wb_part.get_or_insert(pn);
            }
            "application/vnd.ms-excel.sheet.binary.macroEnabled.main" => return unsup("binary workbook"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" => {
                sst_part.get_or_insert(pn);
            }
            "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" => {
                sty_part.get_or_insert(pn);
            }
            _ => {}
        }
    }
    let wb_part = match wb_part {
        Some(p) => p,
        None => {
            if z.by_name("xl/workbook.xml").is_ok() {
                "xl/workbook.xml".to_string()
            } else {
                return unsup("no workbook part");
            }
        }
    };
    let strs = match &sst_part {
        Some(p) => parse_sst(&read_text(&mut z, p).unwrap_or_default()),
        None => Vec::new(),
    };
    let styles = match &sty_part {
        Some(p) => parse_styles(&read_text(&mut z, p).unwrap_or_default())?,
        None => Styles { xfs: None, custom: HashMap::new() },
    };
    let wb = read_text(&mut z, &wb_part).ok_or_else(|| Error::Msg("xlsx: workbook part missing".into()))?;
    if let Some(m) = WORKBOOK_PR.find(&wb) {
        if matches!(attrs(m.as_str()).get("date1904").map(|s| s.as_str()), Some("1") | Some("true") | Some("TRUE")) {
            return unsup("1904 date system");
        }
    }
    let sheet_tags: Vec<HashMap<String, String>> = SHEET_TAG.find_iter(&wb).map(|m| attrs(m.as_str())).collect();
    if sheet_tags.is_empty() {
        return Err(Error::Msg("This workbook has no sheets.".into()));
    }
    // workbook relationships: Id -> (Target, Type)
    let dir_end = wb_part.rfind('/').map_or(0, |i| i + 1);
    let rels_name = format!("{}_rels/{}.rels", &wb_part[..dir_end], &wb_part[dir_end..]);
    let rels_name = if z.by_name(&rels_name).is_ok() { rels_name } else { "xl/_rels/workbook.xml.rels".to_string() };
    let rels_xml = read_text(&mut z, &rels_name);
    let mut rels: HashMap<String, (String, String)> = HashMap::new();
    if let Some(x) = &rels_xml {
        for t in REL_TAG.find_iter(x) {
            let a = attrs(t.as_str());
            if let (Some(id), Some(target), Some(ty)) = (a.get("id"), a.get("target"), a.get("type")) {
                rels.insert(id.clone(), (target.clone(), ty.clone()));
            }
        }
    }
    let by_rel: Option<Vec<(String, String)>> = if rels_xml.is_some() {
        sheet_tags.iter().map(|a| a.get("id").and_then(|id| rels.get(id)).map(|(t, ty)| (t.clone(), ty.clone()))).collect()
    } else {
        None
    };
    let mut sheets = Vec::new();
    for (i, a) in sheet_tags.iter().enumerate() {
        let name = unescape_xml(a.get("name").map(|s| s.as_str()).unwrap_or(""));
        let path = match &by_rel {
            Some(r) => {
                let (target, ty) = &r[i];
                if !ty.ends_with("/worksheet") {
                    return unsup("sheet type other than a worksheet");
                }
                let p1 = format!("xl/{}", XL_PREFIX.replace(target, ""));
                let p2 = target.trim_start_matches('/').to_string();
                let p3 = format!("{}{}", &rels_name[..rels_name.find("_rels").unwrap_or(0)], target);
                [p1, p2, p3].into_iter().find(|p| z.by_name(p).is_ok()).ok_or_else(|| Error::Msg("xlsx: sheet part missing".into()))?
            }
            None => format!("xl/worksheets/sheet{}.xml", i + 1),
        };
        let data = read_text(&mut z, &path).ok_or_else(|| Error::Msg("xlsx: sheet part missing".into()))?;
        let grid = parse_sheet(&data, &strs, &styles)?;
        sheets.push((name, grid_rows(&grid)?));
    }
    Ok(Workbook { sheets })
}

/// `sheet_to_json(ws, {header: 1, defval: '', raw: false, blankrows: false})`.
fn grid_rows(g: &Grid) -> Result<Vec<Vec<String>>> {
    let Some((sr, sc, er, ec)) = g.range else { return Ok(Vec::new()) };
    if (er - sr + 1).saturating_mul(ec - sc + 1) > 40_000_000 {
        return unsup("huge sheet range");
    }
    let mut rows = Vec::new();
    for r in sr..=er {
        let mut row = Vec::with_capacity((ec - sc + 1) as usize);
        let mut any = false;
        for c in sc..=ec {
            match g.cells.get(&format!("{}{}", col_name(c as usize), r + 1)) {
                Some((t, has)) => {
                    any |= *has;
                    row.push(t.clone());
                }
                None => row.push(String::new()),
            }
        }
        if any {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// The rows the TypeScript engine lays out for each sheet (name, rows trimmed to the used columns), for tests.
pub fn dump_sheets(input: &Path) -> Result<serde_json::Value> {
    let wb = read_workbook(input)?;
    Ok(serde_json::Value::Array(wb.sheets.iter().map(|(n, r)| serde_json::json!({ "name": n, "rows": r })).collect()))
}

// ------------------------------------------------------------------ drawing

const PAGE_W: f64 = 842.0;
const PAGE_H: f64 = 595.0;
const MARGIN: f64 = 32.0;
const MAX_COL: f64 = 220.0;
const PADDING: f64 = 4.0;

struct Typeface<'a> {
    std: Option<[Font; 2]>,
    uni: Fonts<'a>,
    sample: String,
    uni_ids: [Option<ObjectId>; 2],
}

impl Typeface<'_> {
    /// (show operator, width) of `text` in the regular (0) or bold (1) face.
    fn measure(&mut self, doc: &mut Document, text: &str, v: usize, size: f64) -> Result<(String, f64)> {
        if text.is_empty() {
            return Ok((if self.std.is_some() { "() Tj".into() } else { "[] TJ".into() }, 0.0));
        }
        if text.contains(['\t', '\r', '\n']) || text.chars().any(|c| (c as u32) < 32) {
            return unsup("control character in a cell");
        }
        if let Some(fonts) = &self.std {
            let font = &fonts[v];
            let b = font.encode(text).ok_or(Error::NeedsUnicodeFont)?;
            return Ok((format!("{} Tj", pdf_string(&b)), font.width(&b, 1000.0) * (size / 1000.0))); // pdf-lib: sum of glyph widths * (size / 1000)
        }
        if text.chars().any(|c| c as u32 > 0xFFFF) {
            return unsup("character outside the BMP");
        }
        let (id, u) = self.uni.get(doc, &self.sample, v == 1, false).ok_or(Error::NeedsUnicodeFont)?;
        self.uni_ids[v] = Some(id);
        let s = u.shape(text, size)?;
        Ok((format!("{} TJ", s.tj), s.width))
    }
}

struct Page {
    ops: String,
}

impl Page {
    fn text(&mut self, show: &str, font: usize, size: f64, gray: f64, x: f64, y: f64) {
        self.ops.push_str(&format!("BT /F{} {} Tf {} {} {} rg {} {} Td {} ET\n", font, f(size), f(gray), f(gray), f(gray), f(x), f(y), show));
    }
    fn fill_rect(&mut self, rgb: [f64; 3], x: f64, y: f64, w: f64, h: f64) {
        self.ops.push_str(&format!("q {} {} {} rg {} {} {} {} re f Q\n", f(rgb[0]), f(rgb[1]), f(rgb[2]), f(x), f(y), f(w), f(h)));
    }
    fn stroke_rect(&mut self, rgb: [f64; 3], bw: f64, x: f64, y: f64, w: f64, h: f64) {
        self.ops.push_str(&format!("q {} {} {} RG {} w {} {} {} {} re S Q\n", f(rgb[0]), f(rgb[1]), f(rgb[2]), f(bw), f(x), f(y), f(w), f(h)));
    }
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}')
}

fn collapse_ws(s: &str) -> String {
    static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s\u{FEFF}]+").unwrap());
    WS.replace_all(s, " ").into_owned()
}

pub fn xlsx_to_pdf(input: &Path, out: &Path, fonts: Option<FontSource>, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    progress(15, "Reading workbook...");
    let wb = read_workbook(input)?;

    struct Sheet {
        name: String,
        rows: Vec<Vec<String>>,
        cols: usize,
    }
    let sheets: Vec<Sheet> = wb
        .sheets
        .into_iter()
        .map(|(name, rows)| {
            let mut cols = 0;
            for r in &rows {
                for (i, c) in r.iter().enumerate() {
                    if !js_trim(c).is_empty() {
                        cols = cols.max(i + 1);
                    }
                }
            }
            let rows = rows.into_iter().map(|r| (0..cols).map(|i| r.get(i).cloned().unwrap_or_default()).collect()).collect();
            Sheet { name, rows, cols }
        })
        .collect();

    // Which fonts: the standard ones when every character fits WinAnsi, an embedded face otherwise (collectText + fontCollection).
    let mut sample = String::new();
    for s in &sheets {
        sample.push_str(&s.name);
        for r in &s.rows {
            for c in r {
                sample.push_str(c);
            }
        }
    }
    let cleaned = sample.replace(['\r', '\n', '\t'], " ");
    let std_fonts = [Font::standard("sans", false, false), Font::standard("sans", true, false)];
    let std_ok = cleaned.chars().all(|c| std_fonts[0].encode(&c.to_string()).is_some());
    let mut uniq = String::new();
    for c in cleaned.chars() {
        if !uniq.contains(c) {
            uniq.push(c);
        }
    }
    let mut tf = Typeface { std: std_ok.then_some(std_fonts), uni: Fonts::new(fonts), sample: uniq, uni_ids: [None; 2] };
    let mut doc = Document::with_version("1.7");

    let avail_w = PAGE_W - MARGIN * 2.0;
    let mut pages: Vec<Page> = Vec::new();
    progress(30, "Laying out sheets...");
    let nsheets = sheets.len();
    for (si, sheet) in sheets.iter().enumerate() {
        let (rows, cols) = (&sheet.rows, sheet.cols);
        let title = |pg: &mut Page, tf: &mut Typeface, doc: &mut Document, suffix: &str| -> Result<()> {
            let (show, _) = tf.measure(doc, &format!("{}{}", sheet.name, suffix), 1, 11.0)?;
            pg.text(&show, 1, 11.0, 0.1, MARGIN, PAGE_H - MARGIN - 10.0);
            Ok(())
        };
        if rows.is_empty() || cols == 0 {
            let mut pg = Page { ops: String::new() };
            title(&mut pg, &mut tf, &mut doc, "")?;
            let (show, _) = tf.measure(&mut doc, "(Empty sheet)", 0, 9.0)?;
            pg.text(&show, 0, 9.0, 0.5, MARGIN, PAGE_H - MARGIN - 34.0);
            pages.push(pg);
            continue;
        }
        // Natural column widths at 9pt, then shrink the font to fit if needed.
        let mut natural = vec![0.0f64; cols];
        for (c, nat) in natural.iter_mut().enumerate() {
            let mut m = 24.0f64;
            for (ri, r) in rows.iter().take(500).enumerate() {
                let (_, w) = tf.measure(&mut doc, &r[c], if ri == 0 { 1 } else { 0 }, 9.0)?;
                m = m.max(w + PADDING * 2.0);
            }
            *nat = m.min(MAX_COL);
        }
        let total_natural: f64 = natural.iter().sum();
        let mut font_size = 9.0;
        if total_natural > avail_w {
            font_size = f64::max(6.0, 9.0 * avail_w / total_natural);
        }
        let widths: Vec<f64> = natural.iter().map(|w| w * font_size / 9.0).collect();

        let mut bands: Vec<Vec<usize>> = Vec::new();
        let mut band: Vec<usize> = Vec::new();
        let mut used = 0.0;
        for (c, &w) in widths.iter().enumerate() {
            if !band.is_empty() && used + w > avail_w {
                bands.push(std::mem::take(&mut band));
                used = 0.0;
            }
            band.push(c);
            used += w;
        }
        bands.push(band);

        let row_h = font_size * 1.9;
        let top = PAGE_H - MARGIN - 26.0;
        let rows_per_page = f64::max(2.0, ((top - MARGIN - 14.0) / row_h).floor()) as usize;
        let header = &rows[0];
        let body = &rows[1..];
        let mut chunks: Vec<&[Vec<String>]> = Vec::new();
        let mut i = 0;
        while i < body.len().max(1) {
            chunks.push(&body[i.min(body.len())..(i + rows_per_page - 1).min(body.len())]);
            i += rows_per_page - 1;
        }
        let total_pages = chunks.len() * bands.len();
        let mut page_no = 0;
        static NUMERIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+(]?[$€£¥]?\s?[0-9.,]+%?\)?$").unwrap());
        for band_cols in &bands {
            for chunk in &chunks {
                page_no += 1;
                let mut pg = Page { ops: String::new() };
                let suffix = if bands.len() > 1 { format!("  (columns {}\u{2013}{})", col_name(band_cols[0]), col_name(*band_cols.last().unwrap())) } else { String::new() };
                title(&mut pg, &mut tf, &mut doc, &suffix)?;
                let mut y = top;
                for (ri, row) in std::iter::once(header).chain(chunk.iter()).enumerate() {
                    let mut x = MARGIN;
                    if ri == 0 {
                        let w: f64 = band_cols.iter().map(|&c| widths[c]).sum();
                        pg.fill_rect([0.94, 0.93, 0.9], x, y - row_h, w, row_h);
                    }
                    for &c in band_cols {
                        let w = widths[c];
                        let v = if ri == 0 { 1 } else { 0 };
                        // fit(): cut the text with an ellipsis until it fits
                        let text0 = collapse_ws(&row[c]);
                        let max = w - PADDING * 2.0;
                        let (mut text, mut tw) = {
                            let (_, tw) = tf.measure(&mut doc, &text0, v, font_size)?;
                            (text0.clone(), tw)
                        };
                        if tw > max {
                            let mut t: Vec<char> = text0.chars().collect();
                            loop {
                                let cand: String = t.iter().collect::<String>() + "\u{2026}";
                                let (_, w2) = tf.measure(&mut doc, &cand, v, font_size)?;
                                if !(t.len() > 1 && w2 > max) {
                                    break;
                                }
                                t.pop();
                            }
                            text = t.iter().collect::<String>() + "\u{2026}";
                            tw = tf.measure(&mut doc, &text, v, font_size)?.1;
                        }
                        let tx = if ri > 0 && NUMERIC.is_match(js_trim(&text)) { x + w - PADDING - tw } else { x + PADDING };
                        if !text.is_empty() {
                            let (show, _) = tf.measure(&mut doc, &text, v, font_size)?;
                            pg.text(&show, v, font_size, 0.12, tx, y - row_h + (row_h - font_size) / 2.0 + font_size * 0.2);
                        }
                        pg.stroke_rect([0.8, 0.79, 0.75], 0.5, x, y - row_h, w, row_h);
                        x += w;
                    }
                    y -= row_h;
                }
                let (show, _) = tf.measure(&mut doc, &format!("{page_no} / {total_pages}"), 0, 8.0)?;
                pg.text(&show, 0, 8.0, 0.5, PAGE_W - MARGIN - 40.0, MARGIN - 14.0);
                pages.push(pg);
            }
        }
        progress(30 + (((si + 1) as f64 / nsheets as f64) * 55.0).round() as u32, &format!("Laid out \"{}\"...", sheet.name));
    }

    progress(95, "Saving PDF...");
    let mut font_res = Dictionary::new();
    for v in 0..2 {
        let obj = match (&tf.std, tf.uni_ids[v]) {
            (Some(fonts), _) => font_dict(&fonts[v]),
            (None, Some(id)) => Object::Reference(id),
            (None, None) => continue,
        };
        font_res.set(format!("F{v}"), obj);
    }
    tf.uni.finish(&mut doc)?;
    let mut res = Dictionary::new();
    res.set("Font", Object::Dictionary(font_res));
    let res_id = doc.add_object(Object::Dictionary(res));
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for p in &pages {
        let mut cs = Stream::new(Dictionary::new(), p.ops.clone().into_bytes());
        cs.allows_compression = true;
        let cid = doc.add_object(Object::Stream(cs));
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages_id));
        page.set("MediaBox", Object::Array(vec![0.into(), 0.into(), Object::Real(PAGE_W as f32), Object::Real(PAGE_H as f32)]));
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
    progress(100, "PDF ready.");
    Ok(n)
}
