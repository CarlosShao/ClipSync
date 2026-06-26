use log::{error, info};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub fn start_monitor(app_handle: AppHandle) {
    info!("Starting clipboard monitor...");

    let mut last_content = String::new();
    let mut last_change_time = Instant::now();
    let debounce_duration = Duration::from_millis(500);
    let poll_interval = Duration::from_millis(100); // Poll every 100ms for responsiveness

    loop {
        std::thread::sleep(poll_interval);

        match read_clipboard() {
            Ok(content) => {
                if !content.is_empty() && content != last_content {
                    // Clipboard changed, reset debounce timer
                    last_content = content.clone();
                    last_change_time = Instant::now();
                    
                    info!("Clipboard change detected, waiting for debounce...");
                } else if !last_content.is_empty() && last_change_time.elapsed() >= debounce_duration {
                    // Debounce period passed, trigger sync
                    let content_to_sync = last_content.clone();
                    last_content.clear(); // Reset to prevent re-triggering
                    
                    let _ = app_handle.emit(
                        "clipboard-changed",
                        serde_json::json!({
                            "content": content_to_sync,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        }),
                    );

                    info!("Clipboard sync triggered after debounce");
                }
            }
            Err(e) => {
                if last_content.is_empty() {
                    error!("Failed to read clipboard: {}", e);
                }
            }
        }
    }
}

fn read_clipboard() -> Result<String, arboard::Error> {
    let mut clipboard = arboard::Clipboard::new()?;
    clipboard.get_text().map(|s| s.to_string())
}
