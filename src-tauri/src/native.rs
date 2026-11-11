//! Rust-engine tool commands. Each reads/writes files in the work folder (the page streams
//! inputs there with `out_*`), reports progress with `ihp:progress` events, and returns a summary.
use ihp_core::compress::{compress, Level};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn compress_pdf(app: AppHandle, id: String, path: String, level: String, target_bytes: Option<u64>) -> Result<serde_json::Value, String> {
    let input = crate::output::in_work_dir(&path)?;
    let output = crate::output::work_dir().join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let level = match level.as_str() {
        "low" => Level::Low,
        "extreme" => Level::Extreme,
        "custom" => Level::Custom(target_bytes.ok_or("Choose a target size.")?),
        _ => Level::Recommended,
    };
    let out2 = output.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut last = 0u32;
        let mut prog = move |p: u32, stage: &str| {
            // Workers report in any order; only ever move forward.
            if p >= last {
                last = p;
                let _ = app.emit("ihp:progress", serde_json::json!({ "id": id, "progress": p, "stage": stage }));
            }
        };
        compress(&input, &out2, level, &mut prog)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "path": output, "size": r.output, "pages": r.pages, "note": r.note, "unchanged": r.unchanged,
        "skipped": r.skipped, "imagesTotal": r.images_total, "imagesRecompressed": r.images_recompressed
    }))
}

fn arr_usize(v: &serde_json::Value) -> Vec<usize> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect()).unwrap_or_default()
}

fn label(g: &[usize]) -> String {
    let (a, b) = (g[0] + 1, g[g.len() - 1] + 1);
    if a == b { format!("p{a}") } else { format!("p{a}-{b}") }
}

/// Runs a page-level tool. `inputs` are work-folder paths; the result is a new work-folder file.
/// Returns { path, size, pages, fileName? } or an error (the page then falls back to the TypeScript worker).
#[tauri::command]
pub async fn run_tool(app: AppHandle, id: String, tool: String, inputs: Vec<String>, args: serde_json::Value) -> Result<serde_json::Value, String> {
    use ihp_core::pages::{self, PageSpec};
    let ins: Vec<std::path::PathBuf> = inputs.iter().map(|p| crate::output::in_work_dir(p)).collect::<Result<_, _>>()?;
    let output = crate::output::work_dir().join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let out2 = output.clone();
    let r = tauri::async_runtime::spawn_blocking(move || -> Result<(usize, Option<String>), String> {
        let mut last = 0u32;
        let mut prog = move |p: u32, stage: &str| {
            if p >= last {
                last = p;
                let _ = app.emit("ihp:progress", serde_json::json!({ "id": id, "progress": p, "stage": stage }));
            }
        };
        let e = |e: ihp_core::compress::Error| e.to_string();
        let first = ins.first().ok_or("No input.")?;
        match tool.as_str() {
            "merge" => {
                let refs: Vec<&std::path::Path> = ins.iter().map(|p| p.as_path()).collect();
                pages::merge(&refs, &out2, &mut prog).map(|n| (n, None)).map_err(e)
            }
            "rotate" => {
                let per: Vec<(usize, i32)> = args["rotations"].as_array().map(|a| a.iter().filter_map(|x| Some((x[0].as_u64()? as usize, x[1].as_i64()? as i32))).collect()).unwrap_or_default();
                pages::rotate(first, &out2, &per, args["global"].as_i64().unwrap_or(0) as i32, &mut prog).map(|n| (n, None)).map_err(e)
            }
            "organize" => {
                let specs: Vec<PageSpec> = args["specs"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| { let i = x[0].as_i64()?; Some(PageSpec { index: (i >= 0).then_some(i as usize), rotate: x[1].as_i64().unwrap_or(0) as i32 }) }).collect())
                    .unwrap_or_default();
                pages::organize(first, &out2, &specs, &mut prog).map(|n| (n, None)).map_err(e)
            }
            "crop" => {
                let m = &args["margins"];
                let idx = args.get("pageIndices").filter(|v| v.is_array()).map(arr_usize);
                pages::crop(first, &out2, m["top"].as_f64().unwrap_or(0.0), m["right"].as_f64().unwrap_or(0.0), m["bottom"].as_f64().unwrap_or(0.0), m["left"].as_f64().unwrap_or(0.0), idx.as_deref(), &mut prog)
                    .map(|n| (n, None))
                    .map_err(e)
            }
            "split" => {
                let base = args["base"].as_str().unwrap_or("document").to_string();
                let total = pages::page_count(first).map_err(e)?;
                let groups: Option<Vec<Vec<usize>>> = if let Some(g) = args["groups"].as_array() {
                    Some(g.iter().map(arr_usize).collect())
                } else if args["all"].as_bool() == Some(true) {
                    Some((0..total).map(|i| vec![i]).collect())
                } else {
                    None
                };
                if let Some(groups) = groups {
                    let valid: Vec<Vec<usize>> = groups.iter().map(|g| g.iter().copied().filter(|&i| i < total).collect::<Vec<_>>()).filter(|g| !g.is_empty()).collect();
                    if valid.is_empty() {
                        return Err("No valid pages selected.".into());
                    }
                    if valid.len() == 1 {
                        let name = format!("{}_{}.pdf", base, label(&valid[0]));
                        return pages::split_one(first, &out2, &valid[0], &mut prog).map(|n| (n, Some(name))).map_err(e);
                    }
                    return pages::split_zip(first, &out2, &base, &valid, &mut prog).map(|n| (n, Some(format!("{base}_split.zip")))).map_err(e);
                }
                let mut idx = Vec::new();
                for r in args["ranges"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                    let from = r["from"].as_i64().unwrap_or(1).max(1) as usize - 1;
                    let to = (r["to"].as_i64().unwrap_or(0).max(1) as usize - 1).min(total.saturating_sub(1));
                    idx.extend(from..=to);
                }
                pages::split_one(first, &out2, &idx, &mut prog).map(|n| (n, Some(format!("{base}_split.pdf")))).map_err(e)
            }
            "images" => {
                use ihp_core::images::{images_to_pdf, Options, Orientation, PageSize};
                let is_png: Vec<bool> = args["png"].as_array().map(|a| a.iter().map(|v| v.as_bool().unwrap_or(false)).collect()).unwrap_or_default();
                let pairs: Vec<(&std::path::Path, bool)> = ins.iter().enumerate().map(|(i, p)| (p.as_path(), is_png.get(i).copied().unwrap_or(false))).collect();
                let opts = Options {
                    page_size: match args["pageSize"].as_str() { Some("letter") => PageSize::Letter, Some("fit") => PageSize::Fit, _ => PageSize::A4 },
                    orientation: match args["orientation"].as_str() { Some("landscape") => Orientation::Landscape, Some("portrait") => Orientation::Portrait, _ => Orientation::Auto },
                    margin_pt: args["marginPt"].as_f64().unwrap_or(0.0),
                };
                images_to_pdf(&pairs, &opts, &out2, &mut prog).map(|n| (n, None)).map_err(e)
            }
            "pagenumbers" => ihp_core::stamp::page_numbers(first, &out2, &args, &mut prog).map(|n| (n, None)).map_err(e),
            "watermark" | "sign" => {
                let img = ins.get(1).map(|p| std::fs::read(p).map_err(|x| x.to_string())).transpose()?;
                let is_png = args["imageType"].as_str().map_or(true, |t| t == "png");
                if tool == "sign" {
                    let png = img.ok_or("No signature image provided.")?;
                    ihp_core::stamp::sign(first, &out2, &png, &args["placements"], &mut prog).map(|n| (n, None)).map_err(e)
                } else {
                    ihp_core::stamp::watermark(first, &out2, &args, img.as_deref().map(|b| (b, is_png)), &mut prog).map(|n| (n, None)).map_err(e)
                }
            }
            other => Err(format!("Unknown tool {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "path": output, "size": size, "pages": r.0, "fileName": r.1 }))
}

/// Where pdfium.dll is: bundled next to the app (resources/), or in the source tree when running unbundled.
fn pdfium_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let mut candidates = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r.join("resources").join("pdfium.dll"));
        candidates.push(r.join("pdfium.dll"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("pdfium.dll"));
            candidates.push(dir.join("resources").join("pdfium.dll"));
            candidates.push(dir.join("../../resources/pdfium.dll"));
        }
    }
    candidates.into_iter().find(|p| p.exists()).ok_or_else(|| "pdfium.dll not found".to_string())
}

/// PDF to JPG/PNG with PDFium. `pages` are 1-based. Returns { path, size, pages, fileName }.
#[tauri::command]
pub async fn render_pdf(app: AppHandle, id: String, path: String, pages: Vec<usize>, dpi: f64, png: bool, quality: f64, base: String) -> Result<serde_json::Value, String> {
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    let output = crate::output::work_dir().join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let out2 = output.clone();
    let (b2, single) = (base.clone(), pages.len() == 1);
    let first = pages.first().copied().unwrap_or(1);
    let n = tauri::async_runtime::spawn_blocking(move || {
        let mut last = 0u32;
        let mut prog = move |p: u32, stage: &str| {
            if p >= last {
                last = p;
                let _ = app.emit("ihp:progress", serde_json::json!({ "id": id, "progress": p, "stage": stage }));
            }
        };
        ihp_core::render::render_pages(&dll, &input, &pages, dpi, png, quality, &b2, &out2, &mut prog).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let ext = if png { "png" } else { "jpg" };
    let name = if single || n == 1 { format!("{base}_page_{first}.{ext}") } else { format!("{base}_pages.zip") };
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "path": output, "size": size, "pages": n, "fileName": name }))
}

/// { total, pages: [[w, h, rotation], ...] } for pages start..start+count.
#[tauri::command]
pub async fn pdf_info(app: AppHandle, path: String, start: usize, count: usize) -> Result<serde_json::Value, String> {
    let t = std::time::Instant::now();
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    let r = tauri::async_runtime::spawn_blocking(move || {
        ihp_core::render::page_infos(&dll, &input, start, count).map(|(total, pages)| serde_json::json!({ "total": total, "pages": pages })).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    trace(&format!("pdf_info {start}+{count}"), t);
    r
}

/// One page as JPEG bytes (raw response, no base64).
#[tauri::command]
pub async fn render_thumb(app: AppHandle, path: String, index: usize, width: u32, quality: f64) -> Result<tauri::ipc::Response, String> {
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || ihp_core::render::thumbnail(&dll, &input, index, width, quality).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Redaction: pages with boxes become images with the boxes burned in; the rest are copied.
/// pages: [{pageIndex, widthPt, heightPt}], boxes: [{pageIndex, x, y, width, height}].
#[tauri::command]
pub async fn redact_pdf(app: AppHandle, id: String, path: String, pages: serde_json::Value, boxes: serde_json::Value, strip_metadata: bool) -> Result<serde_json::Value, String> {
    use ihp_core::pages::{redact, RedactPage};
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    let output = crate::output::work_dir().join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let out2 = output.clone();
    let pg: Vec<RedactPage> = pages.as_array().map(|a| a.iter().filter_map(|p| Some(RedactPage { index: p["pageIndex"].as_u64()? as usize, width_pt: p["widthPt"].as_f64()?, height_pt: p["heightPt"].as_f64()? })).collect()).unwrap_or_default();
    let bx: Vec<(usize, [f64; 4])> = boxes.as_array().map(|a| a.iter().filter_map(|b| Some((b["pageIndex"].as_u64()? as usize, [b["x"].as_f64()?, b["y"].as_f64()?, b["width"].as_f64()?, b["height"].as_f64()?]))).collect()).unwrap_or_default();
    let (n, total) = tauri::async_runtime::spawn_blocking(move || {
        let mut last = 0u32;
        let mut prog = move |p: u32, stage: &str| {
            if p >= last {
                last = p;
                let _ = app.emit("ihp:progress", serde_json::json!({ "id": id, "progress": p, "stage": stage }));
            }
        };
        let total = redact(&dll, &input, &out2, &pg, &bx, strip_metadata, &mut prog).map_err(|e| e.to_string())?;
        Ok::<_, String>((pg.len(), total))
    })
    .await
    .map_err(|e| e.to_string())??;
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "path": output, "size": size, "pages": total, "redacted": n }))
}

/// { pages } for a readable PDF, { password: true } when it needs one, or an error (damaged).
#[tauri::command]
pub async fn pdf_probe(app: AppHandle, path: String, password: Option<String>) -> Result<serde_json::Value, String> {
    let t = std::time::Instant::now();
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    let r = tauri::async_runtime::spawn_blocking(move || match ihp_core::render::probe(&dll, &input, password.as_deref()) {
        Ok(ihp_core::render::Probe::Pages(n)) => Ok(serde_json::json!({ "pages": n })),
        Ok(ihp_core::render::Probe::Password) => Ok(serde_json::json!({ "password": true })),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?;
    trace("pdf_probe", t);
    r
}

/// Timing trace for diagnostics: set IHP_TRACE=1 and read %TEMP%\ihp-trace.log.
pub fn trace(what: &str, since: std::time::Instant) {
    if std::env::var("IHP_TRACE").is_ok() {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("ihp-trace.log")) {
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let _ = writeln!(f, "{ms} {what} took {} ms", since.elapsed().as_millis());
        }
    }
}

/// Repair with PDFium: reads the damaged file tolerantly and writes a clean copy. { path, size, pages }.
#[tauri::command]
pub async fn repair_pdf(app: AppHandle, path: String) -> Result<serde_json::Value, String> {
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    let output = crate::output::work_dir().join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let out2 = output.clone();
    let pages = tauri::async_runtime::spawn_blocking(move || ihp_core::render::repair(&dll, &input, &out2).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "path": output, "size": size, "pages": pages }))
}

/// Text runs and picture boxes for pages start..start+count (viewer space). Errors on rotated pages.
#[tauri::command]
pub async fn pdf_runs(app: AppHandle, path: String, start: usize, count: usize) -> Result<serde_json::Value, String> {
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        ihp_core::render::page_runs(&dll, &input, start, count)
            .map(|pages| {
                serde_json::Value::Array(
                    pages
                        .into_iter()
                        .map(|p| {
                            serde_json::json!({
                                "width": p.width, "height": p.height, "images": p.images,
                                "runs": p.runs.into_iter().map(|r| serde_json::json!({
                                    "text": r.text, "x": r.x, "y": r.y, "w": r.w, "size": r.size, "bold": r.bold,
                                    "italic": r.italic, "fontName": r.font, "mono": r.mono, "serif": r.serif
                                })).collect::<Vec<_>>()
                            })
                        })
                        .collect(),
                )
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Plain text of pages start..start+count.
#[tauri::command]
pub async fn pdf_texts(app: AppHandle, path: String, start: usize, count: usize) -> Result<Vec<String>, String> {
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || ihp_core::render::page_texts(&dll, &input, start, count).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}
