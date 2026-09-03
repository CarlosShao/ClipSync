import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/router/app_router.dart';
import 'package:clipsync_mobile/services/biometric_service.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';

/// 生物识别锁定页 (Obsidian v2 / 规范 5.2)。
///
/// 规范要求：
/// 1. 全屏品牌紫 4% -> 12% 垂直渐变（锁定语义：视觉上“上锁”）；
/// 2. 居中：96dp 锁形大图标（app_lock 语义色 / Knox 安全石墨色）；
/// 3. 「应用已锁定」(headlineSmall) + 「验证身份以继续」(bodyMedium)；
/// 4. 解锁按钮：FilledButton.tonal 图标 + 文字，带 spring 按压微动效；
/// 5. 验证失败：error 红 inline 提示 + spring shake 震颤动画（水平 ±8dp × 3）；
/// 6. 保持系统生物识别自动调起与逻辑守卫畅通。
class LockScreen extends StatefulWidget {
  const LockScreen({super.key});

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen>
    with SingleTickerProviderStateMixin {
  bool _authenticating = false;
  String? _error;

  late final AnimationController _shakeController;
  late final Animation<double> _shakeAnimation;

  @override
  void initState() {
    super.initState();

    // 震颤动画：3 次正弦振动，幅度 ±8dp，时长 350ms
    _shakeController = AnimationController(
      vsync: this,
      duration: AppMotionV2.slow,
    );

    _shakeAnimation = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(
        parent: _shakeController,
        curve: Curves.easeInOut,
      ),
    );

    // 进入锁定页自动发起一次系统生物验证
    WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  @override
  void dispose() {
    _shakeController.dispose();
    super.dispose();
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
      BiometricLockGate.unlock();
    } else {
      setState(() => _error = l10n.biometricVerifyFailed);
      _triggerShake();
    }
  }

  void _triggerShake() {
    _shakeController.forward(from: 0.0);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final l10n = AppLocalizations.of(context);
    final isZh = l10n.localeName.startsWith('zh');

    // 锁定语义背景：全屏品牌紫 4% -> 12% 渐变
    final brandPrimary =
        isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight;
    final lockAccent =
        isDark ? const Color(0xFF94A3B8) : AppColorsV2.secureAccent;
    final dangerColor = AppColorsV2.dangerColor(context);

    return Scaffold(
      backgroundColor: AppColorsV2.surface(context, tier: SurfaceTier.base),
      body: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              brandPrimary.withValues(alpha: 0.04),
              brandPrimary.withValues(alpha: 0.12),
            ],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.xl,
                vertical: AppSpacing.lg,
              ),
              child: AnimatedBuilder(
                animation: _shakeAnimation,
                builder: (context, child) {
                  // 3 次正弦震颤：sin(t * 3 * 2π)，位移 ±8dp
                  final offset = math.sin(_shakeAnimation.value * math.pi * 6) * 8.0 * (1.0 - _shakeAnimation.value);
                  return Transform.translate(
                    offset: Offset(offset, 0),
                    child: child,
                  );
                },
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    // 居中 96dp 锁形大图标（app_lock 语义色 / Knox 安全色）
                    Container(
                      width: 120,
                      height: 120,
                      decoration: BoxDecoration(
                        color: lockAccent.withValues(alpha: 0.1),
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: lockAccent.withValues(alpha: 0.2),
                          width: 1.5,
                        ),
                      ),
                      child: Center(
                        child: Icon(
                          Icons.lock_rounded,
                          size: 64,
                          color: lockAccent,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xl),

                    // 「应用已锁定」headlineSmall
                    Text(
                      isZh ? '应用已锁定' : 'App Locked',
                      style: theme.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),

                    // 「验证身份以继续」bodyMedium
                    Text(
                      isZh ? '验证身份以继续' : 'Verify your identity to continue',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: AppSpacing.xxl),

                    // 解锁按钮（FilledButton.tonal 图标+文字，spring 微反馈）
                    if (_authenticating)
                      const SizedBox(
                        height: 52,
                        child: Center(
                          child: CircularProgressIndicator(strokeWidth: 2.4),
                        ),
                      )
                    else
                      SizedBox(
                        height: 52,
                        child: FilledButton.tonalIcon(
                          onPressed: _unlock,
                          style: FilledButton.styleFrom(
                            shape: const RoundedRectangleBorder(
                              borderRadius: AppShapesV2.brSm,
                            ),
                            padding: const EdgeInsets.symmetric(
                              horizontal: AppSpacing.xl,
                            ),
                          ),
                          icon: const Icon(Icons.fingerprint_rounded, size: 22),
                          label: Text(
                            l10n.unlock,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),

                    // 验证失败提示（error 红 inline 提示）
                    if (_error != null) ...[
                      const SizedBox(height: AppSpacing.lg),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.error_outline_rounded,
                            size: 16,
                            color: dangerColor,
                          ),
                          const SizedBox(width: AppSpacing.xs),
                          Text(
                            _error!,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: dangerColor,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

