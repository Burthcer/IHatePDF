//! Edit PDF engine, analysis half, ported from src/features/editPdf/engine (lexer, cmap, fontModel,
//! interpreter, layout): reads each page's content streams, finds every shown glyph with its position,
//! font, size and colour, and groups them into lines and paragraphs. Used by PDF to PowerPoint for the
//! editable text boxes (`ppt_text_boxes`). Compared with the TypeScript engine in scripts/test-editpdf-rust.ts.
//! Same arithmetic, same thresholds; any parse problem returns Err so the TypeScript engine runs instead.

use lopdf::{Dictionary, Document, Object, ObjectId};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn multiply(m: &Matrix, n: &Matrix) -> Matrix {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}
fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}
fn apply_vector(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y, m[1] * x + m[3] * y)
}

// ------------------------------------------------------------------ data tables

struct Data {
    standard: Vec<String>,
    mac_roman: Vec<String>,
    win_ansi: Vec<String>,
    symbol: Vec<String>,
    zapf: Vec<String>,
    glyph_unicode: HashMap<String, u32>,
    fonts: HashMap<String, StdFont>,
}
struct StdFont {
    asc: Option<f64>,
    desc: Option<f64>,
    w: HashMap<String, f64>,
}

fn data() -> &'static Data {
    static D: OnceLock<Data> = OnceLock::new();
    D.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("editdata.json")).expect("editdata.json");
        let arr = |k: &str| -> Vec<String> { v[k].as_array().unwrap().iter().map(|s| s.as_str().unwrap_or("").to_string()).collect() };
        let glyph_unicode = v["glyphUnicode"].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_u64().unwrap_or(0) as u32)).collect();
        let fonts = v["fonts"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, f)| {
                (
                    k.clone(),
                    StdFont {
                        asc: f["asc"].as_f64(),
                        desc: f["desc"].as_f64(),
                        w: f["w"].as_object().unwrap().iter().map(|(n, x)| (n.clone(), x.as_f64().unwrap_or(0.0))).collect(),
                    },
                )
            })
            .collect();
        Data { standard: arr("standard"), mac_roman: arr("macRoman"), win_ansi: arr("winAnsi"), symbol: arr("symbol"), zapf: arr("zapf"), glyph_unicode, fonts }
    })
}

// ------------------------------------------------------------------ small JS-compatible helpers

fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
/// `t === undefined || /^\s+$/.test(t)`
fn is_space(t: &Option<String>) -> bool {
    match t {
        None => true,
        Some(s) => !s.is_empty() && s.chars().all(js_space),
    }
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if js_space(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}
fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

// ------------------------------------------------------------------ content-stream lexer

#[derive(Clone, Debug)]
#[allow(dead_code)] // Dict/Bool are parsed so inline-image dictionaries and flags are consumed correctly
enum Opd {
    Num(f64),
    Name(String),
    Str(Vec<u8>),
    Arr(Vec<Opd>),
    Dict(HashMap<String, Opd>),
    Bool(bool),
    Null,
}
enum Tok {
    Op(Opd),
    Kw(String),
}
struct ContentOp {
    op: String,
    args: Vec<Opd>,
}

fn is_ws(c: u8) -> bool {
    matches!(c, 0 | 9 | 10 | 12 | 13 | 32)
}
fn is_delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}
fn is_regular(c: u8) -> bool {
    !is_ws(c) && !is_delim(c)
}

struct Lexer<'a> {
    b: &'a [u8],
    pos: usize,
}

fn hex_val(c: u8) -> i32 {
    match c {
        b'0'..=b'9' => (c - b'0') as i32,
        b'A'..=b'F' => (c - b'A') as i32 + 10,
        b'a'..=b'f' => (c - b'a') as i32 + 10,
        _ => -1,
    }
}

fn parse_float_prefix(t: &str) -> Option<f64> {
    // JS parseFloat: longest numeric prefix
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i == ds || (i == ds + 1 && b[ds] == b'.') {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let es = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > es {
            i = j;
        }
    }
    t[..i].parse::<f64>().ok()
}

fn parse_number(token: &str) -> Option<f64> {
    // Tolerate producer quirks like "--5" or "1.2.3" the way viewers do.
    let mut t = token.to_string();
    let bytes = t.as_bytes();
    if bytes.len() >= 2 && (bytes[0] == b'+' || bytes[0] == b'-') && (bytes[1] == b'+' || bytes[1] == b'-') {
        let sign = bytes[0] as char;
        let rest = t[1..].trim_start_matches(|c| c == '+' || c == '-').to_string();
        t = format!("{sign}{rest}");
    }
    if let Some(first) = t.find('.') {
        if let Some(second) = t[first + 1..].find('.') {
            t.truncate(first + 1 + second);
        }
    }
    let plain = t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.' | b'e' | b'E'));
    if plain {
        if let Ok(v) = t.parse::<f64>() {
            if v.is_finite() {
                return Some(v);
            }
        }
    }
    if let Some(f) = parse_float_prefix(&t) {
        return Some(f);
    }
    if t == "-" || t == "+" || t == "." {
        return Some(0.0);
    }
    None
}

impl<'a> Lexer<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.b.len() {
            let c = self.b[self.pos];
            if is_ws(c) {
                self.pos += 1;
            } else if c == b'%' {
                while self.pos < self.b.len() && self.b[self.pos] != 10 && self.b[self.pos] != 13 {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn read(&mut self) -> Option<Tok> {
        self.skip_ws();
        let b = self.b;
        if self.pos >= b.len() {
            return None;
        }
        let c = b[self.pos];
        if c == b'/' {
            return Some(Tok::Op(self.read_name()));
        }
        if c == b'(' {
            return Some(Tok::Op(self.read_literal()));
        }
        if c == b'<' {
            if b.get(self.pos + 1) == Some(&b'<') {
                return Some(Tok::Op(self.read_dict()));
            }
            return Some(Tok::Op(self.read_hex()));
        }
        if c == b'[' {
            self.pos += 1;
            let mut items = Vec::new();
            loop {
                self.skip_ws();
                if self.pos >= b.len() {
                    break;
                }
                if b[self.pos] == b']' {
                    self.pos += 1;
                    break;
                }
                match self.read() {
                    None => break,
                    Some(Tok::Kw(_)) => continue,
                    Some(Tok::Op(o)) => items.push(o),
                }
            }
            return Some(Tok::Op(Opd::Arr(items)));
        }
        if matches!(c, b']' | b'>' | b')' | b'{' | b'}') {
            self.pos += 1;
            return Some(Tok::Kw(String::new()));
        }
        let start = self.pos;
        while self.pos < b.len() && is_regular(b[self.pos]) {
            self.pos += 1;
        }
        let token = latin1(&b[start..self.pos]);
        if token.is_empty() {
            self.pos += 1;
            return Some(Tok::Kw(String::new()));
        }
        let first = token.as_bytes()[0];
        if first.is_ascii_digit() || first == b'+' || first == b'-' || first == b'.' {
            if let Some(n) = parse_number(&token) {
                return Some(Tok::Op(Opd::Num(n)));
            }
        }
        Some(Tok::Op(match token.as_str() {
            "true" => Opd::Bool(true),
            "false" => Opd::Bool(false),
            "null" => Opd::Null,
            _ => return Some(Tok::Kw(token)),
        }))
    }

    fn read_name(&mut self) -> Opd {
        let b = self.b;
        self.pos += 1;
        let mut name = String::new();
        while self.pos < b.len() && is_regular(b[self.pos]) {
            let c = b[self.pos];
            if c == b'#' && self.pos + 2 < b.len() {
                let (h, l) = (hex_val(b[self.pos + 1]), hex_val(b[self.pos + 2]));
                if h >= 0 && l >= 0 {
                    name.push(((h * 16 + l) as u8) as char);
                    self.pos += 3;
                    continue;
                }
            }
            name.push(c as char);
            self.pos += 1;
        }
        Opd::Name(name)
    }

    fn read_literal(&mut self) -> Opd {
        let b = self.b;
        self.pos += 1;
        let mut out = Vec::new();
        let mut depth = 1;
        while self.pos < b.len() {
            let c = b[self.pos];
            self.pos += 1;
            if c == b'\\' {
                let n = b.get(self.pos).copied();
                self.pos += 1;
                match n {
                    Some(b'n') => out.push(10),
                    Some(b'r') => out.push(13),
                    Some(b't') => out.push(9),
                    Some(b'b') => out.push(8),
                    Some(b'f') => out.push(12),
                    Some(13) => {
                        if b.get(self.pos) == Some(&10) {
                            self.pos += 1;
                        }
                    }
                    Some(10) => {}
                    Some(d) if (b'0'..=b'7').contains(&d) => {
                        let mut v = (d - b'0') as u32;
                        for _ in 0..2 {
                            match b.get(self.pos) {
                                Some(&e) if (b'0'..=b'7').contains(&e) => {
                                    v = v * 8 + (e - b'0') as u32;
                                    self.pos += 1;
                                }
                                _ => break,
                            }
                        }
                        out.push((v & 0xff) as u8);
                    }
                    Some(other) => out.push(other),
                    None => {}
                }
                continue;
            }
            if c == b'(' {
                depth += 1;
            }
            if c == b')' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            out.push(c);
        }
        Opd::Str(out)
    }

    fn read_hex(&mut self) -> Opd {
        let b = self.b;
        self.pos += 1;
        let mut out = Vec::new();
        let mut hi: i32 = -1;
        while self.pos < b.len() {
            let c = b[self.pos];
            self.pos += 1;
            if c == b'>' {
                break;
            }
            let v = hex_val(c);
            if v < 0 {
                continue;
            }
            if hi < 0 {
                hi = v;
            } else {
                out.push(((hi << 4) | v) as u8);
                hi = -1;
            }
        }
        if hi >= 0 {
            out.push((hi << 4) as u8);
        }
        Opd::Str(out)
    }

    fn read_dict(&mut self) -> Opd {
        let b = self.b;
        self.pos += 2;
        let mut map = HashMap::new();
        loop {
            self.skip_ws();
            if self.pos >= b.len() {
                break;
            }
            if b[self.pos] == b'>' && b.get(self.pos + 1) == Some(&b'>') {
                self.pos += 2;
                break;
            }
            let key = match self.read() {
                None => break,
                Some(Tok::Op(Opd::Name(k))) => k,
                Some(_) => continue,
            };
            match self.read() {
                None => break,
                Some(Tok::Kw(_)) => continue,
                Some(Tok::Op(v)) => {
                    map.insert(key, v);
                }
            }
        }
        Opd::Dict(map)
    }

    fn skip_inline_image_data(&mut self, dict: &HashMap<String, Opd>) {
        let b = self.b;
        if self.pos < b.len() && is_ws(b[self.pos]) {
            self.pos += 1;
        }
        let len = dict.get("L").or_else(|| dict.get("Length"));
        if let Some(Opd::Num(l)) = len {
            if *l > 0.0 {
                let target = self.pos + *l as usize;
                if let Some(after) = find_ei(b, target) {
                    if after - target < 16 {
                        self.pos = after;
                        return;
                    }
                }
            }
        }
        self.pos = find_ei(b, self.pos).unwrap_or(b.len());
    }
}

fn find_ei(b: &[u8], from: usize) -> Option<usize> {
    let mut i = from.max(1);
    while i + 1 < b.len() {
        if b[i] == b'E' && b[i + 1] == b'I' && is_ws(b[i - 1]) && (i + 2 >= b.len() || is_ws(b[i + 2]) || is_delim(b[i + 2])) {
            return Some(i + 2);
        }
        i += 1;
    }
    None
}

fn parse_content(bytes: &[u8]) -> Vec<ContentOp> {
    let mut lx = Lexer { b: bytes, pos: 0 };
    let mut ops = Vec::new();
    let mut args: Vec<Opd> = Vec::new();
    loop {
        lx.skip_ws();
        let tok = match lx.read() {
            None => break,
            Some(t) => t,
        };
        match tok {
            Tok::Op(o) => {
                args.push(o);
                if args.len() > 64 {
                    args.remove(0);
                }
            }
            Tok::Kw(kw) => {
                if kw.is_empty() {
                    continue;
                }
                if kw == "BI" {
                    let mut dict = HashMap::new();
                    loop {
                        let k = match lx.read() {
                            None => break,
                            Some(Tok::Kw(k)) => {
                                if k == "ID" {
                                    break;
                                }
                                continue;
                            }
                            Some(Tok::Op(Opd::Name(n))) => n,
                            Some(_) => continue,
                        };
                        match lx.read() {
                            None => break,
                            Some(Tok::Kw(v)) => {
                                if v == "ID" {
                                    break;
                                }
                                continue;
                            }
                            Some(Tok::Op(v)) => {
                                dict.insert(k, v);
                            }
                        }
                    }
                    lx.skip_inline_image_data(&dict);
                    ops.push(ContentOp { op: "BI".into(), args: vec![Opd::Dict(dict)] });
                } else {
                    ops.push(ContentOp { op: kw, args: std::mem::take(&mut args) });
                }
                args = Vec::new();
            }
        }
    }
    ops
}

// ------------------------------------------------------------------ CMap

#[derive(Clone, Copy)]
struct Codespace {
    bytes: usize,
    low: u64,
    high: u64,
}
#[derive(Default)]
struct CMap {
    codespaces: Vec<Codespace>,
    unicode: HashMap<u64, String>,
    cids: HashMap<u64, u64>,
    cid_ranges: Vec<(u64, u64, u64)>,
    vertical: bool,
    use_cmap: Option<String>,
}
enum CTok {
    Hex(Vec<u8>),
    Num(f64),
    Word(String),
    Open,
    Close,
}

fn cmap_tokenize(text: &[char]) -> Vec<CTok> {
    let mut out = Vec::new();
    let n = text.len();
    let mut i = 0;
    let is_space = |c: char| c.is_whitespace() || c == '\u{feff}' || c == '\u{a0}';
    while i < n {
        let c = text[i];
        if c == '%' {
            while i < n && text[i] != '\n' && text[i] != '\r' {
                i += 1;
            }
        } else if c == '<' {
            if text.get(i + 1) == Some(&'<') {
                i += 2;
                continue;
            }
            let end = text[i..].iter().position(|&x| x == '>').map(|p| p + i);
            let stop = end.unwrap_or(n);
            let hex: String = text[i + 1..stop].iter().filter(|c| c.is_ascii_hexdigit()).collect();
            let mut bytes = Vec::new();
            let hb = hex.as_bytes();
            let mut j = 0;
            while j < hb.len() {
                let hi = hex_val(hb[j]);
                let lo = if j + 1 < hb.len() { hex_val(hb[j + 1]) } else { 0 };
                bytes.push((hi * 16 + lo) as u8);
                j += 2;
            }
            out.push(CTok::Hex(bytes));
            i = match end {
                Some(e) => e + 1,
                None => n,
            };
        } else if c == '>' {
            i += 1;
        } else if c == '[' {
            out.push(CTok::Open);
            i += 1;
        } else if c == ']' {
            out.push(CTok::Close);
            i += 1;
        } else if c == '(' {
            let mut depth = 1;
            i += 1;
            while i < n && depth > 0 {
                if text[i] == '\\' {
                    i += 1;
                } else if text[i] == '(' {
                    depth += 1;
                } else if text[i] == ')' {
                    depth -= 1;
                }
                i += 1;
            }
        } else if is_space(c) {
            i += 1;
        } else {
            let mut j = i;
            while j < n && !(is_space(text[j]) || matches!(text[j], '<' | '>' | '[' | ']' | '(' | ')' | '%')) {
                j += 1;
            }
            let word: String = text[i..j].iter().collect();
            let starts_num = word.chars().next().map_or(false, |f| f.is_ascii_digit() || matches!(f, '+' | '-' | '.'));
            let num = if starts_num && word.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.' | b'e' | b'E')) { word.parse::<f64>().ok().filter(|v| v.is_finite()) } else { None };
            out.push(match num {
                Some(v) => CTok::Num(v),
                None => CTok::Word(word),
            });
            i = if j == i { i + 1 } else { j };
        }
    }
    out
}

fn to_int(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |acc, &x| acc.wrapping_mul(256).wrapping_add(x as u64))
}
fn utf16be_to_string(b: &[u8]) -> String {
    if b.len() == 1 {
        return String::from_utf16_lossy(&[b[0] as u16]);
    }
    let mut u = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        u.push(((b[i] as u16) << 8) | b[i + 1] as u16);
        i += 2;
    }
    String::from_utf16_lossy(&u)
}
fn increment_unicode(b: &[u8], delta: u64) -> Vec<u8> {
    let mut out = b.to_vec();
    let mut carry = delta;
    let mut i = out.len() as isize - 1;
    while i >= 0 && carry > 0 {
        let v = out[i as usize] as u64 + carry;
        out[i as usize] = (v & 0xff) as u8;
        carry = v >> 8;
        i -= 1;
    }
    out
}

fn parse_cmap(text: &str) -> CMap {
    let chars: Vec<char> = text.chars().collect();
    let toks = cmap_tokenize(&chars);
    let mut cm = CMap::default();
    let mut i = 0;
    while i < toks.len() {
        if let CTok::Word(w) = &toks[i] {
            match w.as_str() {
                "begincodespacerange" => {
                    i += 1;
                    while i + 1 < toks.len() {
                        if let (CTok::Hex(lo), CTok::Hex(hi)) = (&toks[i], &toks[i + 1]) {
                            cm.codespaces.push(Codespace { bytes: lo.len(), low: to_int(lo), high: to_int(hi) });
                            i += 2;
                        } else {
                            break;
                        }
                    }
                    i = i.wrapping_sub(1);
                }
                "beginbfchar" => {
                    i += 1;
                    while i + 1 < toks.len() {
                        if let CTok::Hex(src) = &toks[i] {
                            match &toks[i + 1] {
                                CTok::Hex(dst) => {
                                    cm.unicode.insert(to_int(src), utf16be_to_string(dst));
                                }
                                CTok::Word(d) if d.starts_with('/') => {
                                    cm.unicode.insert(to_int(src), d[1..].to_string());
                                }
                                _ => {}
                            }
                            i += 2;
                        } else {
                            break;
                        }
                    }
                    i = i.wrapping_sub(1);
                }
                "beginbfrange" => {
                    i += 1;
                    while i + 2 < toks.len() {
                        if let (CTok::Hex(lo), CTok::Hex(hi)) = (&toks[i], &toks[i + 1]) {
                            let (lo, hi) = (to_int(lo), to_int(hi));
                            match &toks[i + 2] {
                                CTok::Hex(dst) => {
                                    let mut code = lo;
                                    while code <= hi && code - lo < 65536 {
                                        cm.unicode.insert(code, utf16be_to_string(&increment_unicode(dst, code - lo)));
                                        code += 1;
                                    }
                                    i += 3;
                                }
                                CTok::Open => {
                                    let mut j = i + 3;
                                    let mut code = lo;
                                    while j < toks.len() && !matches!(toks[j], CTok::Close) {
                                        if let CTok::Hex(d) = &toks[j] {
                                            if code <= hi {
                                                cm.unicode.insert(code, utf16be_to_string(d));
                                            }
                                        }
                                        code += 1;
                                        j += 1;
                                    }
                                    i = j + 1;
                                }
                                _ => i += 3,
                            }
                        } else {
                            break;
                        }
                    }
                    i = i.wrapping_sub(1);
                }
                "begincidchar" => {
                    i += 1;
                    while i + 1 < toks.len() {
                        if let (CTok::Hex(s), CTok::Num(c)) = (&toks[i], &toks[i + 1]) {
                            cm.cids.insert(to_int(s), *c as u64);
                            i += 2;
                        } else {
                            break;
                        }
                    }
                    i = i.wrapping_sub(1);
                }
                "begincidrange" => {
                    i += 1;
                    while i + 2 < toks.len() {
                        if let (CTok::Hex(lo), CTok::Hex(hi), CTok::Num(c)) = (&toks[i], &toks[i + 1], &toks[i + 2]) {
                            cm.cid_ranges.push((to_int(lo), to_int(hi), *c as u64));
                            i += 3;
                        } else {
                            break;
                        }
                    }
                    i = i.wrapping_sub(1);
                }
                "/WMode" => {
                    if let Some(CTok::Num(v)) = toks.get(i + 1) {
                        cm.vertical = *v == 1.0;
                    }
                }
                "usecmap" => {
                    if i > 0 {
                        if let CTok::Word(p) = &toks[i - 1] {
                            if p.starts_with('/') {
                                cm.use_cmap = Some(p[1..].to_string());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        i = i.wrapping_add(1);
    }
    cm
}

fn lookup_cid(cm: &CMap, code: u64) -> Option<u64> {
    if let Some(c) = cm.cids.get(&code) {
        return Some(*c);
    }
    cm.cid_ranges.iter().find(|r| code >= r.0 && code <= r.1).map(|r| r.2 + (code - r.0))
}

fn split_codes(bytes: &[u8], cs: &[Codespace], fallback: usize) -> Vec<(u64, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let mut matched = 0;
        let mut code = 0u64;
        if !cs.is_empty() {
            let mut acc = 0u64;
            let mut n = 1;
            while n <= 4 && i + n <= bytes.len() {
                acc = acc * 256 + bytes[i + n - 1] as u64;
                if cs.iter().any(|c| c.bytes == n && acc >= c.low && acc <= c.high) {
                    matched = n;
                    code = acc;
                    break;
                }
                n += 1;
            }
        }
        if matched == 0 {
            let n = fallback.min(bytes.len() - i);
            code = 0;
            for k in 0..n {
                code = code * 256 + bytes[i + k] as u64;
            }
            matched = n;
        }
        out.push((code, matched));
        i += matched.max(1);
    }
    out
}

// ------------------------------------------------------------------ PDF object helpers

struct Pdf<'a> {
    doc: &'a Document,
}

impl<'a> Pdf<'a> {
    fn res(&self, o: &'a Object) -> Option<&'a Object> {
        self.doc.dereference(o).ok().map(|x| x.1)
    }
    fn get(&self, d: &'a Dictionary, key: &str) -> Option<&'a Object> {
        d.get(key.as_bytes()).ok().and_then(|o| self.res(o))
    }
    fn name(&self, d: &'a Dictionary, key: &str) -> Option<String> {
        match self.get(d, key)? {
            Object::Name(n) => Some(latin1(n)),
            _ => None,
        }
    }
    fn num_of(o: &Object) -> Option<f64> {
        match o {
            Object::Integer(i) => Some(*i as f64),
            Object::Real(r) => Some(*r as f64),
            _ => None,
        }
    }
    fn num(&self, d: &'a Dictionary, key: &str) -> Option<f64> {
        Self::num_of(self.get(d, key)?)
    }
    fn dict_of(&self, o: &'a Object) -> Option<&'a Dictionary> {
        match o {
            Object::Dictionary(d) => Some(d),
            Object::Stream(s) => Some(&s.dict),
            _ => None,
        }
    }
    fn dict(&self, d: &'a Dictionary, key: &str) -> Option<&'a Dictionary> {
        self.dict_of(self.get(d, key)?)
    }
    fn number_array(&self, o: Option<&'a Object>) -> Option<Vec<f64>> {
        match o? {
            Object::Array(a) => Some(a.iter().map(|x| self.res(x).and_then(Self::num_of).unwrap_or(0.0)).collect()),
            _ => None,
        }
    }
    fn stream_bytes(&self, o: Option<&'a Object>) -> Option<Vec<u8>> {
        match o? {
            Object::Stream(s) => s.decompressed_content().ok(),
            _ => None,
        }
    }
    /// Page attribute with inheritance through /Parent.
    fn inherited(&self, page: &'a Dictionary, key: &str) -> Option<&'a Object> {
        let mut cur = page;
        for _ in 0..64 {
            if let Some(o) = self.get(cur, key) {
                return Some(o);
            }
            let parent = cur.get(b"Parent").ok().and_then(|p| self.res(p)).and_then(|p| self.dict_of(p));
            match parent {
                Some(p) => cur = p,
                None => return None,
            }
        }
        None
    }
}

// ------------------------------------------------------------------ page geometry

fn rect_of(pdf: &Pdf, o: Option<&Object>) -> Option<[f64; 4]> {
    match o? {
        Object::Array(a) if a.len() == 4 => {
            let v: Vec<f64> = a.iter().map(|x| pdf.res(x).and_then(Pdf::num_of).unwrap_or(0.0)).collect();
            Some([v[0], v[1], v[2], v[3]])
        }
        _ => None,
    }
}

/// `x, y, width, height` as pdf-lib's `asRectangle`
fn as_rectangle(r: [f64; 4]) -> (f64, f64, f64, f64) {
    (r[0], r[1], r[2] - r[0], r[3] - r[1])
}

fn user_to_viewer(pdf: &Pdf, page: &Dictionary) -> Result<(Matrix, f64, f64), String> {
    let mb = as_rectangle(rect_of(pdf, pdf.inherited(page, "MediaBox")).ok_or("page has no MediaBox")?);
    let media = [mb.0.min(mb.0 + mb.2), mb.1.min(mb.1 + mb.3), mb.0.max(mb.0 + mb.2), mb.1.max(mb.1 + mb.3)];
    let (x0, y0, x1, y1) = match rect_of(pdf, pdf.inherited(page, "CropBox")) {
        None => (media[0], media[1], media[2], media[3]),
        Some(c) => {
            let cb = as_rectangle(c);
            let crop = [cb.0.min(cb.0 + cb.2), cb.1.min(cb.1 + cb.3), cb.0.max(cb.0 + cb.2), cb.1.max(cb.1 + cb.3)];
            let x0 = media[0].max(crop[0]);
            let y0 = media[1].max(crop[1]);
            let x1 = media[2].min(crop[2]);
            let y1 = media[3].min(crop[3]);
            if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
                (media[0], media[1], media[2], media[3])
            } else {
                (x0, y0, x1, y1)
            }
        }
    };
    let angle = pdf.inherited(page, "Rotate").and_then(Pdf::num_of).unwrap_or(0.0);
    let r = angle % 360.0;
    let rotation = ((js_round(r / 90.0) * 90.0) % 360.0 + 360.0) % 360.0;
    let (ra, rb, rc, rd) = match rotation as i32 {
        180 => (-1.0, 0.0, 0.0, 1.0),
        90 => (0.0, 1.0, 1.0, 0.0),
        270 => (0.0, -1.0, -1.0, 0.0),
        _ => (1.0, 0.0, 0.0, -1.0),
    };
    let cx = (x1 + x0) / 2.0;
    let cy = (y1 + y0) / 2.0;
    let (off_x, off_y, width, height) = if ra == 0.0 { ((cy - y0).abs(), (cx - x0).abs(), y1 - y0, x1 - x0) } else { ((cx - x0).abs(), (cy - y0).abs(), x1 - x0, y1 - y0) };
    Ok(([ra, rb, rc, rd, off_x - ra * cx - rc * cy, off_y - rb * cx - rd * cy], width, height))
}

// ------------------------------------------------------------------ font model

fn glyph_name_to_unicode(name: &str) -> Option<String> {
    let d = data();
    if let Some(&cp) = d.glyph_unicode.get(name) {
        return char::from_u32(cp).map(|c| c.to_string());
    }
    let base: Vec<&str> = name.split('.').next().unwrap_or("").split('_').collect();
    if base.len() > 1 {
        let parts: Vec<Option<String>> = base.iter().map(|b| glyph_name_to_unicode(b)).collect();
        if parts.iter().all(|p| p.as_deref().map_or(false, |s| !s.is_empty())) {
            return Some(parts.into_iter().map(|p| p.unwrap()).collect());
        }
    }
    let n = base[0];
    if let Some(&cp) = d.glyph_unicode.get(n) {
        return char::from_u32(cp).map(|c| c.to_string());
    }
    if let Some(rest) = n.strip_prefix("uni") {
        if !rest.is_empty() && rest.len() % 4 == 0 && rest.bytes().all(|c| c.is_ascii_hexdigit()) {
            let units: Vec<u16> = (0..rest.len()).step_by(4).map(|i| u16::from_str_radix(&rest[i..i + 4], 16).unwrap_or(0)).collect();
            return Some(String::from_utf16_lossy(&units));
        }
    }
    if let Some(rest) = n.strip_prefix('u') {
        if (4..=6).contains(&rest.len()) && rest.bytes().all(|c| c.is_ascii_hexdigit()) {
            return u32::from_str_radix(rest, 16).ok().and_then(char::from_u32).map(|c| c.to_string());
        }
    }
    if n.len() == 1 && n.as_bytes()[0].is_ascii_alphabetic() {
        return Some(n.to_string());
    }
    match n {
        "ff" | "fi" | "fl" | "ffi" | "ffl" => Some(n.to_string()),
        _ => None,
    }
}

fn base_encoding(name: Option<&str>) -> Option<&'static Vec<String>> {
    let d = data();
    match name? {
        "WinAnsiEncoding" => Some(&d.win_ansi),
        "MacRomanEncoding" => Some(&d.mac_roman),
        "StandardEncoding" | "MacExpertEncoding" => Some(&d.standard),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Family {
    Sans,
    Serif,
    Mono,
}

fn re(p: &str) -> Regex {
    regex::RegexBuilder::new(p).unicode(false).build().unwrap()
}

struct Style {
    display_name: String,
    bold: bool,
    italic: bool,
    family: Family,
}

fn strip_subset(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() > 7 && b[6] == b'+' && b[..6].iter().all(|c| c.is_ascii_uppercase()) {
        &s[7..]
    } else {
        s
    }
}

fn classify(base_font: &str, pdf: &Pdf, descriptor: Option<&Dictionary>) -> Style {
    static RES: OnceLock<[Regex; 6]> = OnceLock::new();
    let r = RES.get_or_init(|| {
        [
            re(r"bold|black|heavy|semibold|demibold|extrabold|ultrabold|-bd\b|,bold|w[6-9]\b"),
            re(r"italic|oblique|-it\b|,italic|kursiv"),
            re(r"mono|courier|consol|menlo|fixed|code|typewriter|inconsolata|lucidaconsole"),
            re(r"sans|gothic|grotesk|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|inter|lato|open"),
            re(r"times|serif|roman|georgia|garamond|cambria|minion|palatino|book|baskerville|caslon|didot|bodoni|merriweather|charter|constantia|century|goudy|mincho|song|ming"),
            re(r"^$"),
        ]
    });
    let name = strip_subset(base_font);
    let lower = name.to_lowercase();
    let n = |k: &str| descriptor.and_then(|d| pdf.num(d, k)).unwrap_or(0.0);
    let flags = n("Flags") as i64;
    let weight = n("FontWeight");
    let angle = n("ItalicAngle");
    let bold = r[0].is_match(&lower) || weight >= 600.0 || (flags & (1 << 18)) != 0;
    let italic = r[1].is_match(&lower) || angle != 0.0 || (flags & (1 << 6)) != 0;
    let mut family = Family::Sans;
    if r[2].is_match(&lower) || (flags & 1) != 0 {
        family = Family::Mono;
    } else if !r[3].is_match(&lower) && (r[4].is_match(&lower) || (flags & 2) != 0) {
        family = Family::Serif;
    }
    Style { display_name: name.to_string(), bold, italic, family }
}

fn std_alias(key: &str) -> Option<&'static str> {
    Some(match key {
        "arial" | "arialmt" | "helvetica" => "Helvetica",
        "arial-bold" | "arial-boldmt" | "helvetica-bold" => "Helvetica-Bold",
        "arial-italic" | "arial-italicmt" | "helvetica-oblique" | "helvetica-italic" => "Helvetica-Oblique",
        "arial-bolditalic" | "arial-bolditalicmt" | "helvetica-boldoblique" | "helvetica-bolditalic" => "Helvetica-BoldOblique",
        "times-roman" | "timesnewroman" | "timesnewromanps" | "timesnewromanpsmt" => "Times-Roman",
        "times-bold" | "timesnewroman-bold" | "timesnewromanps-boldmt" => "Times-Bold",
        "times-italic" | "timesnewroman-italic" | "timesnewromanps-italicmt" => "Times-Italic",
        "times-bolditalic" | "timesnewroman-bolditalic" | "timesnewromanps-bolditalicmt" => "Times-BoldItalic",
        "courier" | "couriernew" | "couriernewpsmt" => "Courier",
        "courier-bold" | "couriernew-bold" | "couriernewps-boldmt" => "Courier-Bold",
        "courier-oblique" | "courier-italic" | "couriernew-italic" => "Courier-Oblique",
        "courier-boldoblique" | "couriernew-bolditalic" => "Courier-BoldOblique",
        "symbol" => "Symbol",
        "zapfdingbats" => "ZapfDingbats",
        _ => return None,
    })
}

fn standard_metrics(base_font: &str) -> Option<&'static StdFont> {
    let key: String = strip_subset(base_font).chars().filter(|c| *c != ' ' && *c != ',').collect::<String>().to_lowercase();
    data().fonts.get(std_alias(&key)?)
}

enum Kind {
    Simple { names: Vec<Option<String>>, widths: Option<Vec<f64>>, first_char: f64, missing: f64, scale: f64, std: Option<&'static StdFont>, to_unicode: Option<CMap>, fallback_latin1: bool },
    Type0 { codespaces: Vec<Codespace>, enc: Option<CMap>, widths: HashMap<u64, f64>, dw: f64, to_unicode: Option<CMap>, code_len: usize },
}

#[allow(dead_code)] // `reliable` is used by Edit PDF's editability check, not by the PowerPoint extraction
struct FontModel {
    display_name: String,
    bold: bool,
    italic: bool,
    family: Family,
    ascent: f64,
    descent: f64,
    vertical: bool,
    reliable: bool,
    kind: Kind,
}

impl FontModel {
    /// Decoded codes with their byte length (for the "is a single-byte space" test).
    fn decode_spans(&self, bytes: &[u8]) -> Vec<(u64, usize)> {
        match &self.kind {
            Kind::Simple { .. } => bytes.iter().map(|&b| (b as u64, 1)).collect(),
            Kind::Type0 { codespaces, code_len, .. } => split_codes(bytes, codespaces, *code_len),
        }
    }
    fn width(&self, code: u64) -> f64 {
        match &self.kind {
            Kind::Simple { names, widths, first_char, missing, scale, std, .. } => {
                let c = code as f64;
                if let Some(w) = widths {
                    if c >= *first_char && c < *first_char + w.len() as f64 {
                        let v = w[(c - *first_char) as usize];
                        if v != 0.0 || std.is_none() {
                            return v * scale;
                        }
                    }
                }
                if let Some(s) = std {
                    let name = names.get(code as usize).and_then(|n| n.as_ref());
                    if let Some(w) = name.and_then(|n| s.w.get(n)) {
                        return w / 1000.0;
                    }
                }
                let m = if *missing != 0.0 { *missing } else if widths.is_some() { 0.0 } else { 500.0 };
                m * scale
            }
            Kind::Type0 { enc, widths, dw, .. } => {
                let cid = match enc {
                    Some(e) => lookup_cid(e, code).unwrap_or(code),
                    None => code,
                };
                widths.get(&cid).copied().unwrap_or(*dw) / 1000.0
            }
        }
    }
    fn unicode(&self, code: u64) -> Option<String> {
        match &self.kind {
            Kind::Simple { names, to_unicode, fallback_latin1, .. } => {
                if let Some(t) = to_unicode.as_ref().and_then(|t| t.unicode.get(&code)) {
                    return Some(t.clone());
                }
                if let Some(Some(name)) = names.get(code as usize) {
                    if let Some(u) = glyph_name_to_unicode(name) {
                        return Some(u);
                    }
                }
                if *fallback_latin1 && (32..256).contains(&code) {
                    return Some((code as u8 as char).to_string());
                }
                None
            }
            Kind::Type0 { to_unicode, .. } => to_unicode.as_ref().and_then(|t| t.unicode.get(&code).cloned()),
        }
    }
}

fn read_widths_array(pdf: &Pdf, w: Option<&Object>) -> HashMap<u64, f64> {
    let mut map = HashMap::new();
    let arr = match w {
        Some(Object::Array(a)) => a,
        _ => return map,
    };
    let item = |i: usize| arr.get(i).and_then(|o| pdf.res(o));
    let mut i = 0;
    while i < arr.len() {
        let first = match item(i).and_then(Pdf::num_of) {
            Some(f) => f,
            None => {
                i += 1;
                continue;
            }
        };
        match item(i + 1) {
            Some(Object::Array(inner)) => {
                for (k, w) in inner.iter().enumerate() {
                    if let Some(w) = pdf.res(w).and_then(Pdf::num_of) {
                        map.insert((first + k as f64) as u64, w);
                    }
                }
                i += 2;
            }
            Some(n) if Pdf::num_of(n).is_some() => {
                let last = Pdf::num_of(n).unwrap();
                let w = item(i + 2).and_then(Pdf::num_of).unwrap_or(0.0);
                let mut c = first;
                while c <= last && c - first < 65536.0 {
                    map.insert(c as u64, w);
                    c += 1.0;
                }
                i += 3;
            }
            _ => i += 1,
        }
    }
    map
}

fn parse_to_unicode(pdf: &Pdf, dict: &Dictionary) -> Option<CMap> {
    let obj = pdf.get(dict, "ToUnicode")?;
    let bytes = pdf.stream_bytes(Some(obj))?;
    Some(parse_cmap(&latin1(&bytes)))
}

fn has_font_file(pdf: &Pdf, d: Option<&Dictionary>) -> bool {
    d.map_or(false, |d| ["FontFile", "FontFile2", "FontFile3"].iter().any(|k| pdf.get(d, k).is_some()))
}

fn build_font(pdf: &Pdf, dict: &Dictionary) -> FontModel {
    let subtype = pdf.name(dict, "Subtype").unwrap_or_else(|| "Type1".into());
    let base_font = pdf.name(dict, "BaseFont").or_else(|| pdf.name(dict, "Name")).unwrap_or_else(|| "Unknown".into());
    let is_type3 = subtype == "Type3";
    let to_unicode = parse_to_unicode(pdf, dict);
    if subtype == "Type0" {
        return build_type0(pdf, dict, &base_font, to_unicode);
    }
    let descriptor = pdf.dict(dict, "FontDescriptor");
    let embedded = is_type3 || has_font_file(pdf, descriptor);
    let std = if embedded { None } else { standard_metrics(&base_font) };
    let style = classify(&base_font, pdf, descriptor);
    let dn = |k: &str| descriptor.and_then(|d| pdf.num(d, k));

    let mut names: Vec<Option<String>> = vec![None; 256];
    let enc = pdf.get(dict, "Encoding");
    let mut base_table: Option<&'static Vec<String>> = None;
    let mut differences: Option<&Vec<Object>> = None;
    match enc {
        Some(Object::Name(n)) => base_table = base_encoding(Some(&latin1(n))),
        Some(Object::Dictionary(d)) => {
            base_table = base_encoding(pdf.name(d, "BaseEncoding").as_deref());
            if let Some(Object::Array(a)) = pdf.get(d, "Differences") {
                differences = Some(a);
            }
        }
        _ => {}
    }
    let lower = base_font.to_lowercase();
    let flags = dn("Flags").unwrap_or(0.0) as i64;
    let symbolic = (flags & 4) != 0 && (flags & 32) == 0;
    if base_table.is_none() {
        let d = data();
        if lower.contains("symbol") && !embedded {
            base_table = Some(&d.symbol);
        } else if lower.contains("dingbats") && !embedded {
            base_table = Some(&d.zapf);
        } else if symbolic || is_type3 {
            base_table = None;
        } else {
            base_table = Some(if subtype == "TrueType" { &d.win_ansi } else { &d.standard });
        }
    }
    if let Some(t) = base_table {
        for c in 0..256 {
            names[c] = t.get(c).filter(|s| !s.is_empty()).cloned();
        }
    }
    if let Some(diff) = differences {
        let mut code: f64 = 0.0;
        for v in diff {
            match pdf.res(v) {
                Some(o) if Pdf::num_of(o).is_some() => code = Pdf::num_of(o).unwrap(),
                Some(Object::Name(n)) => {
                    if code >= 0.0 && code < 256.0 {
                        names[code as usize] = Some(latin1(n));
                    }
                    code += 1.0;
                }
                _ => {}
            }
        }
    }

    let first_char = pdf.num(dict, "FirstChar").unwrap_or(0.0);
    let widths = pdf.number_array(pdf.get(dict, "Widths"));
    let missing = dn("MissingWidth").unwrap_or(0.0);
    let mut font_matrix: Matrix = [0.001, 0.0, 0.0, 0.001, 0.0, 0.0];
    if is_type3 {
        if let Some(fm) = pdf.number_array(pdf.get(dict, "FontMatrix")) {
            if fm.len() == 6 {
                font_matrix = [fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]];
            }
        }
    }
    let scale = if font_matrix[0] != 0.0 { font_matrix[0] } else { 0.001 };

    let mut ascent = dn("Ascent").unwrap_or(0.0) / 1000.0;
    let mut descent = dn("Descent").unwrap_or(0.0) / 1000.0;
    if is_type3 {
        if let Some(bbox) = pdf.number_array(pdf.get(dict, "FontBBox")) {
            if bbox.len() == 4 {
                ascent = (bbox[3] * font_matrix[3]).abs();
                descent = -(bbox[1] * font_matrix[3]).abs();
            }
        }
    }
    if let Some(s) = std {
        if ascent == 0.0 {
            ascent = s.asc.filter(|v| *v != 0.0).unwrap_or(750.0) / 1000.0;
            descent = s.desc.filter(|v| *v != 0.0).unwrap_or(-250.0) / 1000.0;
        }
    }
    if !(ascent > 0.3 && ascent < 1.6) {
        ascent = 0.8;
    }
    if !(descent < 0.0 && descent > -0.8) {
        descent = -0.2;
    }

    FontModel {
        display_name: style.display_name,
        bold: style.bold,
        italic: style.italic,
        family: style.family,
        ascent,
        descent,
        vertical: false,
        reliable: true,
        kind: Kind::Simple { names, widths, first_char, missing, scale, std, to_unicode, fallback_latin1: symbolic || base_table.is_none() },
    }
}

fn build_type0(pdf: &Pdf, dict: &Dictionary, base_font: &str, to_unicode: Option<CMap>) -> FontModel {
    let cid_dict = match pdf.get(dict, "DescendantFonts") {
        Some(Object::Array(a)) => a.first().and_then(|o| pdf.res(o)).and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None }),
        _ => None,
    };
    let descriptor = cid_dict.and_then(|d| pdf.dict(d, "FontDescriptor"));
    let style = classify(base_font, pdf, descriptor);
    let mut codespaces = vec![Codespace { bytes: 2, low: 0, high: 0xffff }];
    let mut enc_cmap: Option<CMap> = None;
    let mut vertical = false;
    let mut reliable = true;
    match pdf.get(dict, "Encoding") {
        Some(Object::Name(n)) => {
            let name = latin1(n);
            vertical = name.ends_with("-V");
            if name != "Identity-H" && name != "Identity-V" {
                reliable = false;
            }
        }
        Some(o @ Object::Stream(_)) => {
            if let Some(bytes) = pdf.stream_bytes(Some(o)) {
                let cm = parse_cmap(&latin1(&bytes));
                if !cm.codespaces.is_empty() {
                    codespaces = cm.codespaces.clone();
                }
                vertical = cm.vertical;
                if let Some(u) = &cm.use_cmap {
                    if !u.starts_with("Identity") {
                        reliable = false;
                    }
                }
                enc_cmap = Some(cm);
            }
        }
        _ => {}
    }
    if vertical {
        reliable = false;
    }
    let widths = read_widths_array(pdf, cid_dict.and_then(|d| pdf.get(d, "W")));
    let dw = cid_dict.and_then(|d| pdf.num(d, "DW")).unwrap_or(1000.0);
    let code_len = codespaces.iter().map(|c| c.bytes).min().unwrap_or(2);
    let mut ascent = descriptor.and_then(|d| pdf.num(d, "Ascent")).unwrap_or(0.0) / 1000.0;
    let mut descent = descriptor.and_then(|d| pdf.num(d, "Descent")).unwrap_or(0.0) / 1000.0;
    if !(ascent > 0.3 && ascent < 1.6) {
        ascent = 0.88;
    }
    if !(descent < 0.0 && descent > -0.8) {
        descent = -0.12;
    }
    FontModel {
        display_name: style.display_name,
        bold: style.bold,
        italic: style.italic,
        family: style.family,
        ascent,
        descent,
        vertical,
        reliable,
        kind: Kind::Type0 { codespaces, enc: enc_cmap, widths, dw, to_unicode, code_len },
    }
}

// ------------------------------------------------------------------ interpreter

struct Glyph {
    text: Option<String>,
    font: usize,
    color: String,
    mode: i64,
    vx: f64,
    vy: f64,
    vdx: f64,
    vdy: f64,
    v_size: f64,
    v_width: f64,
}

#[derive(Clone)]
struct ColorState {
    space: String,
    rgb: String,
}

#[derive(Clone)]
struct GState {
    ctm: Matrix,
    fill: ColorState,
    stroke: ColorState,
    font: Option<usize>,
    font_size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    mode: f64,
}

fn hex2(v: f64) -> String {
    format!("{:02x}", js_round(v.clamp(0.0, 1.0) * 255.0) as i64)
}

fn to_rgb_hex(space: &str, c: &[f64]) -> Option<String> {
    let g = |i: usize| c.get(i).copied().unwrap_or(0.0);
    match space {
        "DeviceGray" | "CalGray" | "G" => Some(format!("#{}", hex2(g(0)).repeat(3))),
        "DeviceRGB" | "CalRGB" | "RGB" => Some(format!("#{}{}{}", hex2(g(0)), hex2(g(1)), hex2(g(2)))),
        "DeviceCMYK" | "CMYK" => {
            let (cc, m, y, k) = (g(0), g(1), g(2), g(3));
            Some(format!("#{}{}{}", hex2((1.0 - cc) * (1.0 - k)), hex2((1.0 - m) * (1.0 - k)), hex2((1.0 - y) * (1.0 - k))))
        }
        "Separation" => Some(format!("#{}", hex2(1.0 - c.first().copied().unwrap_or(1.0)).repeat(3))),
        _ => None,
    }
}

fn num(o: Option<&Opd>) -> f64 {
    match o {
        Some(Opd::Num(v)) => *v,
        _ => 0.0,
    }
}

fn nums6(args: &[Opd]) -> Matrix {
    let mut m = [0.0; 6];
    for i in 0..6 {
        m[i] = num(args.get(i));
    }
    m
}

struct Interp<'a> {
    pdf: Pdf<'a>,
    u2v: Matrix,
    glyphs: Vec<Glyph>,
    fonts: Vec<FontModel>,
    font_cache: HashMap<String, usize>,
}

impl<'a> Interp<'a> {
    fn resolve_color_space(&self, resources: Option<&'a Dictionary>, name: &str) -> (String, usize) {
        let shortcut = match name {
            "DeviceGray" | "G" => Some(("DeviceGray", 1)),
            "DeviceRGB" | "RGB" => Some(("DeviceRGB", 3)),
            "DeviceCMYK" | "CMYK" => Some(("DeviceCMYK", 4)),
            "Pattern" => Some(("Pattern", 1)),
            _ => None,
        };
        if let Some((s, n)) = shortcut {
            return (s.to_string(), n);
        }
        let cs = resources.and_then(|r| self.pdf.dict(r, "ColorSpace")).and_then(|d| self.pdf.get(d, name));
        self.describe_cs(cs, 0)
    }

    fn describe_cs(&self, obj: Option<&'a Object>, depth: usize) -> (String, usize) {
        if depth > 8 {
            return ("DeviceRGB".into(), 3);
        }
        match obj {
            Some(Object::Name(n)) => self.resolve_color_space(None, &latin1(n)),
            Some(Object::Array(a)) if !a.is_empty() => {
                let family = a.first().and_then(|o| self.pdf.res(o));
                let fam = match family {
                    Some(Object::Name(n)) => latin1(n),
                    _ => String::new(),
                };
                match fam.as_str() {
                    "ICCBased" => {
                        let n = match a.get(1).and_then(|o| self.pdf.res(o)) {
                            Some(Object::Stream(s)) => s.dict.get(b"N").ok().and_then(|o| self.pdf.res(o)).and_then(Pdf::num_of),
                            _ => None,
                        };
                        let count = n.unwrap_or(3.0) as usize;
                        (if count == 1 { "DeviceGray" } else if count == 4 { "DeviceCMYK" } else { "DeviceRGB" }.to_string(), count)
                    }
                    "CalRGB" => ("DeviceRGB".into(), 3),
                    "CalGray" => ("DeviceGray".into(), 1),
                    "Lab" => ("Lab".into(), 3),
                    "Separation" => ("Separation".into(), 1),
                    "DeviceN" => {
                        let n = match a.get(1).and_then(|o| self.pdf.res(o)) {
                            Some(Object::Array(x)) => x.len(),
                            _ => 1,
                        };
                        ("DeviceN".into(), n)
                    }
                    "Indexed" => ("Indexed".into(), 1),
                    "Pattern" => ("Pattern".into(), 1),
                    _ => self.describe_cs(family, depth + 1),
                }
            }
            _ => ("DeviceRGB".into(), 3),
        }
    }

    fn font_index(&mut self, key: String, dict: &'a Dictionary) -> usize {
        if let Some(&i) = self.font_cache.get(&key) {
            return i;
        }
        let m = build_font(&self.pdf, dict);
        self.fonts.push(m);
        let i = self.fonts.len() - 1;
        self.font_cache.insert(key, i);
        i
    }

    fn load_font(&mut self, resources: Option<&'a Dictionary>, name: &str) -> Option<usize> {
        let fonts = self.pdf.dict(resources?, "Font")?;
        let raw = fonts.get(name.as_bytes()).ok()?;
        let resolved = self.pdf.res(raw)?;
        let d = match resolved {
            Object::Dictionary(d) => d,
            _ => return None,
        };
        let key = match raw {
            Object::Reference(id) => format!("{}_{}", id.0, id.1),
            _ => format!("direct:{name}:{:p}", d),
        };
        Some(self.font_index(key, d))
    }

    fn run(&mut self, ops: &[ContentOp], resources: Option<&'a Dictionary>, initial: GState, depth: usize, visiting: &mut HashSet<ObjectId>) {
        let mut gs = initial;
        let mut stack: Vec<GState> = Vec::new();
        let mut tm = IDENTITY;
        let mut tlm = IDENTITY;
        for ContentOp { op, args } in ops {
            match op.as_str() {
                "q" => stack.push(gs.clone()),
                "Q" => {
                    if let Some(s) = stack.pop() {
                        gs = s;
                    }
                }
                "cm" => {
                    if args.len() >= 6 {
                        gs.ctm = multiply(&nums6(args), &gs.ctm);
                    }
                }
                "BT" => {
                    tm = IDENTITY;
                    tlm = IDENTITY;
                }
                "ET" => {}
                "Tf" => {
                    if let Some(Opd::Name(n)) = args.first() {
                        gs.font = self.load_font(resources, n);
                    }
                    gs.font_size = num(args.get(1));
                }
                "Tc" => gs.tc = num(args.first()),
                "Tw" => gs.tw = num(args.first()),
                "Tz" => gs.th = num(args.first()) / 100.0,
                "TL" => gs.tl = num(args.first()),
                "Ts" => gs.rise = num(args.first()),
                "Tr" => gs.mode = num(args.first()),
                "Td" => {
                    tlm = multiply(&[1.0, 0.0, 0.0, 1.0, num(args.first()), num(args.get(1))], &tlm);
                    tm = tlm;
                }
                "TD" => {
                    gs.tl = -num(args.get(1));
                    tlm = multiply(&[1.0, 0.0, 0.0, 1.0, num(args.first()), num(args.get(1))], &tlm);
                    tm = tlm;
                }
                "Tm" => {
                    if args.len() >= 6 {
                        tlm = nums6(args);
                        tm = tlm;
                    }
                }
                "T*" => {
                    tlm = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl], &tlm);
                    tm = tlm;
                }
                "Tj" | "'" | "\"" | "TJ" => {
                    if op == "'" {
                        tlm = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl], &tlm);
                        tm = tlm;
                    }
                    if op == "\"" {
                        gs.tw = num(args.first());
                        gs.tc = num(args.get(1));
                        tlm = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl], &tlm);
                        tm = tlm;
                    }
                    match (op.as_str(), args.last()) {
                        ("TJ", Some(Opd::Arr(items))) => {
                            for item in items {
                                match item {
                                    Opd::Str(b) => self.show_string(&gs, &mut tm, b),
                                    Opd::Num(v) => {
                                        let shift = (-v / 1000.0) * gs.font_size;
                                        let vertical = gs.font.map_or(false, |f| self.fonts[f].vertical);
                                        tm = if vertical { multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, shift], &tm) } else { multiply(&[1.0, 0.0, 0.0, 1.0, shift * gs.th, 0.0], &tm) };
                                    }
                                    _ => {}
                                }
                            }
                        }
                        ("TJ", _) => {}
                        (_, Some(Opd::Str(b))) => self.show_string(&gs, &mut tm, b),
                        _ => {}
                    }
                }
                "gs" => {
                    if let Some(Opd::Name(n)) = args.first() {
                        let ext = resources.and_then(|r| self.pdf.dict(r, "ExtGState")).and_then(|d| self.pdf.dict(d, n));
                        if let Some(Object::Array(fe)) = ext.and_then(|e| self.pdf.get(e, "Font")) {
                            if fe.len() >= 2 {
                                let raw = &fe[0];
                                if let Some(Object::Dictionary(fd)) = self.pdf.res(raw) {
                                    let key = match raw {
                                        Object::Reference(id) => format!("{}_{}", id.0, id.1),
                                        _ => format!("gsfont:{:p}", fd),
                                    };
                                    gs.font = Some(self.font_index(key, fd));
                                    if let Some(sz) = self.pdf.res(&fe[1]).and_then(Pdf::num_of) {
                                        gs.font_size = sz;
                                    }
                                }
                            }
                        }
                    }
                }
                "g" => gs.fill = ColorState { space: "DeviceGray".into(), rgb: to_rgb_hex("DeviceGray", &[num(args.first())]).unwrap() },
                "G" => gs.stroke = ColorState { space: "DeviceGray".into(), rgb: to_rgb_hex("DeviceGray", &[num(args.first())]).unwrap() },
                "rg" => gs.fill = ColorState { space: "DeviceRGB".into(), rgb: to_rgb_hex("DeviceRGB", &args.iter().map(|a| num(Some(a))).collect::<Vec<_>>()).unwrap() },
                "RG" => gs.stroke = ColorState { space: "DeviceRGB".into(), rgb: to_rgb_hex("DeviceRGB", &args.iter().map(|a| num(Some(a))).collect::<Vec<_>>()).unwrap() },
                "k" => gs.fill = ColorState { space: "DeviceCMYK".into(), rgb: to_rgb_hex("DeviceCMYK", &args.iter().map(|a| num(Some(a))).collect::<Vec<_>>()).unwrap() },
                "K" => gs.stroke = ColorState { space: "DeviceCMYK".into(), rgb: to_rgb_hex("DeviceCMYK", &args.iter().map(|a| num(Some(a))).collect::<Vec<_>>()).unwrap() },
                "cs" | "CS" => {
                    if let Some(Opd::Name(n)) = args.first() {
                        let (space, _) = self.resolve_color_space(resources, n);
                        let initial: &[f64] = match space.as_str() {
                            "DeviceCMYK" => &[0.0, 0.0, 0.0, 1.0],
                            "Separation" => &[1.0],
                            _ => &[0.0, 0.0, 0.0],
                        };
                        let rgb = to_rgb_hex(&space, initial).unwrap_or_else(|| "#000000".into());
                        let state = ColorState { space, rgb };
                        if op == "cs" {
                            gs.fill = state;
                        } else {
                            gs.stroke = state;
                        }
                    }
                }
                "sc" | "scn" | "SC" | "SCN" => {
                    let fill = op == "sc" || op == "scn";
                    let target = if fill { &gs.fill } else { &gs.stroke };
                    let comps: Vec<f64> = args.iter().filter_map(|a| if let Opd::Num(v) = a { Some(*v) } else { None }).collect();
                    let rgb = to_rgb_hex(&target.space, &comps).unwrap_or_else(|| target.rgb.clone());
                    let next = ColorState { space: target.space.clone(), rgb };
                    if fill {
                        gs.fill = next;
                    } else {
                        gs.stroke = next;
                    }
                }
                "Do" => {
                    let name = match args.first() {
                        Some(Opd::Name(n)) => n,
                        _ => continue,
                    };
                    let xobjects = match resources.and_then(|r| self.pdf.dict(r, "XObject")) {
                        Some(x) => x,
                        None => continue,
                    };
                    let raw = match xobjects.get(name.as_bytes()) {
                        Ok(r) => r,
                        Err(_) => continue,
                    };
                    let xo = match self.pdf.res(raw) {
                        Some(Object::Stream(s)) => s,
                        _ => continue,
                    };
                    let subtype = self.pdf.name(&xo.dict, "Subtype");
                    if subtype.as_deref() == Some("Form") && depth < 12 {
                        let id = match raw {
                            Object::Reference(id) => *id,
                            _ => (0, 0),
                        };
                        if id != (0, 0) && visiting.contains(&id) {
                            continue;
                        }
                        let bytes = match xo.decompressed_content() {
                            Ok(b) => b,
                            Err(_) => continue,
                        };
                        let matrix = self.pdf.number_array(self.pdf.get(&xo.dict, "Matrix"));
                        let form_res = self.pdf.dict(&xo.dict, "Resources").or(resources);
                        let child_ops = parse_content(&bytes);
                        let mut child = gs.clone();
                        if let Some(m) = matrix {
                            if m.len() == 6 {
                                child.ctm = multiply(&[m[0], m[1], m[2], m[3], m[4], m[5]], &gs.ctm);
                            }
                        }
                        if id != (0, 0) {
                            visiting.insert(id);
                        }
                        self.run(&child_ops, form_res, child, depth + 1, visiting);
                        if id != (0, 0) {
                            visiting.remove(&id);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn show_string(&mut self, gs: &GState, tm: &mut Matrix, bytes: &[u8]) {
        let fi = match gs.font {
            Some(f) => f,
            None => return,
        };
        let fs = gs.font_size;
        let spans = self.fonts[fi].decode_spans(bytes);
        for (code, len) in spans {
            let font = &self.fonts[fi];
            let w0 = font.width(code);
            let is_space = len == 1 && code == 32;
            let adv_text = w0 * fs + gs.tc + if is_space { gs.tw } else { 0.0 };
            let trm = multiply(&multiply(&[fs * gs.th, 0.0, 0.0, fs, 0.0, gs.rise], tm), &gs.ctm);
            let (ox, oy) = apply(&trm, 0.0, 0.0);
            let (ex, ey) = apply(&trm, w0, 0.0);
            let (vx, vy) = apply(&self.u2v, ox, oy);
            let (vex, vey) = apply(&self.u2v, ex, ey);
            let (tx0, ty0) = apply_vector(&trm, 1.0, 0.0);
            let (mut dx, mut dy) = apply_vector(&self.u2v, tx0, ty0);
            let dir_len = {
                let l = dx.hypot(dy);
                if l == 0.0 { 1.0 } else { l }
            };
            dx /= dir_len;
            dy /= dir_len;
            let (ux, uy) = apply_vector(&trm, 0.0, 1.0);
            let (upx, upy) = apply_vector(&self.u2v, ux, uy);
            let text = font.unicode(code);
            let vertical = font.vertical;
            self.glyphs.push(Glyph {
                text,
                font: fi,
                color: if gs.mode == 1.0 { gs.stroke.rgb.clone() } else { gs.fill.rgb.clone() },
                mode: gs.mode as i64,
                vx,
                vy,
                vdx: dx,
                vdy: dy,
                v_size: upx.hypot(upy),
                v_width: (vex - vx).hypot(vey - vy),
            });
            *tm = if vertical { multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -adv_text], tm) } else { multiply(&[1.0, 0.0, 0.0, 1.0, adv_text * gs.th, 0.0], tm) };
        }
    }
}

struct PageModel {
    glyphs: Vec<Glyph>,
    fonts: Vec<FontModel>,
}

fn contents_bytes(pdf: &Pdf, page: &Dictionary) -> Vec<u8> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    match pdf.get(page, "Contents") {
        Some(o @ Object::Stream(_)) => {
            if let Some(b) = pdf.stream_bytes(Some(o)) {
                parts.push(b);
            }
        }
        Some(Object::Array(a)) => {
            for x in a {
                if let Some(b) = pdf.stream_bytes(pdf.res(x)) {
                    parts.push(b);
                }
            }
        }
        _ => {}
    }
    let mut out = Vec::new();
    for p in parts {
        out.extend_from_slice(&p);
        out.push(10);
    }
    out
}

fn interpret_page(doc: &Document, page: &Dictionary) -> Result<(PageModel, f64, f64), String> {
    let pdf = Pdf { doc };
    let (u2v, vw, vh) = user_to_viewer(&pdf, page)?;
    let resources = match pdf.inherited(page, "Resources") {
        Some(Object::Dictionary(d)) => Some(d),
        _ => None,
    };
    let bytes = contents_bytes(&pdf, page);
    let ops = parse_content(&bytes);
    let black = ColorState { space: "DeviceGray".into(), rgb: "#000000".into() };
    let initial = GState { ctm: IDENTITY, fill: black.clone(), stroke: black, font: None, font_size: 0.0, tc: 0.0, tw: 0.0, th: 1.0, tl: 0.0, rise: 0.0, mode: 0.0 };
    let mut it = Interp { pdf, u2v, glyphs: Vec::new(), fonts: Vec::new(), font_cache: HashMap::new() };
    it.run(&ops, resources, initial, 0, &mut HashSet::new());
    Ok((PageModel { glyphs: it.glyphs, fonts: it.fonts }, vw, vh))
}

// ------------------------------------------------------------------ layout

#[derive(Clone)]
struct Chunk {
    glyphs: Vec<usize>,
    angle_key: i64,
    dx: f64,
    dy: f64,
    x0: f64,
    x1: f64,
    perp: f64,
    size: f64,
    dup_of: Option<usize>,
}

#[derive(Clone)]
struct RawLine {
    chunks: Vec<usize>,
    angle_key: i64,
    dx: f64,
    dy: f64,
    x0: f64,
    x1: f64,
    perp: f64,
    size: f64,
}

#[derive(Clone)]
struct SLine {
    raw: RawLine,
    text: String,
    glyph_ids: Vec<usize>,
    bold: bool,
}

fn along(g: &Glyph, dx: f64, dy: f64) -> f64 {
    g.vx * dx + g.vy * dy
}
fn perp_of(g: &Glyph, dx: f64, dy: f64) -> f64 {
    g.vx * -dy + g.vy * dx
}
fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut s = values.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    s[s.len() / 2]
}
fn dominant<K: std::hash::Hash + Eq + Clone>(items: &[K]) -> K {
    let mut counts: HashMap<K, i64> = HashMap::new();
    let mut best = items[0].clone();
    let mut best_count = -1;
    for item in items {
        let c = counts.get(item).copied().unwrap_or(0) + 1;
        counts.insert(item.clone(), c);
        if c > best_count {
            best = item.clone();
            best_count = c;
        }
    }
    best
}

fn build_chunks(glyphs: &[Glyph]) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut cur: Option<usize> = None;
    for (gi, g) in glyphs.iter().enumerate() {
        if g.mode == 3 || g.mode == 7 || !(g.v_size > 0.5) || !(g.v_size < 2000.0) {
            continue;
        }
        let angle = g.vdy.atan2(g.vdx);
        let angle_key = js_round(angle * 180.0 / std::f64::consts::PI) as i64;
        if let Some(ci) = cur {
            let c = &mut chunks[ci];
            if c.angle_key == angle_key {
                let size = c.size.max(g.v_size);
                let a = along(g, c.dx, c.dy);
                let p = perp_of(g, c.dx, c.dy);
                let gap = a - c.x1;
                if (p - c.perp).abs() < size * 0.3 && gap > -size * 0.6 && gap < size * 1.0 {
                    c.glyphs.push(gi);
                    c.x1 = c.x1.max(a + g.v_width);
                    c.x0 = c.x0.min(a);
                    c.size = size;
                    continue;
                }
            }
        }
        let rad = angle_key as f64 * std::f64::consts::PI / 180.0;
        let dx = rad.cos();
        let dy = rad.sin();
        let a = along(g, dx, dy);
        chunks.push(Chunk { glyphs: vec![gi], angle_key, dx, dy, x0: a, x1: a + g.v_width, perp: perp_of(g, dx, dy), size: g.v_size, dup_of: None });
        cur = Some(chunks.len() - 1);
    }
    chunks
}

fn chunk_text(c: &Chunk, glyphs: &[Glyph]) -> String {
    c.glyphs.iter().map(|&g| glyphs[g].text.clone().unwrap_or_default()).collect()
}

fn build_lines(chunks: &mut Vec<Chunk>, glyphs: &[Glyph]) -> Vec<RawLine> {
    let mut by_angle: Vec<(i64, Vec<usize>)> = Vec::new();
    for (i, c) in chunks.iter().enumerate() {
        match by_angle.iter_mut().find(|(k, _)| *k == c.angle_key) {
            Some((_, l)) => l.push(i),
            None => by_angle.push((c.angle_key, vec![i])),
        }
    }
    let mut lines: Vec<RawLine> = Vec::new();
    for (_, mut list) in by_angle {
        list.sort_by(|&a, &b| chunks[a].perp.partial_cmp(&chunks[b].perp).unwrap_or(std::cmp::Ordering::Equal));
        let mut bands: Vec<Vec<usize>> = Vec::new();
        for &c in &list {
            if let Some(band) = bands.last_mut() {
                let r = band[0];
                if (chunks[c].perp - chunks[r].perp).abs() < chunks[c].size.max(chunks[r].size) * 0.35 {
                    band.push(c);
                    continue;
                }
            }
            bands.push(vec![c]);
        }
        for mut band in bands {
            band.sort_by(|&a, &b| chunks[a].x0.partial_cmp(&chunks[b].x0).unwrap_or(std::cmp::Ordering::Equal));
            let mut line: Option<usize> = None; // index into `lines`
            for c in band {
                if let Some(li) = line {
                    let size = lines[li].size.max(chunks[c].size);
                    let overlap = lines[li].x1.min(chunks[c].x1) - chunks[c].x0.max(lines[li].x0);
                    let ctext = chunk_text(&chunks[c], glyphs);
                    let dup_target = lines[li].chunks.iter().copied().find(|&o| chunks[o].dup_of.is_none() && (chunks[o].x0 - chunks[c].x0).abs() < size * 0.3 && chunk_text(&chunks[o], glyphs) == ctext);
                    if let (Some(t), true) = (dup_target, overlap > 0.0) {
                        chunks[c].dup_of = Some(t);
                        lines[li].chunks.push(c);
                        continue;
                    }
                    if chunks[c].x0 - lines[li].x1 < size * 1.0 {
                        lines[li].chunks.push(c);
                        lines[li].x1 = lines[li].x1.max(chunks[c].x1);
                        lines[li].size = size;
                        continue;
                    }
                }
                let ch = &chunks[c];
                lines.push(RawLine { chunks: vec![c], angle_key: ch.angle_key, dx: ch.dx, dy: ch.dy, x0: ch.x0, x1: ch.x1, perp: ch.perp, size: ch.size });
                line = Some(lines.len() - 1);
            }
        }
    }
    lines
}

fn line_text(line: &RawLine, chunks: &[Chunk], glyphs: &[Glyph]) -> (String, Vec<usize>) {
    let mut text = String::new();
    let mut ids = Vec::new();
    let mut prev_end: Option<f64> = None;
    let mut prev_glyph: Option<usize> = None;
    for &c in &line.chunks {
        ids.extend_from_slice(&chunks[c].glyphs);
    }
    for &c in line.chunks.iter().filter(|&&c| chunks[c].dup_of.is_none()) {
        for &gi in &chunks[c].glyphs {
            let g = &glyphs[gi];
            let a = along(g, line.dx, line.dy);
            if let (Some(pe), Some(pg)) = (prev_end, prev_glyph) {
                let gap = a - pe;
                if gap > line.size * 0.17 && !is_space(&g.text) && !is_space(&glyphs[pg].text) && !text.ends_with(' ') {
                    text.push(' ');
                }
            }
            let t = g.text.clone().unwrap_or_else(|| "\u{fffd}".into());
            if t == " " || t == "\t" {
                text.push(' ');
            } else {
                text.push_str(&t);
            }
            prev_end = Some(prev_end.map_or(a + g.v_width, |p| p.max(a + g.v_width)));
            prev_glyph = Some(gi);
        }
    }
    (js_trim(&collapse_ws(&text)).to_string(), ids)
}

struct Block {
    text: String,
    lines: Vec<(String, bool)>, // text, hard_break
    bx: f64,
    by: f64,
    bw: f64,
    bh: f64,
    font_size: f64,
    color: String,
    bold: bool,
    italic: bool,
    family: Family,
    align: &'static str,
    line_height: f64,
    angle: i64,
    font_name: String,
}

struct Acc {
    lines: Vec<usize>, // indices into sorted
    x0: f64,
    x1: f64,
    spacing: Option<f64>,
}

fn ord_by(d: f64) -> Option<std::cmp::Ordering> {
    if d.is_nan() || d == 0.0 {
        None
    } else if d < 0.0 {
        Some(std::cmp::Ordering::Less)
    } else {
        Some(std::cmp::Ordering::Greater)
    }
}

fn build_blocks(model: &PageModel) -> Vec<Block> {
    let glyphs = &model.glyphs;
    let mut chunks = build_chunks(glyphs);
    let raw_lines: Vec<RawLine> = build_lines(&mut chunks, glyphs).into_iter().filter(|l| l.chunks.iter().any(|&c| chunks[c].glyphs.iter().any(|&g| !is_space(&glyphs[g].text)))).collect();

    let mut sorted: Vec<SLine> = raw_lines
        .into_iter()
        .map(|l| {
            let (text, glyph_ids) = line_text(&l, &chunks, glyphs);
            let fonts: Vec<usize> = glyph_ids.iter().map(|&i| glyphs[i].font).collect();
            let bold = model.fonts[dominant(&fonts)].bold;
            SLine { raw: l, text, glyph_ids, bold }
        })
        .collect();
    sorted.sort_by(|a, b| {
        ord_by((a.raw.angle_key - b.raw.angle_key) as f64)
            .or_else(|| ord_by(a.raw.perp - b.raw.perp))
            .or_else(|| ord_by(a.raw.x0 - b.raw.x0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut blocks: Vec<Acc> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    for li in 0..sorted.len() {
        let line = &sorted[li];
        let mut best: Option<usize> = None;
        let mut best_dy = f64::INFINITY;
        open.retain(|&bi| {
            let last = &sorted[*blocks[bi].lines.last().unwrap()];
            last.raw.angle_key == line.raw.angle_key && line.raw.perp - last.raw.perp <= last.raw.size.max(line.raw.size) * 2.0
        });
        for oi in (0..open.len()).rev() {
            let bi = open[oi];
            let block = &blocks[bi];
            let last_idx = *block.lines.last().unwrap();
            let last = &sorted[last_idx];
            if last.raw.angle_key != line.raw.angle_key {
                continue;
            }
            let s = last.raw.size.max(line.raw.size);
            let dy = line.raw.perp - last.raw.perp;
            if dy < s * 0.55 || dy > s * 1.75 {
                continue;
            }
            let ratio = line.raw.size / last.raw.size;
            if ratio < 0.83 || ratio > 1.2 {
                continue;
            }
            if line.bold != last.bold {
                continue;
            }
            if let Some(sp) = block.spacing {
                if (dy - sp).abs() > sp * 0.25 {
                    continue;
                }
            }
            let overlap = line.raw.x1.min(block.x1) - line.raw.x0.max(block.x0);
            if overlap <= 0.0 {
                continue;
            }
            let left_ok = (line.raw.x0 - block.x0).abs() < s * if block.lines.len() == 1 { 3.0 } else { 1.5 };
            let right_ok = (line.raw.x1 - block.x1).abs() < s * 1.5;
            let center_ok = ((line.raw.x0 + line.raw.x1) / 2.0 - (block.x0 + block.x1) / 2.0).abs() < s * 1.5;
            let inside = line.raw.x0 >= block.x0 - s && line.raw.x1 <= block.x1 + s;
            if !(left_ok || right_ok || center_ok || inside) {
                continue;
            }
            let mut blocked = false;
            let mut k = last_idx + 1;
            while k < li && !blocked {
                let o = &sorted[k];
                blocked = o.raw.perp > last.raw.perp + s * 0.2 && o.raw.perp < line.raw.perp - s * 0.2 && o.raw.x1.min(line.raw.x1) - o.raw.x0.max(line.raw.x0) > 0.0;
                k += 1;
            }
            if blocked {
                continue;
            }
            if dy < best_dy {
                best = Some(bi);
                best_dy = dy;
            }
        }
        if let Some(bi) = best {
            let prev_perp = sorted[*blocks[bi].lines.last().unwrap()].raw.perp;
            let b = &mut blocks[bi];
            if b.spacing.is_none() {
                b.spacing = Some(line.raw.perp - prev_perp);
            }
            b.lines.push(li);
            b.x0 = b.x0.min(line.raw.x0);
            b.x1 = b.x1.max(line.raw.x1);
        } else {
            blocks.push(Acc { lines: vec![li], x0: line.raw.x0, x1: line.raw.x1, spacing: None });
            open.push(blocks.len() - 1);
        }
    }
    blocks.iter().map(|acc| finalize_block(acc, &sorted, glyphs, model)).collect()
}

fn finalize_block(acc: &Acc, sorted: &[SLine], glyphs: &[Glyph], model: &PageModel) -> Block {
    let lines_in: Vec<&SLine> = acc.lines.iter().map(|&i| &sorted[i]).collect();
    let first = lines_in[0];
    let (dx, dy) = (first.raw.dx, first.raw.dy);
    let all_ids: Vec<usize> = lines_in.iter().flat_map(|l| l.glyph_ids.iter().copied()).collect();
    let text_glyphs: Vec<&Glyph> = all_ids.iter().map(|&i| &glyphs[i]).filter(|g| !is_space(&g.text)).collect();
    let font_idx = dominant(&text_glyphs.iter().map(|g| g.font).collect::<Vec<_>>());
    let font = &model.fonts[font_idx];
    let color = dominant(&text_glyphs.iter().map(|g| g.color.clone()).collect::<Vec<_>>());
    let med = median(&text_glyphs.iter().map(|g| g.v_size).collect::<Vec<_>>());
    let size = if med != 0.0 { med } else { first.raw.size };
    let block_width = acc.x1 - acc.x0;
    let medw = median(&text_glyphs.iter().map(|g| g.v_width).collect::<Vec<_>>());
    let avg_char_width = if medw != 0.0 { medw } else { size * 0.5 };

    let mut lines: Vec<(String, bool, f64, f64, f64, f64)> = Vec::new(); // text, hard, x0, x1, perp, size
    for (i, l) in lines_in.iter().enumerate() {
        let mut hard = true;
        if let Some(next) = lines_in.get(i + 1) {
            let first_word = next.text.split(' ').next().unwrap_or("");
            let next_word_width = utf16_len(first_word) as f64 * avg_char_width;
            hard = l.raw.x1 - acc.x0 + size * 0.3 + next_word_width <= block_width * 1.02;
        }
        lines.push((l.text.clone(), hard, l.raw.x0, l.raw.x1, l.raw.perp, l.raw.size));
    }

    let mut text = String::new();
    let (hyphen, lower_start) = (&late().0, &late().1);
    for i in 0..lines.len() {
        text.push_str(&lines[i].0);
        if i == lines.len() - 1 {
            break;
        }
        if lines[i].1 {
            text.push('\n');
        } else if hyphen.is_match(&lines[i].0) && lower_start.is_match(&lines[i + 1].0) {
            text.pop();
        } else {
            text.push(' ');
        }
    }

    let mut align = "left";
    if lines.len() > 1 {
        let spread = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - v.iter().cloned().fold(f64::INFINITY, f64::min) };
        let tol = size * 0.5;
        let lefts: Vec<f64> = lines[1..].iter().map(|l| l.2).collect();
        let rights: Vec<f64> = lines[..lines.len() - 1].iter().map(|l| l.3).collect();
        let centers: Vec<f64> = lines.iter().map(|l| (l.2 + l.3) / 2.0).collect();
        let left_aligned = spread(&lefts) < tol;
        let right_aligned = spread(&rights) < tol && rights.len() >= 2;
        if left_aligned && right_aligned && lines.iter().any(|l| !l.1) {
            align = "justify";
        } else if left_aligned && (lines[0].2 - lefts[0]).abs() < size * 3.0 {
            align = "left";
        } else if spread(&centers) < tol {
            align = "center";
        } else if spread(&lines.iter().map(|l| l.3).collect::<Vec<_>>()) < tol {
            align = "right";
        }
    }

    let line_height = acc.spacing.unwrap_or(size * 1.2);
    let (ascent, descent) = (font.ascent, font.descent);
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for l in &lines {
        for a in [l.2, l.3] {
            for p in [l.4 - ascent * l.5, l.4 - descent * l.5] {
                xs.push(a * dx - p * dy);
                ys.push(a * dy + p * dx);
            }
        }
    }
    let minx = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let maxx = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let miny = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let maxy = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    Block {
        text,
        lines: lines.iter().map(|l| (l.0.clone(), l.1)).collect(),
        bx: minx,
        by: miny,
        bw: maxx - minx,
        bh: maxy - miny,
        font_size: size,
        color,
        bold: font.bold,
        italic: font.italic,
        family: font.family,
        align,
        line_height,
        angle: js_round(dy.atan2(dx) * 180.0 / std::f64::consts::PI) as i64,
        font_name: font.display_name.clone(),
    }
}

/// Regexes used per block, compiled once.
fn late() -> &'static (Regex, Regex, Regex, Regex, Regex) {
    static R: OnceLock<(Regex, Regex, Regex, Regex, Regex)> = OnceLock::new();
    R.get_or_init(|| (re(r"[A-Za-z]-$"), re(r"^[a-z]"), re(r"(MT|PS|Std|Pro)$"), re(r"([a-z])([A-Z])"), re(r"^[A-Za-z ]{3,40}$")))
}

fn family_face(font_name: &str, family: Family) -> String {
    let first = font_name.split(|c| c == '-' || c == ',' || c == '+').next().unwrap_or("");
    let l = late();
    let stripped = l.2.replace(first, "").to_string();
    let spaced = l.3.replace_all(&stripped, "$1 $2").to_string();
    let base = js_trim(&spaced).to_string();
    if l.4.is_match(&base) {
        return base;
    }
    match family {
        Family::Serif => "Times New Roman",
        Family::Mono => "Courier New",
        Family::Sans => "Arial",
    }
    .to_string()
}

/// Per page, the paragraphs as PowerPoint text boxes (same fields as `PptTextBox` in src/types/worker.ts).
pub fn ppt_text_boxes(input: &Path, progress: &mut dyn FnMut(u8, &str)) -> Result<Value, String> {
    let doc = Document::load(input).map_err(|e| format!("Couldn't read the PDF: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted PDF".into());
    }
    let pages = doc.get_pages();
    let total = pages.len();
    let mut out = Vec::new();
    for (i, (_, id)) in pages.iter().enumerate() {
        progress(((i * 90) / total.max(1)) as u8, &format!("Separating text from page {}...", i + 1));
        let page = doc.get_dictionary(*id).map_err(|e| e.to_string())?;
        let (model, _, _) = interpret_page(&doc, page)?;
        let boxes: Vec<Value> = build_blocks(&model)
            .iter()
            .filter(|b| !js_trim(&b.text).is_empty())
            .map(|b| {
                let mut v = json!({
                    "x": b.bx, "y": b.by, "width": b.bw, "height": b.bh,
                    "lines": b.lines.iter().map(|l| l.0.clone()).collect::<Vec<_>>(),
                    "fontSize": b.font_size, "color": b.color, "bold": b.bold, "italic": b.italic,
                    "fontFace": family_face(&b.font_name, b.family),
                    "align": if b.align == "justify" { "left" } else { b.align },
                    "rotate": b.angle,
                });
                if b.lines.len() > 1 {
                    v["lineHeight"] = json!(b.line_height);
                }
                v
            })
            .collect();
        out.push(json!({ "boxes": boxes }));
    }
    Ok(Value::Array(out))
}
