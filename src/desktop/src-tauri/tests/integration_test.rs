// Tauri 桌面应用集成测试
// 测试核心命令和状态管理
//
// A10：原文件与真实类型已经脱节（`is_monitoring` 早从 `Arc<Mutex<bool>>` 改成
// `Arc<AtomicBool>`、`AppConfig` 多了两个快捷键字段、默认值端口是 3001 而不是 3000），
// 导致 `cargo test` 根本编不过。这里按当前实现重写。

use clipsync_desktop_lib::{AppConfig, AppState};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 构造一个与 `run()` 中一致的 AppState（含三个防抖时间戳字段）。
fn make_state() -> AppState {
    let stale = Instant::now() - Duration::from_secs(10);
    AppState {
        config: Arc::new(Mutex::new(AppConfig::default())),
        is_monitoring: Arc::new(AtomicBool::new(false)),
        last_qp_toggle: Arc::new(Mutex::new(stale)),
        last_tw_toggle: Arc::new(Mutex::new(stale)),
        last_ai_toggle: Arc::new(Mutex::new(stale)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_config_default() {
        let config = AppConfig::default();
        assert_eq!(config.server_url, "http://localhost:3001");
        assert_eq!(config.token, None);
        assert_eq!(config.device_id, None);
        assert_eq!(config.user_id, None);
        assert_eq!(config.quick_paste_shortcut, Some("Ctrl+Shift+V".to_string()));
        assert_eq!(config.toggle_window_shortcut, Some("Ctrl+Alt+Space".to_string()));
        assert_eq!(config.toggle_ai_panel_shortcut, Some("Ctrl+Shift+A".to_string()));
    }

    #[test]
    fn test_app_config_clone() {
        let config = AppConfig {
            server_url: "https://example.com".to_string(),
            token: Some("test-token".to_string()),
            device_id: Some("device-123".to_string()),
            user_id: Some("user-456".to_string()),
            quick_paste_shortcut: Some("Ctrl+Alt+K".to_string()),
            toggle_window_shortcut: Some("Ctrl+Alt+S".to_string()),
            toggle_ai_panel_shortcut: Some("Ctrl+Shift+A".to_string()),
        };

        let cloned = config.clone();
        assert_eq!(cloned.server_url, "https://example.com");
        assert_eq!(cloned.token, Some("test-token".to_string()));
        assert_eq!(cloned.device_id, Some("device-123".to_string()));
        assert_eq!(cloned.user_id, Some("user-456".to_string()));
        assert_eq!(cloned.quick_paste_shortcut, Some("Ctrl+Alt+K".to_string()));
        assert_eq!(cloned.toggle_window_shortcut, Some("Ctrl+Alt+S".to_string()));
        assert_eq!(cloned.toggle_ai_panel_shortcut, Some("Ctrl+Shift+A".to_string()));
    }

    /// A1：空 server_url 是合法的"未连接"态，不能被默认值悄悄覆盖。
    #[test]
    fn test_app_config_allows_empty_server_url() {
        let config = AppConfig {
            server_url: String::new(),
            ..AppConfig::default()
        };
        assert!(config.server_url.is_empty());
    }

    /// A1：旧版本/缺字段的配置文件必须能反序列化成可用配置，而不是整份失效。
    /// `AppConfig` 带 `#[serde(default)]`，缺失字段回落到 `Default::default()`。
    #[test]
    fn test_app_config_deserialize_tolerates_missing_fields() {
        let parsed: AppConfig = serde_json::from_str("{}").expect("missing fields must fall back");
        assert_eq!(parsed.server_url, "http://localhost:3001");
        assert_eq!(parsed.token, None);
        assert_eq!(parsed.quick_paste_shortcut, Some("Ctrl+Shift+V".to_string()));

        let partial: AppConfig =
            serde_json::from_str(r#"{"server_url":"https://api.clipsync.dev"}"#)
                .expect("partial config must deserialize");
        assert_eq!(partial.server_url, "https://api.clipsync.dev");
        assert_eq!(partial.user_id, None);
    }

    /// A1：损坏的 JSON 不会 panic（load_persisted_config 会捕获并回落默认值）。
    #[test]
    fn test_app_config_corrupt_json_is_rejected_not_panicking() {
        assert!(serde_json::from_str::<AppConfig>("{not json").is_err());
        assert!(serde_json::from_str::<AppConfig>(r#"{"server_url": 42}"#).is_err());
    }

    #[test]
    fn test_app_config_roundtrip_json() {
        let config = AppConfig {
            server_url: "https://api.clipsync.dev".to_string(),
            token: Some("t".to_string()),
            device_id: Some("d".to_string()),
            user_id: Some("u".to_string()),
            quick_paste_shortcut: Some("Ctrl+Shift+V".to_string()),
            toggle_window_shortcut: Some("Ctrl+Alt+Space".to_string()),
            toggle_ai_panel_shortcut: Some("Ctrl+Shift+A".to_string()),
        };
        let raw = serde_json::to_string(&config).unwrap();
        let back: AppConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.server_url, config.server_url);
        assert_eq!(back.token, config.token);
        assert_eq!(back.toggle_ai_panel_shortcut, config.toggle_ai_panel_shortcut);
    }

    #[test]
    fn test_app_state_creation() {
        let state = make_state();

        let config = state.config.lock().unwrap().clone();
        assert_eq!(config.server_url, "http://localhost:3001");

        assert!(!state.is_monitoring.load(Ordering::Relaxed));
    }

    #[test]
    fn test_app_state_update_config() {
        let state = make_state();

        // 更新配置（模拟 update_config 的字段级合并语义）
        {
            let mut config = state.config.lock().unwrap();
            config.server_url = "https://api.clipsync.com".to_string();
            config.token = Some("new-token-123".to_string());
            config.quick_paste_shortcut = Some("Ctrl+Alt+V".to_string());
        }

        // 验证更新
        let config = state.config.lock().unwrap().clone();
        assert_eq!(config.server_url, "https://api.clipsync.com");
        assert_eq!(config.token, Some("new-token-123".to_string()));
        assert_eq!(config.quick_paste_shortcut, Some("Ctrl+Alt+V".to_string()));
        // 未被覆盖的字段保持默认
        assert_eq!(config.toggle_window_shortcut, Some("Ctrl+Alt+Space".to_string()));
    }

    /// A9：`is_monitoring` 是 AtomicBool，是 autoSync 开关背后的真开关。
    #[test]
    fn test_app_state_monitoring_flag() {
        let state = make_state();

        // 初始状态
        assert!(!state.is_monitoring.load(Ordering::Relaxed));

        // 开启
        state.is_monitoring.store(true, Ordering::Relaxed);
        assert!(state.is_monitoring.load(Ordering::Relaxed));

        // 关闭
        state.is_monitoring.store(false, Ordering::Relaxed);
        assert!(!state.is_monitoring.load(Ordering::Relaxed));
    }

    #[test]
    fn test_clipboard_content_roundtrip() {
        // 测试剪贴板内容的序列化和反序列化
        let test_content = "Hello, ClipSync!";
        let json_value = json!({
            "content": test_content,
            "timestamp": 1234567890
        });

        assert_eq!(json_value["content"], test_content);
        assert_eq!(json_value["timestamp"], 1234567890);
    }

    #[test]
    fn test_clipboard_image_event_shape() {
        // 监听线程 emit 的图片事件形状（前端依赖这些字段名）
        let event = json!({
            "contentType": "image",
            "size": 4096,
            "hash": "1234567890",
            "dataUrl": "data:image/png;base64,AAAA",
            "timestamp": "2026-01-01T00:00:00Z",
        });
        assert_eq!(event["contentType"], "image");
        assert_eq!(event["size"], 4096);
        assert!(event["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn test_login_response_parsing() {
        // 测试登录响应的解析
        let response = json!({
            "token": "abc123token",
            "user": {
                "id": "user-001",
                "phone": "+8613800138000"
            }
        });

        assert_eq!(response["token"], "abc123token");
        assert_eq!(response["user"]["id"], "user-001");
        assert_eq!(response["user"]["phone"], "+8613800138000");
    }

    #[test]
    fn test_update_check_response() {
        // 测试更新检查响应
        let no_update = json!({ "hasUpdate": false });
        assert_eq!(no_update["hasUpdate"], false);

        let has_update = json!({
            "hasUpdate": true,
            "version": "1.2.3"
        });
        assert_eq!(has_update["hasUpdate"], true);
        assert_eq!(has_update["version"], "1.2.3");
    }
}
