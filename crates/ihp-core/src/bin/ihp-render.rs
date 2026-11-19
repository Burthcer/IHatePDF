//! ihp-render pdfium.dll in.pdf out dpi jpg|png quality 1,2,3
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let pages: Vec<usize> = a[7].split(',').map(|x| x.parse().unwrap()).collect();
    let t = std::time::Instant::now();
    match ihp_core::render::render_pages(a[1].as_ref(), a[2].as_ref(), &pages, a[4].parse().unwrap(), a[5] == "png", a[6].parse().unwrap(), "doc", a[3].as_ref(), &mut |_, _| {}) {
        Ok(n) => println!("ok {n} pages in {} ms", t.elapsed().as_millis()),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
