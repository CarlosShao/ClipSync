import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'providers/auth_provider.dart';
import 'providers/device_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/ws_provider.dart';
import 'router/app_router.dart';
import 'router/route_guard.dart';
import 'services/cache_service.dart';
import 'services/clipboard_capture.dart';
import 'services/error_report_service.dart';
import 'services/local_notification_service.dart';
import 'services/server_config.dart';
import 'services/sync_service.dart';
import 'services/ws_service.dart';
import 'screens/share/share_intent_listener.dart';
import 'theme/app_theme.dart';
import 'utils/performance.dart';
// Temporarily disabled - localization
// import 'package:flutter_gen/gen_l10n/app_localizations.dart';

void main() async {
  // 启动性能监控 - 记录启动开始时间
  PerformanceUtils.recordAppStart();

  WidgetsFlutterBinding.ensureInitialized();

  // 初始化性能优化
  PerformanceUtils.cleanMemory();
  OptimizedImageCache.initialize();

  // 初始化缓存服务（关键依赖，必须提前初始化）
  await CacheService.instance.initialize(
    maxMemoryCacheSize: 100,
    maxDiskCacheSize: 50 * 1024 * 1024, // 50MB
    defaultTTL: const Duration(hours: 1),
  );

  // 加载后端地址配置（读取 SharedPreferences 的 server_url，未设置用平台默认）
  await ServerConfig.load();

  // 读取 onboarding 完成标记，作为路由守卫数据源（写入方：OnboardingScreen）
  final prefs = await SharedPreferences.getInstance();
  final onboardingCompleted = prefs.getBool('onboarding_completed') ?? false;

  // 创建需要异步初始化的 Provider（在 runApp 前完成，供路由守卫与设置页使用）
  final authProvider = AuthProvider();
  final guardState = RouteGuardState(onboardingCompleted: onboardingCompleted);
  final settingsProvider = SettingsProvider();
  await settingsProvider.init();

  // T3.1/T3.2：剪贴板采集管线绑定 + 登录态启停前台服务挂钩
  // - EchoAwareClipboardProvider：WS 推送内容登记进采集去重环（回环抑制）
  // - ClipboardCaptureService：持有列表引用 + 设备 id，采集文本去重后入库
  // - SyncService.attach：已登录（含冷启动恢复）→ 启动前台服务，登出 → 停止
  final clipboardProvider = EchoAwareClipboardProvider();
  ClipboardCaptureService.instance.bind(
    provider: clipboardProvider,
    deviceIdProvider: () => authProvider.deviceId,
  );
  SyncService.instance.attach(authProvider);

  // 创建 go_router 路由表（守卫依赖 authProvider / guardState）
  final appRouter = createAppRouter(
    authProvider: authProvider,
    guardState: guardState,
  );

  // T3.4：本地通知初始化（幂等；失败静默）+ 通知点击回首页 +
  //        WS new_clipboard 全局钩子（弹「剪贴板已更新」通知）
  await LocalNotificationService.instance.initialize();
  LocalNotificationService.instance.onNotificationTap = () {
    appRouter.go(AppRoutes.home);
  };
  WsService.globalNewClipboardHook = (msg) {
    LocalNotificationService.instance.handleWsNewClipboard(msg);
  };

  // T3.4：首次启动权限引导页门控（onboarding 完成后的下一次启动展示一次；
  //        路由守卫要求 onboarding + 登录完成，顺序由 app_router 保证）
  PermissionGuideGate.pending.value =
      !(prefs.getBool('permission_guide_shown') ?? false);

  // T3.5：系统分享面板接收监听（冷启动 getInitialMedia + 运行中 media stream）
  ShareIntentListener.instance.start(appRouter);

  // 延迟初始化错误报告服务（不阻塞启动）
  _initializeErrorReporting();

  // 记录初始化完成时间
  PerformanceUtils.recordInitializationComplete();

  runApp(ClipSyncApp(
    appRouter: appRouter,
    authProvider: authProvider,
    guardState: guardState,
    settingsProvider: settingsProvider,
    clipboardProvider: clipboardProvider,
  ));
}

/// 延迟初始化错误报告服务（不阻塞首帧渲染）
void _initializeErrorReporting() {
  // 在首帧渲染完成后初始化
  WidgetsBinding.instance.addPostFrameCallback((_) async {
    try {
      await ErrorReportService.instance.initialize();
      if (kDebugMode) {
        debugPrint('✅ ErrorReportService initialized after first frame');
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('⚠️ ErrorReportService initialization failed: $e');
      }
    }
  });
}

class ClipSyncApp extends StatelessWidget {
  final GoRouter appRouter;
  final AuthProvider authProvider;
  final RouteGuardState guardState;
  final SettingsProvider settingsProvider;

  /// T3.1/T3.2：带回环登记的剪贴板 Provider（main() 中创建并绑定采集服务）
  final EchoAwareClipboardProvider clipboardProvider;

  const ClipSyncApp({
    super.key,
    required this.appRouter,
    required this.authProvider,
    required this.guardState,
    required this.settingsProvider,
    required this.clipboardProvider,
  });

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        // 已在 main() 中完成异步初始化的 Provider，使用 .value 注入
        ChangeNotifierProvider.value(value: authProvider),
        ChangeNotifierProvider.value(value: guardState),
        ChangeNotifierProvider.value(value: settingsProvider),
        // 延迟加载非关键Provider
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        // T3.1/T3.2：EchoAwareClipboardProvider 在 main() 中创建（采集回环登记），.value 注入
        ChangeNotifierProvider.value(value: clipboardProvider),
        ChangeNotifierProvider(create: (context) => DeviceProvider()),
        ChangeNotifierProvider(create: (context) => WsProvider()),
      ],
      child: Consumer<ThemeProvider>(
        builder: (context, themeProvider, _) {
          return MaterialApp.router(
            title: 'ClipSync',
            debugShowCheckedModeBanner: false,
            // Temporarily disabled - localization
            // localizationsDelegates: AppLocalizations.localizationsDelegates,
            localizationsDelegates: [
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            supportedLocales: [
              Locale('en', ''),
              Locale('zh', ''),
            ],
            theme: AppTheme.lightTheme,
            darkTheme: AppTheme.darkTheme,
            themeMode: themeProvider.themeMode,
            routerConfig: appRouter,
            builder: (context, child) {
              return ErrorReportWidget(child: child ?? const SizedBox.shrink());
            },
          );
        },
      ),
    );
  }
}
