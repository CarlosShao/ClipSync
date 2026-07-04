use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_autostart::MacosLauncher;

mod clipboard_monitor;
mod crypto;
mod sync_client;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server_url: String,
    pub token: Option<String>,
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub quick_paste_shortcut: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:3001".to_string(),
            token: None,
            device_id: None,
            user_id: None,
            quick_paste_shortcut: Some("Ctrl+Shift+V".to_string()),
        }
    }
}

pub struct AppState {
    pub config: Arc<Mutex<AppConfig>>,
    pub is_monitoring: Arc<Mutex<bool>>,
}

// 系统托盘菜单命令
#[tauri::command]
fn tray_show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn tray_hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn tray_quit(app: tauri::AppHandle) {
    let _ = app.exit(0);
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
fn update_config(state: tauri::State<AppState>, config: AppConfig) {
    *state.config.lock().unwrap() = config;
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
    use clipboard_win::raw;
    raw::open().map_err(|e| format!("open: {}", e))?;
    let result = raw::set(13, content.as_bytes());
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

#[tauri::command]
fn save_and_copy_file(base64_data: String, filename: String) -> Result<String, String> {
    use std::fs;
    // 1. Decode base64
    let bytes = base64::decode(&base64_data)
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
                        eprintln!("[get_clipboard_files] CF_HDROP available, got {} file(s)", files.len());
                    }
                    Err(e) => {
                        eprintln!("[get_clipboard_files] CF_HDROP available but get_file_list failed: {}", e);
                    }
                }
            }
            let _ = clipboard_win::raw::close();
        }
        Err(e) => {
            eprintln!("[get_clipboard_files] clipboard open failed: {}", e);
        }
    }
    files
}

/// Lightweight check: is there an image on the clipboard? Returns size only (no data read, no base64).
/// Call this every 500ms instead of get_clipboard_image to avoid CPU-heavy base64 encoding.
#[tauri::command]
fn check_clipboard_image_info() -> serde_json::Value {
    use clipboard_win::raw;
    match raw::open() {
        Ok(()) => {
            let has_image = raw::is_format_avail(2) || raw::is_format_avail(8); // CF_BITMAP or CF_DIB
            let _ = raw::close();
            if has_image {
                // Re-open to get size (cheaper than reading + encoding full data)
                match raw::open() {
                    Ok(()) => {
                        let mut data = Vec::<u8>::new();
                        let size = raw::get_bitmap(&mut data).unwrap_or(0);
                        let _ = raw::close();
                        serde_json::json!({ "available": true, "size": size })
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
#[tauri::command]
fn get_clipboard_image() -> Result<String, String> {
    use clipboard_win::raw;

    raw::open().map_err(|e| format!("open clipboard: {}", e))?;

    if !raw::is_format_avail(2) && !raw::is_format_avail(8) {
        let _ = raw::close();
        return Ok(String::new());
    }

    let mut dib = Vec::<u8>::new();
    let n = raw::get_bitmap(&mut dib).map_err(|e| {
        let _ = raw::close();
        format!("read bitmap: {}", e)
    })?;

    let _ = raw::close();

    if n == 0 || dib.len() < 40 {
        return Ok(String::new());
    }

    eprintln!("[get_clipboard_image] raw {} bytes, starts with {:02x?}, has_BM={}",
        dib.len(), dib.iter().take(4).collect::<Vec<_>>(),
        dib.len() > 2 && &dib[0..2] == b"BM");

    // === Try 1: image crate BMP decoder (most reliable for standard BMP) ===
    if dib.len() > 14 && &dib[0..2] == b"BM" {
        match image::load_from_memory(&dib) {
            Ok(img) => {
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                eprintln!("[get_clipboard_image] image crate OK: {}x{}", w, h);
                return encode_rgba_to_png_data_url(&rgba, w, h);
            }
            Err(e) => {
                eprintln!("[get_clipboard_image] image crate failed: {}, trying manual parser", e);
            }
        }
    }

    // === Try 2: Manual DIB parsing (fallback for non-standard formats) ===
    let actual_dib = if &dib[0..2] == b"BM" && dib.len() > 14 { &dib[14..] } else { &dib };
    dib_to_png_data_url(actual_dib).map_err(|e| format!("get_clipboard_image: {}", e))
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

    eprintln!("[convert_bmp_to_png] decoded {} bytes, first 4: {:02x?}, has_BM_header: {}",
        raw_bytes.len(),
        raw_bytes.iter().take(4).collect::<Vec<_>>(),
        raw_bytes.len() > 2 && &raw_bytes[0..2] == b"BM");

    // Find actual DIB start — skip BM file header if present
    let dib = if raw_bytes.len() > 14 && &raw_bytes[0..2] == b"BM" {
        // Use pixel offset from BM header if it looks sane, otherwise default to 14
        let pix_off = u32::from_le_bytes(raw_bytes[10..14].try_into().unwrap());
        if pix_off >= 14 && pix_off < raw_bytes.len() as u32 {
            eprintln!("[convert_bmp_to_png] using BM pixel_offset={}", pix_off);
            &raw_bytes[pix_off as usize..]
        } else {
            eprintln!("[convert_bmp_to_png] bad pixel_offset={}, defaulting to 14", pix_off);
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
    use base64::Engine;

    if dib.len() < 40 {
        return Err(format!("DIB too short: {} bytes", dib.len()));
    }

    // Parse BITMAPINFOHEADER (first 40 bytes — common to all BMP versions)
    let header_size = i32::from_le_bytes(dib[0..4].try_into().unwrap());
    let width = i32::from_le_bytes(dib[4..8].try_into().unwrap());
    let height_raw = i32::from_le_bytes(dib[8..12].try_into().unwrap());
    let bpp = u16::from_le_bytes(dib[14..16].try_into().unwrap());
    let compression = u32::from_le_bytes(dib[16..20].try_into().unwrap());

    eprintln!("[dib_to_png] === NEW CONVERSION === {}x{} bpp={} comp={} hdr={} dib_len={}",
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
    eprintln!("[dib_to_png] --- HEX DUMP around header/pixel boundary ---");
    // Last 16 bytes of header area
    let dump_start = header_size.saturating_sub(16).max(0) as usize;
    for row in (dump_start..(header_size as usize + 64).min(dib.len())).step_by(16) {
        let end = (row + 16).min(dib.len());
        let hex: Vec<String> = dib[row..end].iter().map(|b| format!("{:02x}", b)).collect();
        let ascii: String = dib[row..end].iter().map(|b| if *b >= 0x20 && *b < 0x7f { *b as char } else { '.' }).collect();
        let marker = if row < header_size as usize { " [HDR]" } else { " [PX?]" };
        eprintln!("[dib_to_png] {:04x}: {}{} {}", row, marker, hex.join(" "), ascii);
    }

    // === Try standard approach first (header_size offset + BGRA for 32bpp) ===
    // Windows clipboard DIB is almost always BGRA at header_size offset
    if (header_size as usize) + (row_stride * h) as usize <= dib.len() {
        let standard_fn: fn(&[u8]) -> [u8; 4] = if bytes_per_pixel == 4 { order_bgra } else { order_bgr };
        let standard_name = if bytes_per_pixel == 4 { "BGRA" } else { "BGR" };
        if let Ok(stats) = try_pixel_extraction(dib, w, h, top_down, header_size as usize, row_stride, bytes_per_pixel, standard_fn) {
            let pct = stats.non_blank as f64 / stats.total.max(1) as f64 * 100.0;
            eprintln!("[dib_to_png] STANDARD offset={} ORDER={} → {:.1}%", header_size, standard_name, pct);
            if stats.total > 0 && pct > 30.0 {
                eprintln!("[dib_to_png] ACCEPTED standard: offset={} order={}", header_size, standard_name);
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
            eprintln!("[dib_to_png] SCAN found likely pixel start at offset {} (nz={}, uniq={})",
                probe_off, non_zero_count, unique_bytes.len());
            candidate_offsets.insert(1, probe_off); // insert early to try first
            break 'offset_search;
        }
    }

    eprintln!("[dib_to_png] Trying {} candidate offsets (fallback)", candidate_offsets.len());
    let mut best_result: Option<(String, usize, PixelExtractionResult)> = None;

    for (idx, &pix_off) in candidate_offsets.iter().enumerate() {
        eprintln!("[dib_to_png] Candidate #{}: offset={} (need {}, have {})",
            idx, pix_off, pix_off + (row_stride * h) as usize, dib.len());

        // Skip obviously invalid offsets
        if pix_off + (row_stride * h) as usize > dib.len() {
            eprintln!("[dib_to_png]   -> SKIP: truncated");
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
                    eprintln!("[dib_to_png] OFFSET#{} @{} ORDER={} -> non_blank={}/{} ({:.1}%)",
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
                    eprintln!("[dib_to_png] OFFSET#{} @{} ORDER={} -> err: {}", idx, pix_off, order_name, e);
                }
            }
        }
    }

    // Accept best result if >30% non-blank
    if let Some((_order_name, pix_off, stats)) = best_result {
        let pct = stats.non_blank as f64 / stats.total.max(1) as f64 * 100.0;
        if pct > 30.0 {
            eprintln!("[dib_to_png] ACCEPTED fallback: offset={} order={:.1}%", pix_off, pct);
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
                    eprintln!("  FINAL PIXEL@({},{})=({},{},{},{})", sx, sy,
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
    eprintln!("[dib_to_png] PNG output: {} bytes", png_buf.len());
    Ok(format!("data:image/png;base64,{}", b64))
}
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(not(mobile))]
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app.updater().map_err(|e| e.to_string())?;
        if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
            let version = update.version.clone();
            let _ = update.download_and_install(
                |chunk_size, total_size| {
                    println!("Downloaded {} bytes (total: {:?})", chunk_size, total_size);
                },
                || {
                    println!("Download finished");
                }
            ).await.map_err(|e| e.to_string())?;
            return Ok(serde_json::json!({ "hasUpdate": true, "version": version }));
        }
    }
    Ok(serde_json::json!({ "hasUpdate": false }))
}

#[tauri::command]
async fn login(state: tauri::State<'_, AppState>, phone: String, code: String) -> Result<serde_json::Value, String> {
    let config = state.config.lock().unwrap().clone();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/auth/login", config.server_url))
        .json(&serde_json::json!({ "phone": phone, "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(token) = body.get("token").and_then(|t| t.as_str()) {
        let mut cfg = state.config.lock().unwrap();
        cfg.token = Some(token.to_string());
        if let Some(user) = body.get("user") {
            cfg.user_id = user.get("id").and_then(|id| id.as_str()).map(|s| s.to_string());
        }
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
        eprintln!("[Shortcut] Registering custom shortcut: '{}'", shortcut_clone);

        handle.global_shortcut().unregister_all().map_err(|e| {
            eprintln!("[Shortcut] unregister_all failed: {}", e);
            e.to_string()
        })?;

        // Tauri v2: parse shortcut string, then register (handler is global via app.listen)
        let shortcut_obj: Shortcut = shortcut_clone
            .parse()
            .map_err(|e| {
                eprintln!("[Shortcut] Failed to parse '{}': {}", shortcut_clone, e);
                format!("Invalid shortcut '{}': {}", shortcut_clone, e)
            })?;

        handle.global_shortcut().register(shortcut_obj).map_err(|e| {
            eprintln!("[Shortcut] register failed for '{}': {}", shortcut_clone, e);
            e.to_string()
        })?;

        eprintln!("[Shortcut] ✅ Successfully registered: '{}'", shortcut_clone);

        if let Some(state) = app.try_state::<AppState>() {
            let mut config = state.config.lock().unwrap();
            config.quick_paste_shortcut = Some(shortcut);
        }
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

/// Open image preview in a new Tauri window.
#[tauri::command]
async fn open_image_viewer(app: tauri::AppHandle, image_data_url: String, title: String) -> Result<(), String> {
    let escaped_url = image_data_url.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");

    let html = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:100vw;height:100vh;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif}}
img{{max-width:96vw;max-height:88vh;object-fit:contain;border-radius:4px}}
.bar{{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:10px;padding:10px 18px;background:rgba(255,255,255,0.08);border-radius:10px}}
button{{padding:8px 16px;border:none;border-radius:7px;cursor:pointer;font-size:13px;font-weight:500}}
.btn-copy{{background:#6366f1;color:#fff}}.btn-copy:hover{{background:#5558e3}}.btn-close{{background:rgba(255,255,255,0.12);color:#ccc;border:1px solid rgba(255,255,255,0.15)}}.btn-close:hover{{background:rgba(255,255,255,0.2);color:#fff}}svg{{width:14px;height:14px;vertical-align:-3px;margin-right:4px}}</style></head>
<body>
<img id="iv-img" src="{}" alt="preview" />
<div class="bar">
  <button class="btn-copy" id="copyBtn" onclick="doCopy()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> 复制图片</button>
  <button class="btn-close" onclick="window.close()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>关闭</button>
</div><script>function doCopy(){{var i=document.getElementById("iv-img"),c=document.createElement("canvas");c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext("2d").drawImage(i,0,0);c.toBlob(function(b){{navigator.clipboard.write([new ClipboardItem({{"image/png":b}})]).then(function(){{document.getElementById("copyBtn").innerHTML="✅ 已复制";setTimeout(function(){{document.getElementById("copyBtn").innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> 复制图ǔ7'}},1500)}},function(e){{alert('复制失败:'+e)}}}},'image/png')}}<\/script></body></html>"#,
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

#[tauri::command]
async fn send_verification_code(phone: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("http://localhost:3001/api/auth/send-code")
        .json(&serde_json::json!({ "phone": phone }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body)
}

// 设置系统托盘（Tauri 2.x）
fn setup_tray_icon(app: &tauri::App) -> tauri::Result<()> {
    // 加载托盘图标（优先使用应用默认图标）
    let tray_icon = app.default_window_icon()
        .cloned();

    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quick_paste_item = MenuItem::with_id(app, "quick_paste", "快速粘贴", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let check_update_item = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    // 同步状态（禁用状态，作为信息展示）
    let sync_status_item = MenuItem::with_id(app, "sync_status", "● 已同步", false, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append_items(&[&show_item, &quick_paste_item, &settings_item, &check_update_item, &sync_status_item, &hide_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("ClipSync - 剪贴板同步")
        .on_menu_event(|app, event| {
            eprintln!("[Tray] Menu event: id={:?}", event.id);
            match event.id.as_ref() {
                "show" => {
                    ensure_window_visible(&app);
                    eprintln!("[Tray] -> show window");
                }
                "quick_paste" => {
                    if let Some(window) = ensure_window_visible(&app) {
                        match window.eval("window.toggleQuickPaste()") {
                            Ok(_) => eprintln!("[Tray] -> toggleQuickPaste"),
                            Err(e) => eprintln!("[Tray] eval error: {}", e),
                        }
                    }
                }
                "settings" => {
                    if let Some(window) = ensure_window_visible(&app) {
                        // 切换到设置页
                        match window.eval("window.switchPage('settings')") {
                            Ok(_) => eprintln!("[Tray] -> open settings"),
                            Err(e) => eprintln!("[Tray] settings eval error: {}", e),
                        }
                    }
                    eprintln!("[Tray] -> open settings");
                }
                "check_update" => {
                    if let Some(window) = ensure_window_visible(&app) {
                        match window.eval("if(window.checkForUpdates) window.checkForUpdates()") {
                            Ok(_) => eprintln!("[Tray] -> check updates"),
                            Err(e) => eprintln!("[Tray] check_updates eval error: {}", e),
                        }
                    }
                }
                "hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                        eprintln!("[Tray] -> hide window");
                    }
                }
                "quit" => {
                    eprintln!("[Tray] -> quit app");
                    let _ = app.exit(0);
                }
                other => {
                    eprintln!("[Tray] Unknown menu item: {}", other);
                }
            }
        });

    // 如果图标加载成功，设置托盘图标
    if let Some(icon) = tray_icon {
        builder = builder.icon(icon);
        eprintln!("[Tray] Icon loaded (using default window icon)");
    } else {
        eprintln!("[Tray] WARNING: No tray icon found, using default");
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
                        eprintln!("[Tray] Left-click -> show (was {})", if is_minimized { "minimized" } else { "hidden" });
                    } else {
                        // Visible and not minimized → hide to tray
                        let _ = window.hide();
                        eprintln!("[Tray] Left-click -> hide");
                    }
                }
            }
            _ => {}
        }
    });

    builder.build(app)?;

    eprintln!("[Tray] Tray icon setup complete");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let state = AppState {
        config: Arc::new(Mutex::new(AppConfig::default())),
        is_monitoring: Arc::new(Mutex::new(false)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            tray_show_window,
            tray_hide_window,
            tray_quit,
            get_config,
            update_config,
            open_url,
            get_clipboard_content,
            set_clipboard_content,
            set_clipboard_files,
            copy_local_files,
            get_clipboard_files,
            save_and_copy_file,
            check_clipboard_image_info,
            get_clipboard_image,
            convert_bmp_to_png,
            check_for_updates,
            login,
            send_verification_code,
            enable_autostart,
            disable_autostart,
            is_autostart_enabled,
            register_shortcut,
            unregister_all_shortcuts,
            open_image_viewer,
        ])
        .setup(|app| {
            // 设置系统托盘
            setup_tray_icon(app)?;

            // 拦截窗口关闭事件：点 X = 最小化到托盘，不退出进程
            let window = app.get_webview_window("main").expect("main window missing");
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 阻止默认关闭行为，改为隐藏窗口到托盘
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    eprintln!("[Window] Close intercepted -> hidden to tray");
                }
            });

            // 注册全局快捷键（快速粘贴面板）
            // 如果主快捷键被占用，自动尝试备选键位
            #[cfg(not(mobile))]
            {
                let handle = app.handle().clone();
                let cfg = app.state::<AppState>().config.lock().unwrap().clone();
                let primary = cfg.quick_paste_shortcut
                    .unwrap_or_else(|| "Ctrl+Shift+V".to_string());
                let primary_normalized = primary.replace("CmdOrCtrl", "Ctrl");

                // 先卸载所有已有快捷键
                let _ = handle.global_shortcut().unregister_all();

                // Tauri v2: 通过事件系统监听全局快捷键
                let handle_evt = handle.clone();
                app.listen("global-shortcut", move |_event| {
                    eprintln!("[GlobalShortcut] Global shortcut pressed!");
                    if let Some(window) = handle_evt.get_webview_window("main") {
                        // Must unminimize first — show() alone doesn't restore minimized windows
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        match window.eval("window.toggleQuickPaste()") {
                            Ok(_) => eprintln!("[GlobalShortcut] toggleQuickPaste() called"),
                            Err(e) => eprintln!("[GlobalShortcut] eval failed: {}", e),
                        }
                    } else {
                        eprintln!("[GlobalShortcut] Main window not found!");
                    }
                });

                // 快捷键候选列表（按优先级，Tauri v2 格式）
                let candidates: Vec<&str> = {
                    if primary_normalized.contains("Shift+V") {
                        vec![&primary_normalized, "Alt+Shift+V", "Ctrl+Shift+K", "Ctrl+Alt+V"]
                    } else {
                        vec![&primary_normalized, "Ctrl+Shift+V", "Alt+Shift+V", "Ctrl+Shift+K"]
                    }
                };

                let mut registered = false;
                for (i, candidate) in candidates.iter().enumerate() {
                    let shortcut: Shortcut = match candidate.parse() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[Setup] Failed to parse '{}': {}", candidate, e);
                            continue;
                        }
                    };

                    // 注册快捷键（handler 通过上面的 app.listen 统一处理）
                    let reg_result = handle.global_shortcut().register(shortcut);

                    match reg_result {
                        Ok(()) => {
                            println!("[Setup] Global shortcut registered: {}", candidate);
                            if i > 0 {
                                println!("[Setup] Used fallback shortcut (primary was occupied)");
                            }
                            registered = true;
                            break;
                        }
                        Err(e) => {
                            if i == 0 {
                                eprintln!("[Setup] Primary shortcut '{}' failed: {}, trying fallback...", candidate, e);
                            } else {
                                eprintln!("[Setup] Fallback '{}' also failed: {}", candidate, e);
                            }
                        }
                    }
                }

                if !registered {
                    eprintln!("[Setup] ALL shortcut candidates FAILED! Quick paste via hotkey will NOT work.");
                    eprintln!("[Setup]   You can still open quick paste panel from the tray menu or main UI.");
                }
            }

            // 剪贴板监控：由前端 invoke 轮询驱动
            eprintln!("[Setup] Clipboard monitoring will be driven by frontend polling (invoke)");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ClipSync");
}
