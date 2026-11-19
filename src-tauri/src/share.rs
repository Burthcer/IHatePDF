//! Share to phone, Wi-Fi mode: a small HTTP server on the local network that lists the chosen files and folders
//! (folders as .zip) behind a random token and stops by itself after a countdown. PC hotspot and Bluetooth
//! are not in this build: their bridge calls say so (see desktopBridge.ts). Architecture only, to be tested on
//! a real phone: Windows will ask once to allow the app through the firewall.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct Active {
    stop: Arc<AtomicBool>,
    expires_ms: Arc<AtomicI64>,
}
#[derive(Default)]
pub struct Share(Mutex<Option<Active>>);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Native picker through the Windows file dialog (no extra plugin).
#[tauri::command]
pub async fn share_pick(kind: String) -> Result<Vec<String>, String> {
    let script = if kind == "folder" {
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"
    } else {
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect = $true; if ($d.ShowDialog() -eq 'OK') { $d.FileNames }"
    };
    let out = tauri::async_runtime::spawn_blocking(move || std::process::Command::new("powershell").args(["-NoProfile", "-STA", "-Command", script]).output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

fn walk(p: &Path, size: &mut u64, count: &mut u64, skipped: &mut Vec<serde_json::Value>, depth: usize) {
    let Ok(rd) = std::fs::read_dir(p) else {
        skipped.push(serde_json::json!({ "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), "reason": "couldn't be read" }));
        return;
    };
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.file_type().is_symlink() {
            skipped.push(serde_json::json!({ "name": e.file_name().to_string_lossy(), "reason": "link left out" }));
        } else if md.is_dir() && depth < 32 {
            walk(&e.path(), size, count, skipped, depth + 1);
        } else if md.is_file() {
            *size += md.len();
            *count += 1;
        }
    }
}

#[tauri::command]
pub fn share_describe(paths: Vec<String>) -> Vec<serde_json::Value> {
    paths
        .iter()
        .filter_map(|p| {
            let path = Path::new(p);
            let md = std::fs::metadata(path).ok()?;
            let (mut size, mut count, mut skipped) = (md.len(), 1, Vec::new());
            if md.is_dir() {
                size = 0;
                count = 0;
                walk(path, &mut size, &mut count, &mut skipped, 0);
            }
            Some(serde_json::json!({ "path": p, "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone()), "isDir": md.is_dir(), "size": size, "count": count, "skipped": skipped }))
        })
        .collect()
}

fn lan_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?; // no packet is sent: this only picks the outgoing interface
    Some(s.local_addr().ok()?.ip().to_string())
}

fn add_dir(z: &mut zip::ZipWriter<&mut std::io::Cursor<Vec<u8>>>, root: &Path, cur: &Path, opts: zip::write::SimpleFileOptions, depth: usize) {
    let Ok(rd) = std::fs::read_dir(cur) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.file_type().is_symlink() {
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        if md.is_dir() && depth < 32 {
            add_dir(z, root, &p, opts, depth + 1);
        } else if md.is_file() {
            if let Ok(data) = std::fs::read(&p) {
                if z.start_file(rel, opts).is_ok() {
                    let _ = z.write_all(&data);
                }
            }
        }
    }
}

fn zip_dir(dir: &Path) -> Option<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        add_dir(&mut z, dir, dir, opts, 0);
        z.finish().ok()?;
    }
    Some(buf.into_inner())
}

fn pct(name: &str) -> String {
    name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) }).collect()
}

fn respond(mut s: TcpStream, status: &str, ctype: &str, body: &[u8], name: Option<&str>) {
    let disp = name.map(|n| format!("Content-Disposition: attachment; filename*=UTF-8''{}\r\n", pct(n))).unwrap_or_default();
    let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n{disp}Cache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    let _ = s.write_all(body);
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn handle(mut s: TcpStream, token: &str, items: &[(PathBuf, bool)]) {
    let mut buf = [0u8; 2048];
    let n = s.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
    let prefix = format!("/{token}/");
    let Some(rest) = path.strip_prefix(&prefix) else { return respond(s, "404 Not Found", "text/plain", b"Not found", None) };
    if rest.is_empty() {
        let mut html = String::from("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>IHatePDF</title><body style=\"font-family:sans-serif;padding:16px\"><h2>Files from your PC</h2><ul style=\"line-height:2.2\">");
        for (i, (p, is_dir)) in items.iter().enumerate() {
            let esc = file_name(p).replace('&', "&amp;").replace('<', "&lt;");
            html.push_str(&format!("<li><a href=\"f/{i}\">{esc}{}</a></li>", if *is_dir { ".zip" } else { "" }));
        }
        html.push_str("</ul></body>");
        return respond(s, "200 OK", "text/html; charset=utf-8", html.as_bytes(), None);
    }
    let idx = rest.strip_prefix("f/").and_then(|i| i.parse::<usize>().ok());
    match idx.and_then(|i| items.get(i)) {
        Some((p, true)) => match zip_dir(p) {
            Some(z) => respond(s, "200 OK", "application/zip", &z, Some(&format!("{}.zip", file_name(p)))),
            None => respond(s, "500 Internal Server Error", "text/plain", b"Couldn't make the zip", None),
        },
        Some((p, false)) => match std::fs::read(p) {
            Ok(d) => respond(s, "200 OK", "application/octet-stream", &d, Some(&file_name(p))),
            Err(_) => respond(s, "404 Not Found", "text/plain", b"Not found", None),
        },
        None => respond(s, "404 Not Found", "text/plain", b"Not found", None),
    }
}

#[tauri::command]
pub fn share_start(app: AppHandle, state: State<Share>, paths: Vec<String>, minutes: f64, mode: String) -> Result<serde_json::Value, String> {
    if mode != "wifi" {
        return Err("The PC hotspot isn't in this build yet. Use Wi-Fi sharing.".into());
    }
    share_stop(state.clone());
    let items: Vec<(PathBuf, bool)> = paths
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .map(|p| {
            let d = p.is_dir();
            (p, d)
        })
        .collect();
    if items.is_empty() {
        return Err("Nothing to share.".into());
    }
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let expires = Arc::new(AtomicI64::new(now_ms() + (minutes.max(1.0) * 60_000.0) as i64));
    let (stop2, exp2, tok2) = (stop.clone(), expires.clone(), token.clone());
    std::thread::spawn(move || {
        let reason = loop {
            if stop2.load(Ordering::Relaxed) {
                break "stopped";
            }
            if now_ms() >= exp2.load(Ordering::Relaxed) {
                break "expired";
            }
            match listener.accept() {
                Ok((s, _)) => {
                    let _ = s.set_nonblocking(false);
                    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    handle(s, &tok2, &items);
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(60)),
            }
        };
        let _ = app.emit("ihp:share-ended", reason);
    });
    let ip = lan_ip().ok_or("This PC isn't on a network.")?;
    *state.0.lock().unwrap() = Some(Active { stop, expires_ms: expires.clone() });
    Ok(serde_json::json!({ "expiresAt": expires.load(Ordering::Relaxed), "urls": [{ "name": "Wi-Fi / LAN", "url": format!("http://{ip}:{port}/{token}/") }], "wifi": null }))
}

#[tauri::command]
pub fn share_stop(state: State<Share>) {
    if let Some(a) = state.0.lock().unwrap().take() {
        a.stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn share_set_minutes(state: State<Share>, minutes: f64) -> Option<i64> {
    let g = state.0.lock().unwrap();
    let a = g.as_ref()?;
    let t = now_ms() + (minutes.max(1.0) * 60_000.0) as i64;
    a.expires_ms.store(t, Ordering::Relaxed);
    Some(t)
}
