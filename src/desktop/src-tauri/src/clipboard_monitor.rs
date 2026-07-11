use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Check if any webview windows exist. Used to avoid emitting events
/// when the frontend is not connected (e.g. during Vite hot-reload), which
/// would trigger stale callback ID warnings from Tauri's JS bridge.
fn has_windows(app: &AppHandle) -> bool {
    !app.webview_windows().is_empty()
}

/// Monitors clipboard changes and emits `clipboard-changed` events.
///
/// Detection covers three content types, prioritized in this order:
///   1. Files  (CF_HDROP) — emitted immediately on change
///   2. Images (CF_DIB / CF_BITMAP) — emitted immediately on size change (lightweight, no PNG conversion)
///   3. Text   (CF_UNICODETEXT) — emitted after 500ms debounce to avoid partial reads
///
/// The frontend listens for `clipboard-changed` events and handles upload logic,
/// replacing the previous 1500ms JS polling approach with event-driven architecture.
/// `stop_flag` is shared with the `stop_clipboard_monitor` command. When set to
/// `true`, the loop breaks on its next iteration and the thread exits. A `MonitorGuard`
/// resets the flag to `false` on thread exit (including on panic), so the monitor can
/// always be restarted — previously the flag was never read and the thread could never
/// be stopped or restarted after a panic.
pub fn start_monitor(app_handle: AppHandle, stop_flag: Arc<AtomicBool>) {
    eprintln!("[ClipMon] Starting clipboard monitor...");

    struct MonitorGuard(Arc<AtomicBool>);
    impl Drop for MonitorGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Relaxed);
            eprintln!("[ClipMon] Monitor thread exited, stop flag reset to false.");
        }
    }
    let _guard = MonitorGuard(stop_flag.clone());

    let mut last_text = String::new();
    let mut last_file_paths: Vec<String> = Vec::new();
    let mut last_image_size: usize = 0;
    let mut last_change_time = Instant::now();
    let debounce_duration = Duration::from_millis(500);
    let poll_interval = Duration::from_millis(700);
    let idle_interval = Duration::from_secs(5); // longer sleep when no windows
    let mut cycle: u64 = 0;

    loop {
        // Honor stop request: the `stop_clipboard_monitor` command (or a panic-exit
        // guard) sets this flag; break so the thread can terminate cleanly.
        if stop_flag.load(Ordering::Relaxed) {
            eprintln!("[ClipMon] Stop requested, exiting monitor loop.");
            break;
        }

        // Check if any frontend windows are alive. If not (e.g. during Vite
        // hot-reload), skip clipboard polling to avoid stale callback warnings.
        let windows_alive = has_windows(&app_handle);
        let sleep_dur = if windows_alive { poll_interval } else { idle_interval };

        std::thread::sleep(sleep_dur);
        cycle += 1;

        if !windows_alive {
            if cycle % 12 == 1 {
                eprintln!("[ClipMon] No alive windows, sleeping {}s", idle_interval.as_secs());
            }
            continue;
        }

        if cycle % 60 == 1 {
            eprintln!("[ClipMon] cycle #{}", cycle);
        }

        let result = read_clipboard_raw();

        match result {
            ClipContent::Text(text) => {
                if !text.is_empty() && text != last_text {
                    last_text = text.clone();
                    last_change_time = Instant::now();
                } else if !last_text.is_empty() && last_change_time.elapsed() >= debounce_duration {
                    let content_to_sync = last_text.clone();
                    last_text.clear();
                    eprintln!("[ClipMon] TEXT: {} chars", content_to_sync.len());
                    let _ = app_handle.emit(
                        "clipboard-changed",
                        serde_json::json!({
                            "content": content_to_sync,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                }
            }
            ClipContent::Files(paths) => {
                if !paths.is_empty() && paths != last_file_paths {
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

                    let _ = app_handle.emit(
                        "clipboard-changed",
                        serde_json::json!({
                            "content": preview,
                            "contentType": "file",
                            "filePaths": paths,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    last_file_paths = paths;
                    last_text.clear();
                } else if paths.is_empty() && !last_file_paths.is_empty() {
                    last_file_paths.clear();
                }
            }
            ClipContent::Image { size } => {
                // Lightweight detection: compare size only (no PNG conversion here).
                // The frontend will call get_clipboard_image() to fetch actual data.
                if size > 0 && size != last_image_size {
                    eprintln!("[ClipMon] IMAGE: {} bytes", size);
                    let _ = app_handle.emit(
                        "clipboard-changed",
                        serde_json::json!({
                            "contentType": "image",
                            "size": size,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    last_image_size = size;
                    // Clear text/file state when an image appears
                    last_text.clear();
                    last_file_paths.clear();
                }
            }
            ClipContent::Empty => {}
            ClipContent::Error(e) => {
                if cycle % 60 == 1 {
                    eprintln!("[ClipMon] ERR: {}", e);
                }
            }
        }
    }
}

enum ClipContent {
    Text(String),
    Files(Vec<String>),
    Image { size: usize },
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
            Ok(size) if size > 0 => return ClipContent::Image { size },
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_bitmap err: {}", e),
        }
    }
    if raw::is_format_avail(17) {
        if let Some(sz) = raw::size(17) {
            return ClipContent::Image { size: sz.get() };
        }
    }
    // PNG clipboard format (e.g. copied from browsers)
    if let Some(png_fmt) = raw::register_format("PNG") {
        let fmt = png_fmt.get();
        if raw::is_format_avail(fmt) {
            if let Some(sz) = raw::size(fmt) {
                return ClipContent::Image { size: sz.get() };
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
