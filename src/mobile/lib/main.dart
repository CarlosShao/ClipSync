import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'providers/auth_provider.dart';
import 'providers/clipboard_provider.dart';
import 'providers/device_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/ws_provider.dart';
import 'router/app_router.dart';
import 'router/route_guard.dart';
import 'services/cache_service.dart';
import 'services/error_report_service.dart';
import 'services/server_config.dart';
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

  // 创建 go_router 路由表（守卫依赖 authProvider / guardState）
  final appRouter = createAppRouter(
    authProvider: authProvider,
    guardState: guardState,
  );

  // 延迟初始化错误报告服务（不阻塞启动）
  _initializeErrorReporting();

  // 记录初始化完成时间
  PerformanceUtils.recordInitializationComplete();

  runApp(ClipSyncApp(
    appRouter: appRouter,
    authProvider: authProvider,
    guardState: guardState,
    settingsProvider: settingsProvider,
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

  const ClipSyncApp({
    super.key,
    required this.appRouter,
    required this.authProvider,
    required this.guardState,
    required this.settingsProvider,
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
        ChangeNotifierProvider(create: (context) => ClipboardProvider()),
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
