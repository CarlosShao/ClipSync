import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'cache_service.dart';
import 'pending_upload_queue.dart';

/// 登出 / 换账号 / 凭据失效的本地数据清理收敛点（P0-B S0-1）。
///
/// 所有登出路径（设置页主动登出、会话吊销、管理台远程下线、冷启动凭据失效）
/// 都必须经 [purgeAll]，否则上个用户的离线队列 / 缓存会串进下个用户的账号。
///
/// 分两层：
/// - 内置核心清理（本类直接执行，不依赖 main() 注册，冷启动早期也可用）：
///   离线上传队列、磁盘/内存缓存、本地错误报告（含 userId）；
/// - 注册任务（main() 注册，需要 Provider / 单例引用的内存态与原生侧清理）：
///   列表 Provider、设备列表、WS 断开、功能开关快照、采集去重环、通知、
///   原生 clipsync_sync_config（含 JWT 明文）。
class SessionCleanup {
  SessionCleanup._();

  /// 错误报告持久化键（含 userId 与堆栈，属用户数据，随登出清理）
  static const String _errorReportsPrefKey = 'pending_error_reports';

  static final List<FutureOr<void> Function()> _tasks = [];

  /// main() 注册内存态清理任务（重复注册会整体替换，热重启安全）
  static void registerAll(List<FutureOr<void> Function()> tasks) {
    _tasks
      ..clear()
      ..addAll(tasks);
  }

  /// 用户登录后调用（登录收尾 / 冷启动恢复）：把离线队列与缓存切入该
  /// userId 的命名空间。命名空间是防御性隔离——即使某次清理遗漏，
  /// 下个用户也只会读到自己的键，不会重放上个用户的数据。
  static Future<void> onUserSignedIn(String? userId) async {
    await PendingUploadQueue.instance.bindUser(userId);
    CacheService.instance.setUserScope(userId);
  }

  /// 全量清理当前用户的本地数据。单项失败只记日志，不阻断其余清理。
  static Future<void> purgeAll() async {
    try {
      await PendingUploadQueue.instance.clear();
    } catch (e) {
      debugPrint('[SessionCleanup] clear upload queue failed: $e');
    }
    try {
      await CacheService.instance.clear();
      CacheService.instance.setUserScope(null);
    } catch (e) {
      debugPrint('[SessionCleanup] clear cache failed: $e');
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_errorReportsPrefKey);
    } catch (e) {
      debugPrint('[SessionCleanup] clear error reports failed: $e');
    }
    for (final task in _tasks) {
      try {
        await task();
      } catch (e) {
        debugPrint('[SessionCleanup] registered task failed: $e');
      }
    }
  }
}
