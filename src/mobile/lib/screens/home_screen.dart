import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';
import '../providers/clipboard_provider.dart';
import '../providers/device_provider.dart';
import '../providers/ws_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/clipboard_card.dart';
import '../widgets/device_card.dart';
import '../widgets/coach_mark.dart';
import '../utils/animations.dart';
import '../utils/performance.dart';
import '../utils/lazy_load.dart';
import 'settings_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with TickerProviderStateMixin {
  int _currentIndex = 0;
  late AnimationController _pageController;
  late CoachMarkController _coachMarkController;
  final GlobalKey _refreshButtonKey = GlobalKey();
  late ScrollController _clipboardScrollController;
  late ScrollController _deviceScrollController;

  // 页面列表
  late final List<Widget> _pages;

  @override
  void initState() {
    super.initState();
    _pageController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    _pageController.forward();

    // 初始化滚动控制器
    _clipboardScrollController = ScrollController();
    _deviceScrollController = ScrollController();
    
    // 添加滚动监听器，实现加载更多
    _clipboardScrollController.addListener(_onClipboardScroll);
    _deviceScrollController.addListener(_onDeviceScroll);

    // 初始化气泡提示控制器
    _coachMarkController = CoachMarkController(
      context: context,
      onComplete: () {
        // 所有提示显示完成后的回调
      },
    );

    // 添加刷新按钮提示
    _coachMarkController.addMark(CoachMark(
      id: 'refresh_button',
      targetKey: _refreshButtonKey,
      title: '刷新内容',
      description: '点击此按钮可以手动刷新剪贴板内容，获取最新的同步数据。',
    ));

    // 延迟显示提示，确保UI已构建且首帧渲染完成
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 延迟 500ms 显示，避免影响首帧渲染
      Future.delayed(const Duration(milliseconds: 500), () {
        if (mounted) {
          _showCoachMarksIfNeeded();
        }
      });
    });

    _pages = [
      _buildClipboardPage(),
      _buildDevicesPage(),
      const SettingsScreen(),
    ];

    _loadData();
  }

  @override
  void dispose() {
    _pageController.dispose();
    _coachMarkController.dispose();
    _clipboardScrollController.dispose();
    _deviceScrollController.dispose();
    super.dispose();
  }

  void _loadData() {
    final auth = context.read<AuthProvider>();
    final token = auth.token;
    if (token != null) {
      context.read<ClipboardProvider>().loadItems(token, refresh: true);
      context.read<DeviceProvider>().loadDevices(token);

      // Connect WebSocket for real-time sync
      final wsProvider = context.read<WsProvider>();
      if (!wsProvider.isConnected) {
        // Use phone as temporary device ID for MVP
        final deviceId = auth.user?['id'] ?? 'mobile';
        wsProvider.connect(
          token: token,
          deviceId: deviceId,
          clipboardProvider: context.read<ClipboardProvider>(),
        );
      }
    }
  }

  void _showCoachMarksIfNeeded() async {
    // 检查是否应该显示提示
    final shouldShow = await CoachMarkController.shouldShowMark('refresh_button');
    if (shouldShow) {
      _coachMarkController.start();
    }
  }

  void _onClipboardScroll() {
    if (_clipboardScrollController.position.pixels >=
        _clipboardScrollController.position.maxScrollExtent - 200) {
      _loadMoreClipboardItems();
    }
  }

  void _onDeviceScroll() {
    if (_deviceScrollController.position.pixels >=
        _deviceScrollController.position.maxScrollExtent - 200) {
      _loadMoreDevices();
    }
  }

  void _loadMoreClipboardItems() {
    final auth = context.read<AuthProvider>();
    final token = auth.token;
    if (token != null) {
      final provider = context.read<ClipboardProvider>();
      if (provider.hasMore && !provider.isLoading) {
        provider.loadItems(token);
      }
    }
  }

  void _loadMoreDevices() {
    final auth = context.read<AuthProvider>();
    final token = auth.token;
    if (token != null) {
      final provider = context.read<DeviceProvider>();
      if (!provider.isLoading) {
        provider.loadDevices(token, forceRefresh: true);
      }
    }
  }

  void _onTabChanged(int index) {
    if (index != _currentIndex) {
      setState(() {
        _currentIndex = index;
      });
      // 重置动画控制器以播放过渡动画
      _pageController.reset();
      _pageController.forward();
    }
  }

  @override
  Widget build(BuildContext context) {
    return PerformanceMonitor(
      name: 'HomeScreen',
      child: Scaffold(
        body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        transitionBuilder: (child, animation) {
          return FadeTransition(
            opacity: animation,
            child: SlideTransition(
              position: Tween<Offset>(
                begin: const Offset(0.05, 0.0),
                end: Offset.zero,
              ).animate(CurvedAnimation(
                parent: animation,
                curve: Curves.easeOutCubic,
              )),
              child: child,
            ),
          );
        },
        child: _pages[_currentIndex],
      ),
      bottomNavigationBar: _buildAnimatedBottomNav(),
    ),
    );
  }

  Widget _buildAnimatedBottomNav() {
    return Container(
      decoration: BoxDecoration(
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.1),
            blurRadius: 10,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: BottomNavigationBar(
        currentIndex: _currentIndex,
        onTap: _onTabChanged,
        type: BottomNavigationBarType.fixed,
        selectedItemColor: AppTheme.primaryColor,
        unselectedItemColor: Colors.grey,
        selectedFontSize: 12,
        unselectedFontSize: 12,
        elevation: 0,
        items: [
          _buildNavItem(
            icon: Icons.content_paste,
            label: '剪贴板',
            index: 0,
          ),
          _buildNavItem(
            icon: Icons.devices,
            label: '设备',
            index: 1,
          ),
          _buildNavItem(
            icon: Icons.settings,
            label: '设置',
            index: 2,
          ),
        ],
      ),
    );
  }

  BottomNavigationBarItem _buildNavItem({
    required IconData icon,
    required String label,
    required int index,
  }) {
    return BottomNavigationBarItem(
      icon: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: EdgeInsets.all(_currentIndex == index ? 4 : 0),
        child: Icon(
          icon,
          size: _currentIndex == index ? 26 : 24,
          color: _currentIndex == index ? AppTheme.primaryColor : Colors.grey,
        ),
      ),
      label: label,
    );
  }

  Widget _buildClipboardPage() {
    return Consumer<ClipboardProvider>(
      builder: (context, provider, _) {
        return CustomScrollView(
          key: const ValueKey('clipboard_page'),
          controller: _clipboardScrollController,
          slivers: [
            SliverAppBar(
              expandedHeight: 120,
              pinned: true,
              flexibleSpace: FlexibleSpaceBar(
                title: const Text('剪贴板'),
                background: Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        AppTheme.primaryColor,
                        AppTheme.primaryLight,
                      ],
                    ),
                  ),
                ),
              ),
              actions: [
                AppAnimations.bounceButton(
                  key: _refreshButtonKey,
                  onTap: _loadData,
                  child: const Padding(
                    padding: EdgeInsets.all(12),
                    child: Icon(Icons.refresh, color: Colors.white),
                  ),
                ),
              ],
            ),
            if (provider.isLoading && provider.items.isEmpty)
              const SliverFillRemaining(
                child: Center(child: CircularProgressIndicator()),
              )
            else if (provider.items.isEmpty)
              const SliverFillRemaining(
                child: Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.content_paste, size: 64, color: Colors.grey),
                      SizedBox(height: 16),
                      Text(
                        '暂无剪贴板内容',
                        style: TextStyle(color: Colors.grey, fontSize: 16),
                      ),
                      SizedBox(height: 8),
                      Text(
                        '复制内容后将自动同步到此处',
                        style: TextStyle(color: Colors.grey, fontSize: 14),
                      ),
                    ],
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.all(16),
                sliver: SliverGrid(
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    childAspectRatio: 0.8,
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final item = provider.items[index];
                      // 为每个卡片添加交错入场动画
                      return _AnimatedCard(
                        index: index,
                        child: ClipboardCard(item: item),
                      );
                    },
                    childCount: provider.items.length,
                  ),
                ),
              ),
            // 加载更多指示器
            if (provider.isLoading && provider.items.isNotEmpty)
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                ),
              ),
            if (!provider.hasMore && provider.items.isNotEmpty)
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(
                    child: Text(
                      '没有更多内容了',
                      style: TextStyle(color: Colors.grey),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _buildDevicesPage() {
    return Consumer<DeviceProvider>(
      builder: (context, provider, _) {
        return CustomScrollView(
          key: const ValueKey('devices_page'),
          controller: _deviceScrollController,
          slivers: [
            SliverAppBar(
              expandedHeight: 120,
              pinned: true,
              flexibleSpace: FlexibleSpaceBar(
                title: const Text('我的设备'),
                background: Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        AppTheme.primaryColor,
                        AppTheme.primaryLight,
                      ],
                    ),
                  ),
                ),
              ),
              actions: [
                AppAnimations.bounceButton(
                  onTap: () {
                    final token = context.read<AuthProvider>().token;
                    if (token != null) {
                      provider.loadDevices(token);
                    }
                  },
                  child: const Padding(
                    padding: EdgeInsets.all(12),
                    child: Icon(Icons.refresh, color: Colors.white),
                  ),
                ),
              ],
            ),
            if (provider.isLoading)
              const SliverFillRemaining(
                child: Center(child: CircularProgressIndicator()),
              )
            else if (provider.devices.isEmpty)
              const SliverFillRemaining(
                child: Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.devices, size: 64, color: Colors.grey),
                      SizedBox(height: 16),
                      Text(
                        '暂无设备',
                        style: TextStyle(color: Colors.grey, fontSize: 16),
                      ),
                      SizedBox(height: 8),
                      Text(
                        '登录其他设备以开始同步',
                        style: TextStyle(color: Colors.grey, fontSize: 14),
                      ),
                    ],
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.all(16),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final device = provider.devices[index];
                      return _AnimatedCard(
                        index: index,
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: DeviceCard(device: device),
                        ),
                      );
                    },
                    childCount: provider.devices.length,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// 带交错入场动画的卡片包装器
class _AnimatedCard extends StatefulWidget {
  final int index;
  final Widget child;

  const _AnimatedCard({
    required this.index,
    required this.child,
  });

  @override
  State<_AnimatedCard> createState() => _AnimatedCardState();
}

class _AnimatedCardState extends State<_AnimatedCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _fadeAnimation;
  late Animation<Offset> _slideAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 400),
      vsync: this,
    );

    // 计算交错延迟（最多延迟 300ms）
    final delay = Duration(milliseconds: (widget.index * 60).clamp(0, 300));
    final start = delay.inMilliseconds / _controller.duration!.inMilliseconds;

    _fadeAnimation = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(
        parent: _controller,
        curve: Interval(start, 1.0, curve: Curves.easeOut),
      ),
    );

    _slideAnimation = Tween<Offset>(
      begin: const Offset(0.0, 0.2),
      end: Offset.zero,
    ).animate(
      CurvedAnimation(
        parent: _controller,
        curve: Interval(start, 1.0, curve: Curves.easeOutCubic),
      ),
    );

    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return FadeTransition(
          opacity: _fadeAnimation,
          child: SlideTransition(
            position: _slideAnimation,
            child: child,
          ),
        );
      },
      child: widget.child,
    );
  }
}