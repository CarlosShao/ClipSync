import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../providers/auth_provider.dart';
import '../providers/clipboard_provider.dart';
import '../providers/settings_provider.dart';
import '../router/app_router.dart';
import '../services/server_config.dart';
import '../theme/app_theme.dart';
import 'notification_settings_screen.dart';
import 'subscription_management_screen.dart';
import 'templates/templates_screen.dart';

/// 设置页面（移动端）
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({Key? key}) : super(key: key);

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final TextEditingController _serverUrlController = TextEditingController();
  bool _notificationsEnabled = true;

  /// 主题模式 int 枚举：0=system / 1=light / 2=dark（与 ThemeMode.index 对齐）
  int _themeModeIndex = 0;
  String _language = 'zh';
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  @override
  void dispose() {
    _serverUrlController.dispose();
    super.dispose();
  }

  Future<void> _loadSettings() async {
    // SettingsProvider 已在 main() 启动时完成 init，直接读取归一化后的主题值
    final settings = context.read<SettingsProvider>();
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _serverUrlController.text = prefs.getString('server_url') ?? ServerConfig.baseUrl;
      _notificationsEnabled = prefs.getBool('notifications_enabled') ?? true;
      _themeModeIndex = settings.themeModeIndex;
      _language = prefs.getString('language') ?? 'zh';
    });
  }

  Future<void> _saveServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    final url = _serverUrlController.text.trim();
    if (url.isEmpty) return;
    await prefs.setString('server_url', url);
    // 同步内存配置，后续请求立即生效（无需重启 App）
    ServerConfig.setBaseUrl(url);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('服务器地址已保存')),
    );
  }

  Future<void> _toggleNotifications(bool value) async {
    setState(() {
      _notificationsEnabled = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('notifications_enabled', value);
  }

  Future<void> _setThemeMode(int? value) async {
    if (value == null) return;
    setState(() {
      _themeModeIndex = value;
    });
    // 持久化（SettingsProvider，int 枚举：0=system/1=light/2=dark）
    context.read<SettingsProvider>().setThemeModeIndex(value);
    // 立即应用到全局主题（ThemeProvider 读写同一 theme_mode 键的 int 值）
    context.read<ThemeProvider>().setThemeMode(ThemeMode.values[value]);
  }

  Future<void> _setLanguage(String? value) async {
    if (value == null) return;
    setState(() {
      _language = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('language', value);
    if (!mounted) return;

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

  /// 退出登录：确认对话框 → 清除凭证 → 回到登录页
  Future<void> _confirmLogout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确定要退出当前账号吗？退出后需要重新验证码登录。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text(
              '退出',
              style: TextStyle(color: Colors.red),
            ),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    await context.read<AuthProvider>().logout();
    if (!mounted) return;
    // go_router 导航回登录页（守卫同样会因失去 token 强制跳转）
    context.go(AppRoutes.login);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('设置'),
        // 作为主页 tab 嵌入时无返回栈，交由 AppBar 自动处理 leading
      ),
      body: ListView(
        children: [
          _buildSectionHeader('服务器配置'),
          _buildServerUrlSetting(),
          const Divider(),

          _buildSectionHeader('通用'),
          _buildNotificationSetting(),
          const Divider(),

          _buildSectionHeader('外观'),
          _buildThemeSetting(),
          _buildLanguageSetting(),
          const Divider(),

          _buildSectionHeader('数据管理'),
          _buildClearCacheButton(),
          _buildTemplatesTile(),
          const Divider(),

          _buildSectionHeader('通知管理'),
          _buildNotificationSettings(),
          const Divider(),

          _buildSectionHeader('订阅管理'),
          _buildSubscriptionSetting(),
          const Divider(),

          _buildLogoutTile(),
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

  Widget _buildNotificationSetting() {
    return SwitchListTile(
      title: const Text('推送通知'),
      subtitle: const Text('接收剪贴板同步通知'),
      value: _notificationsEnabled,
      onChanged: (value) => _toggleNotifications(value),
    );
  }

  Widget _buildThemeSetting() {
    return ListTile(
      title: const Text('主题'),
      subtitle: Text(_getThemeText()),
      trailing: DropdownButton<int>(
        value: _themeModeIndex,
        onChanged: _setThemeMode,
        items: const [
          DropdownMenuItem(value: 0, child: Text('跟随系统')),
          DropdownMenuItem(value: 1, child: Text('浅色')),
          DropdownMenuItem(value: 2, child: Text('深色')),
        ],
      ),
    );
  }

  String _getThemeText() {
    switch (_themeModeIndex) {
      case 1:
        return '浅色主题';
      case 2:
        return '深色主题';
      case 0:
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

  /// 模板库（T4.2）：查看 / 使用剪贴板模板
  Widget _buildTemplatesTile() {
    return ListTile(
      leading: const Icon(Icons.description_outlined),
      title: const Text('模板库'),
      subtitle: const Text('查看并快速使用剪贴板模板'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () {
        Navigator.push(
          context,
          MaterialPageRoute<void>(
            builder: (context) => const TemplatesScreen(),
          ),
        );
      },
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
          MaterialPageRoute<void>(
            builder: (context) => const NotificationSettingsScreen(),
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
          MaterialPageRoute<void>(
            builder: (context) => const SubscriptionManagementScreen(),
          ),
        );
      },
    );
  }

  /// 退出登录（红色，确认后清除凭证并返回登录页）
  Widget _buildLogoutTile() {
    return ListTile(
      leading: const Icon(Icons.logout, color: Colors.red),
      title: const Text(
        '退出登录',
        style: TextStyle(color: Colors.red),
      ),
      subtitle: const Text('清除本机登录凭证'),
      onTap: _confirmLogout,
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
