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
}
