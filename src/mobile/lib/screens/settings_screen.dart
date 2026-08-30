import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../l10n/app_localizations.dart';
import '../providers/auth_provider.dart';
import '../providers/clipboard_provider.dart';
import '../providers/settings_provider.dart';
import '../router/app_router.dart';
import '../services/biometric_service.dart';
import '../services/server_config.dart';
import '../theme/app_theme.dart';
import 'notification_settings_screen.dart';
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

  /// T4.6：生物识别锁开关（SharedPreferences 键 biometric_lock_enabled，
  /// 读取方 main.dart 冷启动布防 + ClipSyncApp 退后台布防）
  bool _biometricLockEnabled = false;

  /// T4.6：设备是否具备可用生物识别能力（不支持则开关禁用）
  bool _biometricSupported = false;

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

    // T4.6：生物识别能力检测（canCheckBiometrics + isDeviceSupported）。
    // 设备不支持时把残留的历史开关强制回落为关闭，避免永久锁在锁定页外。
    final biometricSupported = await BiometricService.canAuthenticate();
    var biometricLockEnabled = prefs.getBool('biometric_lock_enabled') ?? false;
    if (!biometricSupported && biometricLockEnabled) {
      biometricLockEnabled = false;
      await prefs.setBool('biometric_lock_enabled', false);
    }

    if (!mounted) return;
    setState(() {
      _serverUrlController.text = prefs.getString('server_url') ?? ServerConfig.baseUrl;
      _notificationsEnabled = prefs.getBool('notifications_enabled') ?? true;
      _themeModeIndex = settings.themeModeIndex;
      _language = prefs.getString('language') ?? 'zh';
      _biometricSupported = biometricSupported;
      _biometricLockEnabled = biometricLockEnabled;
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
      SnackBar(content: Text(AppLocalizations.of(context).serverUrlSaved)),
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
        SnackBar(content: Text(AppLocalizations.of(context).cacheCleared)),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context).clearCacheFailed(e.toString()),
          ),
        ),
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
      builder: (dialogContext) {
        final l10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          title: Text(l10n.logout),
          content: Text(l10n.logoutConfirmMessage),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(l10n.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(
                l10n.logoutAction,
                style: const TextStyle(color: Colors.red),
              ),
            ),
          ],
        );
      },
    );

    if (confirmed != true || !mounted) return;

    await context.read<AuthProvider>().logout();
    if (!mounted) return;
    // go_router 导航回登录页（守卫同样会因失去 token 强制跳转）
    context.go(AppRoutes.login);
  }

  @override
  Widget build(BuildContext context) {
    // T4.5: i18n —— 本页文案接 AppLocalizations，随设置页语言切换即时变化；
    // 未迁移的硬编码文案（如 T4.6 安全区块）维持现状，后续渐进迁移。
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.tabSettings),
        // 作为主页 tab 嵌入时无返回栈，交由 AppBar 自动处理 leading
      ),
      body: ListView(
        children: [
          _buildSectionHeader(l10n.sectionServer),
          _buildServerUrlSetting(),
          const Divider(),

          _buildSectionHeader(l10n.sectionGeneral),
          _buildNotificationSetting(),
          const Divider(),

          _buildSectionHeader(l10n.sectionAppearance),
          _buildThemeSetting(),
          _buildLanguageSetting(),
          const Divider(),

          _buildSectionHeader('安全'),
          _buildBiometricLockSetting(),
          const Divider(),

          _buildSectionHeader(l10n.sectionData),
          _buildClearCacheButton(),
          _buildTemplatesTile(),
          const Divider(),

          _buildSectionHeader(l10n.sectionNotification),
          _buildNotificationSettings(),
          const Divider(),

          _buildSectionHeader(l10n.sectionSubscription),
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
    final l10n = AppLocalizations.of(context);
    return ListTile(
      title: Text(l10n.serverUrl),
      subtitle: Text(l10n.serverUrlDesc),
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
    final l10n = AppLocalizations.of(context);
    return SwitchListTile(
      title: Text(l10n.pushNotifications),
      subtitle: Text(l10n.pushNotificationsDesc),
      value: _notificationsEnabled,
      onChanged: (value) => _toggleNotifications(value),
    );
  }

  Widget _buildThemeSetting() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      title: Text(l10n.theme),
      subtitle: Text(_getThemeText()),
      trailing: DropdownButton<int>(
        value: _themeModeIndex,
        onChanged: _setThemeMode,
        items: [
          DropdownMenuItem(value: 0, child: Text(l10n.themeSystem)),
          DropdownMenuItem(value: 1, child: Text(l10n.themeLight)),
          DropdownMenuItem(value: 2, child: Text(l10n.themeDark)),
        ],
      ),
    );
  }

  String _getThemeText() {
    final l10n = AppLocalizations.of(context);
    switch (_themeModeIndex) {
      case 1:
        return l10n.themeLight;
      case 2:
        return l10n.themeDark;
      case 0:
      default:
        return l10n.themeSystem;
    }
  }

  Widget _buildLanguageSetting() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      title: Text(l10n.language),
      // 副标题展示语言原生名（简体中文/English），刻意不随语言切换翻译
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

  /// T4.6：生物识别锁开关——设备不支持时呈「设备不支持」禁用态
  Widget _buildBiometricLockSetting() {
    return SwitchListTile(
      secondary: const Icon(Icons.fingerprint),
      title: const Text('生物识别锁'),
      subtitle: Text(
        _biometricSupported
            ? '冷启动与回到前台时需通过指纹/面容验证'
            : '设备不支持生物识别',
      ),
      value: _biometricSupported && _biometricLockEnabled,
      // 设备不支持时 onChanged 为 null → 开关呈禁用态
      onChanged: _biometricSupported ? _toggleBiometricLock : null,
    );
  }

  /// T4.6：切换生物识别锁。开启前先做一次生物验证确认本人操作，
  /// 验证未通过则保持关闭；结果持久化到 biometric_lock_enabled。
  Future<void> _toggleBiometricLock(bool value) async {
    if (value) {
      final ok = await BiometricService.authenticate(
        reason: '验证指纹或面容以开启生物识别锁',
      );
      if (!ok) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('验证未通过，未开启生物识别锁')),
        );
        return;
      }
    }
    if (!mounted) return;
    setState(() {
      _biometricLockEnabled = value;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('biometric_lock_enabled', value);
  }

  Widget _buildClearCacheButton() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.cleaning_services),
      title: Text(l10n.clearCache),
      subtitle: Text(l10n.clearCacheDesc),
      trailing: _isLoading
          ? const CircularProgressIndicator()
          : IconButton(
              icon: const Icon(Icons.delete_forever),
              onPressed: _clearCache,
              tooltip: l10n.clearCacheTooltip,
            ),
    );
  }

  /// 模板库（T4.2）：查看 / 使用剪贴板模板
  Widget _buildTemplatesTile() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.description_outlined),
      title: Text(l10n.templates),
      subtitle: Text(l10n.templatesDesc),
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
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.notifications),
      title: Text(l10n.notificationSettings),
      subtitle: Text(l10n.notificationSettingsDesc),
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

  /// 订阅管理设置（T4.4：改指路由 /subscriptions，
  /// 旧 subscription_management_screen.dart 直推入口已删除）
  Widget _buildSubscriptionSetting() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.workspace_premium),
      title: Text(l10n.subscriptionManagement),
      subtitle: Text(l10n.subscriptionDesc),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push(AppRoutes.subscriptionManagement),
    );
  }

  /// 退出登录（红色，确认后清除凭证并返回登录页）
  Widget _buildLogoutTile() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.logout, color: Colors.red),
      title: Text(
        l10n.logout,
        style: const TextStyle(color: Colors.red),
      ),
      subtitle: Text(l10n.logoutDesc),
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
        Text(AppLocalizations.of(context).aboutDesc),
        const SizedBox(height: 8),
        const Text('© 2026 ClipSync Team'),
      ],
    );
  }
}
