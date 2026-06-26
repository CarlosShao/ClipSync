import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/user.dart';
import '../providers/settings_provider.dart';
import '../providers/clipboard_provider.dart';
import 'notification_settings_screen.dart';
import 'subscription_management_screen.dart';
import 'package:provider/provider.dart';

/// 桌面端设置页面
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({Key? key}) : super(key: key);

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final TextEditingController _serverUrlController = TextEditingController();
  final TextEditingController _shortcutController = TextEditingController();
  bool _autoStart = false;
  bool _notificationsEnabled = true;
  String _themeMode = 'system';
  String _language = 'zh';
  String _quickPasteShortcut = 'CmdOrCtrl+Shift+V';
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  @override
  void dispose() {
    _serverUrlController.dispose();
    _shortcutController.dispose();
    super.dispose();
  }

  Future<void> _loadSettings() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _serverUrlController.text = prefs.getString('server_url') ?? 'http://localhost:3001';
      _autoStart = prefs.getBool('auto_start') ?? false;
      _notificationsEnabled = prefs.getBool('notifications_enabled') ?? true;
      _themeMode = prefs.getString('theme_mode') ?? 'system';
      _language = prefs.getString('language') ?? 'zh';
      _quickPasteShortcut = prefs.getString('quick_paste_shortcut') ?? 'CmdOrCtrl+Shift+V';
      _shortcutController.text = _quickPasteShortcut;
    });
  }

  Future<void> _saveServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_url', _serverUrlController.text);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('服务器地址已保存')),
    );
  }

  Future<void> _toggleAutoStart(bool value) async {
    setState(() {
      _autoStart = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('auto_start', value);
    
    // 调用桌面端命令
    try {
      if (value) {
        await const MethodChannel('com.clipsync.desktop/channel')
            .invokeMethod('enable_autostart');
      } else {
        await const MethodChannel('com.clipsync.desktop/channel')
            .invokeMethod('disable_autostart');
      }
    } catch (e) {
      // 桌面端不可用（如在移动端运行）
      print('自动启动设置失败: $e');
    }
  }

  Future<void> _toggleNotifications(bool value) async {
    setState(() {
      _notificationsEnabled = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('notifications_enabled', value);
  }

  Future<void> _saveShortcut() async {
    final newShortcut = _shortcutController.text.trim();
    if (newShortcut.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('快捷键不能为空')),
      );
      return;
    }

    setState(() {
      _isLoading = true;
    });

    try {
      // 调用桌面端命令注册新快捷键
      await const MethodChannel('com.clipsync.desktop/channel')
          .invokeMethod('register_shortcut', {'shortcut': newShortcut});

      setState(() {
        _quickPasteShortcut = newShortcut;
      });

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('quick_paste_shortcut', newShortcut);

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('快捷键已更新: $newShortcut')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('快捷键设置失败: $e')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _setThemeMode(String? value) async {
    if (value == null) return;
    setState(() {
      _themeMode = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('theme_mode', value);
    
    // 通知设置变更
    final provider = Provider.of<SettingsProvider>(context, listen: false);
    provider.setThemeMode(value);
  }

  Future<void> _setLanguage(String? value) async {
    if (value == null) return;
    setState(() {
      _language = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('language', value);
    
    // 通知语言变更
    final provider = Provider.of<SettingsProvider>(context, listen: false);
    provider.setLanguage(value);
  }

  Future<void> _clearCache() async {
    setState(() {
      _isLoading = true;
    });
    
    try {
      // 清除剪贴板缓存
      final provider = Provider.of<ClipboardProvider>(context, listen: false);
      provider.clearCache();
      
      // 清除图片缓存
      PaintingBinding.instance.imageCache.clear();
      PaintingBinding.instance.imageCache.clearLiveImages();
      
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove('clipboard_cache');
      
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('缓存已清理')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('清理失败: $e')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _exportLogs() async {
    setState(() {
      _isLoading = true;
    });
    
    try {
      // 调用桌面端命令导出日志
      final result = await const MethodChannel('com.clipsync.desktop/channel')
          .invokeMethod('export_logs');
      
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('日志已导出至: $result')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('导出失败: $e')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('设置'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: ListView(
        children: [
          _buildSectionHeader('服务器配置'),
          _buildServerUrlSetting(),
          const Divider(),
          
            _buildSectionHeader('桌面端设置'),
            _buildAutoStartSetting(),
            _buildNotificationSetting(),
            _buildShortcutSetting(),
            const Divider(),
          
          _buildSectionHeader('外观'),
          _buildThemeSetting(),
          _buildLanguageSetting(),
          const Divider(),
          
          _buildSectionHeader('数据管理'),
          _buildClearCacheButton(),
          _buildExportLogsButton(),
          const Divider(),
          
          _buildSectionHeader('通知管理'),
          _buildNotificationSettings(),
          const Divider(),
          
          _buildSectionHeader('订阅管理'),
          _buildSubscriptionSetting(),
          const Divider(),
          
          _buildAboutSection(),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.bold,
          color: Theme.of(context).primaryColor,
        ),
      ),
    );
  }

  Widget _buildServerUrlSetting() {
    return ListTile(
      title: const Text('服务器地址'),
      subtitle: const Text('ClipSync 后端服务地址'),
      trailing: SizedBox(
        width: 200,
        child: TextField(
          controller: _serverUrlController,
          decoration: const InputDecoration(
            hintText: 'http://localhost:3001',
            contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          ),
          onSubmitted: (_) => _saveServerUrl(),
        ),
      ),
    );
  }

  Widget _buildAutoStartSetting() {
    return SwitchListTile(
      title: const Text('开机自启动'),
      subtitle: const Text('系统启动时自动运行 ClipSync'),
      value: _autoStart,
      onChanged: (value) => _toggleAutoStart(value),
    );
  }

  Widget _buildNotificationSetting() {
    return SwitchListTile(
      title: const Text('推送通知'),
      subtitle: const Text('接收剪贴板同步通知'),
      value: _notificationsEnabled,
      onChanged: (value) => _toggleNotifications(value),
    );
  }

  Widget _buildShortcutSetting() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ListTile(
          title: const Text('快速粘贴快捷键'),
          subtitle: const Text('触发快速粘贴面板的全局快捷键'),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _shortcutController,
                  decoration: const InputDecoration(
                    hintText: 'CmdOrCtrl+Shift+V',
                    contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _isLoading
                  ? const CircularProgressIndicator()
                  : IconButton(
                      icon: const Icon(Icons.save),
                      onPressed: _saveShortcut,
                      tooltip: '保存快捷键',
                    ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text(
            '格式示例: CmdOrCtrl+Shift+V, Alt+Space',
            style: TextStyle(fontSize: 12, color: Colors.grey[600]),
          ),
        ),
      ],
    );
  }

  Widget _buildThemeSetting() {
    return ListTile(
      title: const Text('主题'),
      subtitle: Text(_getThemeText()),
      trailing: DropdownButton<String>(
        value: _themeMode,
        onChanged: _setThemeMode,
        items: const [
          DropdownMenuItem(value: 'light', child: Text('浅色')),
          DropdownMenuItem(value: 'dark', child: Text('深色')),
          DropdownMenuItem(value: 'system', child: Text('跟随系统')),
        ],
      ),
    );
  }

  String _getThemeText() {
    switch (_themeMode) {
      case 'light':
        return '浅色主题';
      case 'dark':
        return '深色主题';
      case 'system':
      default:
        return '跟随系统';
    }
  }

  Widget _buildLanguageSetting() {
    return ListTile(
      title: const Text('语言'),
      subtitle: Text(_getLanguageText()),
      trailing: DropdownButton<String>(
        value: _language,
        onChanged: _setLanguage,
        items: const [
          DropdownMenuItem(value: 'zh', child: Text('简体中文')),
          DropdownMenuItem(value: 'en', child: Text('English')),
        ],
      ),
    );
  }

  String _getLanguageText() {
    switch (_language) {
      case 'zh':
        return '简体中文';
      case 'en':
        return 'English';
      default:
        return '简体中文';
    }
  }

  Widget _buildClearCacheButton() {
    return ListTile(
      leading: const Icon(Icons.cleaning_services),
      title: const Text('清理缓存'),
      subtitle: const Text('清除剪贴板缓存和临时文件'),
      trailing: _isLoading
          ? const CircularProgressIndicator()
          : IconButton(
              icon: const Icon(Icons.delete_forever),
              onPressed: _clearCache,
              tooltip: '清理',
            ),
    );
  }

  Widget _buildExportLogsButton() {
    return ListTile(
      leading: const Icon(Icons.file_download),
      title: const Text('导出日志'),
      subtitle: const Text('导出应用日志用于错误报告'),
      trailing: _isLoading
          ? const CircularProgressIndicator()
          : IconButton(
              icon: const Icon(Icons.file_open),
              onPressed: _exportLogs,
              tooltip: '导出',
            ),
    );
  }

  /// 通知设置
  Widget _buildNotificationSettings() {
    return ListTile(
      leading: const Icon(Icons.notifications),
      title: const Text('通知设置'),
      subtitle: const Text('管理推送通知偏好'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => NotificationSettingsScreen(),
          ),
        );
      },
    );
  }

  /// 订阅管理设置
  Widget _buildSubscriptionSetting() {
    return ListTile(
      leading: const Icon(Icons.workspace_premium),
      title: const Text('订阅管理'),
      subtitle: const Text('查看或更改订阅套餐'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => SubscriptionManagementScreen(),
          ),
        );
      },
    );
  }

  Widget _buildAboutSection() {
    return AboutListTile(
      icon: const Icon(Icons.info),
      applicationName: 'ClipSync',
      applicationVersion: '0.1.0',
      applicationIcon: const FlutterLogo(size: 48),
      aboutBoxChildren: [
        const Text('跨设备剪贴板同步工具'),
        const SizedBox(height: 8),
        const Text('© 2026 ClipSync Team'),
      ],
    );
  }
}
