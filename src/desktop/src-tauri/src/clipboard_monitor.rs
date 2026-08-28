use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::encode_clipboard_raw_to_png;

/// Check if any webview windows exist. Used to avoid emitting events
/// when the frontend is not connected (e.g. during Vite hot-reload), which
/// would trigger stale callback ID warnings from Tauri's JS bridge.
fn has_windows(app: &AppHandle) -> bool {
    !app.webview_windows().is_empty()
}

/// Shutdown handle for the clipboard Monitor. Stored here so the
/// `stop_clipboard_monitor` command can drop it, which posts a close message
/// and unblocks the `Monitor::recv()` call (otherwise the monitor thread would
/// block forever waiting for the next clipboard message).
static MONITOR_SHUTDOWN: Mutex<Option<clipboard_win::monitor::Shutdown>> = Mutex::new(None);

/// Signal the running monitor to exit by dropping its Shutdown handle.
/// Safe to call even if no monitor is running.
pub fn request_stop_monitor() {
    if let Some(s) = MONITOR_SHUTDOWN.lock().unwrap().take() {
        drop(s); // Drop posts a WM_CLIPBOARDUPDATE with CLOSE_PARAM → recv() returns Ok(false)
    }
}

/// Echo guard for TEXT (and text-encoded image data URLs) that ClipSync itself
/// writes to the clipboard (paste / sync from another device / copy-to-clipboard
/// buttons). When ClipSync writes content X, the OS fires a clipboard-change
/// notification that the monitor would otherwise treat as an *external* copy and
/// pop the AI summary float for our own write. We stash the content here right
/// before writing; the monitor consumes & clears it on the next matching change.
static IGNORE_NEXT: Mutex<Option<String>> = Mutex::new(None);

/// Tell the monitor to ignore the next clipboard change equal to `content`.
/// Called from `set_clipboard_content` (and friends) before/around the write.
pub fn ignore_next_clipboard(content: &str) {
    *IGNORE_NEXT.lock().unwrap() = Some(content.to_string());
}

/// Monitors clipboard changes and emits `clipboard-changed` events.
///
/// ARCHITECTURE (2026-07-11, rewritten to fix "consecutive screenshots only
/// sync the first/last"):
///
/// Previous design POLLED the clipboard every 100ms and read it once per poll.
/// Because the Windows clipboard only ever holds the LATEST item, any writes
/// that happened BETWEEN two polls were physically overwritten before we could
/// read them — so a burst of N screenshots collapsed into a single "latest" read.
/// That is the root cause of "only the last one synced".
///
/// New design is EVENT-DRIVEN via `clipboard_win::monitor::Monitor`, which wraps
/// `AddClipboardFormatListener` (WM_CLIPBOARDUPDATE). The OS posts ONE message
/// per clipboard write. We read the clipboard IMMEDIATELY inside the recv loop,
/// before the next write's message is processed. So N writes → N messages → N
/// independent reads → N syncs. Intermediate screenshots can no longer be lost
/// to "latest overwrites".
///
/// PNG encoding is still handed off to a dedicated worker thread so the monitor
/// loop never blocks on compression and can keep servicing the message queue.
pub fn start_monitor(app_handle: AppHandle, stop_flag: Arc<AtomicBool>) {
    eprintln!("[ClipMon] Starting clipboard monitor (event-driven)...");

    struct MonitorGuard(Arc<AtomicBool>);
    impl Drop for MonitorGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Relaxed);
            eprintln!("[ClipMon] Monitor thread exited, stop flag reset to false.");
        }
    }
    let _guard = MonitorGuard(stop_flag.clone());

    // Create the clipboard change listener (message-only window + AddClipboardFormatListener).
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

    // Spawn a dedicated worker thread to convert raw clipboard bytes → PNG and emit
    // events. PNG encoding is the slowest part of image handling (50-200ms for a
    // 1080p screenshot). If we did it inline in the monitor loop, rapid consecutive
    // screenshots could be missed while the loop was blocked encoding the previous
    // one. The monitor loop only does FAST reads (a few ms) and hands bytes off to
    // this worker, so it can keep up with a burst of screenshots.
    let (image_tx, image_rx) = std::sync::mpsc::channel::<(Vec<u8>, &'static str, usize)>();
    let app_handle_worker = app_handle.clone();
    std::thread::spawn(move || {
        let mut last_image_png_hash: u64 = 0;
        while let Ok((raw, src, size)) = image_rx.recv() {
            if let Some((data_url, _raw_hash)) = encode_clipboard_raw_to_png(&raw, src) {
                // ECHO guard uses the PNG *content* hash (fnv64 over the encoded data URL),
                // NOT the raw DIB hash. Consecutive screenshots of the same window have
                // colliding RAW DIB bytes (the original bug), so a raw-hash guard silently
                // dropped the middle shots. The PNG content hash only collides for genuinely
                // identical images — exactly what we want to dedupe (e.g. ClipSync's own paste
                // writing the same bytes back to the clipboard). Using it guarantees every
                // distinct screenshot in a burst syncs.
                let png_content_hash = fnv64(data_url.as_bytes());
                if png_content_hash != last_image_png_hash {
                    last_image_png_hash = png_content_hash;
                    eprintln!("[ClipMon] IMAGE: {} bytes, png_hash={:016x}, emit", size, png_content_hash);
                    let _ = app_handle_worker.emit(
                        "clipboard-changed",
                        serde_json::json!({
                            "contentType": "image",
                            "size": size,
                            "hash": png_content_hash.to_string(),
                            "dataUrl": data_url,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                } else {
                    eprintln!("[ClipMon] IMAGE: echo png_content_hash={:016x}, skip", png_content_hash);
                }
            }
        }
        eprintln!("[ClipMon] Image worker thread exiting (sender dropped).");
    });

    let mut state = MonitorState::default();

    loop {
        // stop_flag = is_monitoring: true = running, false = should stop.
        if !stop_flag.load(Ordering::Relaxed) {
            eprintln!("[ClipMon] Stop requested, exiting monitor loop.");
            break;
        }

        match monitor.recv() {
            Ok(true) => {
                // A real clipboard change happened. Read it NOW, before any subsequent
                // write's message is processed — this is what prevents burst loss.
                let windows_alive = has_windows(&app_handle);
                if windows_alive {
                    eprintln!("[ClipMon] change detected (windows alive)");
                    let content = read_clipboard_raw();
                    handle_content(&app_handle, &image_tx, &mut state, content);
                } else {
                    // No frontend connected (e.g. Vite hot-reload). Skip processing to avoid
                    // stale Tauri callback warnings. The change is simply not captured — it
                    // cannot be displayed anyway, and the next change after the UI returns
                    // will be captured normally.
                    eprintln!("[ClipMon] change detected but no windows, skipping");
                }
            }
            Ok(false) => {
                eprintln!("[ClipMon] Shutdown requested via monitor channel, exiting.");
                break;
            }
            Err(e) => {
                eprintln!("[ClipMon] monitor.recv error: {:?} — exiting monitor thread", e);
                break;
            }
        }
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
    image_tx: &Sender<(Vec<u8>, &'static str, usize)>,
    state: &mut MonitorState,
    content: ClipContent,
) {
    match content {
        ClipContent::Text { text, html } => {
            // Echo guard: if this text equals what ClipSync itself just wrote to the
            // clipboard (paste / sync / copy button), skip it so we don't pop a summary
            // for our own write. Consume the guard on match.
            {
                let mut ig = IGNORE_NEXT.lock().unwrap();
                if let Some(ignored) = ig.take() {
                    if ignored == text {
                        eprintln!("[ClipMon] TEXT: echo of own write ({} chars), skip", text.len());
                        state.last_text = text.clone();
                        state.last_change_time = Instant::now();
                        return;
                    } else {
                        // Not our write after all — restore the guard and continue normally.
                        *ig = Some(ignored);
                    }
                }
            }

            // Genuinely new external text → emit so the AI summary float can pop up.
            // `last_text` dedupes consecutive identical copies (e.g. copy X twice).
            if !text.is_empty() && text != state.last_text {
                state.last_text = text.clone();
                state.last_change_time = Instant::now();
                eprintln!("[ClipMon] TEXT: {} chars, emit", text.len());
                let _ = app.emit(
                    "clipboard-changed",
                    serde_json::json!({
                        "content": text,
                        "html": html,
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
        ClipContent::Image { size, raw, src } => {
            // Hand the RAW bytes (read at detection time, before any further clipboard
            // write) to the worker. The worker does the slow PNG encoding and a lightweight
            // ECHO guard (to skip re-syncing images ClipSync itself wrote to the clipboard
            // on paste). We NEVER re-read the live clipboard later — doing so would resolve
            // every queued message to the LATEST image and re-introduce the burst-loss bug.
            if let Err(e) = image_tx.send((raw, src, size)) {
                eprintln!("[ClipMon] IMAGE: failed to send to worker: {}", e);
            }
            // Clear text/file state when an image appears
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
    /// Plain text plus optional captured rich text (Windows "HTML Format" fragment).
    /// HTML capture is an *enhancement* to plain text: `html` is None whenever the
    /// clipboard has no usable CF_HTML payload, and the text path must never depend on it.
    Text { text: String, html: Option<String> },
    Files(Vec<String>),
    /// `raw` holds the exact clipboard bytes at detection time; `src` tells the
    /// encoder whether they are PNG already or DIB/BMP that need conversion.
    Image { size: usize, raw: Vec<u8>, src: &'static str },
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
                // HTML Format（富文本增强）：浏览器/Office 复制富文本时与 CF_UNICODETEXT 并存。
                // 读取失败或缺失都不影响纯文本主流程（html 为 None）。
                let html = read_clipboard_html_format();
                return ClipContent::Text { text, html };
            }
            Ok(_) => {}
            Err(e) => eprintln!("[ClipMon] get_string err: {}", e),
        }
    }

    ClipContent::Empty
}

/// Read the Windows registered clipboard format "HTML Format" (CF_HTML, 49449) and
/// return the HTML fragment WITHOUT the CF_HTML text header. Returns None whenever
/// the format is absent or unusable — HTML capture is an enhancement to plain text
/// and must never break the text path. Must be called while the clipboard is open.
fn read_clipboard_html_format() -> Option<String> {
    use clipboard_win::raw;

    let fmt = raw::register_format("HTML Format")?;
    let code = fmt.get();
    if !raw::is_format_avail(code) {
        return None;
    }
    let n = raw::size(code)?.get();
    // Sanity cap: real web copies are far below 8 MiB; refuse absurd allocations.
    if n == 0 || n > 8 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; n];
    let read = raw::get(code, &mut buf).unwrap_or(0);
    if read == 0 {
        return None;
    }
    buf.truncate(read);
    extract_cf_html_fragment(&buf)
}

/// Parse a CF_HTML payload ("Version:0.9\r\nStartHTML:...\r\n...<html>...") and extract
/// the fragment between the StartFragment..EndFragment byte offsets, falling back to
/// StartHTML..EndHTML. Offsets are BYTE positions counted from the start of the whole
/// payload (header included); the body is UTF-8 from all mainstream producers.
fn extract_cf_html_fragment(data: &[u8]) -> Option<String> {
    // The header is short ASCII; only scan the first 4 KiB for field keys.
    let head = &data[..data.len().min(4096)];

    /// Locate `Key:` in the ASCII header and parse the integer that follows it.
    fn header_field(head: &[u8], key: &str) -> Option<usize> {
        let needle = key.as_bytes();
        if needle.len() + 1 > head.len() {
            return None;
        }
        for i in 0..=(head.len() - needle.len() - 1) {
            if &head[i..i + needle.len()] == needle && head[i + needle.len()] == b':' {
                let rest = &head[i + needle.len() + 1..];
                let digits: Vec<u8> = rest
                    .iter()
                    .copied()
                    .skip_while(|&b| b == b' ')
                    .take_while(|&b| b.is_ascii_digit())
                    .collect();
                if digits.is_empty() {
                    return None;
                }
                return std::str::from_utf8(&digits).ok()?.parse::<usize>().ok();
            }
        }
        None
    }

    let take = |start: usize, end: usize| -> Option<String> {
        if start > 0 && start < end && end <= data.len() {
            let frag = String::from_utf8_lossy(&data[start..end])
                .trim_matches('\0')
                .trim()
                .to_string();
            if !frag.is_empty() {
                return Some(frag);
            }
        }
        None
    };

    // Preferred: the actual selection fragment (excludes the <!--StartFragment--> wrapper).
    if let Some(frag) = take(
        header_field(head, "StartFragment").unwrap_or(0),
        header_field(head, "EndFragment").unwrap_or(0),
    ) {
        return Some(frag);
    }
    // Fallback: the whole HTML document.
    take(
        header_field(head, "StartHTML").unwrap_or(0),
        header_field(head, "EndHTML").unwrap_or(0),
    )
}

struct ClipGuard;
impl Drop for ClipGuard {
    fn drop(&mut self) {
        let _ = clipboard_win::raw::close();
    }
}

/// Fast non-crypto hash (FNV-1a 64-bit) over clipboard bytes.
/// Used by the image worker to dedup images by CONTENT (PNG data URL), not by
/// raw-DIB byte length — two screenshots of the same window/dimensions have
/// identical DIB byte length but different pixels, so a raw-hash check silently
/// drops the second one.
fn fnv64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
