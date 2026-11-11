// IHatePDF desktop shell (Tauri): serves dist/, owns the work folder, saving, and memory info.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native;
mod output;

use std::path::PathBuf;
use tauri::{Emitter, Manager, WebviewWindowBuilder};

pub fn save_dir(app: &tauri::AppHandle) -> PathBuf {
    let base = app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("IHatePDF");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
fn show_in_folder(app: tauri::AppHandle, file: String) {
    let p = PathBuf::from(&file);
    if p.starts_with(save_dir(&app)) {
        let _ = std::process::Command::new("explorer").arg(format!("/select,{}", file)).spawn();
    }
}

#[tauri::command]
fn mem_info() -> serde_json::Value {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    const MB: u64 = 1024 * 1024;
    let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()));
    let total = sys.total_memory();
    let gb = 1024 * MB;
    let budget = (total / 2).min(total.saturating_sub(3 * gb)).min(16 * gb).max(gb);
    serde_json::json!({
        "level": "normal", "usedMB": 0, "budgetMB": budget / MB,
        "totalMB": total / MB, "availableMB": sys.available_memory() / MB
    })
}

// Usage log / memory watchdog commands: ported next; no-ops keep the page working meanwhile.
#[tauri::command]
fn noop() {}
#[tauri::command]
fn log_info() -> serde_json::Value {
    serde_json::json!({ "enabled": false, "dir": null })
}
#[tauri::command]
fn log_set(_on: bool) -> bool {
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(output::Outputs::default())
        .invoke_handler(tauri::generate_handler![
            show_in_folder,
            noop,
            log_info,
            log_set,
            mem_info,
            output::out_create,
            output::out_write,
            output::out_close,
            output::out_save,
            output::out_discard,
            output::out_read,
            native::compress_pdf,
            native::run_tool,
            native::render_pdf,
            native::pdf_info,
            native::render_thumb
        ])
        .setup(|app| {
            output::clean_work_dir();
            let handle = app.handle().clone();
            let cfg = app.config().app.windows[0].clone();
            let win = WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                .on_download(move |_wv, event| {
                    use tauri::webview::DownloadEvent::*;
                    match event {
                        Requested { url, destination } => {
                            let fallback = url.path_segments().and_then(|s| s.last()).unwrap_or("document").to_string();
                            let name = destination.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(fallback);
                            *destination = output::unique_path(&save_dir(&handle), &name);
                            true
                        }
                        Finished { path, success, .. } => {
                            if let (true, Some(p)) = (success, path) {
                                let _ = handle.emit(
                                    "ihp:saved",
                                    serde_json::json!({ "name": p.file_name().map(|n| n.to_string_lossy().to_string()), "path": p }),
                                );
                            }
                            true
                        }
                        _ => true,
                    }
                })
                .build()?;
            win.show()?;
            Ok(())
        })
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { .. } = e {
                output::clean_work_dir();
                w.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("IHatePDF failed to start");
}
