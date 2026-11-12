//! ihp-pptx-out pdfium.dll in.pdf boxes.json out.pptx   (boxes.json: [[PptTextBox, ...], ...] per page, or null)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let boxes: serde_json::Value = std::fs::read_to_string(&a[3]).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::Value::Null);
    match ihp_core::pptx_out::build_from_pdf(a[1].as_ref(), a[2].as_ref(), &boxes, a[4].as_ref(), &mut |_, _| {}) {
        Ok(n) => println!("ok {n}"),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
