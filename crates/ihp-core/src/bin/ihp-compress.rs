//! Test CLI: ihp-compress <in.pdf> <out.pdf> <low|recommended|extreme|custom:BYTES>
use ihp_core::compress::{compress, Level};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 {
        eprintln!("usage: ihp-compress in.pdf out.pdf low|recommended|extreme|custom:BYTES");
        std::process::exit(2);
    }
    let level = match a[3].as_str() {
        "low" => Level::Low,
        "extreme" => Level::Extreme,
        s if s.starts_with("custom:") => Level::Custom(s[7..].parse().expect("bytes")),
        _ => Level::Recommended,
    };
    let t = std::time::Instant::now();
    match compress(a[1].as_ref(), a[2].as_ref(), level, &mut |_, _| {}) {
        Ok(r) => println!("{} -> {} bytes ({} ms) images {}/{} skipped {} deduped {} removed {} unchanged {} | {}", r.original, r.output, t.elapsed().as_millis(), r.images_recompressed, r.images_total, r.skipped, r.deduped, r.removed, r.unchanged, r.note),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
