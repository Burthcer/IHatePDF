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
