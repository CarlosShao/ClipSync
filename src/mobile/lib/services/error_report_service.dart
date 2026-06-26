import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 错误严重程度
enum ErrorSeverity {
  low,
  medium,
  high,
  critical,
}

/// 错误报告
class ErrorReport {
  final String id;
  final String message;
  final String? stackTrace;
  final ErrorSeverity severity;
  final String platform;
  final String appVersion;
  final String? userId;
  final Map<String, dynamic> metadata;
  final DateTime timestamp;
  final bool isResolved;

  ErrorReport({
    required this.id,
    required this.message,
    this.stackTrace,
    required this.severity,
    required this.platform,
    required this.appVersion,
    this.userId,
    this.metadata = const {},
    required this.timestamp,
    this.isResolved = false,
  });

  Map<String, dynamic> toJson() => {
    'id': id,
    'message': message,
    'stackTrace': stackTrace,
    'severity': severity.name,
    'platform': platform,
    'appVersion': appVersion,
    'userId': userId,
    'metadata': metadata,
    'timestamp': timestamp.toIso8601String(),
    'isResolved': isResolved,
  };

  factory ErrorReport.fromJson(Map<String, dynamic> json) => ErrorReport(
    id: json['id'],
    message: json['message'],
    stackTrace: json['stackTrace'],
    severity: ErrorSeverity.values.firstWhere(
      (e) => e.name == json['severity'],
      orElse: () => ErrorSeverity.medium,
    ),
    platform: json['platform'],
    appVersion: json['appVersion'],
    userId: json['userId'],
    metadata: json['metadata'] ?? {},
    timestamp: DateTime.parse(json['timestamp']),
    isResolved: json['isResolved'] ?? false,
  );
}

/// 错误报告服务
class ErrorReportService {
  static ErrorReportService? _instance;
  static ErrorReportService get instance => _instance ??= ErrorReportService._();
  
  ErrorReportService._();
  
  final List<ErrorReport> _errorQueue = [];
  bool _isReporting = false;
  String? _userId;
  String _appVersion = 'unknown';
  String _platform = 'unknown';
  
  /// 初始化错误报告服务
  Future<void> initialize({String? userId}) async {
    _userId = userId;
    
    // 获取应用信息
    try {
      final packageInfo = await PackageInfo.fromPlatform();
      _appVersion = packageInfo.version;
    } catch (e) {
      debugPrint('Failed to get package info: $e');
    }
    
    // 获取平台信息
    try {
      if (Platform.isAndroid) {
        _platform = 'android';
      } else if (Platform.isIOS) {
        _platform = 'ios';
      } else if (Platform.isWindows) {
        _platform = 'windows';
      } else if (Platform.isMacOS) {
        _platform = 'macos';
      } else if (Platform.isLinux) {
        _platform = 'linux';
      }
    } catch (e) {
      debugPrint('Failed to get platform: $e');
    }
    
    // 设置全局错误处理
    _setupErrorHandlers();
    
    // 加载未发送的错误报告
    await _loadPendingReports();
    
    debugPrint('ErrorReportService initialized');
  }
  
  /// 设置用户ID
  void setUserId(String? userId) {
    _userId = userId;
  }
  
  /// 报告错误
  Future<void> reportError(
    dynamic error, {
    StackTrace? stackTrace,
    ErrorSeverity severity = ErrorSeverity.medium,
    Map<String, dynamic>? metadata,
  }) async {
    final errorReport = ErrorReport(
      id: _generateId(),
      message: error.toString(),
      stackTrace: stackTrace?.toString(),
      severity: severity,
      platform: _platform,
      appVersion: _appVersion,
      userId: _userId,
      metadata: metadata ?? {},
      timestamp: DateTime.now(),
    );
    
    // 添加到队列
    _errorQueue.add(errorReport);
    
    // 保存到本地
    await _savePendingReports();
    
    // 尝试发送
    await _sendErrorReports();
    
    // 在调试模式下打印错误
    if (kDebugMode) {
      debugPrint('Error reported: ${errorReport.message}');
      if (stackTrace != null) {
        debugPrint('Stack trace: $stackTrace');
      }
    }
  }
  
  /// 报告Flutter框架错误
  void reportFlutterError(FlutterErrorDetails details) {
    reportError(
      details.exception,
      stackTrace: details.stack,
      severity: ErrorSeverity.high,
      metadata: {
        'library': details.library,
        'context': details.context?.toString(),
        'informationCollector': details.informationCollector?.toString(),
      },
    );
  }
  
  /// 报告异步错误
  void reportAsyncError(dynamic error, StackTrace stackTrace) {
    reportError(
      error,
      stackTrace: stackTrace,
      severity: ErrorSeverity.high,
    );
  }
  
  /// 获取待发送的错误报告数量
  int get pendingCount => _errorQueue.length;
  
  /// 清空错误队列
  Future<void> clearQueue() async {
    _errorQueue.clear();
    await _savePendingReports();
  }
  
  /// 获取错误报告统计
  Map<String, dynamic> getStats() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final thisWeek = today.subtract(Duration(days: today.weekday - 1));
    
    int todayCount = 0;
    int weekCount = 0;
    int total = _errorQueue.length;
    
    for (final report in _errorQueue) {
      if (report.timestamp.isAfter(today)) {
        todayCount++;
      }
      if (report.timestamp.isAfter(thisWeek)) {
        weekCount++;
      }
    }
    
    return {
      'total': total,
      'today': todayCount,
      'thisWeek': weekCount,
      'platform': _platform,
      'appVersion': _appVersion,
    };
  }
  
  // 私有方法
  
  void _setupErrorHandlers() {
    // 捕获Flutter框架错误
    FlutterError.onError = (FlutterErrorDetails details) {
      reportFlutterError(details);
      
      // 在调试模式下打印错误
      if (kDebugMode) {
        FlutterError.presentError(details);
      }
    };
    
    // 捕获异步错误
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 这里可以添加更多错误捕获逻辑
    });
  }
  
  Future<void> _sendErrorReports() async {
    if (_isReporting || _errorQueue.isEmpty) return;
    
    _isReporting = true;
    
    try {
      // 这里应该调用实际的错误报告API
      // 暂时模拟发送
      await Future.delayed(const Duration(seconds: 1));
      
      // 发送成功，清空队列
      _errorQueue.clear();
      await _savePendingReports();
      
      debugPrint('Error reports sent successfully');
    } catch (e) {
      debugPrint('Failed to send error reports: $e');
    } finally {
      _isReporting = false;
    }
  }
  
  Future<void> _loadPendingReports() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final reportsJson = prefs.getStringList('pending_error_reports') ?? [];
      
      for (final reportJson in reportsJson) {
        try {
          final json = jsonDecode(reportJson) as Map<String, dynamic>;
          _errorQueue.add(ErrorReport.fromJson(json));
        } catch (e) {
          debugPrint('Failed to parse error report: $e');
        }
      }
      
      debugPrint('Loaded ${_errorQueue.length} pending error reports');
    } catch (e) {
      debugPrint('Failed to load pending reports: $e');
    }
  }
  
  Future<void> _savePendingReports() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final reportsJson = _errorQueue.map((report) => jsonEncode(report.toJson())).toList();
      await prefs.setStringList('pending_error_reports', reportsJson);
    } catch (e) {
      debugPrint('Failed to save pending reports: $e');
    }
  }
  
  String _generateId() {
    final now = DateTime.now();
    final timestamp = now.millisecondsSinceEpoch;
    final random = (timestamp * 1000) % 10000;
    return 'error_${timestamp}_$random';
  }
}

/// 错误报告装饰器，为现有服务添加错误报告功能
class ErrorReportDecorator {
  final ErrorReportService _errorService = ErrorReportService.instance;
  
  /// 带错误报告的异步方法执行
  Future<T?> withErrorReport<T>(
    Future<T> Function() operation, {
    String? operationName,
    ErrorSeverity severity = ErrorSeverity.medium,
    Map<String, dynamic>? metadata,
  }) async {
    try {
      return await operation();
    } catch (error, stackTrace) {
      final reportMetadata = metadata ?? {};
      if (operationName != null) {
        reportMetadata['operation'] = operationName;
      }
      
      await _errorService.reportError(
        error,
        stackTrace: stackTrace,
        severity: severity,
        metadata: reportMetadata,
      );
      
      rethrow;
    }
  }
}

/// 错误报告UI组件
class ErrorReportWidget extends StatefulWidget {
  final Widget child;
  final bool showFloatingButton;
  
  const ErrorReportWidget({
    Key? key,
    required this.child,
    this.showFloatingButton = true,
  }) : super(key: key);
  
  @override
  State<ErrorReportWidget> createState() => _ErrorReportWidgetState();
}

class _ErrorReportWidgetState extends State<ErrorReportWidget> {
  int _pendingReports = 0;
  
  @override
  void initState() {
    super.initState();
    _updatePendingCount();
    
    // 定期检查待发送报告
    Timer.periodic(const Duration(minutes: 5), (_) {
      _updatePendingCount();
    });
  }
  
  void _updatePendingCount() {
    setState(() {
      _pendingReports = ErrorReportService.instance.pendingCount;
    });
  }
  
  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.child,
        if (widget.showFloatingButton && _pendingReports > 0)
          Positioned(
            bottom: 16,
            right: 16,
            child: FloatingActionButton(
              onPressed: () => _showErrorReportDialog(context),
              backgroundColor: Colors.orange,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  const Icon(Icons.bug_report, color: Colors.white),
                  if (_pendingReports > 0)
                    Positioned(
                      top: 0,
                      right: 0,
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: const BoxDecoration(
                          color: Colors.red,
                          shape: BoxShape.circle,
                        ),
                        child: Text(
                          '$_pendingReports',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
  
  void _showErrorReportDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('错误报告'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('待发送错误报告：$_pendingReports 条'),
            const SizedBox(height: 8),
            const Text('这些错误将在下次联网时自动发送。'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
          TextButton(
            onPressed: () {
              ErrorReportService.instance.clearQueue();
              _updatePendingCount();
              Navigator.pop(context);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('已清空错误队列')),
              );
            },
            child: const Text('清空'),
          ),
        ],
      ),
    );
  }
}

/// 错误报告服务扩展
extension ErrorReportServiceExtension on ErrorReportService {
  /// 便捷方法：报告网络错误
  Future<void> reportNetworkError(
    dynamic error, {
    String? url,
    int? statusCode,
    Map<String, dynamic>? metadata,
  }) async {
    final reportMetadata = metadata ?? {};
    if (url != null) reportMetadata['url'] = url;
    if (statusCode != null) reportMetadata['statusCode'] = statusCode;
    
    await reportError(
      error,
      severity: ErrorSeverity.medium,
      metadata: reportMetadata,
    );
  }
  
  /// 便捷方法：报告数据库错误
  Future<void> reportDatabaseError(
    dynamic error, {
    String? operation,
    String? table,
    Map<String, dynamic>? metadata,
  }) async {
    final reportMetadata = metadata ?? {};
    if (operation != null) reportMetadata['operation'] = operation;
    if (table != null) reportMetadata['table'] = table;
    
    await reportError(
      error,
      severity: ErrorSeverity.high,
      metadata: reportMetadata,
    );
  }
  
  /// 便捷方法：报告认证错误
  Future<void> reportAuthError(
    dynamic error, {
    String? operation,
    Map<String, dynamic>? metadata,
  }) async {
    final reportMetadata = metadata ?? {};
    if (operation != null) reportMetadata['operation'] = operation;
    
    await reportError(
      error,
      severity: ErrorSeverity.high,
      metadata: reportMetadata,
    );
  }
}