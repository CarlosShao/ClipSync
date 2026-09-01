import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../l10n/app_localizations.dart';
import '../router/app_router.dart';
import '../router/route_guard.dart';

/// 首次使用引导流程
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({Key? key}) : super(key: key);

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _pageController = PageController();
  int _currentPage = 0;

  /// 引导页文案需经 l10n 求值，无法再以 const 字段初始化，
  /// 改为每次 build 用 AppLocalizations 现构造列表。
  List<OnboardingPage> _buildPages(AppLocalizations l10n) => [
        OnboardingPage(
          icon: Icons.sync,
          title: l10n.onboardingTitle1,
          description: l10n.onboardingDesc1,
          color: Colors.blue,
        ),
        OnboardingPage(
          icon: Icons.cloud_sync,
          title: l10n.onboardingTitle2,
          description: l10n.onboardingDesc2,
          color: Colors.green,
        ),
        OnboardingPage(
          icon: Icons.notifications,
          title: l10n.onboardingTitle3,
          description: l10n.onboardingDesc3,
          color: Colors.orange,
        ),
        OnboardingPage(
          icon: Icons.content_paste,
          title: l10n.onboardingTitle4,
          description: l10n.onboardingDesc4,
          color: Colors.purple,
        ),
        OnboardingPage(
          icon: Icons.check_circle,
          title: l10n.onboardingTitle5,
          description: l10n.onboardingDesc5,
          color: Colors.teal,
        ),
      ];

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  Future<void> _completeOnboarding() async {
    // 统一写入 'onboarding_completed' 键（与 main.dart 路由守卫读取的键一致），
    // 并同步内存守卫状态，避免重定向把用户弹回引导页
    if (!mounted) return;
    await context.read<RouteGuardState>().completeOnboarding();
    if (!mounted) return;
    // 通过 go_router 导航；守卫会依据登录态决定最终落地页（未登录 → /login）
    context.go(AppRoutes.home);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final pages = _buildPages(l10n);
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: PageView.builder(
                controller: _pageController,
                onPageChanged: (index) {
                  setState(() {
                    _currentPage = index;
                  });
                },
                itemCount: pages.length,
                itemBuilder: (context, index) {
                  final page = pages[index];
                  return OnboardingPageWidget(page: page);
                },
              ),
            ),
            _buildPageIndicator(pages),
            _buildButtons(l10n, pages),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  Widget _buildPageIndicator(List<OnboardingPage> pages) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(pages.length, (index) {
        return Container(
          width: 10,
          height: 10,
          margin: const EdgeInsets.symmetric(horizontal: 4),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: _currentPage == index
                ? Theme.of(context).primaryColor
                : Colors.grey.shade300,
          ),
        );
      }),
    );
  }

  Widget _buildButtons(AppLocalizations l10n, List<OnboardingPage> pages) {
    final isLastPage = _currentPage == pages.length - 1;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          TextButton(
            onPressed: _completeOnboarding,
            child: Text(l10n.skip),
          ),
          ElevatedButton(
            onPressed: () {
              if (isLastPage) {
                _completeOnboarding();
              } else {
                _pageController.nextPage(
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeInOut,
                );
              }
            },
            child: Text(isLastPage ? l10n.getStarted : l10n.next),
          ),
        ],
      ),
    );
  }
}

class OnboardingPage {
  final IconData icon;
  final String title;
  final String description;
  final Color color;

  const OnboardingPage({
    required this.icon,
    required this.title,
    required this.description,
    required this.color,
  });
}

class OnboardingPageWidget extends StatelessWidget {
  final OnboardingPage page;

  const OnboardingPageWidget({Key? key, required this.page}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            page.icon,
            size: 80,
            color: page.color,
          ),
          const SizedBox(height: 32),
          Text(
            page.title,
            style: Theme.of(context).textTheme.headlineSmall,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Text(
            page.description,
            style: Theme.of(context).textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
