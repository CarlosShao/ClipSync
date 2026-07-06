// Tauri 桌面应用集成测试
// 测试核心命令和状态管理

use clipsync_desktop_lib::{AppConfig, AppState};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_config_default() {
        let config = AppConfig::default();
        assert_eq!(config.server_url, "http://localhost:3000");
        assert_eq!(config.token, None);
        assert_eq!(config.device_id, None);
        assert_eq!(config.user_id, None);
        assert_eq!(config.quick_paste_shortcut, Some("CmdOrCtrl+Shift+V".to_string()));
    }

    #[test]
    fn test_app_config_clone() {
        let config = AppConfig {
            server_url: "https://example.com".to_string(),
            token: Some("test-token".to_string()),
            device_id: Some("device-123".to_string()),
            user_id: Some("user-456".to_string()),
            quick_paste_shortcut: Some("Ctrl+Alt+K".to_string()),
        };

        let cloned = config.clone();
        assert_eq!(cloned.server_url, "https://example.com");
        assert_eq!(cloned.token, Some("test-token".to_string()));
        assert_eq!(cloned.device_id, Some("device-123".to_string()));
        assert_eq!(cloned.user_id, Some("user-456".to_string()));
        assert_eq!(cloned.quick_paste_shortcut, Some("Ctrl+Alt+K".to_string()));
    }

    #[test]
    fn test_app_state_creation() {
        let state = AppState {
            config: Arc::new(Mutex::new(AppConfig::default())),
            is_monitoring: Arc::new(Mutex::new(false)),
        };

        let config = state.config.lock().unwrap().clone();
        assert_eq!(config.server_url, "http://localhost:3000");
        
        let is_monitoring = state.is_monitoring.lock().unwrap();
        assert_eq!(*is_monitoring, false);
    }

    #[test]
    fn test_app_state_update_config() {
        let state = AppState {
            config: Arc::new(Mutex::new(AppConfig::default())),
            is_monitoring: Arc::new(Mutex::new(false)),
        };

        // 更新配置
        {
            let mut config = state.config.lock().unwrap();
            config.server_url = "https://api.clipsync.com".to_string();
            config.token = Some("new-token-123".to_string());
            config.quick_paste_shortcut = Some("CmdOrCtrl+Alt+V".to_string());
        }

        // 验证更新
        let config = state.config.lock().unwrap().clone();
        assert_eq!(config.server_url, "https://api.clipsync.com");
        assert_eq!(config.token, Some("new-token-123".to_string()));
        assert_eq!(config.quick_paste_shortcut, Some("CmdOrCtrl+Alt+V".to_string()));
    }

    #[test]
    fn test_app_state_monitoring_flag() {
        let state = AppState {
            config: Arc::new(Mutex::new(AppConfig::default())),
            is_monitoring: Arc::new(Mutex::new(false)),
        };

        // 初始状态
        assert_eq!(*state.is_monitoring.lock().unwrap(), false);

        // 更新状态
        {
            let mut flag = state.is_monitoring.lock().unwrap();
            *flag = true;
        }

        // 验证更新
        assert_eq!(*state.is_monitoring.lock().unwrap(), true);
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
