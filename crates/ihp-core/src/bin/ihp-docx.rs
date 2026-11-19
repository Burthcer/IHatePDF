//! ihp-docx in.docx out.pdf   (fonts dir in IHP_FONTS for non-Western text)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = std::env::var("IHP_FONTS").ok();
    let from = dir.as_ref().map(|d| ihp_core::fonts::from_dir(std::path::Path::new(d)));
    let fonts: Option<ihp_core::fonts::FontSource> = from.as_ref().map(|f| f as ihp_core::fonts::FontSource);
    match ihp_core::docx::docx_to_pdf(a[1].as_ref(), a[2].as_ref(), fonts, &mut |_, _| {}) {
        Ok(n) => println!("ok {n}"),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
