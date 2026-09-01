import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../l10n/app_localizations.dart';

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
    id: json['id'] as String? ?? '',
    message: json['message'] as String? ?? '',
    stackTrace: json['stackTrace'] as String?,
    severity: ErrorSeverity.values.firstWhere(
      (e) => e.name == json['severity'],
      orElse: () => ErrorSeverity.medium,
    ),
    platform: json['platform'] as String? ?? 'unknown',
    appVersion: json['appVersion'] as String? ?? 'unknown',
    userId: json['userId'] as String?,
    metadata: json['metadata'] is Map<String, dynamic>
        ? json['metadata'] as Map<String, dynamic>
        : <String, dynamic>{},
    timestamp: DateTime.tryParse(json['timestamp'] as String? ?? '') ??
        DateTime.fromMillisecondsSinceEpoch(0),
    isResolved: json['isResolved'] as bool? ?? false,
  );
}

/// 错误报告服务。
///
/// 保留语义（与桌面端 src/desktop/src/utils/errorReport.ts 对齐）：
/// 捕获的错误仅在本地滚动保留最近 [_maxStoredReports] 条（超出丢弃最旧），
/// 并持久化到 SharedPreferences，重启后仍可查看。
/// 后端当前没有错误上报端点，因此不会向服务器发送任何错误数据；
/// 用户可在错误报告对话框中查看、导出（分享 JSON 文件）或清空这些本地记录。
class ErrorReportService {
  static ErrorReportService? _instance;
  static ErrorReportService get instance => _instance ??= ErrorReportService._();

  ErrorReportService._();

  /// 本地保留的错误报告上限（超出丢弃最旧）。
  static const int _maxStoredReports = 20;

  final List<ErrorReport> _errorQueue = [];
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
    
    // 加载本地保留的错误报告
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
    
    // 添加到队列（本地滚动保留，超出丢弃最旧；不做任何网络发送）
    _errorQueue.add(errorReport);
    _trimQueue();

    // 保存到本地
    await _savePendingReports();
    
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
  
  /// 获取本地保留的错误报告数量
  int get pendingCount => _errorQueue.length;

  /// 获取本地保留的错误报告只读快照（旧 → 新）
  List<ErrorReport> get recentReports => List.unmodifiable(_errorQueue);
  
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

    // 捕获未被Flutter框架处理的异步错误（记录到本地队列）
    PlatformDispatcher.instance.onError = (error, stackTrace) {
      reportAsyncError(error, stackTrace);
      return true;
    };
  }
  
  /// 将队列裁剪到 [_maxStoredReports] 条以内（丢弃最旧）。
  void _trimQueue() {
    if (_errorQueue.length > _maxStoredReports) {
      _errorQueue.removeRange(0, _errorQueue.length - _maxStoredReports);
    }
  }

  /// 将本地错误报告导出为 JSON 文件（写入临时目录），返回文件路径。
  /// 队列为空或写入失败时返回 null。仅操作本地数据，不涉及网络上传。
  Future<String?> exportToFile() async {
    if (_errorQueue.isEmpty) return null;

    try {
      final tempDir = await getTemporaryDirectory();
      final timestamp = DateTime.now().millisecondsSinceEpoch;
      final file = File(
        '${tempDir.path}${Platform.pathSeparator}clipsync-errors-$timestamp.json',
      );
      const encoder = JsonEncoder.withIndent('  ');
      await file.writeAsString(
        encoder.convert(_errorQueue.map((report) => report.toJson()).toList()),
      );
      return file.path;
    } catch (e) {
      debugPrint('Failed to export error reports: $e');
      return null;
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

      // 历史数据可能超出上限，裁剪后回写
      _trimQueue();
      await _savePendingReports();

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
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _updatePendingCount();

    // 定期刷新本地保留的报告计数
    _refreshTimer = Timer.periodic(const Duration(minutes: 5), (_) {
      _updatePendingCount();
    });
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  void _updatePendingCount() {
    if (!mounted) return;
    final count = ErrorReportService.instance.pendingCount;
    if (count == _pendingReports) return;
    setState(() {
      _pendingReports = count;
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
  
  /// 导出本地错误报告为 JSON 文件并通过系统分享面板分享。
  /// 文案兜底说明：分享图标即「导出」入口（本工单禁止改 arb，暂无导出文案 key）。
  Future<void> _exportReports() async {
    try {
      final path = await ErrorReportService.instance.exportToFile();
      if (path == null) return;
      await Share.shareXFiles([XFile(path)]);
    } catch (e) {
      debugPrint('Failed to share error reports: $e');
    }
  }

  void _showErrorReportDialog(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    // 最新记录排在最前（打开对话框时的快照）
    final reports = ErrorReportService.instance.recentReports.reversed.toList();

    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.bug_report, size: 22),
            const SizedBox(width: 8),
            Text(l10n.errorReportTitle),
          ],
        ),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 320),
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: reports.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final report = reports[index];
                      return ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          Icons.circle,
                          size: 10,
                          color: _severityColor(report.severity),
                        ),
                        title: Text(
                          report.message,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13),
                        ),
                        subtitle: Text(
                          _formatTimestamp(report.timestamp),
                          style: const TextStyle(fontSize: 11),
                        ),
                      );
                    },
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                l10n.errorLocalOnlyDesc,
                style: TextStyle(fontSize: 11, color: Theme.of(context).hintColor),
              ),
            ],
          ),
        ),
        actions: [
          IconButton(
            onPressed: _exportReports,
            tooltip: l10n.exportErrorLogs,
            icon: const Icon(Icons.share),
          ),
          TextButton(
            onPressed: () {
              ErrorReportService.instance.clearQueue();
              _updatePendingCount();
              Navigator.pop(dialogContext);
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(l10n.errorQueueCleared)),
              );
            },
            child: Text(l10n.clearAll),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(l10n.close),
          ),
        ],
      ),
    );
  }

  Color _severityColor(ErrorSeverity severity) {
    switch (severity) {
      case ErrorSeverity.low:
        return Colors.grey;
      case ErrorSeverity.medium:
        return Colors.orange;
      case ErrorSeverity.high:
        return Colors.deepOrange;
      case ErrorSeverity.critical:
        return Colors.red;
    }
  }

  String _formatTimestamp(DateTime timestamp) {
    final local = timestamp.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)}';
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