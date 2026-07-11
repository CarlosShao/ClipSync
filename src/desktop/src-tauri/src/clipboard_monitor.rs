use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::encode_clipboard_raw_to_png;
use crate::captured_images;

/// Signal the running monitor to exit by dropping its Shutdown handle.
static MONITOR_SHUTDOWN: Mutex<Option<clipboard_win::monitor::Shutdown>> = Mutex::new(None);

/// Request the monitor thread to stop. Safe to call even if no monitor is running.
pub fn request_stop_monitor() {
    if let Some(s) = MONITOR_SHUTDOWN.lock().unwrap().take() {
        drop(s);
    }
}

/// Check if any webview windows exist. Used to avoid emitting events
/// when the frontend is not connected (e.g. during Vite hot-reload).
fn has_windows(app: &AppHandle) -> bool {
    !app.webview_windows().is_empty()
}

/// Monitors clipboard changes and emits `clipboard-changed` events.
///
/// ARCHITECTURE (2026-07-11, final):
///
/// EVENT-DRIVEN via `clipboard_win::monitor::Monitor` (AddClipboardFormatListener).
/// SEQUENCE-NUMBER SWEEP every 15ms (GetClipboardSequenceNumber) catches rapid
/// bursts that Windows coalesces into a single WM_CLIPBOARDUPDATE.
///
/// PNG encoding happens INLINE in the monitor loop (not in a worker thread).
/// The loop only sleeps 15ms between sweeps, so a 50-200ms encode blocks the
/// loop briefly — but during that time no new clipboard reads happen, and the
/// sequence number already captured the change. This is fine for human-paced
/// screenshots (gaps of 300ms+).
///
/// The full PNG data URL is included DIRECTLY in the event payload, eliminating
/// the `getCapturedImage(hash)` IPC round-trip that added 50-100ms per image.
pub fn start_monitor(app_handle: AppHandle, stop_flag: Arc<AtomicBool>) {
    eprintln!("[ClipMon] Starting clipboard monitor (inline-encode, no worker)...");

    // Create the clipboard change listener
    let mut monitor = match clipboard_win::monitor::Monitor::new() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[ClipMon] FATAL: failed to create clipboard Monitor: {:?}", e);
            stop_flag.store(false, Ordering::Relaxed);
            return;
        }
    };
    // Store the shutdown handle so the stop command can unblock recv().
    *MONITOR_SHUTDOWN.lock().unwrap() = Some(monitor.shutdown_channel());

    let mut state = MonitorState::default();
    // Baseline sequence number so the first sweep doesn't treat already-present
    // clipboard content as a brand-new change.
    let mut last_seq: u32 = crate::get_clipboard_seq();

    loop {
        // Honor stop request
        if stop_flag.load(Ordering::Relaxed) {
            eprintln!("[ClipMon] Stop requested, exiting monitor loop.");
            break;
        }

        // --- Event-driven: drain any queued WM_CLIPBOARDUPDATE messages. ---
        while let Ok(true) = monitor.try_recv() {
            eprintln!("[ClipMon] WM_CLIPBOARDUPDATE received");
            if has_windows(&app_handle) {
                let content = read_clipboard_raw();
                handle_content(&app_handle, &mut state, content);
            } else {
                eprintln!("[ClipMon] change detected but no windows, skipping");
            }
        }

        // --- Sequence-number sweep: the real burst catcher. ---
        let seq = crate::get_clipboard_seq();
        if seq != last_seq {
            last_seq = seq;
            if has_windows(&app_handle) {
                eprintln!("[ClipMon] seq {} -> read clipboard now", seq);
                let content = read_clipboard_raw();
                handle_content(&app_handle, &mut state, content);
            } else {
                eprintln!("[ClipMon] seq changed but no windows, skipping");
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(15));
    }
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

/// Dispatch a single clipboard change (already read) to the appropriate channel/emit.
fn handle_content(
    app: &AppHandle,
    state: &mut MonitorState,
    content: ClipContent,
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
            // Encode to PNG INLINE (no worker thread, no IPC round-trip).
            // PNG content hash (fnv64 over the encoded data URL) is used for dedup:
            // same-window same-size screenshots have different pixels, so their PNG
            // content differs → no collision → no silent drops.
            match encode_clipboard_raw_to_png(&raw, src, Some(720)) {
                Some((data_url, png_content_hash)) => {
                    // Cache for fallback polling (getCapturedImage / getClipboardImage).
                    // Store (data_url, Instant) tuple to match the HashMap<u64, (String, Instant)> type.
                    if let Ok(mut map) = captured_images().lock() {
                        map.insert(png_content_hash, (data_url.clone(), Instant::now()));
                    }

                    state.last_text.clear();
                    state.last_file_paths.clear();

                    let _ = app.emit(
                        "clipboard-changed",
                        serde_json::json!({
                            "contentType": "image",
                            "size": size,
                            "hash": png_content_hash.to_string(),
                            "imageData": data_url,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                }
                None => {
                    eprintln!("[ClipMon] IMAGE: encode failed (size={})", size);
                }
            }
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
    /// `raw` holds the exact clipboard bytes at detection time; `src` tells the
    /// encoder whether they are PNG already or DIB/BMP that need conversion.
    /// `size` is the raw byte count.
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

    // Priority 1: Files (CF_HDROP, format 15)
    if raw::is_format_avail(15) {
        let mut files: Vec<String> = Vec::new();
        match raw::get_file_list(&mut files) {
            Ok(count) if count > 0 => return ClipContent::Files(files),
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_file_list err: {}", e),
        }
    }

    // Priority 2: Images.
    // Standard DIB (CF_DIB 8 / CF_BITMAP 2) first — what WeChat, Snipping Tool and most
    // Windows apps put on the clipboard, read reliably via get_bitmap().
    // Fall back to CF_DIBV5 (17) and PNG only when the standard DIB is unavailable
    // (browsers / some tools place images as DIBV5 or PNG only).
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
    // PNG clipboard format (e.g. copied from browsers)
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

    // Priority 3: Text (CF_UNICODETEXT, format 13)
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
