//! Test CLI for the page tools.
//!   ihp-pages merge out.pdf a.pdf b.pdf ...
//!   ihp-pages extract in.pdf out.pdf 3,1,-1,2:90      (0-based pages, -1 = blank, :deg = rotate)
//!   ihp-pages splitzip in.pdf out.zip base 0-1,2,3-5
//!   ihp-pages rotate in.pdf out.pdf GLOBAL [idx:deg,...]
//!   ihp-pages crop in.pdf out.pdf top right bottom left [idx,...]
use ihp_core::pages::*;
use std::path::Path;
fn p(s: &str) -> &Path { Path::new(s) }
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut prog = |_: u32, _: &str| {};
    let r = match a.get(1).map(String::as_str) {
        Some("merge") => { let ins: Vec<&Path> = a[3..].iter().map(|s| p(s)).collect(); merge(&ins, p(&a[2]), &mut prog) }
        Some("extract") => {
            let specs: Vec<PageSpec> = a[4].split(',').map(|t| { let (i, d) = t.split_once(':').unwrap_or((t, "0")); let i: i64 = i.parse().unwrap(); PageSpec { index: (i >= 0).then(|| i as usize), rotate: d.parse().unwrap() } }).collect();
            organize(p(&a[2]), p(&a[3]), &specs, &mut prog)
        }
        Some("splitzip") => {
            let groups: Vec<Vec<usize>> = a[5].split(',').map(|g| match g.split_once('-') { Some((x, y)) => (x.parse().unwrap()..=y.parse().unwrap()).collect(), None => vec![g.parse().unwrap()] }).collect();
            split_zip(p(&a[2]), p(&a[3]), &a[4], &groups, &mut prog)
        }
        Some("rotate") => {
            let per: Vec<(usize, i32)> = a.get(5).map(|s| s.split(',').filter(|x| !x.is_empty()).map(|t| { let (i, d) = t.split_once(':').unwrap(); (i.parse().unwrap(), d.parse().unwrap()) }).collect()).unwrap_or_default();
            rotate(p(&a[2]), p(&a[3]), &per, a[4].parse().unwrap(), &mut prog)
        }
        Some("crop") => {
            let idx: Option<Vec<usize>> = a.get(8).map(|s| s.split(',').map(|x| x.parse().unwrap()).collect());
            crop(p(&a[2]), p(&a[3]), a[4].parse().unwrap(), a[5].parse().unwrap(), a[6].parse().unwrap(), a[7].parse().unwrap(), idx.as_deref(), &mut prog)
        }
        _ => { eprintln!("see source header"); std::process::exit(2) }
    };
    match r { Ok(n) => println!("ok {n} pages"), Err(e) => { eprintln!("error: {e}"); std::process::exit(1) } }
}
