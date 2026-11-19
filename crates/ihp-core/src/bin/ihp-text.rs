//! ihp-text pdfium.dll in.pdf : the text of every page, one page per paragraph, words separated by single spaces
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let t = ihp_core::render::page_texts(a[1].as_ref(), a[2].as_ref(), 0, 100000).unwrap();
    for (i, p) in t.iter().enumerate() {
        println!("== page {}\n{}", i + 1, p.split_whitespace().collect::<Vec<_>>().join(" "));
    }
}
