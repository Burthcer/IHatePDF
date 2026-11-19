//! ihp-stamp <pagenumbers|watermark|sign> in.pdf out.pdf payload.json [image]
use ihp_core::stamp;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let payload: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&a[4]).unwrap()).unwrap();
    let img = a.get(5).map(|p| (std::fs::read(p).unwrap(), p.to_lowercase().ends_with(".png")));
    let mut prog = |_: u32, _: &str| {};
    let dir = std::env::var("IHP_FONTS").ok();
    let from = dir.as_ref().map(|d| ihp_core::fonts::from_dir(std::path::Path::new(d)));
    let fonts: Option<ihp_core::fonts::FontSource> = from.as_ref().map(|f| f as ihp_core::fonts::FontSource);
    let (i, o) = (std::path::Path::new(&a[2]), std::path::Path::new(&a[3]));
    let r = match a[1].as_str() {
        "pagenumbers" => stamp::page_numbers(i, o, &payload, fonts, &mut prog),
        "watermark" => stamp::watermark(i, o, &payload, img.as_ref().map(|(b, p)| (b.as_slice(), *p)), fonts, &mut prog),
        "sign" => stamp::sign(i, o, &img.unwrap().0, &payload["placements"], &mut prog),
        _ => panic!("op"),
    };
    match r { Ok(n) => println!("ok {n}"), Err(e) => { eprintln!("error: {e}"); std::process::exit(if matches!(e, ihp_core::compress::Error::NeedsUnicodeFont) { 3 } else { 1 }) } }
}
