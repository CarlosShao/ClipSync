import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

// T4.5: i18n 基建 —— flutter gen-l10n 生成（配置见 l10n.yaml）
import 'l10n/app_localizations.dart';
import 'providers/auth_provider.dart';
import 'providers/clipboard_provider.dart';
import 'providers/device_provider.dart';
import 'providers/settings_provider.dart';
import 'providers/ws_provider.dart';
import 'router/app_router.dart';
import 'router/route_guard.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import 'services/api_service.dart';
import 'services/cache_service.dart';
import 'services/clipboard_capture.dart';
import 'services/error_report_service.dart';
import 'services/local_notification_service.dart';
import 'services/server_config.dart';
import 'services/sync_service.dart';
import 'services/token_store.dart';
import 'services/ws_service.dart';
import 'screens/share/share_intent_listener.dart';
import 'theme/app_theme.dart';
import 'utils/performance.dart';

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

  // T4.6：生物识别锁冷启动布防——开关开启即锁定，已登录用户会被路由守卫
  // 重定向到 /lock 经生物验证后放行；未登录/凭证失效时守卫会自动复位。
  // 开关写入方：设置页（settings_screen.dart），键 biometric_lock_enabled。
  BiometricLockGate.locked.value =
      prefs.getBool('biometric_lock_enabled') ?? false;

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

  // B3：网络恢复 → WS 自动重连。WsService 连续重连 10 次失败会按既有策略
  // 永久放弃，此处由 SyncService 的 connectivity 恢复事件重新发起连接；
  // WsProvider 在 main() 创建（.value 注入），供本钩子与 UI 共用同一实例。
  final wsProvider = WsProvider();
  SyncService.instance.onNetworkRestored = () {
    if (!authProvider.isAuthenticated) return;
    final token = authProvider.token;
    if (token == null || token.isEmpty) return;
    final deviceId = authProvider.deviceId;
    if (deviceId == null || deviceId.isEmpty) {
      // 设备 id 未就绪（注册未完成）：由 home_screen 的 ensureDeviceId 链路兜底
      debugPrint('[B3] network restored: skip WS reconnect, deviceId not ready');
      return;
    }
    debugPrint('[B3] network restored: ensure WS connected');
    wsProvider.ensureConnected(
      token: token,
      deviceId: deviceId,
      clipboardProvider: clipboardProvider,
    );
  };

  // 创建 go_router 路由表（守卫依赖 authProvider / guardState）
  final appRouter = createAppRouter(
    authProvider: authProvider,
    guardState: guardState,
  );

  // T3.4：本地通知初始化（幂等；失败静默）+ 通知点击回首页
  await LocalNotificationService.instance.initialize();
  LocalNotificationService.instance.onNotificationTap = () {
    appRouter.go(AppRoutes.home);
  };

  // 手机端原生截屏感知 → 自动上传至服务端（PC 端与移动端列表即时呈现）。
  // 原生侧已按 content:// 读取好图片字节（Android 10+ 分区存储下文件路径
  // 可能不可直读，统一由原生读取最稳）。
  // 手机端原生截屏感知 → 自动上传至服务端（PC 端与移动端列表即时呈现）。
  // 原生侧已按 content:// 读取好图片字节（Android 10+ 分区存储下文件路径
  // 可能不可直读，统一由原生读取最稳）。
  SyncService.instance.onScreenshotCaptured = (bytes, fileName, mimeType) async {
    if (!settingsProvider.autoSyncScreenshots) {
      debugPrint('[ScreenshotCapture] skipped: autoSyncScreenshots is off');
      return;
    }
    final myDevice = authProvider.deviceId ?? await authProvider.ensureDeviceId();
    if (myDevice == null || myDevice.isEmpty) {
      debugPrint('[ScreenshotCapture] dropped: deviceId is null');
      return;
    }
    try {
      if (bytes.isEmpty) return;
      final filename = (fileName == null || fileName.isEmpty)
          ? 'screenshot_${DateTime.now().millisecondsSinceEpoch}.png'
          : fileName;
      debugPrint(
          '[ScreenshotCapture] Uploading screenshot: $filename (${bytes.length} bytes) from device $myDevice');
      final result = await ApiService().uploadImage(
        null,
        myDevice,
        imageBytes: bytes,
        filename: filename,
        mimeType: mimeType,
      );
      if (result != null) {
        debugPrint('[ScreenshotCapture] Uploaded screenshot successfully: ${result['id']}');
        await clipboardProvider.refresh(forceRefresh: true);
      } else {
        debugPrint('[ScreenshotCapture] uploadImage returned null');
      }
    } catch (e) {
      debugPrint('[ScreenshotCapture] Upload failed: $e');
    }
  };

  // 辅助方法：拉取条目图片字节（兼容 PC base64 dataUrl 与服务端媒体文件）
  Future<Map<String, dynamic>?> fetchItemImage(String itemId) async {
    // 1. 优先尝试从 /api/clipboard/:id/content 获取（PC 截图以 base64 dataUrl 存入 content_encrypted）
    try {
      final content = await ApiService().getItemContent(null, itemId);
      if (content != null && content.startsWith('data:')) {
        final comma = content.indexOf(',');
        if (comma > 0) {
          final m = RegExp(r'^data:([^;]+)').firstMatch(content);
          final mime = m?.group(1) ?? 'image/png';
          final bytes = Uint8List.fromList(base64Decode(content.substring(comma + 1)));
          if (bytes.isNotEmpty) {
            return {'bytes': bytes, 'mime': mime};
          }
        }
      }
    } catch (e) {
      debugPrint('[FetchImage] getItemContent error: $e');
    }

    // 2. 若 content 不是 dataUrl（例如移动端通过 /api/media/image 上传的文件），走 /api/media/:id/download
    try {
      final token = await TokenStore.getAccessToken();
      final downloadUrl = '${ServerConfig.baseUrl}/api/media/$itemId/download';
      final response = await http.get(
        Uri.parse(downloadUrl),
        headers: token != null ? {'Authorization': 'Bearer $token'} : {},
      );
      if (response.statusCode == 200 && response.bodyBytes.isNotEmpty) {
        final mime = response.headers['content-type']?.split(';').first ?? 'image/png';
        return {'bytes': response.bodyBytes, 'mime': mime};
      }
    } catch (e) {
      debugPrint('[FetchImage] media download error: $e');
    }

    return null;
  }

  // WS new_clipboard 全局钩子：图片自动保存相册 + 富媒体大图通知 + 文本回写剪贴板
  WsService.globalNewClipboardHook = (msg) {
    try {
      final item = msg['item'] as Map<String, dynamic>?;
      final type = item?['contentType'] as String?;
      final sourceDevice = item?['sourceDeviceId'] as String?;
      final sourceDeviceName = item?['sourceDeviceName'] as String?;
      final myDevice = authProvider.deviceId;
      final itemId = item?['id'] as String?;
      final preview = LocalNotificationService.extractPreview(msg);
      final isRemote =
          sourceDevice == null || sourceDevice.isEmpty || sourceDevice != myDevice;
      final writebackOn = settingsProvider.clipboardWritebackEnabled;

      if (isRemote && itemId != null && type == 'image') {
        // 核心场景：PC 截图/图片 → 自动保存手机相册 + 弹出大图预览通知。
        Future(() async {
          try {
            final imgData = await fetchItemImage(itemId);
            if (imgData == null) {
              debugPrint('[AutoSaveImage] no image bytes fetched for item $itemId');
              await LocalNotificationService.instance.handleWsNewClipboard(msg);
              return;
            }

            final imageBytes = imgData['bytes'] as Uint8List;
            final imageMime = imgData['mime'] as String;

            if (settingsProvider.autoSaveImagesToAlbum) {
              final ext = imageMime.contains('jpeg')
                  ? 'jpg'
                  : imageMime.contains('webp')
                      ? 'webp'
                      : imageMime.contains('gif')
                          ? 'gif'
                          : 'png';
              final filename = 'Screenshot_${DateTime.now().millisecondsSinceEpoch}.$ext';
              final savedAlbumPath = await SyncService.instance.saveImageToAlbum(
                imageBytes,
                fileName: filename,
                mimeType: imageMime,
              );
              debugPrint('[AutoSaveImage] Saved to album: $savedAlbumPath');
            }

            // 大图预览由 showClipboardUpdated 写至应用私有临时文件供系统加载
            await LocalNotificationService.instance.showClipboardUpdated(
              preview,
              imageBytes: imageBytes,
              sourceDevice: sourceDeviceName,
            );
          } catch (e) {
            debugPrint('[AutoSaveImage] failed: $e');
            await LocalNotificationService.instance.handleWsNewClipboard(msg);
          }
        });
      } else if (isRemote && itemId != null && (type == 'text' || type == 'link')) {
        // 核心场景：文本/链接回写系统剪贴板 + 弹出多行长文本预览通知
        Future(() async {
          try {
            final content = await ApiService().getItemContent(null, itemId);
            if (content != null && content.isNotEmpty) {
              if (writebackOn) {
                await Clipboard.setData(ClipboardData(text: content));
                debugPrint('[Writeback] clipboard written from item $itemId');
              }
              await LocalNotificationService.instance.showClipboardUpdated(
                preview,
                fullText: content,
                sourceDevice: sourceDeviceName,
              );
            } else {
              await LocalNotificationService.instance.handleWsNewClipboard(msg);
            }
          } catch (e) {
            debugPrint('[Writeback] failed for $itemId: $e');
            await LocalNotificationService.instance.handleWsNewClipboard(msg);
          }
        });
      } else {
        // 其他类型或非远程消息，走默认基础通知
        LocalNotificationService.instance.handleWsNewClipboard(msg);
      }
    } catch (e) {
      debugPrint('[WsHook] error: $e');
      LocalNotificationService.instance.handleWsNewClipboard(msg);
    }
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
    wsProvider: wsProvider,
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

class ClipSyncApp extends StatefulWidget {
  final GoRouter appRouter;
  final AuthProvider authProvider;
  final RouteGuardState guardState;
  final SettingsProvider settingsProvider;

  /// T3.1/T3.2：带回环登记的剪贴板 Provider（main() 中创建并绑定采集服务）
  final EchoAwareClipboardProvider clipboardProvider;

  /// B3：WS Provider（main() 中创建，onNetworkRestored 钩子与 UI 共用）
  final WsProvider wsProvider;

  const ClipSyncApp({
    super.key,
    required this.appRouter,
    required this.authProvider,
    required this.guardState,
    required this.settingsProvider,
    required this.clipboardProvider,
    required this.wsProvider,
  });

  @override
  State<ClipSyncApp> createState() => _ClipSyncAppState();
}

class _ClipSyncAppState extends State<ClipSyncApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// T4.6：App 退到后台即布防生物锁；回前台时由路由守卫强制经 /lock
  /// 生物验证后放行（冷启动布防在 main() 读取 biometric_lock_enabled）。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) {
      _armBiometricLock();
    }
  }

  /// 已登录且开关开启时布防（开关读取走 SharedPreferences，
  /// 与设置页写入键 biometric_lock_enabled 保持一致）
  Future<void> _armBiometricLock() async {
    if (!widget.authProvider.isAuthenticated) return;
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool('biometric_lock_enabled') ?? false) {
      BiometricLockGate.lock();
    }
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        // 已在 main() 中完成异步初始化的 Provider，使用 .value 注入
        ChangeNotifierProvider.value(value: widget.authProvider),
        ChangeNotifierProvider.value(value: widget.guardState),
        ChangeNotifierProvider.value(value: widget.settingsProvider),
        // 延迟加载非关键Provider
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        // T3.1/T3.2：EchoAwareClipboardProvider 在 main() 中创建（采集回环登记）。
        // ⚠️ 必须显式声明父类型 ClipboardProvider：provider 包按注册时的
        // 泛型精确匹配查找，注册成子类类型会导致 Consumer<ClipboardProvider>
        // 抛 ProviderNotFoundException（真机已踩坑）
        ChangeNotifierProvider<ClipboardProvider>.value(value: widget.clipboardProvider),
        ChangeNotifierProvider(create: (context) => DeviceProvider()),
        // B3：WsProvider 在 main() 创建（onNetworkRestored 钩子与 UI 共用）
        ChangeNotifierProvider<WsProvider>.value(value: widget.wsProvider),
      ],
      // T4.5: i18n —— locale 由 SettingsProvider.language 驱动（设置页切换即时生效，
      // 持久化键 'language'；未迁移的硬编码文案不受影响，后续渐进迁移）
      child: Consumer2<ThemeProvider, SettingsProvider>(
        builder: (context, themeProvider, settingsProvider, _) {
          return MaterialApp.router(
            title: 'ClipSync',
            debugShowCheckedModeBanner: false,
            locale: Locale(settingsProvider.language),
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: AppTheme.lightTheme,
            darkTheme: AppTheme.darkTheme,
            themeMode: themeProvider.themeMode,
            routerConfig: widget.appRouter,
            builder: (context, child) {
              // A3：本地通知文案本地化——服务层无 BuildContext，在 MaterialApp
              // builder（Localizations 之下）首帧取 AppLocalizations 注入；
              // locale 切换时 builder 重建会再次注入
              final l10n = AppLocalizations.of(context);
              LocalNotificationService.instance.applyTexts(
                NotificationTexts(
                  channelClipboardName: l10n.notifChannelClipboard,
                  channelClipboardDesc: l10n.notifChannelClipboardDesc,
                  channelAlertName: l10n.notifChannelAlert,
                  channelAlertDesc: l10n.notifChannelAlertDesc,
                  clipboardUpdatedTitle: l10n.notifClipboardUpdated,
                  newClipboardBody: l10n.notifNewClipboardBody,
                ),
              );
              return ErrorReportWidget(child: child ?? const SizedBox.shrink());
            },
          );
        },
      ),
    );
  }
}
