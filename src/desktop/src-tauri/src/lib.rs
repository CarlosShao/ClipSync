use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{CustomMenuItem, SystemTray, SystemTrayMenu, SystemTrayMenuItem, Manager};

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
            server_url: "http://localhost:3000".to_string(),
            token: None,
            device_id: None,
            user_id: None,
            quick_paste_shortcut: Some("CmdOrCtrl+Shift+V".to_string()),
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
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn tray_hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn tray_quit(app: tauri::AppHandle) {
    let _ = app.exit(0);
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn update_config(state: tauri::State<AppState>, config: AppConfig) {
    *state.config.lock().unwrap() = config;
}

#[tauri::command]
fn get_clipboard_content() -> Result<String, String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map(|s| s.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_clipboard_content(content: String) -> Result<(), String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(not(mobile))]
    {
        use tauri_plugin_updater::UpdaterExt;
        match app.updater().map_err(|e| e.to_string())? {
            mut updater => {
                if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
                    let version = update.version.clone();
                    let _ = update.download_and_install().await.map_err(|e| e.to_string())?;
                    return Ok(serde_json::json!({ "hasUpdate": true, "version": version }));
                }
            }
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

// 开机自启动命令
#[tauri::command]
fn enable_autostart() -> Result<(), String> {
    tauri_plugin_autostart::enable()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn disable_autostart() -> Result<(), String> {
    tauri_plugin_autostart::disable()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn is_autostart_enabled() -> Result<bool, String> {
    Ok(tauri_plugin_autostart::is_enabled())
}

// 快捷键管理命令
#[tauri::command]
fn register_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    #[cfg(not(mobile))]
    {
        let handle = app.clone();
        handle.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
        handle.global_shortcut().register(shortcut.clone(), move || {
            if let Some(window) = handle.get_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }).map_err(|e| e.to_string())?;
        
        // 保存到配置
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

#[tauri::command]
async fn send_verification_code(phone: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();

    let resp = client
        .post("http://localhost:3000/api/auth/send-code")
        .json(&serde_json::json!({ "phone": phone }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body)
}

// 创建系统托盘
fn create_system_tray() -> SystemTray {
    let show = CustomMenuItem::new("show".to_string(), "显示主窗口");
    let hide = CustomMenuItem::new("hide".to_string(), "隐藏到托盘");
    let quit = CustomMenuItem::new("quit".to_string(), "退出");
    
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(hide)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
    
    SystemTray::new()
        .with_menu(tray_menu)
        .with_tooltip("ClipSync - 剪贴板同步")
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
        .plugin(tauri_plugin_global_shortcut::init())
        .plugin(tauri_plugin_autostart::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            tray_show_window,
            tray_hide_window,
            tray_quit,
            get_config,
            update_config,
            get_clipboard_content,
            set_clipboard_content,
            check_for_updates,
            login,
            send_verification_code,
            enable_autostart,
            disable_autostart,
            is_autostart_enabled,
            register_shortcut,
            unregister_all_shortcuts,
        ])
        .system_tray(create_system_tray())
        .on_system_tray_event(|app, event| {
            match event {
                tauri::SystemTrayEvent::LeftClick { .. } => {
                    // 左键单击：显示/隐藏窗口
                    if let Some(window) = app.get_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                tauri::SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        "show" => {
                            if let Some(window) = app.get_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(window) = app.get_window("main") {
                                let _ = window.hide();
                            }
                        }
                        "quit" => {
                            let _ = app.exit(0);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // 从配置中读取快捷键，默认 Ctrl+Shift+V (Windows/Linux) / Cmd+Shift+V (macOS)
            #[cfg(not(mobile))]
            {
                let handle = app.handle().clone();
                let shortcut = app.state::<AppState>().config.lock().unwrap().quick_paste_shortcut.clone().unwrap_or_else(|| "CmdOrCtrl+Shift+V".to_string());
                
                // 在后台线程注册快捷键，避免阻塞主线程
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100)); // 延迟 100ms，让主窗口先渲染
                    if let Err(e) = handle.global_shortcut().register(shortcut.as_str(), move || {
                        // 触发快速粘贴面板
                        if let Some(window) = handle.get_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }) {
                        eprintln!("Failed to register global shortcut: {}", e);
                    } else {
                        println!("Global shortcut registered: {}", shortcut);
                    }
                });
            }
            
            // 启动剪贴板监控（已在后台线程）
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                clipboard_monitor::start_monitor(app_handle);
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ClipSync");
}
