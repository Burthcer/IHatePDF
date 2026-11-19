//! ihp-editapply in.pdf out.pdf edits.json [onlyPage]   (Edit PDF: apply page edits); prints "ok <pages> <ms>"
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let t = std::time::Instant::now();
    let edits: serde_json::Value = serde_json::from_slice(&std::fs::read(&a[3]).unwrap()).unwrap();
    let only = a.get(4).and_then(|p| p.parse::<usize>().ok());
    match ihp_core::editpdf::apply_edits(a[1].as_ref(), a[2].as_ref(), &edits, only, &mut |_, _| {}) {
        Ok(n) => println!("ok {n} {:.1}", t.elapsed().as_secs_f64() * 1000.0),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
