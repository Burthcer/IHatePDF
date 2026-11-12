//! ihp-editpdf in.pdf out.json   (PDF to PowerPoint text boxes, per page); prints "ok <pages> <ms>"
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let t = std::time::Instant::now();
    match ihp_core::editpdf::ppt_text_boxes(a[1].as_ref(), &mut |_, _| {}) {
        Ok(v) => { let ms = t.elapsed().as_secs_f64() * 1000.0; std::fs::write(&a[2], serde_json::to_vec(&v).unwrap()).unwrap(); println!("ok {} {ms:.1}", v.as_array().map_or(0, |p| p.len())) }
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
