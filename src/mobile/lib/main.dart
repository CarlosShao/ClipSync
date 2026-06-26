import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/onboarding_screen.dart';
import 'providers/auth_provider.dart';
import 'providers/clipboard_provider.dart';
import 'providers/device_provider.dart';
import 'providers/ws_provider.dart';
import 'theme/app_theme.dart';
import 'utils/performance.dart';
import 'services/cache_service.dart';
import 'services/error_report_service.dart';
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
  
  // 延迟初始化错误报告服务（不阻塞启动）
  _initializeErrorReporting();
  
  // 记录初始化完成时间
  PerformanceUtils.recordInitializationComplete();
  
  runApp(const ClipSyncApp());
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

class ClipSyncApp extends StatefulWidget {
  const ClipSyncApp({super.key});

  @override
  State<ClipSyncApp> createState() => _ClipSyncAppState();
}

class _ClipSyncAppState extends State<ClipSyncApp> {
  bool _showOnboarding = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _checkOnboarding();
    
    // 监听首帧渲染完成
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PerformanceUtils.recordFirstFrameRendered();
      if (kDebugMode) {
        final report = PerformanceUtils.getStartupPerformanceReport();
        debugPrint('🚀 Startup Performance Report: $report');
      }
    });
  }

  Future<void> _checkOnboarding() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final completed = prefs.getBool('onboarding_completed') ?? false;
      setState(() {
        _showOnboarding = !completed;
        _loading = false;
      });
    } catch (e) {
      // 如果SharedPreferences失败，直接进入应用
      setState(() {
        _showOnboarding = false;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        // 延迟加载非关键Provider
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => AuthProvider()),
        ChangeNotifierProvider(create: (context) => ClipboardProvider()),
        ChangeNotifierProvider(create: (context) => DeviceProvider()),
        ChangeNotifierProvider(create: (context) => WsProvider()),
      ],
        child: Consumer<ThemeProvider>(
          builder: (context, themeProvider, _) {
            return MaterialApp(
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
            home: ErrorReportWidget(
              child: _loading
                  ? const Scaffold(
                      body: Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
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
                    )
                  : _showOnboarding
                      ? const OnboardingScreen()
                      : Consumer<AuthProvider>(
                          builder: (context, auth, _) {
                            if (auth.isLoading) {
                              return const Scaffold(
                                body: Center(
                                  child: CircularProgressIndicator(color: Color(0xFF6C5CE7)),
                                ),
                              );
                            }
                            if (auth.isAuthenticated) {
                              return const HomeScreen();
                            }
                            return const LoginScreen();
                          },
                        ),
            ),
          );
        },
      ),
    );
  }
}
