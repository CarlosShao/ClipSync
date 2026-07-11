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
            match encode_clipboard_raw_to_png(&raw, src) {
                Some((data_url, _raw_hash)) => {
                    // ECHO guard uses the PNG *content* hash (fnv64 over the encoded data
                    // URL), NOT the raw DIB hash. Consecutive screenshots of the same window
                    // have colliding RAW DIB bytes, so a raw-hash guard silently dropped the
                    // middle shots. The PNG content hash only collides for genuinely identical
                    // images (e.g. ClipSync's own paste writing the same bytes back). Using it
                    // guarantees every distinct screenshot in a burst syncs.
                    let png_content_hash = fnv64(data_url.as_bytes());
                    if png_content_hash != last_image_png_hash {
                        last_image_png_hash = png_content_hash;
                        // Cache the bytes by content hash; frontend pulls them via
                        // get_captured_image (avoids shipping multi-MB payloads over events).
                        if let Ok(mut map) = crate::captured_images().lock() {
                            map.insert(png_content_hash, (data_url.clone(), std::time::Instant::now()));
                        }
                        eprintln!("[ClipMon] IMAGE: {} bytes, png_hash={:016x}, emit", size, png_content_hash);
                        let _ = app_handle_worker.emit(
                            "clipboard-changed",
                            serde_json::json!({
                                "contentType": "image",
                                "size": size,
                                "hash": png_content_hash.to_string(),
                                "timestamp": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                    } else {
                        eprintln!("[ClipMon] IMAGE: echo png_content_hash={:016x}, skip", png_content_hash);
                    }
                }
                None => {
                    eprintln!("[ClipMon] IMAGE: encode failed (size={})", size);
                }
            }
        }
        eprintln!("[ClipMon] Image worker thread exiting (sender dropped).");
    });

    let mut state = MonitorState::default();
    // Baseline sequence number so the first sweep doesn't treat the already-present
    // clipboard content as a brand-new change.
    let mut last_seq: u32 = crate::get_clipboard_seq();

    loop {
        // Honor stop request (set by the stop command before dropping Shutdown).
        if stop_flag.load(Ordering::Relaxed) {
            eprintln!("[ClipMon] Stop requested, exiting monitor loop.");
            break;
        }

        // --- Event-driven: drain any queued WM_CLIPBOARDUPDATE messages. ---
        // AddClipboardFormatListener posts ONE message per "pending" window flag, so a
        // fast burst of writes collapses into a single notification. Draining the queue
        // here still only yields that one coalesced message — which is exactly why we
        // ALSO run the sequence-number sweep below (the OS bumps the sequence number on
        // EVERY write, coalesced or not).
        while let Ok(true) = monitor.try_recv() {
            eprintln!("[ClipMon] WM_CLIPBOARDUPDATE received");
            if has_windows(&app_handle) {
                let content = read_clipboard_raw();
                handle_content(&app_handle, &image_tx, &mut state, content);
            } else {
                eprintln!("[ClipMon] change detected but no windows, skipping");
            }
        }

        // --- Sequence-number sweep: the real burst catcher. ---
        // GetClipboardSequenceNumber increments on EVERY clipboard write. We sample it
        // every 15ms; if it changed, the clipboard currently holds a NEW image that we
        // must read NOW (before the next write overwrites it). For human-paced captures
        // (gaps of hundreds of ms) this catches every screenshot in its gap. This is the
        // only reliable way to capture a burst — WM_CLIPBOARDUPDATE alone cannot, because
        // Windows coalesces those notifications.
        let seq = crate::get_clipboard_seq();
        if seq != last_seq {
            last_seq = seq;
            if has_windows(&app_handle) {
                eprintln!("[ClipMon] seq {} -> read clipboard now", seq);
                let content = read_clipboard_raw();
                handle_content(&app_handle, &image_tx, &mut state, content);
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
    image_tx: &Sender<(Vec<u8>, &'static str, usize)>,
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
    Text(String),
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
