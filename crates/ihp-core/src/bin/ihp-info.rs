//! ihp-info pdfium.dll in.pdf  : time to read every page size, one thumbnail, and a Rust merge-free open
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let t = std::time::Instant::now();
    let (total, infos) = ihp_core::render::page_infos(a[1].as_ref(), a[2].as_ref(), 0, 64).unwrap();
    println!("first 64 of {} pages in {} ms", total, t.elapsed().as_millis());
    let infos = vec![[0f32; 3]; total.max(infos.len())];
    let t = std::time::Instant::now();
    let jpg = ihp_core::render::thumbnail(a[1].as_ref(), a[2].as_ref(), infos.len() / 2, 320, 0.75).unwrap();
    println!("one thumbnail from the middle: {} bytes in {} ms", jpg.len(), t.elapsed().as_millis());
    let t = std::time::Instant::now();
    let n = ihp_core::pages::page_count(a[2].as_ref()).unwrap();
    println!("lopdf page_count: {} in {} ms", n, t.elapsed().as_millis());
}
