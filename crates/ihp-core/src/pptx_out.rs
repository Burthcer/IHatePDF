//! PDF to PowerPoint, the writing half: slides (one full-slide JPEG + text boxes) as a .pptx package.
//! Mirrors `features/pdfToPpt/buildPptx.worker.ts` (pptxgenjs) value for value: EMU rounding, text box
//! geometry (w = width*1.08+4 pt, h = max(height, size*1.2)), half-point font sizes, line spacing, rotation.
//! The slide images come from PDFium at 1600 px wide (JPEG quality 0.88), like the page-side `renderSlides`.

use crate::compress::{Error, Result};
use serde_json::Value;
use std::io::Write;
use std::path::Path;

const EMU: f64 = 914_400.0;
const PT_TO_IN: f64 = 1.0 / 72.0;
const SLIDE_PX: u32 = 1600;
const JPEG_QUALITY: f64 = 0.88;

pub struct TextBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub lines: Vec<String>,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub font_face: String,
    pub align: String,
    pub line_height: f64,
    pub rotate: f64,
}

pub struct Slide {
    pub jpeg: Vec<u8>,
    pub width_pt: f64,
    pub height_pt: f64,
    pub boxes: Vec<TextBox>,
}

impl TextBox {
    /// One `PptTextBox` (src/types/worker.ts) as JSON.
    pub fn from_json(v: &Value) -> TextBox {
        let f = |k: &str| v[k].as_f64().unwrap_or(0.0);
        TextBox {
            x: f("x"),
            y: f("y"),
            width: f("width"),
            height: f("height"),
            lines: v["lines"].as_array().map(|a| a.iter().map(|l| l.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default(),
            font_size: f("fontSize"),
            color: v["color"].as_str().unwrap_or("#000000").to_string(),
            bold: v["bold"].as_bool().unwrap_or(false),
            italic: v["italic"].as_bool().unwrap_or(false),
            font_face: v["fontFace"].as_str().unwrap_or("Arial").to_string(),
            align: v["align"].as_str().unwrap_or("left").to_string(),
            line_height: f("lineHeight"),
            rotate: f("rotate"),
        }
    }
}

/// JS `Math.round`.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// pptxgenjs `inch2Emu` of a length in points.
fn emu(pt: f64) -> i64 {
    js_round(EMU * (pt * PT_TO_IN))
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => o.push(c),
        }
    }
    o
}

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
const DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn text_shape(b: &TextBox, id: usize, n: usize) -> String {
    let size = (b.font_size * 2.0).round().max(2.0) / 2.0; // Math.max(1, Math.round(size*2)/2)
    let sz = js_round(size * 100.0);
    let color: String = b.color.replace('#', "").to_uppercase();
    let face = esc(&b.font_face);
    let algn = match b.align.as_str() {
        "center" => "ctr",
        "right" => "r",
        "justify" => "just",
        _ => "l",
    };
    let w = (b.width * 1.08 + 4.0) * PT_TO_IN;
    let h = b.height.max(b.font_size * 1.2) * PT_TO_IN;
    let rot = if b.rotate != 0.0 { format!(" rot=\"{}\"", js_round((if b.rotate > 360.0 { b.rotate - 360.0 } else { b.rotate }) * 60000.0)) } else { String::new() };
    let lnspc = if b.line_height != 0.0 { format!("<a:lnSpc><a:spcPts val=\"{}\"/></a:lnSpc>", js_round((b.line_height * 10.0).round() / 10.0 * 100.0)) } else { String::new() };
    let mut paras = String::new();
    // pptxgenjs: a line containing a newline becomes several paragraphs.
    for line in b.lines.iter().flat_map(|l| l.split('\n')) {
        paras.push_str(&format!("<a:p><a:pPr algn=\"{algn}\" indent=\"0\" marL=\"0\">{lnspc}<a:buNone/></a:pPr>"));
        if !line.is_empty() {
            paras.push_str(&format!(
                "<a:r><a:rPr lang=\"en-US\" sz=\"{sz}\"{}{} dirty=\"0\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:latin typeface=\"{face}\" pitchFamily=\"34\" charset=\"0\"/><a:ea typeface=\"{face}\" pitchFamily=\"34\" charset=\"-122\"/><a:cs typeface=\"{face}\" pitchFamily=\"34\" charset=\"-120\"/></a:rPr><a:t>{}</a:t></a:r>",
                if b.bold { " b=\"1\"" } else { "" },
                if b.italic { " i=\"1\"" } else { "" },
                esc(line)
            ));
        }
        paras.push_str(&format!("<a:endParaRPr lang=\"en-US\" sz=\"{sz}\" dirty=\"0\"/></a:p>"));
    }
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Text {n}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm{rot}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap=\"square\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" rtlCol=\"0\" anchor=\"t\"><a:noAutofit/></a:bodyPr><a:lstStyle/>{paras}</p:txBody></p:sp>",
        emu(b.x),
        emu(b.y),
        js_round(EMU * w),
        js_round(EMU * h),
    )
}

fn slide_xml(s: &Slide, idx: usize) -> String {
    let mut shapes = String::new();
    for (i, b) in s.boxes.iter().enumerate() {
        shapes.push_str(&text_shape(b, 3 + i, i));
    }
    format!(
        "{DECL}\n<p:sld {NS}><p:cSld name=\"Slide {}\"><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id=\"2\" name=\"Image 0\" descr=\"Page {}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"rId1\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        idx + 1,
        idx + 1,
        emu(s.width_pt),
        emu(s.height_pt),
    )
}

/// UTC "2026-11-12T03:04:31Z" from the system clock (no chrono dependency).
fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Writes the package. All slides share the first slide's size (the TypeScript layout does too).
pub fn write_pptx(slides: &[Slide], out: &Path) -> Result<()> {
    if slides.is_empty() {
        return Err(Error::Msg("No rendered pages provided to build a presentation from.".into()));
    }
    let io = |e: std::io::Error| Error::Msg(e.to_string());
    let ze = |e: zip::result::ZipError| Error::Msg(e.to_string());
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(std::fs::File::create(out).map_err(io)?));
    let deflate = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut put = |name: &str, data: &[u8], o: zip::write::SimpleFileOptions| -> Result<()> {
        zip.start_file(name, o).map_err(ze)?;
        zip.write_all(data).map_err(io)
    };
    let n = slides.len();

    let mut ct = format!("{DECL}\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/ppt/presProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presProps+xml\"/><Override PartName=\"/ppt/viewProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml\"/><Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>");
    for i in 1..=n {
        ct.push_str(&format!("<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"));
    }
    ct.push_str("</Types>");
    put("[Content_Types].xml", ct.as_bytes(), deflate)?;

    put("_rels/.rels", format!("{DECL}\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"ppt/presentation.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>").as_bytes(), deflate)?;

    let now = now_iso();
    put("docProps/core.xml", format!("{DECL}\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>Presentation</dc:title><dc:creator>IHatePDF</dc:creator><cp:lastModifiedBy>IHatePDF</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified></cp:coreProperties>").as_bytes(), deflate)?;
    put("docProps/app.xml", format!("{DECL}\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><TotalTime>0</TotalTime><Words>0</Words><Application>IHatePDF</Application><PresentationFormat>Custom</PresentationFormat><Slides>{n}</Slides><AppVersion>16.0000</AppVersion></Properties>").as_bytes(), deflate)?;

    // presentation.xml: rId1 master, rId2.. slides, then presProps, viewProps, theme, tableStyles.
    let mut ids = String::new();
    let mut rels = format!("<Relationship Id=\"rId1\" Type=\"{REL}/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>");
    for i in 1..=n {
        ids.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 255 + i, 1 + i));
        rels.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{REL}/slide\" Target=\"slides/slide{i}.xml\"/>", 1 + i));
    }
    for (k, (t, f)) in [("presProps", "presProps.xml"), ("viewProps", "viewProps.xml"), ("theme", "theme/theme1.xml"), ("tableStyles", "tableStyles.xml")].iter().enumerate() {
        rels.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{REL}/{t}\" Target=\"{f}\"/>", n + 2 + k));
    }
    put("ppt/_rels/presentation.xml.rels", format!("{DECL}\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{rels}</Relationships>").as_bytes(), deflate)?;
    put(
        "ppt/presentation.xml",
        format!(
            "{DECL}\n<p:presentation {NS} saveSubsetFonts=\"1\" autoCompressPictures=\"0\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"{}\" cy=\"{}\"/><p:notesSz cx=\"{}\" cy=\"{}\"/>{}</p:presentation>",
            emu(slides[0].width_pt),
            emu(slides[0].height_pt),
            emu(slides[0].height_pt),
            emu(slides[0].width_pt),
            include_str!("pptx_tpl/defaultTextStyle.xml")
        )
        .as_bytes(),
        deflate,
    )?;
    put("ppt/presProps.xml", include_bytes!("pptx_tpl/presProps.xml"), deflate)?;
    put("ppt/viewProps.xml", include_bytes!("pptx_tpl/viewProps.xml"), deflate)?;
    put("ppt/tableStyles.xml", include_bytes!("pptx_tpl/tableStyles.xml"), deflate)?;
    put("ppt/theme/theme1.xml", include_bytes!("pptx_tpl/theme1.xml"), deflate)?;
    put("ppt/slideMasters/slideMaster1.xml", include_bytes!("pptx_tpl/slideMaster1.xml"), deflate)?;
    put("ppt/slideMasters/_rels/slideMaster1.xml.rels", include_bytes!("pptx_tpl/slideMaster1.xml.rels"), deflate)?;
    put("ppt/slideLayouts/slideLayout1.xml", include_bytes!("pptx_tpl/slideLayout1.xml"), deflate)?;
    put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", include_bytes!("pptx_tpl/slideLayout1.xml.rels"), deflate)?;

    for (i, s) in slides.iter().enumerate() {
        let k = i + 1;
        put(&format!("ppt/slides/slide{k}.xml"), slide_xml(s, i).as_bytes(), deflate)?;
        put(&format!("ppt/slides/_rels/slide{k}.xml.rels"), format!("{DECL}\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/image\" Target=\"../media/image-{k}-1.jpeg\"/><Relationship Id=\"rId2\" Type=\"{REL}/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/></Relationships>").as_bytes(), deflate)?;
        put(&format!("ppt/media/image-{k}-1.jpeg"), &s.jpeg, stored)?;
    }
    zip.finish().map_err(ze)?;
    Ok(())
}

/// Renders every page of `input` (PDFium, 1600 px wide JPEG) and writes the deck with `boxes[i]` on slide i
/// (`boxes` is the JSON array of arrays of `PptTextBox`, or null for pictures only). Returns the slide count.
pub fn build_from_pdf(dll: &Path, input: &Path, boxes: &Value, out: &Path, progress: &mut dyn FnMut(u32, &str)) -> Result<usize> {
    let (total, infos) = crate::render::page_infos(dll, input, 0, usize::MAX / 2)?;
    if total == 0 {
        return Err(Error::Msg("No rendered pages provided to build a presentation from.".into()));
    }
    let mut slides = Vec::with_capacity(total);
    for (i, info) in infos.iter().enumerate() {
        progress(5 + (i * 85 / total) as u32, &format!("Rendering slide {} of {}...", i + 1, total));
        let jpeg = crate::render::thumbnail(dll, input, i, SLIDE_PX, JPEG_QUALITY)?;
        let page_boxes = boxes.get(i).and_then(|b| b.as_array()).map(|a| a.iter().map(TextBox::from_json).collect()).unwrap_or_default();
        slides.push(Slide { jpeg, width_pt: info[0] as f64, height_pt: info[1] as f64, boxes: page_boxes });
    }
    progress(92, "Packing .pptx archive...");
    write_pptx(&slides, out)?;
    crate::render::forget(input);
    Ok(total)
}
