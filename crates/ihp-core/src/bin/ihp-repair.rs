//! ihp-repair pdfium.dll in.pdf out.pdf
fn main() {
    let a: Vec<String> = std::env::args().collect();
    match ihp_core::render::repair(a[1].as_ref(), a[2].as_ref(), a[3].as_ref()) {
        Ok(n) => println!("ok {n}"),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
