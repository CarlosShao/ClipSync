use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Monitors clipboard changes and emits events.
/// Uses a single clipboard_win handle, never conflicts with get_clipboard_files.
pub fn start_monitor(app_handle: AppHandle) {
    eprintln!("[ClipMon] Starting clipboard monitor...");

    let mut last_text = String::new();
    let mut last_file_paths: Vec<String> = Vec::new();
    let mut last_change_time = Instant::now();
    let debounce_duration = Duration::from_millis(500);
    let poll_interval = Duration::from_millis(700); // Slightly slower to reduce contention
    let mut cycle: u64 = 0;

    loop {
        std::thread::sleep(poll_interval);
        cycle += 1;

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

    // Files take priority over text
    if raw::is_format_avail(15) {
        let mut files: Vec<String> = Vec::new();
        match raw::get_file_list(&mut files) {
            Ok(count) if count > 0 => return ClipContent::Files(files),
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_file_list err: {}", e),
        }
    }

    if raw::is_format_avail(13) {
        let mut buf = Vec::<u8>::new();
        match raw::get_string(&mut buf) {
            Ok(count) if count > 0 => {
                // CF_UNICODETEXT is UTF-16LE; raw::get_string returns raw bytes
                // Try UTF-8 first (for backward compat), then UTF-16LE fallback
                let text = match String::from_utf8(buf.clone()) {
                    Ok(s) => s,
                    Err(_) => {
                        // Parse as UTF-16LE (CF_UNICODETEXT format)
                        let mut utf16_bytes = &buf[..];
                        // Ensure even length for u16 pairs
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
