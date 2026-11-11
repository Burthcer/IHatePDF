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
            other => Err(format!("Unknown tool {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "path": output, "size": size, "pages": r.0, "fileName": r.1 }))
}
