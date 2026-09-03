import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/router/app_router.dart';
import 'package:clipsync_mobile/router/route_guard.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'package:clipsync_mobile/widgets/common/app_card.dart';

/// 首次使用引导页面 (Obsidian v2)。
///
/// 规范要求：
/// 1. 全面应用 Obsidian v2 质感：displaySmall 大标题、AppCard v2 容器、清晰的页面步进；
/// 2. 按钮与动效全面对齐 tokens_v2（AppShapesV2、AppMotionV2）；
/// 3. 支持平滑过渡动效，点状指示器随页进阶；
/// 4. 路由与守卫逻辑保持完全兼容（completeOnboarding -> home）。
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _pageController = PageController();
  int _currentPage = 0;

  List<_OnboardingStep> _buildSteps(AppLocalizations l10n, bool isDark) => [
        _OnboardingStep(
          icon: Icons.all_inclusive_rounded,
          title: l10n.onboardingTitle1,
          description: l10n.onboardingDesc1,
          accentColor: isDark
              ? AppColorsV2.brandPrimaryDark
              : AppColorsV2.brandPrimaryLight,
        ),
        _OnboardingStep(
          icon: Icons.sync_rounded,
          title: l10n.onboardingTitle2,
          description: l10n.onboardingDesc2,
          accentColor: isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
        ),
        _OnboardingStep(
          icon: Icons.notifications_active_rounded,
          title: l10n.onboardingTitle3,
          description: l10n.onboardingDesc3,
          accentColor:
              isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight,
        ),
        _OnboardingStep(
          icon: Icons.content_paste_rounded,
          title: l10n.onboardingTitle4,
          description: l10n.onboardingDesc4,
          accentColor: isDark ? AppColorsV2.typeTextDark : AppColorsV2.typeTextLight,
        ),
        _OnboardingStep(
          icon: Icons.check_circle_rounded,
          title: l10n.onboardingTitle5,
          description: l10n.onboardingDesc5,
          accentColor:
              isDark ? AppColorsV2.typeColorDark : AppColorsV2.typeColorLight,
        ),
      ];

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  Future<void> _completeOnboarding() async {
    if (!mounted) return;
    await context.read<RouteGuardState>().completeOnboarding();
    if (!mounted) return;
    context.go(AppRoutes.home);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final l10n = AppLocalizations.of(context);
    final steps = _buildSteps(l10n, isDark);
    final isLastPage = _currentPage == steps.length - 1;

    final brandPrimary =
        isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight;

    return Scaffold(
      backgroundColor: AppColorsV2.surface(context, tier: SurfaceTier.base),
      body: Stack(
        children: [
          // 顶部微光渐变背景
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 320,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    steps[_currentPage].accentColor.withValues(alpha: 0.08),
                    steps[_currentPage].accentColor.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                // 顶部「跳过」快捷按钮
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.lg,
                    vertical: AppSpacing.sm,
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      if (!isLastPage)
                        TextButton(
                          onPressed: _completeOnboarding,
                          style: TextButton.styleFrom(
                            foregroundColor: theme.colorScheme.onSurfaceVariant,
                          ),
                          child: Text(l10n.skip),
                        )
                      else
                        const SizedBox(height: 48),
                    ],
                  ),
                ),

                // 主页面内容（PageView）
                Expanded(
                  child: PageView.builder(
                    controller: _pageController,
                    onPageChanged: (index) {
                      setState(() {
                        _currentPage = index;
                      });
                    },
                    itemCount: steps.length,
                    itemBuilder: (context, index) {
                      final step = steps[index];
                      return _OnboardingStepView(
                        step: step,
                        index: index,
                        total: steps.length,
                      );
                    },
                  ),
                ),

                // 底部指示器与操作按钮
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.xl,
                    vertical: AppSpacing.lg,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // 点状进度指示器
                      _buildPageIndicator(steps.length, brandPrimary),
                      const SizedBox(height: AppSpacing.xl),

                      // 全宽 54dp 高主按钮
                      SizedBox(
                        width: double.infinity,
                        height: 54,
                        child: FilledButton(
                          onPressed: () {
                            if (isLastPage) {
                              _completeOnboarding();
                            } else {
                              _pageController.nextPage(
                                duration: AppMotionV2.slow,
                                curve: AppMotionV2.emphasized,
                              );
                            }
                          },
                          style: FilledButton.styleFrom(
                            shape: const RoundedRectangleBorder(
                              borderRadius: AppShapesV2.brSm,
                            ),
                          ),
                          child: Text(
                            isLastPage ? l10n.getStarted : l10n.next,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPageIndicator(int count, Color activeColor) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(count, (index) {
        final isSelected = _currentPage == index;
        return AnimatedContainer(
          duration: AppMotionV2.normal,
          curve: AppMotionV2.emphasized,
          width: isSelected ? 24 : 8,
          height: 8,
          margin: const EdgeInsets.symmetric(horizontal: 4),
          decoration: BoxDecoration(
            borderRadius: const BorderRadius.all(AppShapesV2.rPill),
            color: isSelected
                ? activeColor
                : activeColor.withValues(alpha: 0.2),
          ),
        );
      }),
    );
  }
}

class _OnboardingStep {
  const _OnboardingStep({
    required this.icon,
    required this.title,
    required this.description,
    required this.accentColor,
  });

  final IconData icon;
  final String title;
  final String description;
  final Color accentColor;
}

class _OnboardingStepView extends StatelessWidget {
  const _OnboardingStepView({
    required this.step,
    required this.index,
    required this.total,
  });

  final _OnboardingStep step;
  final int index;
  final int total;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // AppCard v2 容器包裹核心大图标
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: const EdgeInsets.all(AppSpacing.xxl),
            child: Container(
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                color: step.accentColor.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: Center(
                child: Icon(
                  step.icon,
                  size: 52,
                  color: step.accentColor,
                ),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xxl),

          // displaySmall 大标题
          Text(
            step.title,
            style: theme.textTheme.displaySmall?.copyWith(
              fontWeight: FontWeight.bold,
              letterSpacing: -0.5,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AppSpacing.md),

          // bodyLarge 引导说明文案
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 340),
            child: Text(
              step.description,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                height: 1.5,
              ),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }
}

