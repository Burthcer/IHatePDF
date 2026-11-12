//! ihp-html payload.json out.pdf [image1.png image2.png ...]   (fonts dir in IHP_FONTS for non-Western text)
//! Or: ihp-html --packed job.bin out.pdf   (the app's staged job file)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = std::env::var("IHP_FONTS").ok();
    let from = dir.as_ref().map(|d| ihp_core::fonts::from_dir(std::path::Path::new(d)));
    let fonts: Option<ihp_core::fonts::FontSource> = from.as_ref().map(|f| f as ihp_core::fonts::FontSource);
    let job = if a[1] == "--packed" {
        ihp_core::html::unpack(&std::fs::read(&a[2]).unwrap())
    } else {
        let v = serde_json::from_slice(&std::fs::read(&a[1]).unwrap()).unwrap();
        Ok((v, a[3..].iter().map(|p| std::fs::read(p).unwrap()).collect()))
    };
    let out = if a[1] == "--packed" { &a[3] } else { &a[2] };
    let r = job.and_then(|(v, imgs)| ihp_core::html::html_to_pdf(&v, &imgs, out.as_ref(), fonts, &mut |_, _| {}));
    match r {
        Ok(n) => println!("ok {n}"),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1) }
    }
}
