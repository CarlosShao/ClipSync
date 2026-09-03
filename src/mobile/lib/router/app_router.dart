// lib/router/app_router.dart

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../l10n/app_localizations.dart';
import '../providers/auth_provider.dart';
import '../screens/clipboard/clipboard_screen.dart';
import '../screens/home_screen.dart';
import '../screens/lock_screen.dart';
import '../screens/login_screen.dart';
import '../screens/notifications/notifications_screen.dart';
import '../screens/onboarding/permission_guide_screen.dart';
import '../screens/onboarding_screen.dart';
import '../screens/settings_screen.dart';
import '../screens/share/share_receive_screen.dart';
import '../screens/shared/shared_links_screen.dart';
import '../screens/subscription/subscription_management_screen.dart';
import '../screens/templates/templates_screen.dart';
import '../theme/tokens_v2.dart';
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

  /// T4.4：订阅管理页（设置页「订阅管理」入口；亦支持深链直达），
  /// 替代已删除的 screens/subscription_management_screen.dart 直推入口
  static const subscriptionManagement = '/subscriptions';

  /// C5：共享链接页（设置页「共享链接」入口；亦支持深链直达）
  static const sharedLinks = '/shared-links';

  /// C5：通知中心页（设置页「通知中心」入口；亦支持深链直达）
  static const notifications = '/notifications';

  /// T4.6：生物识别锁定页（由 [BiometricLockGate] 门控：布防时唯一可达页面）
  static const lock = '/lock';
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

/// 生物识别锁布防门控（T4.6）。
///
/// locked=true（已布防）时，已登录用户访问任何路由都会被重定向到
/// `/lock`（[LockScreen]），通过生物验证后由锁定页调用 [unlock] 放行。
///
/// 布防时机（两处，均在 main.dart）：
/// - 冷启动：读取 SharedPreferences `biometric_lock_enabled`（开关写入方
///   settings_screen.dart），开关开启即布防；
/// - 运行期：ClipSyncApp 监听 AppLifecycleState.paused——App 退到后台
///   即布防，回前台经锁定页验证后放行。
///
/// 未登录/登录失效时由路由守卫自动复位（重新登录后按开关状态重新布防）。
class BiometricLockGate {
  BiometricLockGate._();

  static final ValueNotifier<bool> locked = ValueNotifier<bool>(false);

  /// 布防：进入应用前需通过生物验证
  static void lock() => locked.value = true;

  /// 解除：生物验证成功，放行进入应用
  static void unlock() => locked.value = false;
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
/// - `/lock`            生物识别锁定页（T4.6，由 [BiometricLockGate] 门控）
/// - `/share/receive`   系统分享接收确认页（T3.5，extra: SharePayload）
/// - `/templates`       模板库页（T4.2）
/// - `/subscriptions`   订阅管理页（T4.4）
/// - `/shared-links`    共享链接页（C5）
/// - `/notifications`   通知中心页（C5）
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
/// 3. 无 token → `/login`（并复位生物锁布防，T4.6）；
/// 4. 有 token 且生物锁已布防（冷启动/后台回前台）→ `/lock`（T4.6）；
/// 5. 已登录未布防时访问 `/` / `/login` / `/onboarding` / `/home` /
///    已解锁的 `/lock` → `/home/clipboard`。
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
      // T4.6：生物锁布防/解除（locked 翻转）后刷新重定向
      BiometricLockGate.locked,
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

      // 3. 已完成引导：无 token 只能停留在登录页；
      //    同时复位生物锁布防（重新登录后由 main.dart 侧按开关重新布防）
      if (!authProvider.isAuthenticated) {
        BiometricLockGate.unlock();
        return location == AppRoutes.login ? null : AppRoutes.login;
      }

      // 3.2 已登录且生物锁已布防（T4.6：冷启动 / 后台回前台）→ 锁定页。
      //     优先于权限引导页：未通过身份验证前不放行任何应用内容。
      if (BiometricLockGate.locked.value &&
          location != AppRoutes.lock) {
        return AppRoutes.lock;
      }

      // 3.3 走到这里说明已解锁：从锁定页回主页（若权限引导未展示过，
      //     先完成引导再进主页，保持 T3.4 一次性引导语义）
      if (location == AppRoutes.lock) {
        return PermissionGuideGate.pending.value
            ? AppRoutes.permissionGuide
            : AppRoutes.homeClipboard;
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
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const LoginScreen(),
        ),
      ),
      GoRoute(
        path: AppRoutes.onboarding,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const OnboardingScreen(),
        ),
      ),
      // T3.4：权限与保活引导页（首次启动一次性，见 PermissionGuideGate）
      GoRoute(
        path: AppRoutes.permissionGuide,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const PermissionGuideScreen(),
        ),
      ),
      // T4.6：生物识别锁定页（已登录 + 布防时由重定向守卫强制进入）
      GoRoute(
        path: AppRoutes.lock,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const LockScreen(),
        ),
      ),
      // T3.5：系统分享接收确认页（extra: SharePayload，非预期类型给空态）
      GoRoute(
        path: AppRoutes.shareReceive,
        pageBuilder: (context, state) {
          final extra = state.extra;
          return buildObsidianTransitionPage(
            key: state.pageKey,
            child: ShareReceiveScreen(
              payload: extra is SharePayload ? extra : const SharePayload(),
            ),
          );
        },
      ),
      // T4.2：模板库（设置页 Navigator.push 打开；此路由同时支持深链直达）
      GoRoute(
        path: AppRoutes.templates,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const TemplatesScreen(),
        ),
      ),
      // T4.4：订阅管理（设置页 context.push 打开；当前套餐/真实套餐列表/
      // 取消与恢复订阅；支付引导桌面端完成）
      GoRoute(
        path: AppRoutes.subscriptionManagement,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const SubscriptionManagementScreen(),
        ),
      ),
      // C5：共享链接（设置页 context.push 打开；列表/复制/撤销/创建）
      GoRoute(
        path: AppRoutes.sharedLinks,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const SharedLinksScreen(),
        ),
      ),
      // C5：通知中心（设置页 context.push 打开；站内通知列表/已读/全部已读）
      GoRoute(
        path: AppRoutes.notifications,
        pageBuilder: (context, state) => buildObsidianTransitionPage(
          key: state.pageKey,
          child: const NotificationsScreen(),
        ),
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

/// Obsidian v2 容器变换与物理位移动效页面（450ms morph emphasized）。
Page<dynamic> buildObsidianTransitionPage({
  required LocalKey key,
  required Widget child,
}) {
  return CustomTransitionPage<void>(
    key: key,
    child: child,
    transitionDuration: AppMotionV2.morph,
    reverseTransitionDuration: AppMotionV2.slow,
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final curvedAnimation = CurvedAnimation(
        parent: animation,
        curve: AppMotionV2.emphasized,
        reverseCurve: AppMotionV2.accelerateE,
      );
      final offsetAnimation = Tween<Offset>(
        begin: const Offset(0.06, 0.0),
        end: Offset.zero,
      ).animate(curvedAnimation);
      final fadeAnimation = Tween<double>(
        begin: 0.0,
        end: 1.0,
      ).animate(curvedAnimation);

      return SlideTransition(
        position: offsetAnimation,
        child: FadeTransition(
          opacity: fadeAnimation,
          child: child,
        ),
      );
    },
  );
}

/// 冷启动加载页：等待本地登录态校验完成（对齐 Obsidian v2 质感）
class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: AppColorsV2.surface(context, tier: SurfaceTier.base),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 80,
              height: 80,
              decoration: BoxDecoration(
                color: theme.colorScheme.primary.withValues(alpha: 0.12),
                shape: BoxShape.circle,
                border: Border.all(
                  color: theme.colorScheme.primary.withValues(alpha: 0.25),
                  width: 1.5,
                ),
              ),
              child: Icon(
                Icons.content_paste_rounded,
                size: 40,
                color: theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: 24),
            Text(
              l10n.appTitle,
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
                letterSpacing: 0,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              l10n.loginSubtitle,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: isDark ? Colors.white60 : Colors.black54,
              ),
            ),
            const SizedBox(height: 36),
            SizedBox(
              width: 28,
              height: 28,
              child: CircularProgressIndicator(
                strokeWidth: 2.5,
                color: theme.colorScheme.primary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
