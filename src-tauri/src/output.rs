//! Tool output files: big results stream from the page into temp files here,
//! "Save" copies them into Downloads/IHatePDF.
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, State,
};

struct Out {
    file: File,
    path: PathBuf,
    size: u64,
}
#[derive(Default)]
pub struct Outputs(Mutex<HashMap<String, Out>>);

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("IHatePDF-work")
}
pub fn clean_work_dir() {
    let _ = std::fs::remove_dir_all(work_dir());
}
fn in_work_dir(p: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(p);
    if p.components().any(|c| c.as_os_str() == "..") || !p.starts_with(work_dir()) {
        return Err("Not an output file.".into());
    }
    Ok(p)
}

pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || (c as u32) < 32 { ' ' } else { c })
        .collect();
    let safe = safe.trim();
    let safe = if safe.is_empty() { "document" } else { safe };
    let p = Path::new(safe);
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let base = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut cand = dir.join(safe);
    let mut n = 2;
    while cand.exists() {
        cand = dir.join(format!("{base} ({n}){ext}"));
        n += 1;
    }
    cand
}

#[tauri::command]
pub fn out_create(state: State<Outputs>) -> Result<String, String> {
    std::fs::create_dir_all(work_dir()).map_err(|e| e.to_string())?;
    let handle = uuid::Uuid::new_v4().to_string();
    let path = work_dir().join(format!("{handle}.tmp"));
    let file = File::create(&path).map_err(|e| e.to_string())?;
    state.0.lock().unwrap().insert(handle.clone(), Out { file, path, size: 0 });
    Ok(handle)
}

/// Raw binary body; the handle travels in the `x-handle` header (no base64, no JSON copy).
#[tauri::command]
pub fn out_write(request: Request, state: State<Outputs>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes.".into());
    };
    let handle = request.headers().get("x-handle").and_then(|v| v.to_str().ok()).ok_or("Missing handle.")?;
    let mut map = state.0.lock().unwrap();
    let o = map.get_mut(handle).ok_or("Unknown output.")?;
    o.file.write_all(bytes).map_err(|e| e.to_string())?;
    o.size += bytes.len() as u64;
    Ok(())
}

#[tauri::command]
pub fn out_close(handle: String, discard: bool, state: State<Outputs>) -> Result<serde_json::Value, String> {
    let o = state.0.lock().unwrap().remove(&handle).ok_or("Unknown output.")?;
    drop(o.file);
    if discard {
        let _ = std::fs::remove_file(&o.path);
    }
    Ok(serde_json::json!({ "path": o.path, "size": o.size }))
}

#[tauri::command]
pub fn out_save(app: AppHandle, file: String, name: String) -> Result<PathBuf, String> {
    let src = in_work_dir(&file)?;
    let target = unique_path(&crate::save_dir(&app), &name);
    std::fs::copy(&src, &target).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "ihp:saved",
        serde_json::json!({ "name": target.file_name().map(|n| n.to_string_lossy().to_string()), "path": target }),
    );
    Ok(target)
}

#[tauri::command]
pub fn out_discard(file: String) {
    if let Ok(p) = in_work_dir(&file) {
        let _ = std::fs::remove_file(p);
    }
}

#[tauri::command]
pub fn out_read(file: String) -> Result<Response, String> {
    let p = in_work_dir(&file)?;
    Ok(Response::new(std::fs::read(p).map_err(|e| e.to_string())?))
}
