import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/providers/auth_provider.dart';
import 'package:clipsync_mobile/router/app_router.dart';
import 'package:clipsync_mobile/services/app_exception.dart';
import 'package:clipsync_mobile/services/server_config.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/sync_pulse_indicator.dart';

/// 登录页面 (Obsidian v2 / 规范 5.1)。
///
/// 规范要求：
/// 1. 布局：竖直居中，顶部带品牌区（ClipSync Logo 32dp + displaySmall 品牌名 + 品牌紫 8%->0% 垂直渐变背景）；
/// 2. 表单区：手机号输入（OutlinedTextField 圆角 12，AppShapesV2.sm）、验证码行内输入 + 倒计时按钮、
///    2FA 6 位动态码（居中、JetBrains Mono 等宽、输入自动聚焦前进）、全宽 56dp 高主登录按钮；
/// 3. 分隔线「或」（左右渐隐渐变横线）；
/// 4. 密码登录模式切换；
/// 5. 底部：服务在线状态点（带有 syncGlow 脉冲/绿色圆点）+ 服务器地址配置入口；
/// 6. 软键盘自适应（resizeToAvoidBottomInset, SingleChildScrollView）；
/// 7. 严格保持 AuthProvider 功能链路（验证码发送、登录、2FA 校验、服务器配置）完全正常。
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _codeController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  final List<TextEditingController> _digitControllers =
      List<TextEditingController>.generate(6, (_) => TextEditingController());
  final List<FocusNode> _digitFocusNodes =
      List<FocusNode>.generate(6, (_) => FocusNode());

  bool _isPasswordMode = false;
  bool _twoFactorRequired = false;
  bool _verifying2fa = false;
  bool _loggingIn = false;
  bool _obscurePassword = true;
  int _countdown = 0;
  Timer? _timer;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    _passwordController.dispose();
    for (final controller in _digitControllers) {
      controller.dispose();
    }
    for (final node in _digitFocusNodes) {
      node.dispose();
    }
    _timer?.cancel();
    super.dispose();
  }

  void _startCountdown() {
    _countdown = 60;
    _timer = Timer.periodic(const Duration(seconds: 1), (Timer timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        if (_countdown > 0) {
          _countdown--;
        } else {
          timer.cancel();
        }
      });
    });
  }

  Future<void> _sendCode() async {
    final l10n = AppLocalizations.of(context);
    final phone = _phoneController.text.trim();
    if (phone.isEmpty || phone.length != 11) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.invalidPhone)),
      );
      return;
    }

    try {
      await context.read<AuthProvider>().sendVerificationCode(phone);
      _startCountdown();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.codeSent)),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    }
  }

  Future<void> _login() async {
    final l10n = AppLocalizations.of(context);
    final phone = _phoneController.text.trim();

    if (_isPasswordMode) {
      final password = _passwordController.text;
      if (phone.isEmpty || password.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(phone.isEmpty
                ? l10n.phoneHint
                : (l10n.localeName.startsWith("zh") ? "请输入密码" : "Please enter password")),
          ),
        );
        return;
      }
      setState(() => _loggingIn = true);
      try {
        final result = await context.read<AuthProvider>().login(phone, password);
        if (!mounted) return;
        _handleLoginResult(result, l10n);
      } finally {
        if (mounted) setState(() => _loggingIn = false);
      }
      return;
    }

    final code = _codeController.text.trim();
    if (phone.isEmpty || code.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.phoneAndCodeRequired)),
      );
      return;
    }

    setState(() => _loggingIn = true);
    try {
      final result = await context.read<AuthProvider>().login(phone, code);
      if (!mounted) return;
      _handleLoginResult(result, l10n);
    } finally {
      if (mounted) setState(() => _loggingIn = false);
    }
  }

  void _handleLoginResult(LoginResult result, AppLocalizations l10n) {
    if (result == LoginResult.success) {
      context.go(AppRoutes.home);
    } else if (result == LoginResult.twoFactorRequired) {
      setState(() => _twoFactorRequired = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_digitFocusNodes.isNotEmpty && mounted) {
          _digitFocusNodes[0].requestFocus();
        }
      });
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.loginFailed)),
      );
    }
  }

  String _getCombinedTwoFactorCode() {
    return _digitControllers.map((c) => c.text).join();
  }

  Future<void> _submitTwoFactor() async {
    final l10n = AppLocalizations.of(context);
    final code = _getCombinedTwoFactorCode().trim();
    if (code.length != 6) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.enterSixDigitCode)),
      );
      return;
    }

    setState(() => _verifying2fa = true);
    final ok = await context.read<AuthProvider>().verifyTwoFactorLogin(code);
    if (!mounted) return;
    setState(() => _verifying2fa = false);

    if (ok) {
      context.go(AppRoutes.home);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.codeInvalidOrExpired)),
      );
    }
  }

  void _backToNormalLogin() {
    context.read<AuthProvider>().cancelTwoFactor();
    for (final c in _digitControllers) {
      c.clear();
    }
    setState(() => _twoFactorRequired = false);
  }

  Future<void> _showServerConfigDialog() async {
    final l10n = AppLocalizations.of(context);
    final textController = TextEditingController(text: ServerConfig.baseUrl);

    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return AlertDialog(
          shape: const RoundedRectangleBorder(borderRadius: AppShapesV2.brLg),
          title: Text(l10n.sectionServer),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                l10n.serverUrlDesc,
                style: Theme.of(dialogContext).textTheme.bodySmall?.copyWith(
                      color: Theme.of(dialogContext).colorScheme.onSurfaceVariant,
                    ),
              ),
              const SizedBox(height: AppSpacing.md),
              TextField(
                controller: textController,
                keyboardType: TextInputType.url,
                decoration: InputDecoration(
                  labelText: l10n.serverUrl,
                  border: const OutlineInputBorder(
                    borderRadius: AppShapesV2.brSm,
                  ),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              onPressed: () async {
                final newUrl = textController.text.trim();
                if (newUrl.isNotEmpty) {
                  ServerConfig.setBaseUrl(newUrl);
                  try {
                    final prefs = await SharedPreferences.getInstance();
                    await prefs.setString("server_url", newUrl);
                  } catch (_) {}
                }
                if (!dialogContext.mounted) return;
                Navigator.of(dialogContext).pop();
                setState(() {});
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text(l10n.serverUrlSaved)),
                );
              },
              child: Text(l10n.confirm),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final brandPrimary =
        isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight;

    return Scaffold(
      resizeToAvoidBottomInset: true,
      backgroundColor: AppColorsV2.surface(context, tier: SurfaceTier.base),
      body: Stack(
        children: [
          // 顶部品牌紫 8% -> 0% 垂直渐变背景（不遮挡内容）
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 280,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    brandPrimary.withValues(alpha: 0.08),
                    brandPrimary.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.xl,
                  vertical: AppSpacing.lg,
                ),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: _twoFactorRequired
                      ? _buildTwoFactorForm(theme, isDark, brandPrimary)
                      : _buildLoginForm(theme, isDark, brandPrimary),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 普通登录表单（手机号 + 验证码 / 密码）
  // ---------------------------------------------------------------------------
  Widget _buildLoginForm(ThemeData theme, bool isDark, Color brandPrimary) {
    final l10n = AppLocalizations.of(context);
    final isZh = l10n.localeName.startsWith("zh");

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        // 品牌区：Logo 32dp + displaySmall 品牌名
        _buildBrandHeader(theme, brandPrimary, l10n),
        const SizedBox(height: AppSpacing.xxl),

        // 手机号输入框（OutlinedTextField 圆角 12，AppShapesV2.sm）
        TextField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(11),
          ],
          decoration: InputDecoration(
            labelText: l10n.phoneNumber,
            hintText: l10n.phoneHint,
            prefixIcon: const Icon(Icons.phone_iphone_rounded, size: 20),
            border: const OutlineInputBorder(
              borderRadius: AppShapesV2.brSm,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),

        // 验证码模式：行内输入 + 倒计时按钮
        if (!_isPasswordMode)
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: TextField(
                  controller: _codeController,
                  keyboardType: TextInputType.number,
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                  decoration: InputDecoration(
                    labelText: l10n.verificationCode,
                    hintText: l10n.codeHint,
                    prefixIcon: const Icon(Icons.shield_outlined, size: 20),
                    border: const OutlineInputBorder(
                      borderRadius: AppShapesV2.brSm,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              SizedBox(
                height: 54,
                child: TextButton(
                  onPressed: _countdown > 0 ? null : _sendCode,
                  style: TextButton.styleFrom(
                    shape: const RoundedRectangleBorder(
                      borderRadius: AppShapesV2.brSm,
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                  ),
                  child: Text(
                    _countdown > 0
                        ? l10n.codeCountdown(_countdown)
                        : l10n.getCode,
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      color: _countdown > 0
                          ? theme.colorScheme.outline
                          : brandPrimary,
                    ),
                  ),
                ),
              ),
            ],
          )
        else
          // 密码登录模式
          TextField(
            controller: _passwordController,
            obscureText: _obscurePassword,
            decoration: InputDecoration(
              labelText: isZh ? "密码" : "Password",
              hintText: isZh ? "请输入账户密码" : "Enter your password",
              prefixIcon: const Icon(Icons.lock_outline_rounded, size: 20),
              suffixIcon: IconButton(
                icon: Icon(
                  _obscurePassword
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                  size: 20,
                ),
                onPressed: () {
                  setState(() => _obscurePassword = !_obscurePassword);
                },
              ),
              border: const OutlineInputBorder(
                borderRadius: AppShapesV2.brSm,
              ),
            ),
          ),

        const SizedBox(height: AppSpacing.xl),

        // 全宽 56dp 高主登录按钮（FilledButton）
        SizedBox(
          width: double.infinity,
          height: 56,
          child: FilledButton(
            onPressed: _loggingIn ? null : _login,
            style: FilledButton.styleFrom(
              shape: const RoundedRectangleBorder(
                borderRadius: AppShapesV2.brSm,
              ),
            ),
            child: _loggingIn
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.2,
                      color: Colors.white,
                    ),
                  )
                : Text(
                    l10n.login,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
          ),
        ),

        const SizedBox(height: AppSpacing.lg),

        // 分隔线「或」（左右渐隐线）
        _buildOrDivider(theme, isDark, isZh),

        const SizedBox(height: AppSpacing.sm),

        // 密码登录 / 验证码登录模式切换
        TextButton(
          onPressed: () {
            setState(() {
              _isPasswordMode = !_isPasswordMode;
            });
          },
          child: Text(
            _isPasswordMode
                ? (isZh ? "使用手机验证码登录" : "Sign in with SMS Code")
                : (isZh ? "使用密码登录" : "Sign in with Password"),
            style: theme.textTheme.bodyMedium?.copyWith(
              color: brandPrimary,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),

        const SizedBox(height: AppSpacing.xxl),

        // 底部：服务状态点（syncGlow 绿=在线）+ 服务器地址配置入口
        _buildServerStatusFooter(theme, isDark, isZh),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 品牌头部展示
  // ---------------------------------------------------------------------------
  Widget _buildBrandHeader(ThemeData theme, Color brandPrimary, AppLocalizations l10n) {
    return Column(
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            color: brandPrimary.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: brandPrimary.withValues(alpha: 0.2),
              width: 1,
            ),
          ),
          child: Center(
            child: Icon(
              Icons.all_inclusive_rounded,
              size: 32,
              color: brandPrimary,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        Text(
          l10n.appTitle,
          style: theme.textTheme.displaySmall?.copyWith(
            fontWeight: FontWeight.bold,
            letterSpacing: -0.5,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          l10n.loginSubtitle,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 「或」分隔线（左右渐隐）
  // ---------------------------------------------------------------------------
  Widget _buildOrDivider(ThemeData theme, bool isDark, bool isZh) {
    final borderColor = AppColorsV2.borderFor(isDark: isDark);
    final textColor = theme.colorScheme.onSurfaceVariant;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Row(
        children: [
          Expanded(
            child: Container(
              height: 1,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    borderColor.withValues(alpha: 0.0),
                    borderColor,
                  ],
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Text(
              isZh ? "或" : "OR",
              style: theme.textTheme.labelSmall?.copyWith(
                color: textColor,
                fontWeight: FontWeight.w500,
                letterSpacing: 1.0,
              ),
            ),
          ),
          Expanded(
            child: Container(
              height: 1,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    borderColor,
                    borderColor.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 底部服务状态点与服务器配置
  // ---------------------------------------------------------------------------
  Widget _buildServerStatusFooter(ThemeData theme, bool isDark, bool isZh) {
    final onlineColor = isDark ? AppColors.successDark : AppColors.success;

    return InkWell(
      onTap: _showServerConfigDialog,
      borderRadius: const BorderRadius.all(AppShapesV2.rPill),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.xs,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            // 在线状态指示点（附带微脉冲）
            SyncPulseIndicator(
              trigger: true,
              size: 8,
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: onlineColor,
                  boxShadow: [
                    BoxShadow(
                      color: onlineColor.withValues(alpha: 0.4),
                      blurRadius: 4,
                      spreadRadius: 1,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(
              ServerConfig.baseUrl.replaceFirst(RegExp(r"^https?://"), ""),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontFamily: "JetBrains Mono",
              ),
            ),
            const SizedBox(width: AppSpacing.xs),
            Icon(
              Icons.tune_rounded,
              size: 14,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 两步验证表单（6 位独立等宽动态码）
  // ---------------------------------------------------------------------------
  Widget _buildTwoFactorForm(ThemeData theme, bool isDark, Color brandPrimary) {
    final l10n = AppLocalizations.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            color: brandPrimary.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: brandPrimary.withValues(alpha: 0.2),
              width: 1,
            ),
          ),
          child: Center(
            child: Icon(
              Icons.security_rounded,
              size: 32,
              color: brandPrimary,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        Text(
          l10n.twoFactorTitle,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          l10n.twoFactorDesc,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.xxl),

        // 6 位独立等宽动态码方框，支持输入自动前进与退格
        _buildSixDigitInput(theme, isDark, brandPrimary),

        const SizedBox(height: AppSpacing.xl),

        // 提交按钮
        SizedBox(
          width: double.infinity,
          height: 56,
          child: FilledButton(
            onPressed: _verifying2fa ? null : _submitTwoFactor,
            style: FilledButton.styleFrom(
              shape: const RoundedRectangleBorder(
                borderRadius: AppShapesV2.brSm,
              ),
            ),
            child: _verifying2fa
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.2,
                      color: Colors.white,
                    ),
                  )
                : Text(
                    l10n.verifyAndLogin,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),

        // 返回普通登录
        TextButton(
          onPressed: _verifying2fa ? null : _backToNormalLogin,
          child: Text(
            l10n.backToLogin,
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }

  Widget _buildSixDigitInput(ThemeData theme, bool isDark, Color brandPrimary) {
    final borderColor = AppColorsV2.borderFor(isDark: isDark);
    final surfaceColor = AppColorsV2.surface(context, tier: SurfaceTier.low);

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: List.generate(6, (index) {
        return SizedBox(
          width: 48,
          height: 56,
          child: KeyboardListener(
            focusNode: FocusNode(),
            onKeyEvent: (event) {
              if (event is KeyDownEvent &&
                  event.logicalKey == LogicalKeyboardKey.backspace &&
                  _digitControllers[index].text.isEmpty &&
                  index > 0) {
                _digitFocusNodes[index - 1].requestFocus();
              }
            },
            child: TextField(
              controller: _digitControllers[index],
              focusNode: _digitFocusNodes[index],
              keyboardType: TextInputType.number,
              textAlign: TextAlign.center,
              maxLength: 1,
              style: const TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.bold,
                fontFamily: "JetBrains Mono",
              ),
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                counterText: "",
                contentPadding: EdgeInsets.zero,
                filled: true,
                fillColor: surfaceColor,
                enabledBorder: OutlineInputBorder(
                  borderRadius: AppShapesV2.brSm,
                  borderSide: BorderSide(color: borderColor),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: AppShapesV2.brSm,
                  borderSide: BorderSide(color: brandPrimary, width: 2),
                ),
              ),
              onChanged: (value) {
                if (value.isNotEmpty) {
                  if (index < 5) {
                    _digitFocusNodes[index + 1].requestFocus();
                  } else {
                    _digitFocusNodes[index].unfocus();
                    _submitTwoFactor();
                  }
                }
              },
            ),
          ),
        );
      }),
    );
  }
}

