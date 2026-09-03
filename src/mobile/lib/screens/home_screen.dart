import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:go_router/go_router.dart";
import "package:provider/provider.dart";

import "package:clipsync_mobile/l10n/app_localizations.dart";
import "package:clipsync_mobile/models/device.dart";
import "package:clipsync_mobile/providers/auth_provider.dart";
import "package:clipsync_mobile/providers/clipboard_provider.dart";
import "package:clipsync_mobile/providers/device_provider.dart";
import "package:clipsync_mobile/providers/ws_provider.dart";
import "package:clipsync_mobile/screens/devices/sessions_section.dart";
import "package:clipsync_mobile/screens/favorites/favorites_screen.dart";
import "package:clipsync_mobile/services/app_exception.dart";
import "package:clipsync_mobile/theme/app_theme.dart";
import "package:clipsync_mobile/utils/performance.dart";
import "package:clipsync_mobile/widgets/common/empty_state.dart";
import "package:clipsync_mobile/widgets/common/error_state.dart";
import "package:clipsync_mobile/widgets/device_card.dart";

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

  /// AppBar 标题的 l10n key（顺序与 tab 索引对应，build 期经 l10n 求值，
  /// 语言切换即时生效）
  static const List<String> _tabTitleKeys = <String>[
    'tabClipboard',
    'tabFavorites',
    'tabDevices',
    'tabSettings',
  ];

  List<String> _tabTitles(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return [
      l10n.tabClipboard,
      l10n.tabFavorites,
      l10n.tabDevices,
      l10n.tabSettings,
    ];
  }

  @override
  void initState() {
    super.initState();
    // 保留旧版行为：进入主页即拉取数据并连接 WS（登录后连接）。
    // ⚠️ 必须推迟到首帧之后：_loadData → loadItems → _fetchPage 会在
    // build 阶段同步 notifyListeners，触发 framework「构建期标记 dirty」
    // 异常（模拟器红屏已踩坑）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _loadData();
    });
  }

  /// 数据加载 + WS 连接（自旧版 home_screen 原样保留）。
  Future<void> _loadData() async {
    final auth = context.read<AuthProvider>();
    final token = auth.token;
    if (token == null) return;

    unawaited(
      context.read<ClipboardProvider>().loadItems(token, refresh: true),
    );

    // Connect WebSocket for real-time sync
    final wsProvider = context.read<WsProvider>();
    if (!wsProvider.isConnected) {
      // 优先使用登录时注册的真实设备 id（T1.5）；未注册成功时回退旧逻辑并告警。
      // ⚠️ 注册必须先于设备列表拉取：首次安装时注册产生本机设备条目，
      // 否则列表为空直到手动刷新（真机已踩坑）。
      final deviceId = await auth.ensureDeviceId();
      if (!mounted) return;
      unawaited(context.read<DeviceProvider>().loadDevices(token));
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
    final tabTitles = _tabTitles(context);
    return PerformanceMonitor(
      name: 'HomeScreen',
      child: Scaffold(
        // 设置 tab 的内容自带 Scaffold + AppBar，shell 侧不再叠加标题栏
        appBar:
            currentIndex == _tabSettings ? null : _buildAppBar(currentIndex, tabTitles),
        body: widget.navigationShell,
        bottomNavigationBar: NavigationBar(
          selectedIndex: currentIndex,
          onDestinationSelected: _onDestinationSelected,
          destinations: <Widget>[
            NavigationDestination(
              icon: const Icon(Icons.content_paste_outlined),
              selectedIcon: const Icon(Icons.content_paste),
              label: tabTitles[0],
            ),
            NavigationDestination(
              icon: const Icon(Icons.star_outline),
              selectedIcon: const Icon(Icons.star),
              label: tabTitles[1],
            ),
            NavigationDestination(
              icon: const Icon(Icons.devices_outlined),
              selectedIcon: const Icon(Icons.devices),
              label: tabTitles[2],
            ),
            NavigationDestination(
              icon: const Icon(Icons.settings_outlined),
              selectedIcon: const Icon(Icons.settings),
              label: tabTitles[3],
            ),
          ],
        ),
      ),
    );
  }

  /// 简洁标题栏：标题随 tab 切换；设备 tab 保留旧版刷新操作。
  PreferredSizeWidget _buildAppBar(int index, List<String> tabTitles) {
    final l10n = AppLocalizations.of(context);
    return AppBar(
      title: Text(tabTitles[index]),
      actions: index == _tabDevices
          ? <Widget>[
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: l10n.refreshDevices,
                onPressed: _refreshDevices,
              ),
            ]
          : null,
    );
  }
}

/// 收藏 tab（T4.1 落地）。
///
/// 保留 [FavoritesTab] 符号：router/app_router.dart 的收藏分支以它为根页；
/// Wave 4 起内部实现由 EmptyState 占位替换为收藏夹页 [FavoritesScreen]
/// （分组列表 / 新建 / 删除，自身管理数据与状态）。
class FavoritesTab extends StatelessWidget {
  const FavoritesTab({super.key});

  @override
  Widget build(BuildContext context) {
    return const FavoritesScreen();
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

  Future<void> _refreshDevices() async {
    final String? token = context.read<AuthProvider>().token;
    if (token != null) {
      await context.read<DeviceProvider>().loadDevices(token, forceRefresh: true);
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
        final l10n = AppLocalizations.of(context);
        if (provider.isLoading && provider.devices.isEmpty) {
          return const Center(child: CircularProgressIndicator());
        }
        // 错误必须可见：此前失败会被显示成「暂无设备」，掩盖真实原因
        if (provider.error != null && provider.devices.isEmpty) {
          return ErrorState(
            title: l10n.devicesLoadFailed,
            message: friendlyError(provider.error, l10n),
            onRetry: () {
              final token = context.read<AuthProvider>().token;
              if (token != null) {
                provider.loadDevices(token);
              }
            },
          );
        }
        if (provider.devices.isEmpty) {
          return RefreshIndicator(
            onRefresh: _refreshDevices,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: <Widget>[
                EmptyState(
                  icon: Icons.devices,
                  title: l10n.noDevices,
                  message: l10n.noDevicesDesc,
                ),
              ],
            ),
          );
        }
        final String? currentDeviceId = context.watch<AuthProvider>().deviceId;
        return RefreshIndicator(
          onRefresh: _refreshDevices,
          child: ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            controller: _scrollController,
            padding: const EdgeInsets.all(AppSpacing.lg),
            // 末位追加「活跃会话」区块（T4.3：会话管理区挂载于设备列表下方）
            itemCount: provider.devices.length + 1,
            separatorBuilder: (BuildContext context, int index) =>
                const SizedBox(height: AppSpacing.md),
            itemBuilder: (context, index) {
              if (index == provider.devices.length) {
                // T4.3：活跃会话区块（自管理加载/空/错误三态与吊销流程）
                return const SessionsSection();
              }
              final device = provider.devices[index];
              final bool isCurrent = currentDeviceId != null &&
                  currentDeviceId.isNotEmpty &&
                  device.id == currentDeviceId;
              // 长按设备卡片呼出解绑确认（T1.5 最小接入，逻辑保留）
              return DeviceCard(
                device: device,
                isCurrent: isCurrent,
                onLongPress: () => _confirmUnbindDevice(device),
              );
            },
          ),
        );
      },
    );
  }

  /// 长按解绑设备：确认对话框 → DELETE /api/devices/:id。
  /// 解绑当前设备时给出保护提示，并在成功后清空本地 deviceId、断开 WS。
  Future<void> _confirmUnbindDevice(Device device) async {
    final auth = context.read<AuthProvider>();
    final isCurrentDevice = device.id == auth.deviceId;
    final l10n = AppLocalizations.of(context);
    // 设备名缺失（服务端未返回）时用 l10n 兜底（A3：model 不再内嵌中文默认值）
    final deviceName = device.deviceName.isEmpty
        ? l10n.unknownDevice
        : device.deviceName;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l10n.unbindDevice),
        content: Text(
          isCurrentDevice
              ? l10n.unbindCurrentDeviceConfirm(deviceName)
              : l10n.unbindConfirm(deviceName),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            child: Text(l10n.unbind),
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
    final l10n = AppLocalizations.of(context);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(l10n.backAgainToExit),
          duration: const Duration(seconds: 2),
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
