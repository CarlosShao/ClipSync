// lib/providers/settings_provider.dart

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 设置状态管理
class SettingsProvider extends ChangeNotifier {
  late SharedPreferences _prefs;

  // 设置项
  bool _darkMode = false;
  String _language = 'zh';
  bool _autoSync = true;
  bool _wifiOnly = false;
  bool _notificationsEnabled = true;

  /// B9：E2E 端到端加密用户级开关的 SharedPreferences 键。
  /// 采集执行侧（clipboard_capture）每次上传前实时读同一键（与 B3
  /// 'clipboard_capture_enabled' 的「UI 缓存 + 执行侧实时读」双写模式一致），
  /// 两端以 SharedPreferences 为准。默认 false（协议 §5：用户级开关默认关闭）。
  static const String e2eEnabledPrefKey = 'e2e_enabled';

  /// B3：剪贴板采集总开关（SharedPreferences 'clipboard_capture_enabled'，
  /// 默认 true）。仅作 UI 显示缓存；采集执行侧（sync_service）每次实时读
  /// 同一键，不依赖本缓存，两端以 SharedPreferences 为准。
  bool _clipboardCaptureEnabled = true;
  /// PC 复制 → 自动写入本机系统剪贴板（直接在任意 App 粘贴，无需打开 ClipSync）
  bool _clipboardWritebackEnabled = true;
  /// PC 截图/图片同步 → 自动保存到手机系统相册（Pictures/ClipSync）
  bool _autoSaveImagesToAlbum = true;
  /// 手机系统截屏 → 自动同步至电脑及其他端
  bool _autoSyncScreenshots = true;

  /// B9：端到端加密用户级本地开关（SharedPreferences 'e2e_enabled'，默认 false）。
  /// 仅作 UI 显示缓存；采集执行侧（clipboard_capture）每次上传前实时读同一键，
  /// 不依赖本缓存。协议 §5 双闸门中的「用户级设置开关」，另一闸门
  /// （套餐特性位 e2e_encryption）见 FeatureFlagsProvider.e2eEncryptionAllowed。
  bool _e2eEnabled = false;

  /// 主题模式，以 int 枚举持久化（SharedPreferences 'theme_mode'）。
  /// 与 Flutter 的 ThemeMode.index 对齐：0=system（跟随系统）、1=light、2=dark。
  /// ThemeProvider（theme/app_theme.dart）读写同一键的 int 值，两端保持一致。
  int _themeModeIndex = 0;

  // Getters
  bool get darkMode => _darkMode;
  String get language => _language;
  bool get autoSync => _autoSync;
  bool get wifiOnly => _wifiOnly;
  bool get notificationsEnabled => _notificationsEnabled;
  bool get clipboardCaptureEnabled => _clipboardCaptureEnabled;
  bool get clipboardWritebackEnabled => _clipboardWritebackEnabled;
  bool get autoSaveImagesToAlbum => _autoSaveImagesToAlbum;
  bool get autoSyncScreenshots => _autoSyncScreenshots;
  bool get e2eEnabled => _e2eEnabled;
  int get themeModeIndex => _themeModeIndex;

  /// 初始化
  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _loadSettings();
  }

  /// 加载设置
  void _loadSettings() {
    _darkMode = _prefs.getBool('dark_mode') ?? false;
    _language = _prefs.getString('language') ?? 'zh';
    _autoSync = _prefs.getBool('auto_sync') ?? true;
    _wifiOnly = _prefs.getBool('wifi_only') ?? false;
    _notificationsEnabled = _prefs.getBool('notifications_enabled') ?? true;
    // B3：剪贴板采集总开关（与 sync_service._prefKeyCaptureEnabled 同一键）
    _clipboardCaptureEnabled = _prefs.getBool('clipboard_capture_enabled') ?? true;
    _clipboardWritebackEnabled = _prefs.getBool('clipboard_writeback_enabled') ?? true;
    _autoSaveImagesToAlbum = _prefs.getBool('auto_save_images_to_album') ?? true;
    _autoSyncScreenshots = _prefs.getBool('auto_sync_screenshots') ?? true;
    // B9：端到端加密用户级开关（默认 false）
    _e2eEnabled = _prefs.getBool(e2eEnabledPrefKey) ?? false;
    // theme_mode 容错读取：历史版本可能写过字符串（'system'/'light'/'dark'），
    // 统一迁移为 int 枚举（0=system/1=light/2=dark），避免 getString/getInt 类型不匹配崩溃。
    _themeModeIndex = _normalizeThemeModeIndex(_prefs.get('theme_mode'));
    notifyListeners();
  }

  /// 将任意历史存储的 theme_mode 值归一化为 int 枚举
  static int _normalizeThemeModeIndex(Object? raw) {
    if (raw is int) {
      if (raw < 0) return 0;
      if (raw > 2) return 2;
      return raw;
    }
    if (raw is String) {
      switch (raw) {
        case 'light':
          return 1;
        case 'dark':
          return 2;
        case 'system':
        default:
          return 0;
      }
    }
    return 0;
  }

  /// 设置深色模式
  Future<void> setDarkMode(bool value) async {
    _darkMode = value;
    await _prefs.setBool('dark_mode', value);
    notifyListeners();
  }

  /// 设置语言
  Future<void> setLanguage(String value) async {
    _language = value;
    await _prefs.setString('language', value);
    notifyListeners();
  }

  /// 设置主题模式（int 枚举：0=system/1=light/2=dark，与 ThemeMode.index 一致）
  Future<void> setThemeModeIndex(int value) async {
    _themeModeIndex = _normalizeThemeModeIndex(value);
    await _prefs.setInt('theme_mode', _themeModeIndex);
    notifyListeners();
  }

  /// 设置自动同步
  Future<void> setAutoSync(bool value) async {
    _autoSync = value;
    await _prefs.setBool('auto_sync', value);
    notifyListeners();
  }

  /// 设置仅 Wi-Fi 同步
  Future<void> setWifiOnly(bool value) async {
    _wifiOnly = value;
    await _prefs.setBool('wifi_only', value);
    notifyListeners();
  }

  /// 设置通知开关
  Future<void> setNotificationsEnabled(bool value) async {
    _notificationsEnabled = value;
    await _prefs.setBool('notifications_enabled', value);
    notifyListeners();
  }

  /// 设置剪贴板采集总开关（B3）：双写 SharedPreferences（采集执行侧
  /// sync_service 每次实时读取该键）+ 内存缓存供 UI 显示，即时生效
  Future<void> setClipboardWritebackEnabled(bool value) async {
    _clipboardWritebackEnabled = value;
    await _prefs.setBool('clipboard_writeback_enabled', value);
    notifyListeners();
  }

  /// 设置接收图片自动保存至相册开关
  Future<void> setAutoSaveImagesToAlbum(bool value) async {
    _autoSaveImagesToAlbum = value;
    await _prefs.setBool('auto_save_images_to_album', value);
    notifyListeners();
  }

  /// 设置手机截图自动同步开关
  Future<void> setAutoSyncScreenshots(bool value) async {
    _autoSyncScreenshots = value;
    await _prefs.setBool('auto_sync_screenshots', value);
    notifyListeners();
  }

  Future<void> setClipboardCaptureEnabled(bool value) async {
    _clipboardCaptureEnabled = value;
    await _prefs.setBool('clipboard_capture_enabled', value);
    notifyListeners();
  }

  /// 设置端到端加密开关（B9）：双写 SharedPreferences（采集执行侧
  /// clipboard_capture 每次上传前实时读取该键）+ 内存缓存供 UI 显示。
  /// 仅影响之后的上传；已在途/已入库条目按各自 metadata.e2e 解密（协议 §5）。
  Future<void> setE2eEnabled(bool value) async {
    _e2eEnabled = value;
    await _prefs.setBool(e2eEnabledPrefKey, value);
    notifyListeners();
  }
}
