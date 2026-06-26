import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 性能优化工具类
class PerformanceUtils {
  // 启动性能监控
  static DateTime? _appStartTime;
  static DateTime? _initializationCompleteTime;
  static DateTime? _firstFrameRenderedTime;
  
  // 内存监控
  static const int _memoryWarningThreshold = 100 * 1024 * 1024; // 100MB
  static const int _memoryCriticalThreshold = 200 * 1024 * 1024; // 200MB
  
  // 帧率监控
  static final List<Duration> _frameDurations = [];
  static const int _maxFrameSamples = 100;
  static bool _isMonitoringFrameRate = false;
  
  /// 记录应用启动开始时间
  static void recordAppStart() {
    _appStartTime = DateTime.now();
    if (kDebugMode) {
      debugPrint('⏱️ App started at: $_appStartTime');
    }
  }
  
  /// 记录初始化完成时间
  static void recordInitializationComplete() {
    _initializationCompleteTime = DateTime.now();
    if (kDebugMode && _appStartTime != null) {
      final duration = _initializationCompleteTime!.difference(_appStartTime!);
      debugPrint('⏱️ Initialization completed in ${duration.inMilliseconds}ms');
    }
  }
  
  /// 记录首帧渲染完成时间
  static void recordFirstFrameRendered() {
    _firstFrameRenderedTime = DateTime.now();
    if (kDebugMode && _appStartTime != null) {
      final duration = _firstFrameRenderedTime!.difference(_appStartTime!);
      debugPrint('⏱️ First frame rendered in ${duration.inMilliseconds}ms');
    }
  }
  
  /// 获取启动性能报告
  static Map<String, dynamic> getStartupPerformanceReport() {
    if (_appStartTime == null) return {};
    
    final report = <String, dynamic>{
      'appStartTime': _appStartTime!.toIso8601String(),
    };
    
    if (_initializationCompleteTime != null) {
      final initDuration = _initializationCompleteTime!.difference(_appStartTime!);
      report['initializationDurationMs'] = initDuration.inMilliseconds;
    }
    
    if (_firstFrameRenderedTime != null) {
      final firstFrameDuration = _firstFrameRenderedTime!.difference(_appStartTime!);
      report['firstFrameDurationMs'] = firstFrameDuration.inMilliseconds;
    }
    
    return report;
  }
  
  /// 延迟初始化
  static Future<T> lazyInit<T>(Future<T> Function() initializer) async {
    return await initializer();
  }
  
  /// 批量处理
  static List<T> batchProcess<T>(List<dynamic> items, T Function(dynamic) processor) {
    return items.map(processor).toList();
  }
  
  /// 内存清理
  static void cleanMemory() {
    PaintingBinding.instance.imageCache.clear();
    PaintingBinding.instance.imageCache.clearLiveImages();
  }
  
  /// 获取内存使用情况
  static Map<String, dynamic> getMemoryUsage() {
    final imageCache = PaintingBinding.instance.imageCache;
    final memoryInfo = <String, dynamic>{
      'imageCacheSize': imageCache.currentSize,
      'imageCacheBytes': imageCache.currentSizeBytes,
      'imageCacheLimit': imageCache.maximumSize,
      'imageCacheLimitByte': imageCache.maximumSizeBytes,
    };
    
    // 添加内存警告
    if (imageCache.currentSizeBytes > _memoryWarningThreshold) {
      memoryInfo['warning'] = 'Memory usage exceeds 100MB';
    }
    if (imageCache.currentSizeBytes > _memoryCriticalThreshold) {
      memoryInfo['critical'] = 'Memory usage exceeds 200MB';
      // 自动清理
      cleanMemory();
    }
    
    return memoryInfo;
  }
  
  /// 开始帧率监控
  static void startFrameRateMonitoring() {
    if (_isMonitoringFrameRate) return;
    _isMonitoringFrameRate = true;
    
    if (kDebugMode) {
      debugPrint('📊 Frame rate monitoring started');
    }
    
    // 使用 WidgetsBinding 监听帧率
    WidgetsBinding.instance.addPersistentFrameCallback((_) {
      final now = DateTime.now();
      if (_frameDurations.length >= _maxFrameSamples) {
        _frameDurations.removeAt(0);
      }
      _frameDurations.add(Duration(milliseconds: now.millisecond));
    });
  }
  
  /// 停止帧率监控
  static void stopFrameRateMonitoring() {
    _isMonitoringFrameRate = false;
    _frameDurations.clear();
  }
  
  /// 获取帧率报告
  static Map<String, dynamic> getFrameRateReport() {
    if (_frameDurations.isEmpty) {
      return {'error': 'No frame data available'};
    }
    
    final avgFrameTime = _frameDurations.map((d) => d.inMilliseconds).reduce((a, b) => a + b) / _frameDurations.length;
    final fps = 1000 / avgFrameTime;
    
    return {
      'averageFrameTimeMs': avgFrameTime.toStringAsFixed(2),
      'fps': fps.toStringAsFixed(1),
      'sampleCount': _frameDurations.length,
      'isHealthy': fps >= 55,
    };
  }
  
  /// 检测主线程卡顿
  static void detectMainThreadJank(VoidCallback heavyTask) {
    final startTime = DateTime.now();
    heavyTask();
    final duration = DateTime.now().difference(startTime);
    
    if (duration.inMilliseconds > 16) { // 60fps threshold
      if (kDebugMode) {
        debugPrint('⚠️ Main thread jank detected: ${duration.inMilliseconds}ms');
      }
    }
  }
  
  /// 在后台线程执行耗时任务
  static Future<T> runInBackground<T>(Future<T> Function() task) async {
    return await compute(_backgroundTaskWrapper, task);
  }
  
  /// 后台任务包装器
  static Future<T> _backgroundTaskWrapper<T>(Future<T> Function() task) async {
    return await task();
  }
}

/// 性能监控包装器
class PerformanceMonitor extends StatefulWidget {
  final Widget child;
  final String name;
  final VoidCallback? onBuild;
  
  const PerformanceMonitor({
    Key? key,
    required this.child,
    required this.name,
    this.onBuild,
  }) : super(key: key);
  
  @override
  State<PerformanceMonitor> createState() => _PerformanceMonitorState();
}

class _PerformanceMonitorState extends State<PerformanceMonitor> {
  @override
  void initState() {
    super.initState();
    if (kDebugMode) {
      debugPrint('PerformanceMonitor: ${widget.name} initialized');
    }
  }
  
  @override
  Widget build(BuildContext context) {
    final startTime = DateTime.now();
    
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final endTime = DateTime.now();
      final duration = endTime.difference(startTime);
      if (kDebugMode && duration.inMilliseconds > 16) { // 60fps threshold
        debugPrint('PerformanceMonitor: ${widget.name} build took ${duration.inMilliseconds}ms');
      }
      widget.onBuild?.call();
    });
    
    return widget.child;
  }
}

/// 优化的图片缓存
class OptimizedImageCache {
  static const int _maxSize = 100;
  static const int _maxSizeBytes = 50 * 1024 * 1024; // 50MB
  
  static void initialize() {
    PaintingBinding.instance.imageCache.maximumSize = _maxSize;
    PaintingBinding.instance.imageCache.maximumSizeBytes = _maxSizeBytes;
  }
  
  static void clear() {
    PaintingBinding.instance.imageCache.clear();
    PaintingBinding.instance.imageCache.clearLiveImages();
  }
  
  static Map<String, dynamic> getStats() {
    return {
      'currentSize': PaintingBinding.instance.imageCache.currentSize,
      'currentSizeBytes': PaintingBinding.instance.imageCache.currentSizeBytes,
      'maximumSize': PaintingBinding.instance.imageCache.maximumSize,
      'maximumSizeBytes': PaintingBinding.instance.imageCache.maximumSizeBytes,
    };
  }
}

/// 节流函数
class Throttler {
  DateTime? _lastTime;
  final Duration interval;
  
  Throttler({this.interval = const Duration(milliseconds: 100)});
  
  bool call(VoidCallback action) {
    final now = DateTime.now();
    if (_lastTime == null || now.difference(_lastTime!) >= interval) {
      _lastTime = now;
      action();
      return true;
    }
    return false;
  }
}

/// 防抖函数
class Debouncer {
  Timer? _timer;
  final Duration delay;
  
  Debouncer({this.delay = const Duration(milliseconds: 300)});
  
  void call(VoidCallback action) {
    _timer?.cancel();
    _timer = Timer(delay, action);
  }
  
  void dispose() {
    _timer?.cancel();
  }
}
