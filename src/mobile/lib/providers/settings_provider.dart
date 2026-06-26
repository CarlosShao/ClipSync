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

  // Getters
  bool get darkMode => _darkMode;
  String get language => _language;
  bool get autoSync => _autoSync;
  bool get wifiOnly => _wifiOnly;
  bool get notificationsEnabled => _notificationsEnabled;

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
    notifyListeners();
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

  /// 设置主题模式
  Future<void> setThemeMode(String value) async {
    _darkMode = value == 'dark';
    await _prefs.setString('theme_mode', value);
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
