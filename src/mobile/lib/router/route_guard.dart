// lib/router/route_guard.dart

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 路由守卫数据源。
///
/// [onboardingCompleted] 在 main.dart 冷启动时从 SharedPreferences 读取
/// `onboarding_completed` 键初始化（与 OnboardingScreen 的写入键保持一致），
/// 引导完成/跳过时由 OnboardingScreen 调用 [completeOnboarding] 同步内存态，
/// 并通过 notifyListeners 触发 go_router 重定向重新求值。
class RouteGuardState extends ChangeNotifier {
  bool onboardingCompleted;

  RouteGuardState({required this.onboardingCompleted});

  /// 标记引导完成：持久化到 SharedPreferences + 更新内存态 + 触发路由刷新
  Future<void> completeOnboarding() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('onboarding_completed', true);
    if (!onboardingCompleted) {
      onboardingCompleted = true;
      notifyListeners();
    }
  }
}
