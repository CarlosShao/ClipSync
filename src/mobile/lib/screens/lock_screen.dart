// lib/screens/lock_screen.dart

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../router/app_router.dart';
import '../services/biometric_service.dart';

/// 生物识别锁定页（T4.6）。
///
/// 已登录 + 生物锁布防（[BiometricLockGate.locked]）时，路由守卫把
/// 所有路由重定向到本页，构成进入应用前的遮罩：
/// - 展示 Logo、提示文案与「解锁」按钮；
/// - 进入本页时自动发起一次系统生物验证，验证成功 →
///   [BiometricLockGate.unlock] → 守卫放行回主页；
/// - 验证失败/取消 → 显示错误提示，可通过按钮无限重试。
class LockScreen extends StatefulWidget {
  const LockScreen({super.key});

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  bool _authenticating = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 进入锁定页自动弹一次系统验证；失败或用户取消后仍可点按钮重试
    WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  Future<void> _unlock() async {
    if (_authenticating || !mounted) return;
    final l10n = AppLocalizations.of(context);
    setState(() {
      _authenticating = true;
      _error = null;
    });
    final ok = await BiometricService.authenticate(
      reason: l10n.biometricUnlockReason,
    );
    if (!mounted) return;
    setState(() => _authenticating = false);
    if (ok) {
      // 解除布防，ValueNotifier 触发 go_router 重新求值重定向 → 主页
      BiometricLockGate.unlock();
    } else {
      setState(() => _error = l10n.biometricVerifyFailed);
    }
  }

  @override
  Widget build(BuildContext context) {
    // 配色与冷启动加载页（app_router.dart _SplashScreen）保持一致
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(
                Icons.content_paste,
                size: 64,
                color: Color(0xFF6C5CE7),
              ),
              const SizedBox(height: 16),
              Text(
                l10n.appTitle,
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF2D3436),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                l10n.lockScreenMessage,
                style: const TextStyle(
                  fontSize: 14,
                  color: Color(0xFF636E72),
                ),
              ),
              const SizedBox(height: 32),
              if (_authenticating)
                const CircularProgressIndicator(color: Color(0xFF6C5CE7))
              else
                FilledButton.icon(
                  onPressed: _unlock,
                  icon: const Icon(Icons.fingerprint),
                  label: Text(l10n.unlock),
                ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  style: const TextStyle(fontSize: 13, color: Colors.red),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
