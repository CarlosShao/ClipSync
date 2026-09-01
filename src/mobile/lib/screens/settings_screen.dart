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
import '../services/profile_api_service.dart';
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

  /// B3：推送通知开关——读写改走 SettingsProvider（SharedPreferences 键
  /// notifications_enabled 不变，本地通知链路 LocalNotificationService 读取
  /// 同一键不受影响）；与通知设置页（notification_settings_screen）共用同一
  /// provider 字段，两处联动。
  Future<void> _toggleNotifications(bool value) async {
    await context.read<SettingsProvider>().setNotificationsEnabled(value);
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
          _buildSectionHeader(l10n.accountSection),
          _buildAccountSection(),
          const Divider(),

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

          _buildSectionHeader(l10n.sectionSecurity),
          _buildBiometricLockSetting(),
          const Divider(),

          _buildSectionHeader(l10n.sectionData),
          _buildClearCacheButton(),
          _buildTemplatesTile(),
          _buildSharedLinksTile(),
          _buildNotificationsCenterTile(),
          const Divider(),

          _buildSectionHeader(l10n.sectionNotification),
          _buildNotificationSettings(),
          _buildClipboardCaptureSetting(),
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

  /// C6：账号资料区块——圆形头像（昵称/手机号首字，主色底白字；有 avatarUrl
  /// 则显示网络头像）+ 昵称（未设置显示手机号）+ 手机号/邮箱副信息行，
  /// trailing 套餐徽标（G6：数据源 auth_provider 已拉的 user.plan，服务端
  /// GET /api/auth/me 的 COALESCE(plan_name, 'Free')；Free 灰、付费主题色
  /// 小 Chip，样式对齐订阅页 _buildStatusChip），点击弹昵称编辑对话框；
  /// 未登录（user 为 null）灰化占位。
  Widget _buildAccountSection() {
    final l10n = AppLocalizations.of(context);
    final user = context.watch<AuthProvider>().user;

    if (user == null) {
      return ListTile(
        enabled: false,
        leading: const CircleAvatar(
          child: Icon(Icons.person_outline),
        ),
        title: Text(l10n.notLoggedIn),
      );
    }

    final nickname = ((user['nickname'] as String?) ?? '').trim();
    final phone = ((user['phone'] as String?) ?? '').trim();
    final email = ((user['email'] as String?) ?? '').trim();
    final avatarUrl = ((user['avatarUrl'] as String?) ?? '').trim();
    final plan = ((user['plan'] as String?) ?? '').trim();

    final display = nickname.isNotEmpty ? nickname : phone;
    final subtitle = phone.isNotEmpty ? phone : email;

    return ListTile(
      leading: CircleAvatar(
        radius: 24,
        backgroundColor: Theme.of(context).primaryColor,
        backgroundImage: avatarUrl.isNotEmpty ? NetworkImage(avatarUrl) : null,
        child: avatarUrl.isNotEmpty
            ? null
            : display.isEmpty
                ? const Icon(Icons.person_outline, color: Colors.white)
                : Text(
                    String.fromCharCode(display.runes.first),
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
      ),
      title: Text(display.isNotEmpty ? display : l10n.notLoggedIn),
      subtitle: subtitle.isNotEmpty ? Text(subtitle) : null,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (plan.isNotEmpty) ...[
            _buildPlanBadge(plan),
            const SizedBox(width: AppSpacing.xs),
          ],
          const Icon(Icons.chevron_right),
        ],
      ),
      onTap: _showEditNicknameDialog,
    );
  }

  /// G6：套餐徽标小 Chip——Free（不区分大小写）灰色，付费套餐（Pro/
  /// Enterprise 等）主题色；plan 缺失时不展示（由调用方判断）。
  Widget _buildPlanBadge(String plan) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final TextTheme textTheme = Theme.of(context).textTheme;
    final bool isFree = plan.toLowerCase() == 'free';
    final (Color background, Color foreground) = isFree
        ? (scheme.surfaceContainerHighest, scheme.onSurfaceVariant)
        : (scheme.primaryContainer, scheme.onPrimaryContainer);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Text(
        plan,
        style: textTheme.labelSmall?.copyWith(
          color: foreground,
          fontWeight: FontWeight.w600,
        ),
        maxLines: 1,
      ),
    );
  }

  /// C6：昵称编辑对话框——保存走 PUT /api/auth/profile（ProfileApiService），
  /// 成功后同步 AuthProvider.user 并提示 nicknameSaved；失败提示
  /// nicknameSaveFailed（对话框保持打开可重试）。
  Future<void> _showEditNicknameDialog() async {
    final l10n = AppLocalizations.of(context);
    final auth = context.read<AuthProvider>();
    final controller = TextEditingController(
      text: ((auth.user?['nickname'] as String?) ?? '').trim(),
    );
    var saving = false;
    String? savedNickname;

    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(l10n.editNickname),
          content: TextField(
            controller: controller,
            autofocus: true,
            decoration: InputDecoration(
              labelText: l10n.nickname,
            ),
          ),
          actions: [
            TextButton(
              onPressed:
                  saving ? null : () => Navigator.pop(dialogContext, false),
              child: Text(l10n.cancel),
            ),
            TextButton(
              onPressed: saving
                  ? null
                  : () async {
                      final nickname = controller.text.trim();
                      if (nickname.isEmpty) return;
                      saving = true;
                      setDialogState(() {});
                      try {
                        await ProfileApiService()
                            .updateNickname(auth.token, nickname);
                        savedNickname = nickname;
                        if (!dialogContext.mounted) return;
                        Navigator.pop(dialogContext, true);
                      } catch (e) {
                        debugPrint('[Settings] update nickname failed: $e');
                        saving = false;
                        setDialogState(() {});
                        if (!mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(l10n.nicknameSaveFailed),
                          ),
                        );
                      }
                    },
              child: saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(l10n.save),
            ),
          ],
        ),
      ),
    );

    final nickname = savedNickname;
    controller.dispose();
    if (saved != true || nickname == null || !mounted) return;

    final currentUser = auth.user;
    if (currentUser != null) {
      final updated = Map<String, dynamic>.from(currentUser);
      updated['nickname'] = nickname;
      auth.updateUser(updated);
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(l10n.nicknameSaved)),
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
    // B3：值来自 SettingsProvider（通知设置页切换后返回本页仍保持联动）
    final notificationsEnabled = context.watch<SettingsProvider>().notificationsEnabled;
    return SwitchListTile(
      title: Text(l10n.pushNotifications),
      subtitle: Text(l10n.pushNotificationsDesc),
      value: notificationsEnabled,
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
    final l10n = AppLocalizations.of(context);
    return SwitchListTile(
      secondary: const Icon(Icons.fingerprint),
      title: Text(l10n.biometricLock),
      subtitle: Text(
        _biometricSupported
            ? l10n.biometricLockDesc
            : l10n.biometricUnsupported,
      ),
      value: _biometricSupported && _biometricLockEnabled,
      // 设备不支持时 onChanged 为 null → 开关呈禁用态
      onChanged: _biometricSupported ? _toggleBiometricLock : null,
    );
  }

  /// T4.6：切换生物识别锁。开启前先做一次生物验证确认本人操作，
  /// 验证未通过则保持关闭；结果持久化到 biometric_lock_enabled。
  Future<void> _toggleBiometricLock(bool value) async {
    final l10n = AppLocalizations.of(context);
    if (value) {
      final ok = await BiometricService.authenticate(
        reason: l10n.biometricLockReason,
      );
      if (!ok) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(l10n.biometricLockFailed)),
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

  /// C5：共享链接管理入口（列表 / 复制 / 撤销 / 创建）
  Widget _buildSharedLinksTile() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.link),
      title: Text(l10n.sharedLinks),
      subtitle: Text(l10n.sharedLinksDesc),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push(AppRoutes.sharedLinks),
    );
  }

  /// C5：通知中心入口（站内通知列表 / 已读 / 全部已读）
  Widget _buildNotificationsCenterTile() {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      leading: const Icon(Icons.mark_email_unread_outlined),
      title: Text(l10n.notificationsCenter),
      subtitle: Text(l10n.notificationsCenterDesc),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push(AppRoutes.notifications),
    );
  }

  /// B3：剪贴板采集总开关——关闭后本机复制内容不再自动同步到其他设备
  /// （前台服务保持运行，WS 推送接收不受影响；状态与持久化在
  /// SettingsProvider 'clipboard_capture_enabled'，采集侧实时读取）
  Widget _buildClipboardCaptureSetting() {
    final l10n = AppLocalizations.of(context);
    final captureEnabled = context.watch<SettingsProvider>().clipboardCaptureEnabled;
    return SwitchListTile(
      secondary: const Icon(Icons.content_copy),
      title: Text(l10n.clipboardCapture),
      subtitle: Text(l10n.clipboardCaptureDesc),
      value: captureEnabled,
      onChanged: (value) {
        context.read<SettingsProvider>().setClipboardCaptureEnabled(value);
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
