import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../l10n/app_localizations.dart';
import '../providers/auth_provider.dart';
import '../router/app_router.dart';
import '../services/app_exception.dart';
import '../theme/app_theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phoneController = TextEditingController();
  final _codeController = TextEditingController();
  final _twoFactorController = TextEditingController();
  bool _twoFactorRequired = false;
  bool _verifying2fa = false;
  int _countdown = 0;
  Timer? _timer;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    _twoFactorController.dispose();
    _timer?.cancel();
    super.dispose();
  }

  void _startCountdown() {
    _countdown = 60;
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
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
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.codeSent)),
      );
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    }
  }

  Future<void> _login() async {
    final l10n = AppLocalizations.of(context);
    final phone = _phoneController.text.trim();
    final code = _codeController.text.trim();

    if (phone.isEmpty || code.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.phoneAndCodeRequired)),
      );
      return;
    }

    final result = await context.read<AuthProvider>().login(phone, code);
    if (!mounted) return;
    if (result == LoginResult.success) {
      // 登录成功：通过 go_router 进入主页（守卫会校验 onboarding/token 状态）
      context.go(AppRoutes.home);
    } else if (result == LoginResult.twoFactorRequired) {
      // 账号开启了两步验证：切换到 6 位动态验证码输入态
      setState(() => _twoFactorRequired = true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.loginFailed)),
      );
    }
  }

  Future<void> _submitTwoFactor() async {
    final l10n = AppLocalizations.of(context);
    final code = _twoFactorController.text.trim();
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
    _twoFactorController.clear();
    setState(() => _twoFactorRequired = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(32),
            child: _twoFactorRequired
                ? _buildTwoFactorForm()
                : _buildLoginForm(),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 普通登录表单（手机号 + 短信验证码）
  // ---------------------------------------------------------------------------
  Widget _buildLoginForm() {
    final l10n = AppLocalizations.of(context);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        // Logo
        Container(
          width: 80,
          height: 80,
          decoration: BoxDecoration(
            color: AppTheme.primaryColor,
            borderRadius: BorderRadius.circular(20),
          ),
          child: const Icon(
            Icons.content_paste,
            size: 40,
            color: Colors.white,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          l10n.appTitle,
          style: const TextStyle(
            fontSize: 32,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          l10n.loginSubtitle,
          style: const TextStyle(
            fontSize: 16,
            color: AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 48),

        // Phone input
        TextField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          decoration: InputDecoration(
            labelText: l10n.phoneNumber,
            hintText: l10n.phoneHint,
            prefixIcon: const Icon(Icons.phone),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
        ),
        const SizedBox(height: 16),

        // Code input
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _codeController,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: l10n.verificationCode,
                  hintText: l10n.codeHint,
                  prefixIcon: const Icon(Icons.lock_outline),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              height: 56,
              child: ElevatedButton(
                onPressed: _countdown > 0 ? null : _sendCode,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _countdown > 0
                      ? Colors.grey
                      : AppTheme.primaryColor,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                child: Text(
                  _countdown > 0
                      ? l10n.codeCountdown(_countdown)
                      : l10n.getCode,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),

        // Login button
        SizedBox(
          width: double.infinity,
          height: 56,
          child: ElevatedButton(
            onPressed: _login,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.primaryColor,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: Text(
              l10n.login,
              style: const TextStyle(fontSize: 18),
            ),
          ),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 两步验证表单（6 位动态验证码）
  // ---------------------------------------------------------------------------
  Widget _buildTwoFactorForm() {
    final l10n = AppLocalizations.of(context);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Container(
          width: 80,
          height: 80,
          decoration: BoxDecoration(
            color: AppTheme.primaryColor,
            borderRadius: BorderRadius.circular(20),
          ),
          child: const Icon(
            Icons.phonelink_lock,
            size: 40,
            color: Colors.white,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          l10n.twoFactorTitle,
          style: const TextStyle(
            fontSize: 28,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          l10n.twoFactorDesc,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 15,
            color: AppTheme.textSecondary,
          ),
        ),
        const SizedBox(height: 48),

        // 2FA code input
        TextField(
          controller: _twoFactorController,
          keyboardType: TextInputType.number,
          maxLength: 6,
          autofocus: true,
          enabled: !_verifying2fa,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 24,
            letterSpacing: 12,
            fontWeight: FontWeight.bold,
          ),
          decoration: InputDecoration(
            counterText: '',
            labelText: l10n.twoFactorCodeLabel,
            hintText: '000000',
            prefixIcon: const Icon(Icons.shield_outlined),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
          onSubmitted: (_) => _submitTwoFactor(),
        ),
        const SizedBox(height: 24),

        // Verify button
        SizedBox(
          width: double.infinity,
          height: 56,
          child: ElevatedButton(
            onPressed: _verifying2fa ? null : _submitTwoFactor,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.primaryColor,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: _verifying2fa
                ? const SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : Text(
                    l10n.verifyAndLogin,
                    style: const TextStyle(fontSize: 18),
                  ),
          ),
        ),
        const SizedBox(height: 16),

        // 返回普通登录
        TextButton(
          onPressed: _verifying2fa ? null : _backToNormalLogin,
          child: Text(
            l10n.backToLogin,
            style: const TextStyle(color: AppTheme.textSecondary),
          ),
        ),
      ],
    );
  }
}
