import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../models/device.dart';
import '../providers/auth_provider.dart';
import '../providers/clipboard_provider.dart';
import '../providers/device_provider.dart';
import '../providers/ws_provider.dart';
import '../theme/app_theme.dart';
import '../utils/performance.dart';
import '../widgets/common/empty_state.dart';
import '../widgets/device_card.dart';

/// 主页骨架（T2.2 应用骨架）：Material 3 NavigationBar 4 tab shell。
///
/// 路由侧由 `router/app_router.dart` 的 [StatefulShellRoute.indexedStack]
/// 承载四个分支（/home/clipboard、/home/favorites、/home/devices、
/// /home/settings）：每个分支一个独立 Navigator，分支间以 IndexedStack
/// 容器保活，切换 tab 不丢失滚动位置与页面状态。
///
/// 本组件是 shell 宿主，职责：
/// - 提供 AppBar：简洁标题随 tab 切换（设置 tab 的 SettingsScreen 自带
///   Scaffold + AppBar，shell 侧在该 tab 隐藏标题栏避免双标题）；
/// - 提供 M3 NavigationBar（64 高、主题见 AppTheme.navigationBarTheme）；
/// - body 挂载 [StatefulNavigationShell]（分支 IndexedStack）；
/// - 保留旧版初始化逻辑：进入主页拉取剪贴板/设备数据并连接 WebSocket
///   （[_HomeScreenState._loadData]，含真实 deviceId 注册与回退逻辑）。
///
/// 旧版剪贴板列表实现（SliverGrid / 交错入场动画 / CoachMark）随本次
/// 重构废弃删除；剪贴板 tab 改由 T2.3 交付的 ClipboardScreen 承载。
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.navigationShell});

  /// go_router 分支导航容器（IndexedStack），由 shell route builder 注入。
  final StatefulNavigationShell navigationShell;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  /// tab 下标（0=剪贴板 / 1=收藏 / 2=设备 / 3=设置，与 NavigationBar
  /// destinations 及路由分支顺序一一对应）
  static const int _tabDevices = 2;
  static const int _tabSettings = 3;

  /// AppBar 简洁标题，随 tab 切换
  static const List<String> _tabTitles = <String>[
    '剪贴板',
    '收藏',
    '我的设备',
    '设置',
  ];

  @override
  void initState() {
    super.initState();
    // 保留旧版行为：进入主页即拉取数据并连接 WS（登录后连接）
    _loadData();
  }

  /// 数据加载 + WS 连接（自旧版 home_screen 原样保留）。
  Future<void> _loadData() async {
    final auth = context.read<AuthProvider>();
    final token = auth.token;
    if (token == null) return;

    unawaited(
      context.read<ClipboardProvider>().loadItems(token, refresh: true),
    );
    unawaited(context.read<DeviceProvider>().loadDevices(token));

    // Connect WebSocket for real-time sync
    final wsProvider = context.read<WsProvider>();
    if (!wsProvider.isConnected) {
      // 优先使用登录时注册的真实设备 id（T1.5）；未注册成功时回退旧逻辑并告警
      final deviceId = await auth.ensureDeviceId();
      if (!mounted) return;
      if (deviceId != null && deviceId.isNotEmpty) {
        wsProvider.connect(
          token: token,
          deviceId: deviceId,
          clipboardProvider: context.read<ClipboardProvider>(),
        );
      } else {
        debugPrint(
          '[ClipSync] 警告: 真实设备 id 缺失（设备注册失败），回退使用 user id '
          '作为 WS deviceId，服务端将拒绝 register',
        );
        wsProvider.connect(
          token: token,
          deviceId: (auth.user?['id'] ?? 'mobile').toString(),
          clipboardProvider: context.read<ClipboardProvider>(),
        );
      }
    }
  }

  void _onDestinationSelected(int index) {
    // 切换分支；再次点击当前 tab 时回到该分支根路由（M3 惯例）
    widget.navigationShell.goBranch(
      index,
      initialLocation: index == widget.navigationShell.currentIndex,
    );
  }

  void _refreshDevices() {
    final token = context.read<AuthProvider>().token;
    if (token != null) {
      context.read<DeviceProvider>().loadDevices(token);
    }
  }

  @override
  Widget build(BuildContext context) {
    final int currentIndex = widget.navigationShell.currentIndex;
    return PerformanceMonitor(
      name: 'HomeScreen',
      child: Scaffold(
        // 设置 tab 的内容自带 Scaffold + AppBar，shell 侧不再叠加标题栏
        appBar:
            currentIndex == _tabSettings ? null : _buildAppBar(currentIndex),
        body: widget.navigationShell,
        bottomNavigationBar: NavigationBar(
          selectedIndex: currentIndex,
          onDestinationSelected: _onDestinationSelected,
          destinations: const <Widget>[
            NavigationDestination(
              icon: Icon(Icons.content_paste_outlined),
              selectedIcon: Icon(Icons.content_paste),
              label: '剪贴板',
            ),
            NavigationDestination(
              icon: Icon(Icons.star_outline),
              selectedIcon: Icon(Icons.star),
              label: '收藏',
            ),
            NavigationDestination(
              icon: Icon(Icons.devices_outlined),
              selectedIcon: Icon(Icons.devices),
              label: '设备',
            ),
            NavigationDestination(
              icon: Icon(Icons.settings_outlined),
              selectedIcon: Icon(Icons.settings),
              label: '设置',
            ),
          ],
        ),
      ),
    );
  }

  /// 简洁标题栏：标题随 tab 切换；设备 tab 保留旧版刷新操作。
  PreferredSizeWidget _buildAppBar(int index) {
    return AppBar(
      title: Text(_tabTitles[index]),
      actions: index == _tabDevices
          ? <Widget>[
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: '刷新设备',
                onPressed: _refreshDevices,
              ),
            ]
          : null,
    );
  }
}

/// 收藏 tab（T2.2 占位）：Wave 4 T4.1 收藏夹页落地前仅展示空状态。
class FavoritesTab extends StatelessWidget {
  const FavoritesTab({super.key});

  @override
  Widget build(BuildContext context) {
    return const EmptyState(
      icon: Icons.star_outline,
      title: '收藏功能即将上线',
      message: 'Wave 4 将带来收藏夹分组与条目管理，敬请期待',
    );
  }
}

/// 设备 tab：设备列表 + 长按解绑（内容自旧版设备页迁移，T2.2 仅更换宿主）。
class DevicesTab extends StatefulWidget {
  const DevicesTab({super.key});

  @override
  State<DevicesTab> createState() => _DevicesTabState();
}

class _DevicesTabState extends State<DevicesTab> {
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    // 滚动近底部时触发拉取（旧版 load-more 逻辑保留）
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 200) {
      _loadMoreDevices();
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

  @override
  Widget build(BuildContext context) {
    return Consumer<DeviceProvider>(
      builder: (context, provider, _) {
        if (provider.isLoading && provider.devices.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }
        if (provider.devices.isEmpty) {
          return const EmptyState(
            icon: Icons.devices,
            title: '暂无设备',
            message: '登录其他设备以开始同步',
          );
        }
        return ListView.separated(
          controller: _scrollController,
          padding: const EdgeInsets.all(AppSpacing.lg),
          itemCount: provider.devices.length,
          separatorBuilder: (BuildContext context, int index) =>
              const SizedBox(height: AppSpacing.md),
          itemBuilder: (context, index) {
            final device = provider.devices[index];
            // 长按设备卡片呼出解绑确认（T1.5 最小接入，逻辑保留）
            return GestureDetector(
              onLongPress: () => _confirmUnbindDevice(device),
              child: DeviceCard(device: device),
            );
          },
        );
      },
    );
  }

  /// 长按解绑设备：确认对话框 → DELETE /api/devices/:id。
  /// 解绑当前设备时给出保护提示，并在成功后清空本地 deviceId、断开 WS。
  Future<void> _confirmUnbindDevice(Device device) async {
    final auth = context.read<AuthProvider>();
    final isCurrentDevice = device.id == auth.deviceId;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('解绑设备'),
        content: Text(
          isCurrentDevice
              ? '「${device.deviceName}」是当前设备。\n解绑后将停止本机同步，且需要重新注册设备才能恢复。确定解绑吗？'
              : '确定解绑「${device.deviceName}」吗？解绑后该设备将无法再同步。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            child: const Text('解绑'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    if (!mounted) return;

    final token = auth.token;
    if (token == null) return;

    await context.read<DeviceProvider>().removeDevice(token, device.id);
    if (!mounted) return;

    if (isCurrentDevice) {
      // 本机解绑成功后清空本地记录（下次 ensureDeviceId 会重新注册），并断开 WS
      await auth.clearDeviceId();
      if (!mounted) return;
      if (auth.deviceId == null) {
        context.read<WsProvider>().disconnect();
      }
    }
  }
}

/// 双击返回退出确认（工单 T2.2「双击退出确认」）。
///
/// go_router 的 StatefulShellRoute 下，系统返回键作用于当前分支 Navigator；
/// 分支到达栈底时返回键将直接退出应用。此 guard 包在每个 tab 分支根页外层，
/// 拦截栈底返回：第一次返回提示「再按一次退出」，2 秒内再次返回才真正退出
/// （计时为静态字段，跨 4 个 tab 分支共享）。
class BackExitGuard extends StatefulWidget {
  const BackExitGuard({super.key, required this.child});

  final Widget child;

  @override
  State<BackExitGuard> createState() => _BackExitGuardState();
}

class _BackExitGuardState extends State<BackExitGuard> {
  /// 上次返回键时间（跨 tab 分支共享）
  static DateTime? _lastBackPressAt;

  Future<void> _onPopInvokedWithResult(bool didPop, Object? result) async {
    if (didPop) return;
    final DateTime now = DateTime.now();
    final DateTime? last = _lastBackPressAt;
    if (last != null && now.difference(last) < const Duration(seconds: 2)) {
      await SystemNavigator.pop();
      return;
    }
    _lastBackPressAt = now;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(
          content: Text('再按一次返回键退出 ClipSync'),
          duration: Duration(seconds: 2),
        ),
      );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: _onPopInvokedWithResult,
      child: widget.child,
    );
  }
}
