// lib/router/app_router.dart

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../providers/auth_provider.dart';
import '../screens/clipboard/clipboard_screen.dart';
import '../screens/home_screen.dart';
import '../screens/login_screen.dart';
import '../screens/onboarding/permission_guide_screen.dart';
import '../screens/onboarding_screen.dart';
import '../screens/settings_screen.dart';
import '../screens/share/share_receive_screen.dart';
import '../screens/templates/templates_screen.dart';
import 'route_guard.dart';

/// 路由路径常量
class AppRoutes {
  static const splash = '/';
  static const login = '/login';
  static const onboarding = '/onboarding';

  /// 主页 shell 逻辑根：裸路径别名（登录/引导完成后的跳转入口），
  /// 由重定向映射到默认分支 [homeClipboard]，本身不注册路由页面。
  static const home = '/home';

  /// 4 个 tab 分支路由（T2.2 应用骨架：StatefulShellRoute.indexedStack）
  static const homeClipboard = '/home/clipboard';
  static const homeFavorites = '/home/favorites';
  static const homeDevices = '/home/devices';
  static const homeSettings = '/home/settings';

  /// T3.4：首次启动权限引导页（通知权限 + 电池优化 + 自启动）
  static const permissionGuide = '/permission-guide';

  /// T3.5：系统分享接收确认页（extra: SharePayload）
  static const shareReceive = '/share/receive';

  /// T4.2：模板库页（设置页「模板库」入口；亦支持深链直达）
  static const templates = '/templates';
}

/// 权限引导页一次性门控（T3.4）。
///
/// pending=true 时（未展示过引导页），已登录用户会被重定向到
/// `/permission-guide`；引导页「完成/跳过」置 false 并写
/// SharedPreferences `permission_guide_shown`（读取方 main.dart）。
class PermissionGuideGate {
  PermissionGuideGate._();

  static final ValueNotifier<bool> pending = ValueNotifier<bool>(false);
}

/// 创建应用路由（go_router）。
///
/// 路由表：
/// - `/home/clipboard`  剪贴板 tab（默认分支，挂载 ClipboardScreen）
/// - `/home/favorites`  收藏 tab（Wave 4 前为 EmptyState 占位）
/// - `/home/devices`    设备 tab（设备列表 + 解绑）
/// - `/home/settings`   设置 tab（SettingsScreen）
/// - `/`                冷启动加载页（等待 AuthProvider 完成 auth_token 本地校验）
/// - `/login`           验证码登录页
/// - `/onboarding`      首次使用引导页
/// - `/permission-guide` 首次启动权限引导页（T3.4，由 [PermissionGuideGate] 门控）
/// - `/share/receive`   系统分享接收确认页（T3.5，extra: SharePayload）
///
/// 四个 tab 由 [StatefulShellRoute.indexedStack] 组成同一个 shell：
/// 每个分支一个独立 Navigator，分支容器为 IndexedStack（切 tab 保活，
/// 不丢滚动位置与状态）；shell 页面由 HomeScreen 承载（AppBar +
/// M3 NavigationBar）。裸 `/home` 与 `/`、`/login`、`/onboarding` 一样
/// 在重定向中映射到默认分支 `/home/clipboard`。
///
/// 重定向守卫（守卫数据源沿用原有读取逻辑：AuthProvider 负责读取
/// SharedPreferences 的 `auth_token`，RouteGuardState 负责读取
/// `onboarding_completed`，两者在启动时完成加载）：
/// 1. 认证状态未知（isLoading）→ 统一回 `/` 加载页；
/// 2. 未完成 onboarding → `/onboarding`；
/// 3. 无 token → `/login`；
/// 4. 有 token 访问 `/` / `/login` / `/onboarding` / `/home` → `/home/clipboard`。
GoRouter createAppRouter({
  required AuthProvider authProvider,
  required RouteGuardState guardState,
}) {
  return GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: Listenable.merge([
      authProvider,
      guardState,
      // 权限引导完成（pending 翻转）后刷新重定向
      PermissionGuideGate.pending,
    ]),
    redirect: (context, state) {
      final location = state.matchedLocation;

      // 1. 认证状态未就绪（本地 token / profile 校验中）：一律回加载页，
      //    避免守卫基于尚未加载的空 token 做出误判。
      if (authProvider.isLoading) {
        return location == AppRoutes.splash ? null : AppRoutes.splash;
      }

      // 2. 未完成首次引导 → 引导页
      if (!guardState.onboardingCompleted) {
        return location == AppRoutes.onboarding ? null : AppRoutes.onboarding;
      }

      // 3. 已完成引导：无 token 只能停留在登录页
      if (!authProvider.isAuthenticated) {
        return location == AppRoutes.login ? null : AppRoutes.login;
      }

      // 3.5 已登录且未展示过权限引导页（T3.4 一次性）→ 权限引导页
      if (PermissionGuideGate.pending.value &&
          location != AppRoutes.permissionGuide) {
        return AppRoutes.permissionGuide;
      }

      // 4. 已登录：从加载页 / 登录页 / 引导页 / 裸 /home 进入主页默认分支
      if (location == AppRoutes.splash ||
          location == AppRoutes.login ||
          location == AppRoutes.onboarding ||
          location == AppRoutes.home) {
        return AppRoutes.homeClipboard;
      }
      return null;
    },
    routes: [
      GoRoute(
        path: AppRoutes.splash,
        builder: (context, state) => const _SplashScreen(),
      ),
      GoRoute(
        path: AppRoutes.login,
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: AppRoutes.onboarding,
        builder: (context, state) => const OnboardingScreen(),
      ),
      // T3.4：权限与保活引导页（首次启动一次性，见 PermissionGuideGate）
      GoRoute(
        path: AppRoutes.permissionGuide,
        builder: (context, state) => const PermissionGuideScreen(),
      ),
      // T3.5：系统分享接收确认页（extra: SharePayload，非预期类型给空态）
      GoRoute(
        path: AppRoutes.shareReceive,
        builder: (context, state) {
          final extra = state.extra;
          return ShareReceiveScreen(
            payload: extra is SharePayload
                ? extra
                : const SharePayload(),
          );
        },
      ),
      // T4.2：模板库（设置页 Navigator.push 打开；此路由同时支持深链直达）
      GoRoute(
        path: AppRoutes.templates,
        builder: (context, state) => const TemplatesScreen(),
      ),
      // 主页 4 tab shell：IndexedStack 保活分支，HomeScreen 提供骨架外观
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) =>
            HomeScreen(navigationShell: navigationShell),
        branches: [
          // 剪贴板 tab：T2.3 交付的 ClipboardScreen（冻结契约：无参构造，
          // 自身消费 ClipboardProvider）。文件由并行工单落盘。
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: AppRoutes.homeClipboard,
                builder: (context, state) =>
                    const BackExitGuard(child: ClipboardScreen()),
              ),
            ],
          ),
          // 收藏 tab：Wave 4 前为 EmptyState 占位
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: AppRoutes.homeFavorites,
                builder: (context, state) =>
                    const BackExitGuard(child: FavoritesTab()),
              ),
            ],
          ),
          // 设备 tab：设备列表 + 长按解绑（自旧版设备页迁移）
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: AppRoutes.homeDevices,
                builder: (context, state) =>
                    const BackExitGuard(child: DevicesTab()),
              ),
            ],
          ),
          // 设置 tab：既有 SettingsScreen 宿主挂载（文件本身不重构）
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: AppRoutes.homeSettings,
                builder: (context, state) =>
                    const BackExitGuard(child: SettingsScreen()),
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

/// 冷启动加载页：等待本地登录态校验完成（与旧版 main.dart 的加载屏保持一致）
class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: const [
            Icon(
              Icons.content_paste,
              size: 64,
              color: Color(0xFF6C5CE7),
            ),
            SizedBox(height: 16),
            Text(
              'ClipSync',
              style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
                color: Color(0xFF2D3436),
              ),
            ),
            SizedBox(height: 8),
            Text(
              '跨设备剪贴板同步',
              style: TextStyle(
                fontSize: 14,
                color: Color(0xFF636E72),
              ),
            ),
            SizedBox(height: 32),
            CircularProgressIndicator(color: Color(0xFF6C5CE7)),
          ],
        ),
      ),
    );
  }
}
