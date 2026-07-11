use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::encode_clipboard_raw_to_png;
use crate::captured_images;
use crate::fnv64;

/// Server configuration for direct HTTP posting (bypasses Tauri event system).
#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub server_url: String,
    pub device_id: String,
}

/// Signal the running monitor to exit by dropping its Shutdown handle.
static MONITOR_SHUTDOWN: Mutex<Option<clipboard_win::monitor::Shutdown>> = Mutex::new(None);

/// Request the monitor thread to stop. Safe to call even if no monitor is running.
pub fn request_stop_monitor() {
    if let Some(s) = MONITOR_SHUTDOWN.lock().unwrap().take() {
        drop(s);
    }
}

/// Check if any webview windows exist.
fn has_windows(app: &AppHandle) -> bool {
    !app.webview_windows().is_empty()
}

/// Ring buffer for recent raw-byte hashes (echo guard).
const ECHO_RING_SIZE: usize = 16;
struct EchoRing(Mutex<[u64; ECHO_RING_SIZE]>, Mutex<usize>);
impl EchoRing {
    fn new() -> Self {
        Self(Mutex::new([0u64; ECHO_RING_SIZE]), Mutex::new(0))
    }
    fn contains(&self, hash: u64) -> bool {
        let ring = self.0.lock().unwrap();
        ring.iter().any(|&h| h == hash)
    }
    fn insert(&self, hash: u64) {
        let mut ring = self.0.lock().unwrap();
        let mut idx = self.1.lock().unwrap();
        ring[*idx % ECHO_RING_SIZE] = hash;
        *idx += 1;
    }
}

/// POST clipboard image directly to the server via HTTP.
/// This bypasses Tauri's unreliable event system entirely.
/// The server broadcasts the new item via WebSocket to all online devices.
async fn post_clipboard_to_server(server_url: &str, device_id: &str, data_url: &str, raw_size: usize) {

    let url = format!("{}/api/clipboard/direct", server_url);
    let base64 = match data_url.strip_prefix("data:image/png;base64,") {
        Some(b) => b,
        None => {
            eprintln!("[ClipMon] HTTP POST: unexpected data URL format");
            return;
        }
    };

    let payload = serde_json::json!({
        "sourceDeviceId": device_id,
        "contentType": "image",
        "contentEncrypted": data_url,
        "contentPreview": format!("[Image {} bytes]", base64.len()),
        "contentSize": base64.len(),
        "metadata": { "source": "rust-monitor", "rawSize": raw_size },
    });

    match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => {
            match client.post(&url)
                .header("Content-Type", "application/json")
                .header("X-Device-ID", device_id)
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) => { let status = resp.status();
                    if status.is_success() {
                        eprintln!("[ClipMon] HTTP POST: success ({})", status);
                    } else {
                        let body = resp.text().await.unwrap_or_default();
                        eprintln!("[ClipMon] HTTP POST: failed {} - {}", status, body);
                    }
                }
                Err(e) => {
                    eprintln!("[ClipMon] HTTP POST: error - {}", e);
                }
            }
        }
        Err(e) => {
            eprintln!("[ClipMon] HTTP POST: client build error - {}", e);
        }
    }
}

/// Encode raw clipboard bytes to PNG data URL + content hash, with dedup.
/// Runs in the dedicated worker thread (off the monitor loop).
fn encode_and_emit(
    app: &AppHandle,
    raw: Vec<u8>,
    src: &'static str,
    size: usize,
    echo_ring: &EchoRing,
    server_config: Option<&ServerConfig>,
) {
    // Echo guard: skip if this exact raw-byte content was recently seen.
    let raw_hash = fnv64(&raw);
    if echo_ring.contains(raw_hash) {
        eprintln!("[ClipMon] IMAGE: echo guard skip (raw_hash={:016x})", raw_hash);
        return;
    }
    echo_ring.insert(raw_hash);

    // PNG encoding + optional 720px resize.
    match encode_clipboard_raw_to_png(&raw, src, Some(720)) {
        Some((data_url, png_content_hash)) => {
            // Cache for fallback polling.
            if let Ok(mut map) = captured_images().lock() {
                map.insert(png_content_hash, (data_url.clone(), Instant::now()));
            }

            eprintln!("[ClipMon] IMAGE: {} bytes -> {} PNG, hash={:016x}",
                size, data_url.len(), png_content_hash);

            // Primary path: POST directly to server (bypasses Tauri event system).
            if let Some(cfg) = server_config {
                let server_url = cfg.server_url.clone();
                let device_id = cfg.device_id.clone();
                let payload = data_url.clone();
                tauri::async_runtime::spawn(async move {
                    post_clipboard_to_server(&server_url, &device_id, &payload, size).await;
                });
            }

            // Secondary path: also emit via Tauri event (fallback, may not work in Tauri 2.x).
            let app_clone = app.clone();
            let event_payload = serde_json::json!({
                "contentType": "image",
                "size": size,
                "hash": png_content_hash.to_string(),
                "imageData": data_url,
                "timestamp": chrono::Utc::now().to_rfc3339(),
            });
            tauri::async_runtime::spawn(async move {
                let _ = app_clone.emit("clipboard-changed", event_payload);
            });
        }
        None => {
            eprintln!("[ClipMon] IMAGE: encode failed (size={})", size);
        }
    }
}

/// Monitors clipboard changes and emits `clipboard-changed` events.
///
/// ARCHITECTURE (2026-07-11, direct HTTP):
///
/// The monitor loop detects clipboard changes via AddClipboardFormatListener +
/// GetClipboardSequenceNumber sweep. Raw bytes are read immediately and sent to
/// a background worker thread for PNG encoding. After encoding, the worker
/// POSTs directly to the server via HTTP (bypasses Tauri event system entirely).
/// The server then broadcasts via WebSocket to all online devices.
///
/// Tauri's `app.emit()` is unreliable from background threads in Tauri 2.x,
/// so we use direct HTTP + WebSocket for 100% reliable delivery.
pub fn start_monitor(app_handle: AppHandle, stop_flag: Arc<AtomicBool>, server_config: Option<ServerConfig>) {
    eprintln!("[ClipMon] Starting clipboard monitor (direct HTTP)...");

    // Channel for passing raw clipboard bytes -> worker thread.
    let (raw_tx, raw_rx) = mpsc::sync_channel::<(Vec<u8>, &'static str, usize)>(8);

    // Create the clipboard change listener
    let mut monitor = match clipboard_win::monitor::Monitor::new() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[ClipMon] FATAL: failed to create clipboard Monitor: {:?}", e);
            stop_flag.store(false, Ordering::Relaxed);
            return;
        }
    };
    *MONITOR_SHUTDOWN.lock().unwrap() = Some(monitor.shutdown_channel());

    // --- Spawn worker thread: PNG encoding + HTTP POST ---
    let app_handle_worker = app_handle.clone();
    let echo_ring = EchoRing::new();
    let server_cfg = server_config.clone();
    thread::spawn(move || {
        eprintln!("[ClipMon] Worker thread started");
        while let Ok((raw, src, size)) = raw_rx.recv() {
            encode_and_emit(&app_handle_worker, raw, src, size, &echo_ring, server_cfg.as_ref());
        }
        eprintln!("[ClipMon] Worker thread exiting (sender dropped).");
    });

    let mut state = MonitorState::default();
    let mut last_seq: u32 = crate::get_clipboard_seq();

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            eprintln!("[ClipMon] Stop requested, exiting monitor loop.");
            break;
        }

        // Event-driven: drain WM_CLIPBOARDUPDATE messages
        while let Ok(true) = monitor.try_recv() {
            eprintln!("[ClipMon] WM_CLIPBOARDUPDATE received");
            if has_windows(&app_handle) {
                let content = read_clipboard_raw();
                handle_content(&app_handle, &mut state, content, &raw_tx);
            } else {
                eprintln!("[ClipMon] change detected but no windows, skipping");
            }
        }

        // Sequence-number sweep: the real burst catcher
        let seq = crate::get_clipboard_seq();
        if seq != last_seq {
            last_seq = seq;
            if has_windows(&app_handle) {
                eprintln!("[ClipMon] seq {} -> read+send to worker", seq);
                let content = read_clipboard_raw();
                handle_content(&app_handle, &mut state, content, &raw_tx);
            } else {
                eprintln!("[ClipMon] seq changed but no windows, skipping");
            }
        }

        std::thread::sleep(Duration::from_millis(15));
    }

    drop(raw_tx);
}

/// Per-change mutable state (debounce / dedup for text & files).
struct MonitorState {
    last_text: String,
    last_file_paths: Vec<String>,
    last_change_time: Instant,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            last_text: String::new(),
            last_file_paths: Vec::new(),
            last_change_time: Instant::now(),
        }
    }
}

/// Dispatch a single clipboard change (already read) to the appropriate handler.
fn handle_content(
    app: &AppHandle,
    state: &mut MonitorState,
    content: ClipContent,
    raw_tx: &mpsc::SyncSender<(Vec<u8>, &'static str, usize)>,
) {
    match content {
        ClipContent::Text(text) => {
            if !text.is_empty() && text != state.last_text {
                state.last_text = text.clone();
                state.last_change_time = Instant::now();
            } else if !state.last_text.is_empty() && state.last_change_time.elapsed() >= Duration::from_millis(500) {
                let content_to_sync = state.last_text.clone();
                state.last_text.clear();
                eprintln!("[ClipMon] TEXT: {} chars", content_to_sync.len());
                let _ = app.emit(
                    "clipboard-changed",
                    serde_json::json!({
                        "content": content_to_sync,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }
        }
        ClipContent::Files(paths) => {
            if !paths.is_empty() && paths != state.last_file_paths {
                eprintln!("[ClipMon] FILES: {} file(s)", paths.len());
                for p in &paths {
                    eprintln!("[ClipMon]   {}", p);
                }

                let preview = if paths.len() == 1 {
                    let name = std::path::Path::new(&paths[0])
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| paths[0].clone());
                    format!("[文件] {} (1个文件)", name)
                } else {
                    let name = std::path::Path::new(&paths[0])
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| paths[0].clone());
                    format!("[文件] {} 等 {} 个文件", name, paths.len())
                };

                let _ = app.emit(
                    "clipboard-changed",
                    serde_json::json!({
                        "content": preview,
                        "contentType": "file",
                        "filePaths": paths,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );
                state.last_file_paths = paths;
                state.last_text.clear();
                state.last_change_time = Instant::now();
            } else if paths.is_empty() && !state.last_file_paths.is_empty() {
                state.last_file_paths.clear();
                state.last_change_time = Instant::now();
            }
        }
        ClipContent::Image { raw, src, size } => {
            if let Err(e) = raw_tx.send((raw, src, size)) {
                eprintln!("[ClipMon] IMAGE: failed to send to worker: {}", e);
            }
            state.last_text.clear();
            state.last_file_paths.clear();
        }
        ClipContent::Empty => {
            if !state.last_text.is_empty() || !state.last_file_paths.is_empty() {
                state.last_text.clear();
                state.last_file_paths.clear();
                state.last_change_time = Instant::now();
            }
        }
        ClipContent::Error(e) => {
            eprintln!("[ClipMon] ERR: {}", e);
        }
    }
}

enum ClipContent {
    Text(String),
    Files(Vec<String>),
    Image { raw: Vec<u8>, src: &'static str, size: usize },
    Empty,
    Error(String),
}

fn read_clipboard_raw() -> ClipContent {
    use clipboard_win::raw;

    if let Err(e) = raw::open() {
        return ClipContent::Error(format!("open: {}", e));
    }

    let _guard = ClipGuard;

    let format_count = raw::count_formats().unwrap_or(0);
    if format_count == 0 {
        return ClipContent::Empty;
    }

    if raw::is_format_avail(15) {
        let mut files: Vec<String> = Vec::new();
        match raw::get_file_list(&mut files) {
            Ok(count) if count > 0 => return ClipContent::Files(files),
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_file_list err: {}", e),
        }
    }

    if raw::is_format_avail(8) || raw::is_format_avail(2) {
        let mut data = Vec::<u8>::new();
        match raw::get_bitmap(&mut data) {
            Ok(size) if size > 0 => return ClipContent::Image {
                size,
                raw: data,
                src: "CF_DIB/CF_BITMAP",
            },
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_bitmap err: {}", e),
        }
    }
    if raw::is_format_avail(17) {
        if let Some(sz) = raw::size(17) {
            let n = sz.get();
            if n > 0 {
                let mut buf = vec![0u8; n];
                if raw::get(17, &mut buf).unwrap_or(0) > 0 {
                    return ClipContent::Image {
                        size: buf.len(),
                        raw: buf,
                        src: "CF_DIBV5",
                    };
                }
            }
        }
    }
    if let Some(png_fmt) = raw::register_format("PNG") {
        let fmt = png_fmt.get();
        if raw::is_format_avail(fmt) {
            if let Some(sz) = raw::size(fmt) {
                let n = sz.get();
                if n > 0 {
                    let mut png = vec![0u8; n];
                    if raw::get(fmt, &mut png).unwrap_or(0) > 0 {
                        return ClipContent::Image {
                            size: png.len(),
                            raw: png,
                            src: "PNG-clipboard",
                        };
                    }
                }
            }
        }
    }

    if raw::is_format_avail(13) {
        let mut buf = Vec::<u8>::new();
        match raw::get_string(&mut buf) {
            Ok(count) if count > 0 => {
                let text = match String::from_utf8(buf.clone()) {
                    Ok(s) => s,
                    Err(_) => {
                        let mut utf16_bytes = &buf[..];
                        if utf16_bytes.len() % 2 != 0 {
                            utf16_bytes = &utf16_bytes[..utf16_bytes.len() - 1];
                        }
                        let utf16_chars: Vec<u16> = utf16_bytes
                            .chunks_exact(2)
                            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                            .collect();
                        String::from_utf16_lossy(&utf16_chars)
                    }
                };
                return ClipContent::Text(text);
            }
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_string err: {}", e),
        }
    }

    ClipContent::Empty
}

struct ClipGuard;
impl Drop for ClipGuard {
    fn drop(&mut self) {
        let _ = clipboard_win::raw::close();
    }
}
