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

/// [[w, h, rotation], ...] for every page.
#[tauri::command]
pub async fn pdf_info(app: AppHandle, path: String) -> Result<Vec<[f32; 3]>, String> {
    let input = crate::output::in_work_dir(&path)?;
    let dll = pdfium_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || ihp_core::render::page_infos(&dll, &input).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
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
