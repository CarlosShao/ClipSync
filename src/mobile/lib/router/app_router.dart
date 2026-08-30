// lib/router/app_router.dart

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../providers/auth_provider.dart';
import '../screens/home_screen.dart';
import '../screens/login_screen.dart';
import '../screens/onboarding_screen.dart';
import 'route_guard.dart';

/// 路由路径常量
class AppRoutes {
  static const splash = '/';
  static const login = '/login';
  static const onboarding = '/onboarding';
  static const home = '/home';
}

/// 创建应用路由（go_router）。
///
/// 路由表：
/// - `/`            冷启动加载页（等待 AuthProvider 完成 auth_token 本地校验）
/// - `/login`       验证码登录页
/// - `/onboarding`  首次使用引导页
/// - `/home`        主页（HomeScreen 内部承载 剪贴板/设备/设置 三个 tab 区）
///
/// 重定向守卫（守卫数据源沿用原有读取逻辑：AuthProvider 负责读取
/// SharedPreferences 的 `auth_token`，RouteGuardState 负责读取
/// `onboarding_completed`，两者在启动时完成加载）：
/// 1. 认证状态未知（isLoading）→ 统一回 `/` 加载页；
/// 2. 未完成 onboarding → `/onboarding`；
/// 3. 无 token → `/login`；
/// 4. 有 token 访问 `/login` 或 `/onboarding` → `/home`。
///
/// 说明：home 的三个 tab 区由 HomeScreen 内部自管理（Wave 0 不拆其内部
/// 结构），此处以单一 `/home` 路由挂载，等价于 shell 方式；真正的
/// StatefulShellRoute 拆分随 T2.2「应用骨架」对 home_screen 的重构落地。
GoRouter createAppRouter({
  required AuthProvider authProvider,
  required RouteGuardState guardState,
}) {
  return GoRouter(
    initialLocation: AppRoutes.splash,
    refreshListenable: Listenable.merge([authProvider, guardState]),
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

      // 4. 已登录：从加载页 / 登录页 / 引导页进入主页
      if (location == AppRoutes.splash ||
          location == AppRoutes.login ||
          location == AppRoutes.onboarding) {
        return AppRoutes.home;
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
      GoRoute(
        path: AppRoutes.home,
        builder: (context, state) => const HomeScreen(),
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
