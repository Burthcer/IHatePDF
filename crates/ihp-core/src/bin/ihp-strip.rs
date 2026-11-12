//! ihp-strip pdfium.dll in.pdf out.pdf   (PDF to PowerPoint backgrounds: all text objects removed)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    match ihp_core::render::strip_text(a[1].as_ref(), a[2].as_ref(), a[3].as_ref()) {
        Ok(n) => println!("ok {n}"),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
