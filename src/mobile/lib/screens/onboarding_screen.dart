import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
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

  final List<OnboardingPage> _pages = const [
    OnboardingPage(
      icon: Icons.sync,
      title: '欢迎使用 ClipSync',
      description: '跨设备剪贴板同步工具\n让您的剪贴板在手机、电脑间自由流转',
      color: Colors.blue,
    ),
    OnboardingPage(
      icon: Icons.cloud_sync,
      title: '后台自动同步',
      description: 'ClipSync 在后台保持连接\n电脑复制的内容自动同步到手机',
      color: Colors.green,
    ),
    OnboardingPage(
      icon: Icons.notifications,
      title: '即时通知',
      description: '电脑复制内容后\n手机第一时间收到通知提醒',
      color: Colors.orange,
    ),
    OnboardingPage(
      icon: Icons.content_paste,
      title: '剪贴板同步',
      description: '手机复制的内容也会自动同步\n在所有设备间无缝流转',
      color: Colors.purple,
    ),
    OnboardingPage(
      icon: Icons.check_circle,
      title: '准备就绪',
      description: '现在可以开始使用 ClipSync 了！\n复制内容试试吧 😊',
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
                itemCount: _pages.length,
                itemBuilder: (context, index) {
                  final page = _pages[index];
                  return OnboardingPageWidget(page: page);
                },
              ),
            ),
            _buildPageIndicator(),
            _buildButtons(),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  Widget _buildPageIndicator() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(_pages.length, (index) {
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

  Widget _buildButtons() {
    final isLastPage = _currentPage == _pages.length - 1;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          TextButton(
            onPressed: _completeOnboarding,
            child: const Text('跳过'),
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
            child: Text(isLastPage ? '开始使用' : '下一步'),
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
