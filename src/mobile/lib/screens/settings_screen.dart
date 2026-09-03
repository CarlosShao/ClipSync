import "package:flutter/material.dart";
import "package:go_router/go_router.dart";
import "package:provider/provider.dart";
import "package:shared_preferences/shared_preferences.dart";

import "package:clipsync_mobile/l10n/app_localizations.dart";
import "package:clipsync_mobile/providers/auth_provider.dart";
import "package:clipsync_mobile/providers/clipboard_provider.dart";
import "package:clipsync_mobile/providers/settings_provider.dart";
import "package:clipsync_mobile/router/app_router.dart";
import "package:clipsync_mobile/screens/notification_settings_screen.dart";
import "package:clipsync_mobile/screens/templates/templates_screen.dart";
import "package:clipsync_mobile/services/biometric_service.dart";
import "package:clipsync_mobile/services/profile_api_service.dart";
import "package:clipsync_mobile/services/server_config.dart";
import "package:clipsync_mobile/theme/app_theme.dart";
import "package:clipsync_mobile/widgets/common/app_card.dart";
import "package:clipsync_mobile/widgets/common/section_divider.dart";

/// 设置页面（移动端）
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

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
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.tabSettings),
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.sm,
        ),
        children: [
          // 账号资料
          SectionDivider(title: l10n.accountSection),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: _buildAccountSection(),
          ),
          const SizedBox(height: AppSpacing.md),

          // 服务器设置
          SectionDivider(title: l10n.sectionServer),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: _buildServerUrlSetting(),
          ),
          const SizedBox(height: AppSpacing.md),

          // 通用通知与提示
          SectionDivider(title: l10n.sectionGeneral),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: _buildNotificationSetting(),
          ),
          const SizedBox(height: AppSpacing.md),

          // 外观偏好
          SectionDivider(title: l10n.sectionAppearance),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
            child: Column(
              children: [
                _buildThemeSetting(),
                const Divider(height: 1),
                _buildLanguageSetting(),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),

          // 安全与生物识别
          SectionDivider(title: l10n.sectionSecurity),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: _buildBiometricLockSetting(),
          ),
          const SizedBox(height: AppSpacing.md),

          // 数据与功能模块
          SectionDivider(title: l10n.sectionData),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                _buildClearCacheButton(),
                const Divider(height: 1),
                _buildTemplatesTile(),
                const Divider(height: 1),
                _buildSharedLinksTile(),
                const Divider(height: 1),
                _buildNotificationsCenterTile(),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),

          // 同步与剪贴板设置
          SectionDivider(title: l10n.sectionNotification),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                _buildNotificationSettings(),
                const Divider(height: 1),
                _buildClipboardCaptureSetting(),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.md),

          // 订阅管理
          SectionDivider(title: l10n.sectionSubscription),
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: _buildSubscriptionSetting(),
          ),
          const SizedBox(height: AppSpacing.md),

          // 退出登录与关于
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                _buildLogoutTile(),
                const Divider(height: 1),
                _buildAboutSection(),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
        ],
      ),
    );
  }

  /// C6：账号资料区块——圆形头像（64dp，昵称/手机号首字，主色底白字；有 avatarUrl
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
          radius: 32,
          child: Icon(Icons.person_outline, size: 32),
        ),
        title: Text(l10n.notLoggedIn),
      );
    }

    final nickname = ((user["nickname"] as String?) ?? "").trim();
    final phone = ((user["phone"] as String?) ?? "").trim();
    final email = ((user["email"] as String?) ?? "").trim();
    final avatarUrl = ((user["avatarUrl"] as String?) ?? "").trim();
    final plan = ((user["plan"] as String?) ?? "").trim();

    final display = nickname.isNotEmpty ? nickname : phone;
    final subtitle = phone.isNotEmpty ? phone : email;

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.xs,
      ),
      leading: CircleAvatar(
        radius: 32,
        backgroundColor: Theme.of(context).primaryColor,
        backgroundImage: avatarUrl.isNotEmpty ? NetworkImage(avatarUrl) : null,
        child: avatarUrl.isNotEmpty
            ? null
            : display.isEmpty
                ? const Icon(Icons.person_outline, color: Colors.white, size: 32)
                : Text(
                    String.fromCharCode(display.runes.first),
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 22,
                    ),
                  ),
      ),
      title: Text(
        display.isNotEmpty ? display : l10n.notLoggedIn,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
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
    final bool isFree = plan.toLowerCase() == "free";
    final (Color background, Color foreground) = isFree
        ? (scheme.surfaceContainerHighest, scheme.onSurfaceVariant)
        : (scheme.primaryContainer, scheme.onPrimaryContainer);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
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
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.sm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.theme,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: AppSpacing.sm),
          SizedBox(
            width: double.infinity,
            child: SegmentedButton<int>(
              showSelectedIcon: false,
              segments: <ButtonSegment<int>>[
                ButtonSegment<int>(
                  value: 0,
                  label: Text(l10n.themeSystem),
                  icon: const Icon(Icons.brightness_auto, size: 18),
                ),
                ButtonSegment<int>(
                  value: 1,
                  label: Text(l10n.themeLight),
                  icon: const Icon(Icons.light_mode, size: 18),
                ),
                ButtonSegment<int>(
                  value: 2,
                  label: Text(l10n.themeDark),
                  icon: const Icon(Icons.dark_mode, size: 18),
                ),
              ],
              selected: <int>{_themeModeIndex},
              onSelectionChanged: (Set<int> newSelection) {
                if (newSelection.isNotEmpty) {
                  _setThemeMode(newSelection.first);
                }
              },
            ),
          ),
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
          DropdownMenuItem(value: "zh", child: Text("简体中文")),
          DropdownMenuItem(value: "en", child: Text("English")),
        ],
      ),
    );
  }

  String _getLanguageText() {
    switch (_language) {
      case "zh":
        return "简体中文";
      case "en":
        return "English";
      default:
        return "简体中文";
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
    return Column(
      children: [
        SwitchListTile(
          secondary: const Icon(Icons.content_copy),
          title: Text(l10n.clipboardCapture),
          subtitle: Text(l10n.clipboardCaptureDesc),
          value: captureEnabled,
          onChanged: (value) {
            context.read<SettingsProvider>().setClipboardCaptureEnabled(value);
          },
        ),
        // 核心场景：PC 复制 → 自动写入本机系统剪贴板，任意 App 直接粘贴
        SwitchListTile(
          secondary: const Icon(Icons.paste),
          title: Text(l10n.clipboardWriteback),
          subtitle: Text(l10n.clipboardWritebackDesc),
          value: context.watch<SettingsProvider>().clipboardWritebackEnabled,
          onChanged: (value) {
            context.read<SettingsProvider>().setClipboardWritebackEnabled(value);
          },
        ),
      ],
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
      icon: const Icon(Icons.info_outline),
      applicationName: "ClipSync",
      applicationVersion: "0.1.0",
      applicationIcon: const FlutterLogo(size: 48),
      aboutBoxChildren: [
        Text(AppLocalizations.of(context).aboutDesc),
        const SizedBox(height: 8),
        const Text("© 2026 ClipSync Team"),
      ],
    );
  }
}
