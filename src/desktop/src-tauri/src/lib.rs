use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use std::thread;

use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent};
use tauri_plugin_autostart::MacosLauncher;

mod clipboard_monitor;

// ============================================================================
// AppConfig persistence (A1)
// ============================================================================

/// File name of the persisted config inside Tauri's `app_config_dir`
/// (Windows: %APPDATA%\com.clipsync.desktop\config.json).
const CONFIG_FILE_NAME: &str = "config.json";

/// Resolve the on-disk config path. `None` when the OS refuses to hand out a
/// config directory — the app then keeps running with an in-memory config.
fn config_file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(CONFIG_FILE_NAME))
}

/// Load the persisted config.
///
/// ANY failure (missing file, unreadable, corrupt JSON, schema drift) falls back
/// to `AppConfig::default()` — a broken/legacy config file must never stop the
/// app from starting.
fn load_persisted_config(app: &tauri::AppHandle) -> AppConfig {
    let Some(path) = config_file_path(app) else {
        warn!("[Config] app_config_dir unavailable, using in-memory defaults");
        return AppConfig::default();
    };
    if !path.exists() {
        info!("[Config] No persisted config at {}, using defaults", path.display());
        return AppConfig::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<AppConfig>(&raw) {
            Ok(cfg) => {
                info!("[Config] Loaded {} (server_url='{}')", path.display(), cfg.server_url);
                cfg
            }
            Err(e) => {
                error!("[Config] Corrupt config at {}: {}. Falling back to defaults.", path.display(), e);
                AppConfig::default()
            }
        },
        Err(e) => {
            error!("[Config] Unreadable config at {}: {}. Falling back to defaults.", path.display(), e);
            AppConfig::default()
        }
    }
}

/// Best-effort persist. Failures are logged, never propagated: a read-only
/// config directory must not break settings that already work in memory.
fn persist_config(app: &tauri::AppHandle, cfg: &AppConfig) {
    let Some(path) = config_file_path(app) else { return };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!("[Config] Cannot create config dir {}: {}", parent.display(), e);
            return;
        }
    }
    match serde_json::to_string_pretty(cfg) {
        Ok(raw) => {
            if let Err(e) = std::fs::write(&path, raw) {
                error!("[Config] Failed to write {}: {}", path.display(), e);
            } else {
                debug!("[Config] Persisted to {}", path.display());
            }
        }
        Err(e) => error!("[Config] Failed to serialize config: {}", e),
    }
}

/// Persist whatever is currently in the in-memory AppState.
fn persist_state_config(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let cfg = state.config.lock().unwrap().clone();
        persist_config(app, &cfg);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub server_url: String,
    pub token: Option<String>,
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub quick_paste_shortcut: Option<String>,
    pub toggle_window_shortcut: Option<String>,
    pub toggle_ai_panel_shortcut: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:3001".to_string(),
            token: None,
            device_id: None,
            user_id: None,
            quick_paste_shortcut: Some("Ctrl+Shift+V".to_string()),
            toggle_window_shortcut: Some("Ctrl+Alt+Space".to_string()),
            toggle_ai_panel_shortcut: Some("Ctrl+Shift+A".to_string()),
        }
    }
}

pub struct AppState {
    pub config: Arc<Mutex<AppConfig>>,
    pub is_monitoring: Arc<AtomicBool>,
    /// Last time QuickPaste was toggled (for debouncing key-repeat)
    pub last_qp_toggle: Arc<Mutex<Instant>>,
    /// Last time ToggleWindow was toggled (for debouncing key-repeat)
    pub last_tw_toggle: Arc<Mutex<Instant>>,
    /// Last time AI panel was toggled (for debouncing key-repeat)
    pub last_ai_toggle: Arc<Mutex<Instant>>,
}

/// Helper: ensure main window is visible and focused (handles both minimized + hidden states)
fn ensure_window_visible(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();   // 先取消最小化
        let _ = window.show();         // 再显示（从隐藏/托盘恢复）
        let _ = window.set_focus();    // 最后聚焦
        return Some(window);
    }
    None
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn update_config(app: tauri::AppHandle, state: tauri::State<AppState>, config: AppConfig) {
    // 字段级合并：只更新用户可设置的字段（server_url / 快捷键），
    // **永远保留**认证与身份字段 token/device_id/user_id。
    // 之前是整体覆盖 `*config = config`，若前端设置快照漏带 token，
    // 一次"保存快捷键"就会把登录态抹成 None → 用户被静默登出。
    // 清除登录态请走专用命令 clear_auth（前端 logout 调用）。
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.server_url = config.server_url;
        cfg.quick_paste_shortcut = config.quick_paste_shortcut;
        cfg.toggle_window_shortcut = config.toggle_window_shortcut;
        cfg.toggle_ai_panel_shortcut = config.toggle_ai_panel_shortcut;
    }
    // A1: 持久化到 app_config_dir，重启后仍然保留
    persist_state_config(&app);
}

/// 清除认证/身份状态（前端 logout 调用）。与 update_config 分离，
/// 确保"保存设置"绝不会误删活动会话。
#[tauri::command]
fn clear_auth(app: tauri::AppHandle, state: tauri::State<AppState>) {
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.token = None;
        cfg.device_id = None;
        cfg.user_id = None;
    }
    persist_state_config(&app);
    debug!("[Auth] Cleared token/device_id/user_id on logout");
}

/// Copy local files to clipboard (CF_HDROP) — checks if files exist first.
/// For files that were originally copied on this same machine.
#[tauri::command]
fn copy_local_files(paths: Vec<String>) -> Result<String, String> {
    use std::path::Path;
    let mut existing = Vec::new();
    let mut missing = Vec::new();
    for p in &paths {
        if Path::new(p).exists() {
            existing.push(p.clone());
        } else {
            missing.push(p.clone());
        }
    }
    if existing.is_empty() {
        return Err(format!(
            "Files not found on this device (cross-device): {}",
            missing.join(", ")
        ));
    }
    set_clipboard_files(existing.clone())?;
    if missing.is_empty() {
        Ok(format!("Copied {} file(s)", existing.len()))
    } else {
        Ok(format!(
            "Copied {} file(s), {} missing: {}",
            existing.len(),
            missing.len(),
            missing.join(", ")
        ))
    }
}

/// Open URL in system default browser
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("failed to open URL: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        opener::open(&url).map_err(|e| format!("failed to open URL: {}", e))?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .args(["/select", &path])
            .spawn()
            .map_err(|e| format!("failed to open explorer: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        opener::reveal(&path).map_err(|e| format!("failed to reveal: {}", e))
    }
}

#[tauri::command]
fn get_clipboard_content() -> Result<String, String> {
    use clipboard_win::raw;
    match raw::open() {
        Ok(()) => {
            let _guard = RawClipGuard;
            let mut buf = Vec::<u8>::new();
            match raw::get_string(&mut buf) {
                Ok(n) if n > 0 => String::from_utf8(buf).map_err(|e| format!("utf8: {}", e)),
                Ok(_) => Ok(String::new()), // 空剪贴板返回空字符串，不报错
                Err(e) => {
                    // Windows 错误码 1168 = ERROR_NOT_FOUND（剪贴板无文本内容），静默处理
                    let err_msg = format!("{}", e);
                    if err_msg.contains("1168") || err_msg.contains("Element not found") {
                        return Ok(String::new());
                    }
                    Err(format!("read: {}", e))
                }
            }
        }
        Err(e) => Err(format!("open: {}", e)),
    }
}

#[tauri::command]
fn set_clipboard_content(content: String) -> Result<(), String> {
    // Tell the monitor to ignore the change we're about to make (paste / sync /
    // copy button), so it doesn't pop the AI summary float for our own write.
    clipboard_monitor::ignore_next_clipboard(&content);

    use clipboard_win::raw;
    raw::open().map_err(|e| format!("open: {}", e))?;
    // A3: 写文本前先清空剪贴板（对齐 set_clipboard_files）。
    // Windows 允许同一剪贴板上并存 CF_UNICODETEXT / CF_DIB / CF_HDROP，
    // 不清空的话"先复制图片、再同步文本"之后 Ctrl+V 仍会得到旧图片。
    let _ = raw::empty();
    // CF_UNICODETEXT (format 13) 要求 UTF-16LE 编码，且必须以双字节 null 结尾
    let mut utf16_bytes: Vec<u8> = content
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();
    utf16_bytes.extend_from_slice(&[0, 0]); // 追加 UTF-16LE null 终止符
    let result = raw::set(13, &utf16_bytes);
    let _ = raw::close();
    result.map_err(|e| format!("write: {}", e))
}

/// Write file paths to the Windows clipboard as CF_HDROP format
#[tauri::command]
fn set_clipboard_files(paths: Vec<String>) -> Result<(), String> {
    use clipboard_win::raw;
    raw::open().map_err(|e| format!("open failed: {}", e))?;
    let _ = raw::empty();
    let result = raw::set_file_list(&paths);
    let _ = raw::close();
    result.map_err(|e| format!("set_file_list failed: {}", e))
}

/// Read a file's content as UTF-8 text. Used for previewing clipboard-copied files.
/// Returns the file content string, or an error if the file can't be read.
#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    use std::fs;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    // Safety limit: 5MB for text preview
    let metadata = fs::metadata(p).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err(format!("File too large for preview: {} bytes", metadata.len()));
    }
    fs::read_to_string(p).map_err(|e| format!("Cannot read file: {}", e))
}

/// Read a binary file and return its content as base64. Used for image file preview.
#[tauri::command]
fn read_file_content_base64(path: String) -> Result<String, String> {
    use std::fs;
    use base64::Engine;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    // Safety limit: 10MB for image preview
    let metadata = fs::metadata(p).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err(format!("File too large for preview: {} bytes", metadata.len()));
    }
    let bytes = fs::read(p).map_err(|e| format!("Cannot read file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
fn save_and_copy_file(base64_data: String, filename: String) -> Result<String, String> {
    use std::fs;
    use base64::Engine;
    // 1. Decode base64（A9：base64::decode 已在 0.22 废弃，改用 Engine API）
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 decode failed: {}", e))?;

    // 2. Save to temp dir
    let temp_dir = std::env::temp_dir().join("clipsync");
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("create temp dir failed: {}", e))?;

    let safe_name = filename
        .replace(|c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_', "_");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let temp_file = temp_dir.join(format!("{}_{}", ts, safe_name));
    fs::write(&temp_file, &bytes)
        .map_err(|e| format!("write file failed: {}", e))?;

    // 3. Set clipboard with file path (CF_HDROP)
    let full_path = temp_file
        .to_str()
        .ok_or("invalid path")?
        .to_string();
    set_clipboard_files(vec![full_path.clone()])?;

    Ok(full_path)
}

struct RawClipGuard;
impl Drop for RawClipGuard {
    fn drop(&mut self) { let _ = clipboard_win::raw::close(); }
}

#[tauri::command]
fn get_clipboard_files() -> Vec<String> {
    let mut files = Vec::new();
    match clipboard_win::raw::open() {
        Ok(()) => {
            if clipboard_win::raw::is_format_avail(15) {
                match clipboard_win::raw::get_file_list(&mut files) {
                    Ok(_) => {
                        debug!("[get_clipboard_files] CF_HDROP available, got {} file(s)", files.len());
                    }
                    Err(e) => {
                        error!("[get_clipboard_files] CF_HDROP available but get_file_list failed: {}", e);
                    }
                }
            }
            let _ = clipboard_win::raw::close();
        }
        Err(e) => {
            error!("[get_clipboard_files] clipboard open failed: {}", e);
        }
    }
    files
}

/// Fast non-crypto hash (FNV-1a 64-bit) over clipboard bytes.
fn fnv64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Lightweight check: is there an image on the clipboard? Returns size + content hash
/// (no base64). Call this on the fallback poll to dedup by CONTENT, not byte length.
#[tauri::command]
fn check_clipboard_image_info() -> serde_json::Value {
    use clipboard_win::raw;
    // Safety limit: skip images larger than 50MB raw (prevents OOM on huge screenshots)
    const MAX_RAW_BYTES: usize = 50 * 1024 * 1024;
    match raw::open() {
        Ok(()) => {
            let png_avail = raw::register_format("PNG")
                .map(|f| raw::is_format_avail(f.get()))
                .unwrap_or(false);
            let has_image = raw::is_format_avail(2)
                || raw::is_format_avail(8)
                || raw::is_format_avail(17)
                || png_avail;
            let _ = raw::close();
            if has_image {
                match raw::open() {
                    Ok(()) => {
                        // Read the actual bytes (prefer standard DIB, then DIBV5, then PNG)
                        // so we can hash by CONTENT. Two same-sized screenshots must not collide.
                        let mut bytes: Vec<u8> = Vec::new();
                        if raw::is_format_avail(8) || raw::is_format_avail(2) {
                            let mut data = Vec::<u8>::new();
                            let _ = raw::get_bitmap(&mut data);
                            bytes = data;
                        } else if raw::is_format_avail(17) {
                            if let Some(sz) = raw::size(17) {
                                let n = sz.get();
                                if n > 0 && n <= MAX_RAW_BYTES {
                                    let mut buf = vec![0u8; n];
                                    if raw::get(17, &mut buf).unwrap_or(0) > 0 {
                                        bytes = buf;
                                    }
                                }
                            }
                        } else if let Some(png_fmt) = raw::register_format("PNG") {
                            let fmt = png_fmt.get();
                            if raw::is_format_avail(fmt) {
                                if let Some(sz) = raw::size(fmt) {
                                    let n = sz.get();
                                    if n > 0 && n <= MAX_RAW_BYTES {
                                        let mut png = vec![0u8; n];
                                        if raw::get(fmt, &mut png).unwrap_or(0) > 0 {
                                            bytes = png;
                                        }
                                    }
                                }
                            }
                        }
                        let _ = raw::close();
                        let size = bytes.len();
                        if size == 0 {
                            serde_json::json!({ "available": false, "size": 0 })
                        } else if size > MAX_RAW_BYTES {
                            debug!("[check_clipboard_image_info] Image too large: {} bytes, skipping", size);
                            serde_json::json!({ "available": false, "size": size, "reason": "too_large" })
                        } else {
                            let hash = fnv64(&bytes);
                            serde_json::json!({ "available": true, "size": size, "hash": hash.to_string() })
                        }
                    }
                    Err(_) => serde_json::json!({ "available": true, "size": 0 }),
                }
            } else {
                serde_json::json!({ "available": false, "size": 0 })
            }
        }
        Err(_) => serde_json::json!({ "available": false, "size": 0 }),
    }
}

/// Read image from Windows clipboard (CF_DIB / CF_BITMAP)
/// Returns base64 PNG data URL. Uses image crate for reliable BMP decoding,
/// with manual DIB parser as fallback for non-standard formats.
/// Read the current clipboard image, convert it to a PNG data URL, and return
/// `(data_url, content_hash)`. Returns `None` if there is no image or conversion fails.
///
/// Shared by the `get_clipboard_image` Tauri command AND the clipboard monitor.
/// The monitor calls it at DETECTION time so the image bytes are snapshotted
/// immediately, instead of letting the frontend re-read a clipboard that may already
/// hold a newer screenshot. Without this, taking several screenshots in quick
/// succession drops all but the last one (the frontend reads the live clipboard long
/// after detection, by which point it holds the newest image).
/// Read the raw image bytes from the clipboard without encoding.
/// Returns `(raw_bytes, source_label)`. The source label tells the encoder
/// whether the bytes are already PNG or need BMP/DIB conversion.
pub fn read_clipboard_image_raw() -> Option<(Vec<u8>, &'static str)> {
    use clipboard_win::raw;

    if raw::open().is_err() {
        return None;
    }

    // PRIORITY: CF_DIB / CF_BITMAP (8/2) first — what WeChat, Snipping Tool and most
    // Windows apps put on the clipboard; get_bitmap() reads it reliably. Fall back to
    // CF_DIBV5 (17) or PNG only when the standard DIB is unavailable.
    let mut dib: Vec<u8> = Vec::new();
    let mut src = "";
    if raw::is_format_avail(8) || raw::is_format_avail(2) {
        if raw::get_bitmap(&mut dib).unwrap_or(0) > 0 {
            src = "CF_DIB/CF_BITMAP";
        }
    }
    if dib.is_empty() && raw::is_format_avail(17) {
        if let Some(sz) = raw::size(17) {
            let n = sz.get();
            if n > 0 {
                let mut buf = vec![0u8; n];
                if raw::get(17, &mut buf).unwrap_or(0) > 0 {
                    dib = buf;
                    src = "CF_DIBV5";
                }
            }
        }
    }
    // PNG clipboard format (e.g. copied from browsers) — bytes are already PNG.
    if dib.is_empty() {
        if let Some(png_fmt) = raw::register_format("PNG") {
            let fmt = png_fmt.get();
            if raw::is_format_avail(fmt) {
                if let Some(sz) = raw::size(fmt) {
                    let n = sz.get();
                    if n > 0 {
                        let mut png = vec![0u8; n];
                        if raw::get(fmt, &mut png).unwrap_or(0) > 0 {
                            let _ = raw::close();
                            debug!("[read_clipboard_image_raw] source=PNG-clipboard, {} bytes", png.len());
                            return Some((png, "PNG-clipboard"));
                        }
                    }
                }
            }
        }
    }

    let _ = raw::close();

    if dib.is_empty() {
        return None;
    }

    debug!("[read_clipboard_image_raw] source={} raw {} bytes, starts with {:02x?}, has_BM={}",
        src, dib.len(), dib.iter().take(4).collect::<Vec<_>>(),
        dib.len() > 2 && &dib[0..2] == b"BM");

    Some((dib, src))
}

/// Encode raw clipboard bytes (DIB/BMP/PNG) into a PNG data URL + hash.
pub fn encode_clipboard_raw_to_png(raw: &[u8], src: &str) -> Option<(String, u64)> {
    use base64::Engine;

    if raw.is_empty() {
        return None;
    }

    // PNG clipboard format — bytes are already PNG.
    if src == "PNG-clipboard" {
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw);
        return Some((format!("data:image/png;base64,{}", b64), fnv64(raw)));
    }

    if raw.len() < 40 {
        return None;
    }

    // === Try 1: image crate BMP decoder (most reliable for standard BMP) ===
    if raw.len() > 14 && &raw[0..2] == b"BM" {
        match image::load_from_memory(raw) {
            Ok(img) => {
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                debug!("[encode_clipboard_raw_to_png] image crate OK: {}x{}", w, h);
                return encode_rgba_to_png_data_url(&rgba, w, h).ok().map(|url| (url, fnv64(raw)));
            }
            Err(e) => {
                error!("[encode_clipboard_raw_to_png] image crate failed: {}, trying manual parser", e);
            }
        }
    }

    // === Try 2: Manual DIB parsing (fallback for non-standard formats) ===
    let actual_dib = if &raw[0..2] == b"BM" && raw.len() > 14 { &raw[14..] } else { raw };
    dib_to_png_data_url(actual_dib)
        .map(|url| (url, fnv64(raw)))
        .map_err(|e| { error!("[encode_clipboard_raw_to_png] failed: {}", e); e })
        .ok()
}

pub fn capture_clipboard_image() -> Option<(String, u64)> {
    let (raw, src) = read_clipboard_image_raw()?;
    encode_clipboard_raw_to_png(&raw, src)
}

#[tauri::command]
fn get_clipboard_image() -> Result<String, String> {
    Ok(capture_clipboard_image().map(|(url, _hash)| url).unwrap_or_default())
}

/// Convert a BMP data URL (from database or clipboard) to PNG data URL.
/// Handles both: full BMP file (with BM header) and raw DIB (header-only).
#[tauri::command]
fn convert_bmp_to_png(bmp_data_url: String) -> Result<String, String> {
    use base64::Engine;

    // Strip data URL prefix — accept any BMP variant
    let b64_part = bmp_data_url
        .strip_prefix("data:image/bmp;base64,")
        .or_else(|| bmp_data_url.strip_prefix("data:image/x-ms-bmp;base64,"))
        .or_else(|| bmp_data_url.strip_prefix("data:image/bmp;"))
        .ok_or_else(|| {
            let preview = if bmp_data_url.len() > 50 { &bmp_data_url[..50] } else { &bmp_data_url };
            format!("not a valid BMP data URL: {}", preview)
        })?;

    // If there's still a "base64," after stripping partial prefix, remove it
    let b64_part = b64_part
        .strip_prefix("base64,")
        .unwrap_or(b64_part);

    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64_part)
        .map_err(|e| format!("base64 decode failed: {} (input {} bytes)", e, b64_part.len()))?;

    debug!("[convert_bmp_to_png] decoded {} bytes, first 4: {:02x?}, has_BM_header: {}",
        raw_bytes.len(),
        raw_bytes.iter().take(4).collect::<Vec<_>>(),
        raw_bytes.len() > 2 && &raw_bytes[0..2] == b"BM");

    // Find actual DIB start — skip BM file header if present
    let dib = if raw_bytes.len() > 14 && &raw_bytes[0..2] == b"BM" {
        // Use pixel offset from BM header if it looks sane, otherwise default to 14
        let pix_off = u32::from_le_bytes(raw_bytes[10..14].try_into().unwrap());
        if pix_off >= 14 && pix_off < raw_bytes.len() as u32 {
            debug!("[convert_bmp_to_png] using BM pixel_offset={}", pix_off);
            &raw_bytes[pix_off as usize..]
        } else {
            debug!("[convert_bmp_to_png] bad pixel_offset={}, defaulting to 14", pix_off);
            &raw_bytes[14..]
        }
    } else if raw_bytes.len() > 4 {
        // Raw DIB — no BM header
        &raw_bytes[..]
    } else {
        return Err(format!("data too short: {} bytes", raw_bytes.len()));
    };

    dib_to_png_data_url(dib)
}

/// Parse raw Windows DIB (BITMAPINFOHEADER + pixel data) → PNG data URL.
/// Handles BITMAPINFOHEADER (40), BITMAPV4HEADER (108), BITMAPV5HEADER (124).
/// Auto-detects byte order by trying multiple interpretations and picking the best one.
fn dib_to_png_data_url(dib: &[u8]) -> Result<String, String> {
    if dib.len() < 40 {
        return Err(format!("DIB too short: {} bytes", dib.len()));
    }

    // Parse BITMAPINFOHEADER (first 40 bytes — common to all BMP versions)
    let header_size = i32::from_le_bytes(dib[0..4].try_into().unwrap());
    let width = i32::from_le_bytes(dib[4..8].try_into().unwrap());
    let height_raw = i32::from_le_bytes(dib[8..12].try_into().unwrap());
    let bpp = u16::from_le_bytes(dib[14..16].try_into().unwrap());
    let compression = u32::from_le_bytes(dib[16..20].try_into().unwrap());

    debug!("[dib_to_png] === NEW CONVERSION === {}x{} bpp={} comp={} hdr={} dib_len={}",
        width.abs(), height_raw.abs(), bpp, compression, header_size, dib.len());

    if header_size < 40 || (header_size as usize) > dib.len() || width <= 0 || height_raw == 0 {
        return Err(format!("invalid header: hdr={} w={} h={}", header_size, width, height_raw));
    }

    let w = width as u32;
    let h = height_raw.abs() as u32;
    let top_down = height_raw < 0;
    let bytes_per_pixel = match bpp { 32 => 4u32, 24 => 3, _ => 0 };
    if bytes_per_pixel == 0 {
        return Err(format!("unsupported bpp: {}", bpp));
    }
    let row_stride = ((w * bytes_per_pixel + 3) / 4) * 4;

    // === HEX DUMP: Show raw bytes around expected pixel data boundary ===
    debug!("[dib_to_png] --- HEX DUMP around header/pixel boundary ---");
    // Last 16 bytes of header area
    let dump_start = header_size.saturating_sub(16).max(0) as usize;
    for row in (dump_start..(header_size as usize + 64).min(dib.len())).step_by(16) {
        let end = (row + 16).min(dib.len());
        let hex: Vec<String> = dib[row..end].iter().map(|b| format!("{:02x}", b)).collect();
        let ascii: String = dib[row..end].iter().map(|b| if *b >= 0x20 && *b < 0x7f { *b as char } else { '.' }).collect();
        let marker = if row < header_size as usize { " [HDR]" } else { " [PX?]" };
        debug!("[dib_to_png] {:04x}: {}{} {}", row, marker, hex.join(" "), ascii);
    }

    // === Try standard approach first (header_size offset + BGRA for 32bpp) ===
    // Windows clipboard DIB is almost always BGRA at header_size offset
    if (header_size as usize) + (row_stride * h) as usize <= dib.len() {
        let standard_fn: fn(&[u8]) -> [u8; 4] = if bytes_per_pixel == 4 { order_bgra } else { order_bgr };
        let standard_name = if bytes_per_pixel == 4 { "BGRA" } else { "BGR" };
        if let Ok(stats) = try_pixel_extraction(dib, w, h, top_down, header_size as usize, row_stride, bytes_per_pixel, standard_fn) {
            let pct = stats.non_blank as f64 / stats.total.max(1) as f64 * 100.0;
            debug!("[dib_to_png] STANDARD offset={} ORDER={} → {:.1}%", header_size, standard_name, pct);
            if stats.total > 0 && pct > 5.0 {
                debug!("[dib_to_png] ACCEPTED standard: offset={} order={} ({:.1}%)", header_size, standard_name, pct);
                return encode_rgba_to_png_data_url(&stats.rgba, w, h);
            }
        }
    }

    // === Fallback: heuristic — try all candidates, pick the best ===
    let mut candidate_offsets = vec![header_size as usize];

    // For BI_BITFIELDS (compression=3) with 40-byte header: 12 bytes of masks follow
    if compression == 3 && header_size == 40 {
        candidate_offsets.push(header_size as usize + 12);
    }

    // For V4/V5 headers, sometimes there's color profile data or alignment padding
    // Try scanning for first non-zero row (real pixel data is rarely all-zero)
    if header_size >= 108 {
        // V4/V5: masks are embedded in header, but there may be ICC profile or other data
        // Try a few offsets after the header
        for extra in &[0usize, 4, 8, 16, 32, 64, 128, 256, 512] {
            let off = (header_size as usize + *extra).min(dib.len().saturating_sub(16));
            if !candidate_offsets.contains(&off) {
                candidate_offsets.push(off);
            }
        }
    }

    // Also do a SCAN-BASED approach: search for the first row that has varied non-zero data
    // A real screenshot row will have lots of variation; header/padding is usually uniform
    'offset_search: for probe_off in (header_size as usize..dib.len().saturating_sub(row_stride as usize)).step_by(4) {
        // Check if this position looks like real pixel data (varied bytes in first 32 pixels)
        let sample_end = (probe_off + 128).min(dib.len());
        let sample = &dib[probe_off..sample_end];
        let non_zero_count = sample.iter().filter(|&&b| b != 0).count();
        let unique_bytes: std::collections::HashSet<&u8> = sample.iter().collect();

        // Real pixel data: >50% non-zero and >10 unique byte values in 128 bytes
        if non_zero_count > 64 && unique_bytes.len() > 10 && !candidate_offsets.contains(&probe_off) {
            debug!("[dib_to_png] SCAN found likely pixel start at offset {} (nz={}, uniq={})",
                probe_off, non_zero_count, unique_bytes.len());
            candidate_offsets.insert(1, probe_off); // insert early to try first
            break 'offset_search;
        }
    }

    debug!("[dib_to_png] Trying {} candidate offsets (fallback)", candidate_offsets.len());
    let mut best_result: Option<(String, usize, PixelExtractionResult)> = None;

    for (idx, &pix_off) in candidate_offsets.iter().enumerate() {
        debug!("[dib_to_png] Candidate #{}: offset={} (need {}, have {})",
            idx, pix_off, pix_off + (row_stride * h) as usize, dib.len());

        // Skip obviously invalid offsets
        if pix_off + (row_stride * h) as usize > dib.len() {
            debug!("[dib_to_png]   -> SKIP: truncated");
            continue;
        }

        // Try ALL byte orderings for 32bpp: BGRA, ARGB, ABGR, RGBA
        let orderings: &[(&str, fn(&[u8]) -> [u8; 4])] = if bytes_per_pixel == 4 {
            &[
                ("BGRA", order_bgra),
                ("ARGB", order_argb),
                ("RGBA", order_rgba),
                ("ABGR", order_abgr),
            ]
        } else {
            &[
                ("BGR", order_bgr),
            ]
        };

        for (order_name, convert_fn) in orderings {
            let result = try_pixel_extraction(dib, w, h, top_down, pix_off, row_stride, bytes_per_pixel, *convert_fn);
            match result {
                Ok(stats) => {
                    let pct = stats.non_blank as f64 / stats.total.max(1) as f64 * 100.0;
                    debug!("[dib_to_png] OFFSET#{} @{} ORDER={} -> non_blank={}/{} ({:.1}%)",
                        idx, pix_off, order_name, stats.non_blank, stats.total, pct);

                    // Keep track of the best result
                    if stats.total > 0 {
                        let is_better = match &best_result {
                            None => true,
                            Some((_, _, prev)) => stats.non_blank > prev.non_blank,
                        };
                        if is_better {
                            best_result = Some((order_name.to_string(), pix_off, stats));
                        }
                    }
                }
                Err(e) => {
                    debug!("[dib_to_png] OFFSET#{} @{} ORDER={} -> err: {}", idx, pix_off, order_name, e);
                }
            }
        }
    }

    // Accept best result if >5% non-blank (lowered from 30% — photos with large bright/dark areas were falsely rejected)
    if let Some((_order_name, pix_off, stats)) = best_result {
        let pct = stats.non_blank as f64 / stats.total.max(1) as f64 * 100.0;
        if pct > 5.0 {
            debug!("[dib_to_png] ACCEPTED fallback: offset={} ({:.1}%)", pix_off, pct);
            return encode_rgba_to_png_data_url(&stats.rgba, w, h);
        }
    }

    Err(format!("All {} candidate offsets × byte-orderings produced blank/invalid images. DIB may be compressed or unsupported. hdr={} w={} h={} bpp={} comp={} len={}",
        candidate_offsets.len(), header_size, width, height_raw, bpp, compression, dib.len()))
}

/// Byte-order conversion functions for DIB pixel data
fn order_bgra(p: &[u8]) -> [u8; 4] { [p[2], p[1], p[0], p[3] ] }  // standard Windows DIB
fn order_argb(p: &[u8]) -> [u8; 4] { [p[1], p[2], p[3], p[0] ] }  // some formats (Qt, etc.)
fn order_rgba(p: &[u8]) -> [u8; 4] { [p[0], p[1], p[2], p[3] ] }  // standard PNG/OpenGL order
fn order_abgr(p: &[u8]) -> [u8; 4] { [p[3], p[2], p[1], p[0] ] }  // reversed
fn order_bgr(p: &[u8]) -> [u8; 4]  { [p[2], p[1], p[0], 255]   }  // 24-bit BGR

struct PixelExtractionResult {
    rgba: Vec<u8>,
    total: u64,
    non_blank: u64,
}

fn try_pixel_extraction(
    dib: &[u8], w: u32, h: u32, top_down: bool,
    pixel_offset: usize, row_stride: u32, bytes_per_pixel: u32,
    convert_fn: fn(&[u8]) -> [u8; 4],
) -> Result<PixelExtractionResult, String> {
    let expected_len = (w * h * 4) as usize;
    let mut rgba = Vec::with_capacity(expected_len);

    for y in 0..h {
        let src_y = if top_down { y } else { h - 1 - y };
        let src_off = (pixel_offset as u32 + src_y * row_stride) as usize;
        for x in 0..w {
            let off = src_off + (x * bytes_per_pixel) as usize;
            if off + bytes_per_pixel as usize > dib.len() {
                return Err(format!("pixel read overflow at ({},{}) off={}", x, y, off));
            }
            rgba.extend_from_slice(&convert_fn(&dib[off..off + bytes_per_pixel as usize]));
        }
    }

    // Count non-blank pixels (non-transparent AND not near-white)
    let total = (rgba.len() / 4) as u64;
    let mut non_blank = 0u64;
    for i in 0..total {
        let idx = (i * 4) as usize;
        let a = rgba[idx + 3];
        let r = rgba[idx]; let g = rgba[idx + 1]; let b = rgba[idx + 2];
        if a > 20 && (r < 240 || g < 240 || b < 240) {
            non_blank += 1;
        }
    }

    Ok(PixelExtractionResult { rgba, total, non_blank })
}

fn encode_rgba_to_png_data_url(rgba: &[u8], w: u32, h: u32) -> Result<String, String> {
    use base64::Engine;

    // Sample a few final pixels for log
    if !rgba.is_empty() {
        let pts = [(w/2, h/2), (5u32, 5u32), (w-6, h-6)];
        for &(sx, sy) in &pts {
            if sx < w && sy < h {
                let idx = ((sy * w + sx) * 4) as usize;
                if idx + 3 < rgba.len() {
                    debug!("  FINAL PIXEL@({},{})=({},{},{},{})", sx, sy,
                        rgba[idx], rgba[idx+1], rgba[idx+2], rgba[idx+3]);
                }
            }
        }
    }

    let mut png_buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_buf, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| format!("png header: {}", e))?;
        writer.write_image_data(rgba).map_err(|e| format!("png data: {}", e))?;
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_buf);
    debug!("[dib_to_png] PNG output: {} bytes", png_buf.len());
    Ok(format!("data:image/png;base64,{}", b64))
}
/// tauri.conf.json 里出厂自带的占位 pubkey。只要它还在，就说明更新服务
/// **尚未配置**——此时必须明确报错，而不是继续谎报"已是最新版本"（A7）。
const PLACEHOLDER_UPDATER_PUBKEY: &str = "placeholder_pubkey_replace_in_production";

/// 从已解析的 Tauri 插件配置里读取 updater 的 pubkey。
fn updater_pubkey(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 只做"有没有更新"的检查，不下载不安装。
/// 返回 `{ hasUpdate, version, notes, date }`；未配置更新服务时返回 Err。
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(mobile)]
    {
        let _ = &app;
        return Err("更新功能仅支持桌面端".to_string());
    }

    #[cfg(not(mobile))]
    {
        use tauri_plugin_updater::UpdaterExt;

        // A7：pubkey 缺失或仍是占位值 → 明确告知"更新服务未配置"
        let pubkey = updater_pubkey(&app).unwrap_or_default();
        if pubkey.trim().is_empty() || pubkey == PLACEHOLDER_UPDATER_PUBKEY {
            return Err("更新服务未配置：tauri.conf.json 的 plugins.updater.pubkey 仍是占位值".to_string());
        }

        let updater = app
            .updater()
            .map_err(|e| format!("更新服务未配置或初始化失败: {}", e))?;

        match updater.check().await {
            Ok(Some(update)) => {
                info!("[Updater] new version available: {}", update.version);
                Ok(serde_json::json!({
                    "hasUpdate": true,
                    "version": update.version,
                    "notes": update.body,
                    "date": update.date.map(|d| d.to_string()),
                }))
            }
            Ok(None) => {
                info!("[Updater] already up to date");
                Ok(serde_json::json!({ "hasUpdate": false }))
            }
            Err(e) => Err(format!("检查更新失败: {}", e)),
        }
    }
}

/// 用户确认后真正下载 + 安装 + 重启（A7：与"检查"解耦，UI 先弹确认框）。
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = &app;
        return Err("更新功能仅支持桌面端".to_string());
    }

    #[cfg(not(mobile))]
    {
        use tauri_plugin_updater::UpdaterExt;

        let updater = app.updater().map_err(|e| e.to_string())?;
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => return Err("没有可用更新".to_string()),
            Err(e) => return Err(format!("检查更新失败: {}", e)),
        };

        update
            .download_and_install(
                |chunk_size, total_size| {
                    debug!("[Updater] downloaded {} bytes (total: {:?})", chunk_size, total_size);
                },
                || {
                    info!("[Updater] download finished");
                },
            )
            .await
            .map_err(|e| format!("下载安装失败: {}", e))?;

        info!("[Updater] installed, relaunching");
        // restart() 发散（!），后面的代码不会执行
        app.restart();
    }
}

#[tauri::command]
async fn login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    phone: String,
    code: String,
) -> Result<serde_json::Value, String> {
    let server_url = state.config.lock().unwrap().server_url.clone();
    if server_url.trim().is_empty() {
        return Err("服务器地址未配置，请先在设置中填写服务器地址".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/auth/login", server_url))
        .json(&serde_json::json!({ "phone": phone, "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(token) = body.get("token").and_then(|t| t.as_str()) {
        {
            let mut cfg = state.config.lock().unwrap();
            cfg.token = Some(token.to_string());
            if let Some(user) = body.get("user") {
                cfg.user_id = user.get("id").and_then(|id| id.as_str()).map(|s| s.to_string());
            }
        }
        // A1：登录态落盘，重启后不必重新登录
        persist_state_config(&app);
    }
    Ok(body)
}

#[tauri::command]
fn enable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|e| e.to_string())
}

#[tauri::command]
fn disable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().disable().map_err(|e| e.to_string())
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn register_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    #[cfg(not(mobile))]
    {
        let handle = app.clone();
        let shortcut_clone = shortcut.clone();
        debug!("[Shortcut] Registering custom shortcut: '{}'", shortcut_clone);

        let shortcut_obj: Shortcut = shortcut_clone
            .parse()
            .map_err(|e| {
                error!("[Shortcut] Failed to parse '{}': {}", shortcut_clone, e);
                format!("Invalid shortcut '{}': {}", shortcut_clone, e)
            })?;

        // Use on_shortcut() with a per-shortcut closure so the handler actually fires.
        // The eval-based toggle expects window.__toggleAiPanel to exist in the main webview.
        let sc_label = shortcut_clone.clone();
        handle.global_shortcut().on_shortcut(shortcut_obj, move |app, _sc, _event| {
            debug!("[GlobalShortcut:custom] '{}' triggered → toggle AI panel", sc_label);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("if(window.__toggleAiPanel) window.__toggleAiPanel()");
            }
        }).map_err(|e| {
            error!("[Shortcut] on_shortcut failed for '{}': {}", shortcut_clone, e);
            e.to_string()
        })?;

        debug!("[Shortcut] ✅ Successfully registered: '{}'", shortcut_clone);
    }
    Ok(())
}

#[tauri::command]
fn unregister_all_shortcuts(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(mobile))]
    {
        app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle main window visibility: show+focus if hidden/minimized/backgrounded, hide if focused.
#[tauri::command]
fn toggle_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let minimized = window.is_minimized().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if minimized || !focused {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
    }
}

/// Start the native clipboard monitor thread (event-driven, replaces JS polling).
/// Idempotent: calling while already monitoring is a no-op.
#[tauri::command]
fn start_clipboard_monitor(state: tauri::State<AppState>, app: tauri::AppHandle) {
    if state.is_monitoring.load(Ordering::Relaxed) {
        debug!("[Monitor] Already running, skipping");
        return;
    }
    state.is_monitoring.store(true, Ordering::Relaxed);
    debug!("[Monitor] Starting native clipboard monitor thread...");

    let handle = app.clone();
    let stop = state.is_monitoring.clone();
    thread::spawn(move || {
        clipboard_monitor::start_monitor(handle, stop);
    });
}

/// Stop the native clipboard monitor thread. Sets the flag AND drops the
/// Monitor's Shutdown handle so the blocking `recv()` unblocks immediately
/// (otherwise the monitor thread would wait forever for the next clipboard message).
#[tauri::command]
fn stop_clipboard_monitor(state: tauri::State<AppState>) {
    if !state.is_monitoring.load(Ordering::Relaxed) {
        debug!("[Monitor] Already stopped, skipping");
        return;
    }
    state.is_monitoring.store(false, Ordering::Relaxed);
    clipboard_monitor::request_stop_monitor();
    debug!("[Monitor] Stopping native clipboard monitor (Shutdown signal sent)");
}

/// Try `requested` first, then each fallback in order, and report EXACTLY what
/// ended up being registered.
///
/// A8: when the OS (or another app) already owns the requested hotkey we used to
/// silently fall back to an alternative and the UI kept showing the key the user
/// picked — i.e. the app lied. `effective` now carries the truth back to the UI.
fn register_with_fallback<F>(
    handle: &tauri::AppHandle,
    requested: &str,
    fallbacks: &[&str],
    handler: F,
) -> serde_json::Value
where
    F: Fn(&tauri::AppHandle, &Shortcut, ShortcutEvent) + Send + Sync + Clone + 'static,
{
    let mut candidates: Vec<String> = vec![requested.to_string()];
    for f in fallbacks {
        if !candidates.iter().any(|c| c == f) {
            candidates.push((*f).to_string());
        }
    }

    let mut last_err = String::new();
    for (idx, candidate) in candidates.iter().enumerate() {
        let sc = match candidate.parse::<Shortcut>() {
            Ok(sc) => sc,
            Err(e) => {
                last_err = format!("无法解析快捷键 '{}': {}", candidate, e);
                error!("[Shortcut] {}", last_err);
                continue;
            }
        };
        match handle.global_shortcut().on_shortcut(sc, handler.clone()) {
            Ok(()) => {
                let is_fallback = idx > 0;
                if is_fallback {
                    warn!(
                        "[Shortcut] '{}' 无法注册（{}），已改用备选键 '{}'",
                        requested, last_err, candidate
                    );
                } else {
                    info!("[Shortcut] registered '{}'", candidate);
                }
                return serde_json::json!({
                    "ok": true,
                    "requested": requested,
                    "effective": candidate,
                    "fallback": is_fallback,
                    "reason": if is_fallback { last_err.clone() } else { String::new() },
                });
            }
            Err(e) => {
                last_err = format!("'{}' 注册失败: {}", candidate, e);
                if idx == 0 {
                    error!("[Shortcut] {}", last_err);
                } else {
                    debug!("[Shortcut] {}", last_err);
                }
            }
        }
    }

    error!("[Shortcut] '{}' 及全部备选键均注册失败: {}", requested, last_err);
    serde_json::json!({
        "ok": false,
        "requested": requested,
        "effective": null,
        "fallback": false,
        "reason": last_err,
    })
}

/// Re-register all global shortcuts from the frontend-supplied map.
/// Map keys: "quickPaste", "toggleWindow", "toggleAiPanel". Also persists them
/// into AppConfig.
///
/// A8: returns a per-id report `{ ok, requested, effective, fallback, reason }`
/// so the UI can show the key combination that actually took effect.
#[tauri::command]
fn set_global_shortcuts(
    app: tauri::AppHandle,
    shortcuts: HashMap<String, String>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    #[cfg(not(mobile))]
    {
        let handle = app.clone();
        handle.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
        let mut report: HashMap<String, serde_json::Value> = HashMap::new();

        // ── QuickPaste ──
        if let Some(qp) = shortcuts.get("quickPaste") {
            let fallbacks: Vec<&str> = if qp.to_lowercase().contains("shift+v") {
                vec!["Alt+Shift+V", "Ctrl+Shift+K", "Ctrl+Alt+V"]
            } else {
                vec!["Ctrl+Shift+V", "Alt+Shift+V", "Ctrl+Shift+K"]
            };
            report.insert(
                "quickPaste".to_string(),
                register_with_fallback(&handle, qp, &fallbacks, |app_h, _shortcut, _event| {
                    // Debounce key-repeat
                    if let Some(s) = app_h.try_state::<AppState>() {
                        let mut last = s.last_qp_toggle.lock().unwrap();
                        if last.elapsed() < std::time::Duration::from_millis(300) { return; }
                        *last = Instant::now();
                    }
                    // Always destroy + recreate (reusing stale Vue DOM causes empty outline)
                    if let Some(existing) = app_h.get_webview_window("quick-paste") {
                        let _ = existing.close();
                    }
                    ensure_quick_paste_window(app_h);
                }),
            );
        }

        // ── Toggle Window ──
        if let Some(tw) = shortcuts.get("toggleWindow") {
            let fallbacks: Vec<&str> = vec!["Ctrl+Alt+S", "Super+Alt+Space", "Ctrl+Alt+Enter"];
            report.insert(
                "toggleWindow".to_string(),
                register_with_fallback(&handle, tw, &fallbacks, |app_h, _shortcut, _event| {
                    // Debounce: ignore OS key-repeat AND potential key-up events (500ms covers long holds)
                    let should_fire = if let Some(s) = app_h.try_state::<AppState>() {
                        let mut last = s.last_tw_toggle.lock().unwrap();
                        if last.elapsed() < std::time::Duration::from_millis(500) {
                            debug!("[setGS:tw] DEBOUNCED ({}ms ago)", last.elapsed().as_millis());
                            false
                        } else { *last = Instant::now(); true }
                    } else { true };
                    if !should_fire { return; }

                    debug!("[setGS:tw] Triggered → toggle main window");
                    if let Some(w) = app_h.get_webview_window("main") {
                        let min = w.is_minimized().unwrap_or(false);
                        let foc = w.is_focused().unwrap_or(false);
                        if min || !foc { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
                        else { let _ = w.hide(); }
                    }
                }),
            );
        }

        // ── Toggle AI Panel ──
        if let Some(ai) = shortcuts.get("toggleAiPanel") {
            let fallbacks: Vec<&str> = vec!["Ctrl+Shift+A", "Ctrl+Alt+A", "Alt+Shift+A"];
            report.insert(
                "toggleAiPanel".to_string(),
                register_with_fallback(&handle, ai, &fallbacks, |app_h, _shortcut, _event| {
                    let should_fire = if let Some(s) = app_h.try_state::<AppState>() {
                        let mut last = s.last_ai_toggle.lock().unwrap();
                        if last.elapsed() < std::time::Duration::from_millis(500) {
                            false
                        } else {
                            *last = Instant::now();
                            true
                        }
                    } else {
                        true
                    };
                    if !should_fire { return; }

                    debug!("[setGS:ai] Triggered → toggle AI panel");
                    if let Some(w) = app_h.get_webview_window("main") {
                        let _ = w.eval("if (window.__toggleAiPanel) window.__toggleAiPanel()");
                    }
                }),
            );
        }

        // Persist to config（保存用户"期望"的键位；实际生效键位以返回值回传前端）
        if let Some(state) = app.try_state::<AppState>() {
            let mut cfg = state.config.lock().unwrap();
            cfg.quick_paste_shortcut = shortcuts.get("quickPaste").cloned();
            cfg.toggle_window_shortcut = shortcuts.get("toggleWindow").cloned();
            cfg.toggle_ai_panel_shortcut = shortcuts.get("toggleAiPanel").cloned();
        }
        persist_state_config(&app);
        return Ok(report);
    }

    #[cfg(mobile)]
    Ok(HashMap::new())
}

/// Open image preview in a new Tauri window.
#[tauri::command]
async fn open_image_viewer(app: tauri::AppHandle, image_data_url: String, title: String) -> Result<(), String> {
    let escaped_url = image_data_url.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");

    let html = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:100vw;height:100vh;overflow:hidden;background:#0a0a0a;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#ccc}}
#img-wrap{{transition:transform .2s ease;transform-origin:center center}}
img{{max-width:96vw;max-height:88vh;object-fit:contain;border-radius:4px;transition:transform .2s ease}}
.bar{{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:6px;padding:8px 14px;background:rgba(255,255,255,0.08);border-radius:10px;backdrop-filter:blur(8px)}}
button{{padding:7px 14px;border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:500;transition:background .15s}}
.btn-primary{{background:#6366f1;color:#fff}}.btn-primary:hover{{background:#5558e3}}
.btn-ghost{{background:rgba(255,255,255,0.08);color:#aaa;border:1px solid rgba(255,255,255,0.1)}}.btn-ghost:hover{{background:rgba(255,255,255,0.15);color:#fff}}
.info{{position:fixed;top:16px;right:16px;background:rgba(0,0,0,0.7);padding:10px 14px;border-radius:8px;font-size:11px;line-height:1.6;display:none;backdrop-filter:blur(8px);max-width:200px}}
.info.show{{display:block}}
.zoom-label{{position:fixed;top:16px;left:16px;background:rgba(0,0,0,0.6);padding:4px 10px;border-radius:6px;font-size:11px;display:none}}
.zoom-label.show{{display:block}}
</style></head>
<body>
<div id="img-wrap"><img id="iv-img" src="{}" alt="preview" /></div>
<div class="zoom-label" id="zoomLabel">100%</div>
<div class="info" id="infoPanel"></div>
<div class="bar">
  <button class="btn-ghost" onclick="doZoom(-0.25)" title="zoom out">-</button>
  <button class="btn-ghost" onclick="doZoom(0)" title="reset" style="min-width:48px" id="zoomBtn">100%</button>
  <button class="btn-ghost" onclick="doZoom(0.25)" title="zoom in">+</button>
  <button class="btn-ghost" onclick="doRotate(-90)" title="rotate left">&#x21B6;</button>
  <button class="btn-ghost" onclick="doRotate(90)" title="rotate right">&#x21B7;</button>
  <button class="btn-ghost" onclick="toggleInfo()" title="info">i</button>
  <button class="btn-primary" id="copyBtn" onclick="doCopy()">Copy</button>
  <button class="btn-ghost" onclick="window.close()">Close</button>
</div>
<script>
var zoom=1,rot=0,img=document.getElementById("iv-img");
function applyTransform(){{
  document.getElementById("img-wrap").style.transform="scale("+zoom+") rotate("+rot+"deg)";
  var l=document.getElementById("zoomLabel"),b=document.getElementById("zoomBtn"),pct=Math.round(zoom*100)+"%";
  b.textContent=pct;
  if(zoom!==1||rot!==0){{l.textContent=pct;l.classList.add("show")}}else l.classList.remove("show")
}}
function doZoom(d){{if(d===0)zoom=1;else zoom=Math.max(0.25,Math.min(4,zoom+d));applyTransform()}}
function doRotate(d){{rot=(rot+d)%360;applyTransform()}}
img.addEventListener("wheel",function(e){{e.preventDefault();doZoom(e.deltaY<0?0.1:-0.1)}});
function toggleInfo(){{
  var p=document.getElementById("infoPanel");
  if(p.classList.contains("show")){{p.classList.remove("show");return}}
  var w=img.naturalWidth,h=img.naturalHeight,sizeStr="";
  try{{var bytes=atob(img.src.split(",")[1]).length;sizeStr=(bytes>1048576?(bytes/1048576).toFixed(1)+" MB":(bytes/1024).toFixed(0)+" KB")}}catch{{}}
  p.innerHTML="<b>"+({{}}||"image").replace(/</g,"&lt;")+"</b><br>"+w+" x "+h+(sizeStr?"<br>"+sizeStr:"")+(zoom!==1?"<br>Zoom: "+Math.round(zoom*100)+"%":"");
  p.classList.add("show")
}}
function doCopy(){{
  var c=document.createElement("canvas");
  c.width=img.naturalWidth;c.height=img.naturalHeight;
  c.getContext("2d").drawImage(img,0,0);
  c.toBlob(function(b){{
    navigator.clipboard.write([new ClipboardItem({{"image/png":b}})]).then(function(){{
      document.getElementById("copyBtn").textContent="Copied!";
      setTimeout(function(){{document.getElementById("copyBtn").textContent="Copy"}},1500)
    }},function(e){{alert("Copy failed: "+e)}})
  }},"image/png")
}}
</script></body></html>"#,
        escaped_url
    );

    let label = format!("imgview-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() % 10000);

    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(900.0, 700.0)
        .min_inner_size(400.0, 300.0)
        .center()
        .resizable(true)
        .decorations(true)
        .initialization_script(&format!("document.open();document.write({:?});document.close();", html))
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 发送验证码。A1：地址不再硬编码 localhost:3001，改读用户配置的 server_url。
#[tauri::command]
async fn send_verification_code(
    state: tauri::State<'_, AppState>,
    phone: String,
) -> Result<serde_json::Value, String> {
    let server_url = state.config.lock().unwrap().server_url.clone();
    if server_url.trim().is_empty() {
        return Err("服务器地址未配置，请先在设置中填写服务器地址".to_string());
    }
    let url = format!("{}/api/auth/send-code", server_url);
    info!("[Auth] send_verification_code -> {}", url);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "phone": phone }))
        .send()
        .await
        .map_err(|e| format!("请求 {} 失败: {}", url, e))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body)
}

// ============================================================================
// 系统标题栏着色（深色模式 → 黑底白字，浅色模式 → 浅灰底深字）
// ============================================================================
//
// Windows 的标题栏由系统绘制，webview CSS 无法控制。
// 通过 DWM API 强制设置标题栏颜色：
//   - Win11 22H2+ : DWMWA_CAPTION_COLOR (35) + DWMWA_TEXT_COLOR (36) — 完全自定义
//   - Win10 1903+ : DWMWA_USE_IMMERSIVE_DARK_MODE (19) — 仅切换系统暗色变体
// 不支持的 Windows 版本静默失败，标题栏保持系统默认。
#[cfg(target_os = "windows")]
fn apply_window_titlebar_color(window: &tauri::WebviewWindow, dark: bool) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    // Tauri 的 hwnd() 返回 tauri::window::Hwnd，inner is isize
    let hwnd_raw = match window.hwnd() {
        Ok(h) => h.0,
        Err(e) => {
            error!("[TitleBar] hwnd() failed: {}", e);
            return;
        }
    };
    let hwnd = hwnd_raw as windows_sys::Win32::Foundation::HWND;

    unsafe {
        // 1) 主方案：DWMWA_CAPTION_COLOR + DWMWA_TEXT_COLOR（Win11 22H2+）
        //    颜色格式：COLORREF = 0x00BBGGRR（小端 BGR）
        let (caption_bgr, text_bgr): (u32, u32) = if dark {
            (0x000000, 0xFFFFFF) // 黑底 + 白字
        } else {
            (0xF3F3F3, 0x1A1A1A) // 浅灰底 + 深字
        };

        let r1 = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR as u32,
            &caption_bgr as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        if r1 != 0 {
            error!("[TitleBar] DWMWA_CAPTION_COLOR failed: {} (需要 Win11 22H2+)", r1);
        }

        let r2 = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR as u32,
            &text_bgr as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        if r2 != 0 {
            error!("[TitleBar] DWMWA_TEXT_COLOR failed: {}", r2);
        }

        // 2) Fallback：DWMWA_USE_IMMERSIVE_DARK_MODE（Win10 1903+，Win11 也支持）
        //    对不支持 caption 颜色的版本，至少让标题栏跟随系统暗色
        let immersive: u32 = if dark { 1 } else { 0 };
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            &immersive as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_window_titlebar_color(_window: &tauri::WebviewWindow, _dark: bool) {
    // macOS / Linux 暂不处理；macOS 可后续用 NSWindow.titlebarAppearsTransparent
}

/// 前端 invoke 入口：切换标题栏暗色/亮色
///
/// 注意：Tauri v2 默认不做 camelCase ↔ snake_case 自动转换，必须显式声明。
/// 前端调用 `invoke('set_titlebar_mode', { isDark: ... })`，这里必须映射到 `is_dark`。
#[tauri::command(rename_all = "camelCase")]
fn set_titlebar_mode(window: tauri::WebviewWindow, is_dark: bool) {
    apply_window_titlebar_color(&window, is_dark);
    info!("[TitleBar] set_titlebar_mode is_dark={}", is_dark);
}

// 设置系统托盘（Tauri 2.x）
fn setup_tray_icon(app: &tauri::App) -> tauri::Result<()> {
    // 加载托盘图标（优先使用应用默认图标）
    let tray_icon = app.default_window_icon()
        .cloned();

    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quick_paste_item = MenuItem::with_id(app, "quick_paste", "快速粘贴", true, None::<&str>)?;
    let toggle_theme_item = MenuItem::with_id(app, "toggle_theme", "切换深色/浅色", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let check_update_item = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    // 同步状态（禁用状态，作为信息展示）
    let sync_status_item = MenuItem::with_id(app, "sync_status", "● 已同步", false, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append_items(&[&show_item, &quick_paste_item, &toggle_theme_item, &settings_item, &check_update_item, &sync_status_item, &hide_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("ClipSync - 剪贴板同步")
        .on_menu_event(|app, event| {
            debug!("[Tray] Menu event: id={:?}", event.id);
            match event.id.as_ref() {
                "show" => {
                    ensure_window_visible(&app);
                    debug!("[Tray] -> show window");
                }
                "quick_paste" => {
                    // Use the dedicated quick-paste floating popup
                    ensure_quick_paste_window(&app);
                    debug!("[Tray] -> toggle QuickPaste popup");
                }
                "toggle_theme" => {
                    if let Some(window) = ensure_window_visible(&app) {
                        // 调用前端 useTheme().toggleMode()
                        let _ = window.eval("if(window.__toggleTheme) window.__toggleTheme()");
                        debug!("[Tray] -> toggle theme");
                    }
                }
                "settings" => {
                    if let Some(window) = ensure_window_visible(&app) {
                        // A7：优先 emit 事件（B10 负责 listen 并跳转）。
                        // 保留原 eval 作为兜底，避免 B10 未落地时托盘"设置"变成死菜单。
                        match window.eval("window.switchPage('settings')") {
                            Ok(_) => debug!("[Tray] -> open settings (eval fallback)"),
                            Err(e) => error!("[Tray] settings eval error: {}", e),
                        }
                    }
                    match app.emit("tray://open-settings", ()) {
                        Ok(_) => debug!("[Tray] -> emitted tray://open-settings"),
                        Err(e) => error!("[Tray] emit tray://open-settings failed: {}", e),
                    }
                }
                "check_update" => {
                    // A7：不再 eval 前端的 window.checkForUpdates（该函数只弹"已是最新"的假
                    // 成功）。改为 emit 事件，由前端统一监听后走真实 check_for_updates。
                    if let Some(window) = ensure_window_visible(&app) {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    match app.emit("tray://check-updates", ()) {
                        Ok(_) => debug!("[Tray] -> emitted tray://check-updates"),
                        Err(e) => error!("[Tray] emit tray://check-updates failed: {}", e),
                    }
                }
                "hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                        debug!("[Tray] -> hide window");
                    }
                }
                "quit" => {
                    debug!("[Tray] -> quit app");
                    let _ = app.exit(0);
                }
                other => {
                    debug!("[Tray] Unknown menu item: {}", other);
                }
            }
        });

    // 如果图标加载成功，设置托盘图标
    if let Some(icon) = tray_icon {
        builder = builder.icon(icon);
        debug!("[Tray] Icon loaded (using default window icon)");
    } else {
        debug!("[Tray] WARNING: No tray icon found, using default");
    }

    // 左键单击托盘图标：切换窗口显示/隐藏（仅处理左键，不干扰右键菜单）
    builder = builder.on_tray_icon_event(|tray, event| {
        match event {
            // 仅处理左键松开事件，右键由系统弹出菜单
            tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } => {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    // Check if window is minimized or hidden
                    let is_minimized = window.is_minimized().unwrap_or(false);
                    let is_visible = window.is_visible().unwrap_or(false);

                    if !is_visible || is_minimized {
                        // Hidden or minimized → show + unminimize + focus
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        debug!("[Tray] Left-click -> show (was {})", if is_minimized { "minimized" } else { "hidden" });
                    } else {
                        // Visible and not minimized → hide to tray
                        let _ = window.hide();
                        debug!("[Tray] Left-click -> hide");
                    }
                }
            }
            _ => {}
        }
    });

    builder.build(app)?;

    debug!("[Tray] Tray icon setup complete");
    Ok(())
}

/// Resize the QuickPaste window (called from JS when input gains focus).
/// Fallback if JS setCurrentWindow().setSize() fails.
#[tauri::command(rename_all = "camelCase")]
async fn resize_qp_window(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("quick-paste") {
        win.set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| format!("set_size failed: {}", e))?;
        debug!("[QP] Rust resized to {}x{}", width, height);
        Ok(())
    } else {
        Err("quick-paste window not found".into())
    }
}

/// Create (or recreate) the QuickPaste floating popup window.
/// Uses URL parameter ?mode=qp so App.vue detects standalone mode SYNCHRONOUSLY
/// (no race condition with Vue mount — window.location.search is available immediately).
///
/// Lifecycle strategy: DESTROY on hide, RECREATE on next show.
/// Rationale: clearing innerHTML to prevent ghost outline destroys Vue's virtual DOM,
/// making re-show produce an empty window. Destroying + recreating is 100% reliable.
fn ensure_quick_paste_window(app: &tauri::AppHandle) {
    // If window already exists, destroy it completely (don't reuse — avoids stale Vue state)
    if let Some(qp_win) = app.get_webview_window("quick-paste") {
        let _ = qp_win.close();
        // Small yield to let OS clean up the window handle
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    // Position: centered horizontally, upper-center vertically.
    // Use collapsed height (58px) for initial position to avoid flickering.
    let (qp_x, qp_y) = if let Some(Some(monitor)) = std::result::Result::ok(app.primary_monitor()) {
        let sz = monitor.size();
        let pos = monitor.position();
        let x = pos.x as f64 + (sz.width as f64 - 660.0) / 2.0;
        let y = pos.y as f64 + (sz.height as f64 - 470.0) / 3.5;
        (x, y)
    } else {
        (0.0, 0.0)
    };

    // Always create a fresh floating popup — ?mode=qp tells App.vue to render QuickPasteStandalone
    match tauri::WebviewWindowBuilder::new(
        app,
        "quick-paste",
        tauri::WebviewUrl::App("index.html?mode=qp".into()),
    )
    .title("ClipSync - Quick Paste")
    .inner_size(660.0, 58.0)
    .position(qp_x, qp_y)
    .decorations(false)
    .always_on_top(true)
    .resizable(true)
    .skip_taskbar(true)
    .build()
    {
        Ok(_) => {
            debug!("[QuickPaste] Floating window created at ({}, {})", qp_x, qp_y);
            if let Some(w) = app.get_webview_window("quick-paste") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        Err(e) => error!("[QuickPaste] Failed: {}", e),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A5：panic 也写日志。release 下 panic = abort 且无控制台，默认 hook 只打到 stderr，
    // 崩溃现场会永久丢失。这里补一条 log::error! 让它落进日志文件。
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error!("[PANIC] {}", info);
        default_panic_hook(info);
    }));

    let state = AppState {
        config: Arc::new(Mutex::new(AppConfig::default())),
        is_monitoring: Arc::new(AtomicBool::new(false)),
        last_qp_toggle: Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(10))),
        last_tw_toggle: Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(10))),
        last_ai_toggle: Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(10))),
    };

    tauri::Builder::default()
        // A6：单实例锁。必须排在其他插件之前注册，二次启动时把已有窗口拉起来而不是再开一个进程。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            info!("[SingleInstance] Second launch detected → focusing existing window");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // A5：日志同时落盘（Tauri log dir）与 stdout，单文件 2MB 轮转
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("clipsync".into()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .max_file_size(2 * 1024 * 1024)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // A6：记住窗口位置/尺寸。
        // 显式不恢复 VISIBLE —— 本应用靠"隐藏到托盘"退出，若把隐藏状态也恢复，
        // 下次启动会看不到主窗口（表现得像没启动）。DECORATIONS 同理不恢复。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            clear_auth,
            open_url,
            reveal_in_folder,
            get_clipboard_content,
            set_clipboard_content,
            set_clipboard_files,
            read_file_content,
            read_file_content_base64,
            copy_local_files,
            get_clipboard_files,
            save_and_copy_file,
            check_clipboard_image_info,
            get_clipboard_image,
            convert_bmp_to_png,
            check_for_updates,
            install_update,
            login,
            send_verification_code,
            enable_autostart,
            disable_autostart,
            is_autostart_enabled,
            register_shortcut,
            unregister_all_shortcuts,
            set_global_shortcuts,
            toggle_window,
            open_image_viewer,
            set_titlebar_mode,
            resize_qp_window,
            start_clipboard_monitor,
            stop_clipboard_monitor,
        ])
        .setup(|app| {
            info!("[Setup] ClipSync starting up");

            // A1：先把持久化的配置读回来（缺失/损坏 → 自动回落默认值），
            // 后面注册快捷键才能用上用户保存的键位。
            let persisted = load_persisted_config(app.handle());
            {
                let st = app.state::<AppState>();
                let mut cfg = st.config.lock().unwrap();
                *cfg = persisted.clone();
            }
            if persisted.server_url.trim().is_empty() {
                warn!("[Config] server_url 为空 → 未连接状态，请在 设置 → 服务器地址 中填写");
            }

            // 设置系统托盘
            setup_tray_icon(app)?;

            // 拦截窗口关闭事件：点 X = 最小化到托盘，不退出进程
            let window = app.get_webview_window("main").expect("main window missing");
            let app_handle = app.handle().clone();

            // 初始化标题栏颜色（默认深色，webview 加载后会通过 invoke 校正）
            apply_window_titlebar_color(&window, true);
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 阻止默认关闭行为，改为隐藏窗口到托盘
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    debug!("[Window] Close intercepted -> hidden to tray");
                }
            });

            // 注册全局快捷键（快速粘贴面板 + 显隐主窗口）
            // 使用 on_shortcut() 为每个快捷键注册独立闭包，彻底避免字符串比较问题。
            // 如果主快捷键被占用，自动尝试备选键位。
            #[cfg(not(mobile))]
            {
                let handle = app.handle().clone();
                let cfg = app.state::<AppState>().config.lock().unwrap().clone();

                // 先卸载所有已有快捷键
                let _ = handle.global_shortcut().unregister_all();

                let qp_str = cfg.quick_paste_shortcut
                    .unwrap_or_else(|| "Ctrl+Shift+V".to_string());
                let tw_str = cfg.toggle_window_shortcut
                    .unwrap_or_else(|| "Ctrl+Alt+Space".to_string());
                let ai_str = cfg.toggle_ai_panel_shortcut
                    .unwrap_or_else(|| "Ctrl+Shift+A".to_string());

                info!("[Setup] Registering global shortcuts: qp='{}' tw='{}' ai='{}'", qp_str, tw_str, ai_str);

                // ── QuickPaste: show/hide independent floating popup ──
                let qp_fallbacks: Vec<&str> = if qp_str.to_lowercase().contains("shift+v") {
                    vec!["Alt+Shift+V", "Ctrl+Shift+K", "Ctrl+Alt+V"]
                } else {
                    vec!["Ctrl+Shift+V", "Alt+Shift+V", "Ctrl+Shift+K"]
                };
                let qp_report = register_with_fallback(&handle, &qp_str, &qp_fallbacks, |app, _shortcut, _event| {
                    // Debounce: ignore OS key-repeat within 300ms
                    {
                        let should_fire = if let Some(s) = app.try_state::<AppState>() {
                            let mut last = s.last_qp_toggle.lock().unwrap();
                            if last.elapsed() < std::time::Duration::from_millis(300) { false }
                            else { *last = Instant::now(); true }
                        } else { false };
                        if !should_fire { return; }
                    }

                    debug!("[GlobalShortcut:qp] Triggered → recreate QuickPaste popup");
                    // Always destroy + recreate (reusing a hidden window with stale Vue DOM causes empty outline)
                    if let Some(existing) = app.get_webview_window("quick-paste") {
                        let _ = existing.close();
                    }
                    ensure_quick_paste_window(app);
                });

                // ── Toggle Window: show/hide main window (pure Rust) ──
                let tw_fallbacks: Vec<&str> = vec!["Ctrl+Alt+S", "Super+Alt+Space", "Ctrl+Alt+Enter"];
                let tw_report = register_with_fallback(&handle, &tw_str, &tw_fallbacks, |app, _shortcut, _event| {
                    // Debounce: ignore OS key-repeat AND potential key-up events (500ms covers long holds)
                    {
                        let should_fire = if let Some(s) = app.try_state::<AppState>() {
                            let mut last = s.last_tw_toggle.lock().unwrap();
                            if last.elapsed() < std::time::Duration::from_millis(500) {
                                debug!("[GlobalShortcut:tw] DEBOUNCED ({}ms ago)", last.elapsed().as_millis());
                                false
                            } else { *last = Instant::now(); true }
                        } else { true };
                        if !should_fire { return; }
                    }

                    debug!("[GlobalShortcut:tw] Triggered → toggle main window");
                    if let Some(window) = app.get_webview_window("main") {
                        let minimized = window.is_minimized().unwrap_or(false);
                        let focused = window.is_focused().unwrap_or(false);
                        if minimized || !focused {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            let _ = window.hide();
                        }
                    } else {
                        error!("[GlobalShortcut:tw] ERROR: main window not found!");
                    }
                });

                // ── AI Panel: toggle AI sidebar (eval frontend __toggleAiPanel) ──
                let ai_fallbacks: Vec<&str> = vec!["Ctrl+Shift+A", "Ctrl+Alt+A", "Alt+Shift+A"];
                let ai_report = register_with_fallback(&handle, &ai_str, &ai_fallbacks, |app, _shortcut, _event| {
                    let should_fire = if let Some(s) = app.try_state::<AppState>() {
                        let mut last = s.last_ai_toggle.lock().unwrap();
                        if last.elapsed() < std::time::Duration::from_millis(500) {
                            false
                        } else {
                            *last = Instant::now();
                            true
                        }
                    } else {
                        true
                    };
                    if !should_fire { return; }

                    debug!("[GlobalShortcut:ai] Triggered → toggle AI panel");
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("if (window.__toggleAiPanel) window.__toggleAiPanel()");
                    }
                });

                // A8：启动时也把"实际生效键位"写进日志，便于排查"设置了但没生效"
                info!(
                    "[Setup] Shortcuts effective: quickPaste={} toggleWindow={} toggleAiPanel={}",
                    qp_report.get("effective").and_then(|v| v.as_str()).unwrap_or("<none>"),
                    tw_report.get("effective").and_then(|v| v.as_str()).unwrap_or("<none>"),
                    ai_report.get("effective").and_then(|v| v.as_str()).unwrap_or("<none>"),
                );
            }

            // A9：剪贴板监控不再在 setup 里无条件自启。
            // 由前端根据"自动同步"开关调用 start_clipboard_monitor / stop_clipboard_monitor
            // 实时启停，这样 autoSync=false 时真的不会再产生任何条目。
            info!("[Setup] Clipboard monitor idle — waiting for the autoSync setting to start it");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ClipSync");
}
