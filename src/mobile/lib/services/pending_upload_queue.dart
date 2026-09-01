import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 重放上传器签名：按原上传链路重传一条队列条目。
/// 返回 true 表示成功（含服务端幂等/去重命中），false 表示仍失败（保留队列）。
typedef PendingUploadUploader = Future<bool> Function(PendingUploadEntry entry);

/// 离线待上传条目（B2 持久化 schema）。
///
/// JSON 形态（SharedPreferences 数组元素）：
/// ```json
/// {
///   "idempotencyKey": "mobile-1735689600000-123456789-987654321",
///   "contentType": "text",   // text | image | file
///   "text": "…",             // text 类必填
///   "filePath": "/data/…",   // image/file 类必填（本地绝对路径）
///   "createdAt": 1735689600000,
///   "attempts": 3
/// }
/// ```
class PendingUploadEntry {
  const PendingUploadEntry({
    required this.idempotencyKey,
    required this.contentType,
    this.text,
    this.filePath,
    required this.createdAt,
    this.attempts = 0,
  });

  /// 入队时生成、贯穿重试与重放的幂等键（服务端按 Idempotency-Key 幂等）
  final String idempotencyKey;

  /// 'text' | 'image' | 'file'
  final String contentType;

  /// text 类：完整文本内容
  final String? text;

  /// image/file 类：本地文件绝对路径
  final String? filePath;

  /// 入队时间戳（毫秒）
  final int createdAt;

  /// 重放失败次数（初值为采集期已耗尽的尝试次数）；>= [PendingUploadQueue.maxAttempts] 视为跳过
  final int attempts;

  bool get isMedia => contentType == 'image' || contentType == 'file';

  /// 重试次数已达上限：保留在队列但重放时跳过（防无限循环）
  bool get isSkipped => attempts >= PendingUploadQueue.maxAttempts;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'idempotencyKey': idempotencyKey,
        'contentType': contentType,
        if (text != null) 'text': text,
        if (filePath != null) 'filePath': filePath,
        'createdAt': createdAt,
        'attempts': attempts,
      };

  /// 解析失败（字段缺失/类型不符）返回 null，由调用方丢弃脏数据。
  static PendingUploadEntry? fromJson(Map<String, dynamic> json) {
    final key = json['idempotencyKey'];
    final type = json['contentType'];
    if (key is! String || key.isEmpty || type is! String) return null;
    final text = json['text'] is String ? json['text'] as String : null;
    final filePath =
        json['filePath'] is String ? json['filePath'] as String : null;
    if (type == 'text' && (text == null || text.isEmpty)) return null;
    if ((type == 'image' || type == 'file') &&
        (filePath == null || filePath.isEmpty)) {
      return null;
    }
    return PendingUploadEntry(
      idempotencyKey: key,
      contentType: type,
      text: text,
      filePath: filePath,
      createdAt: json['createdAt'] is int
          ? json['createdAt'] as int
          : DateTime.now().millisecondsSinceEpoch,
      attempts: json['attempts'] is int ? json['attempts'] as int : 0,
    );
  }

  PendingUploadEntry copyWith({int? attempts}) => PendingUploadEntry(
        idempotencyKey: idempotencyKey,
        contentType: contentType,
        text: text,
        filePath: filePath,
        createdAt: createdAt,
        attempts: attempts ?? this.attempts,
      );
}

/// 剪贴板采集离线持久化队列（B2）。
///
/// - 存储：SharedPreferences JSON 数组（项目无 sqflite 依赖，选最简方案）；
///   首次访问惰性加载，重启 App 后队列仍在
/// - 容量：上限 [_maxEntries]（200）条，超出丢最旧并 log
/// - 去重：同内容（text 文本相等 / 媒体路径相等）已积压则跳过入队
/// - 重放：[replayPending] 由 SyncService（网络恢复 / 启动在线）与
///   ClipboardCaptureService（失败冷却结束后再次采集）触发；
///   重入保护 + 逐条串行；成功即出队，失败 attempts+1（指数退避由下次
///   触发事件自然形成，不做内嵌 timer 轰炸）；
///   attempts >= [maxAttempts] 的条目保留在队列但标记跳过
class PendingUploadQueue {
  PendingUploadQueue._();

  static final PendingUploadQueue instance = PendingUploadQueue._();

  static const String _storageKey = 'pending_upload_queue_v1';

  /// 队列容量上限，超出丢最旧
  static const int _maxEntries = 200;

  /// 重放失败次数上限：达到后条目保留在队列但跳过重放（防无限循环）
  static const int maxAttempts = 10;

  /// 上传器：由 SyncService.attach 绑定
  /// （文本走采集管线、图片/文件走 ApiService 既有 multipart 链路）
  PendingUploadUploader? _uploader;

  /// 队列读写互斥链（加载/增删/持久化串行化，避免并发写互相覆盖）
  Future<void> _mutex = Future<void>.value();

  List<PendingUploadEntry> _entries = <PendingUploadEntry>[];
  bool _loaded = false;

  /// 重放重入保护标志
  bool _replaying = false;

  void bindUploader(PendingUploadUploader uploader) {
    _uploader = uploader;
  }

  /// 是否存在待重放条目（跳过条目不计）
  Future<bool> hasPending() {
    return _run(() async {
      await _ensureLoaded();
      return _entries.any((e) => !e.isSkipped);
    });
  }

  /// 入队（上传最终失败后调用）。
  ///
  /// - 同内容已积压（text 文本相等 / 媒体路径相等）则跳过，避免重放重复入库
  /// - 超容量（[_maxEntries]）丢最旧并 log
  Future<void> enqueue({
    required String idempotencyKey,
    required String contentType,
    String? text,
    String? filePath,
    int initialAttempts = 0,
  }) {
    return _run(() async {
      await _ensureLoaded();
      final duplicated = _entries.any((e) {
        if (e.isSkipped || e.contentType != contentType) return false;
        if (contentType == 'text') return e.text == text;
        return e.isMedia && e.filePath == filePath;
      });
      if (duplicated) {
        debugPrint(
            '[PendingUploadQueue] enqueue skipped: same content already queued');
        return;
      }
      final entry = PendingUploadEntry(
        idempotencyKey: idempotencyKey,
        contentType: contentType,
        text: text,
        filePath: filePath,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        attempts: initialAttempts,
      );
      _entries = List<PendingUploadEntry>.of(_entries)..add(entry);
      while (_entries.length > _maxEntries) {
        final dropped = _entries.removeAt(0);
        debugPrint('[PendingUploadQueue] queue full (>$_maxEntries), '
            'dropped oldest ${dropped.contentType} '
            '(${DateTime.fromMillisecondsSinceEpoch(dropped.createdAt)})');
      }
      await _persist();
      debugPrint('[PendingUploadQueue] enqueued ${entry.contentType} '
          '(queue=${_entries.length})');
    });
  }

  /// 在线采集上传成功后调用：清除队列中同文本积压，
  /// 防止「积压条目 + 用户稍后再次复制且上传成功」时重放造成重复入库。
  Future<void> removeMatchingText(String text) {
    return _run(() async {
      await _ensureLoaded();
      if (_entries.isEmpty) return;
      final before = _entries.length;
      _entries = _entries
          .where((e) => !(e.contentType == 'text' && e.text == text))
          .toList();
      if (_entries.length != before) {
        await _persist();
        debugPrint('[PendingUploadQueue] removed ${before - _entries.length} '
            'queued entry(ies) matching live-uploaded text');
      }
    });
  }

  /// 重放队列：逐条按原上传链路重传。返回本次成功上传条数。
  ///
  /// - 重入保护：重放期间再次调用直接返回 0
  /// - 媒体条目本地文件已不存在（临时目录被系统清理，属预期）→ 丢弃该条并 log
  /// - 成功 → 出队（幂等键复用入队值，服务端幂等保证不产生重复条目）
  /// - 失败 → attempts+1 保留；达到 [maxAttempts] → 保留队列但跳过并 log
  Future<int> replayPending() async {
    // 检查与置位间无 await，单线程事件循环下无并发窗口
    if (_replaying) {
      debugPrint('[PendingUploadQueue] replay skipped: already replaying');
      return 0;
    }
    _replaying = true;
    try {
      final uploader = _uploader;
      if (uploader == null) {
        debugPrint('[PendingUploadQueue] replay skipped: uploader not bound');
        return 0;
      }
      final pending = await _run(() async {
        await _ensureLoaded();
        return _entries.where((e) => !e.isSkipped).toList(growable: false);
      });
      if (pending.isEmpty) return 0;

      var successCount = 0;
      for (final entry in pending) {
        if (entry.isMedia) {
          final path = entry.filePath!;
          if (!File(path).existsSync()) {
            debugPrint('[PendingUploadQueue] drop ${entry.contentType} entry '
                '(file missing): $path');
            await _run(() => _removeLocked(entry.idempotencyKey));
            continue;
          }
        }
        bool ok;
        try {
          ok = await uploader(entry);
        } catch (e) {
          debugPrint('[PendingUploadQueue] replay upload threw: $e');
          ok = false;
        }
        if (ok) {
          final removed = await _run(() => _removeLocked(entry.idempotencyKey));
          if (removed) successCount++;
        } else {
          final skippedNow =
              await _run(() => _recordFailureLocked(entry.idempotencyKey));
          if (skippedNow) {
            debugPrint('[PendingUploadQueue] entry skipped after '
                '$maxAttempts failures: ${entry.idempotencyKey}');
          }
        }
      }
      debugPrint('[PendingUploadQueue] replay finished: '
          '$successCount/${pending.length} uploaded');
      return successCount;
    } finally {
      _replaying = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：互斥链 + 持久化
  // ---------------------------------------------------------------------------

  Future<T> _run<T>(Future<T> Function() action) {
    final result = _mutex.then((_) => action());
    _mutex = result.then<void>((_) {}, onError: (_) {});
    return result;
  }

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_storageKey);
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          _entries = decoded
              .whereType<Map<String, dynamic>>()
              .map(PendingUploadEntry.fromJson)
              .whereType<PendingUploadEntry>()
              .toList(growable: false);
        }
      }
    } catch (e) {
      debugPrint('[PendingUploadQueue] load failed (start empty): $e');
      _entries = <PendingUploadEntry>[];
    }
    _loaded = true;
  }

  Future<void> _persist() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
          _storageKey, jsonEncode(_entries.map((e) => e.toJson()).toList()));
    } catch (e) {
      debugPrint('[PendingUploadQueue] persist failed: $e');
    }
  }

  /// 调用方须已持互斥（在 [_run] 内）。返回是否实际删除。
  Future<bool> _removeLocked(String idempotencyKey) async {
    await _ensureLoaded();
    final before = _entries.length;
    _entries = _entries
        .where((e) => e.idempotencyKey != idempotencyKey)
        .toList();
    if (_entries.length == before) return false;
    await _persist();
    return true;
  }

  /// 调用方须已持互斥（在 [_run] 内）。返回是否刚达到跳过阈值。
  Future<bool> _recordFailureLocked(String idempotencyKey) async {
    await _ensureLoaded();
    final index = _entries.indexWhere((e) => e.idempotencyKey == idempotencyKey);
    if (index < 0) return false;
    final updated = _entries[index].copyWith(attempts: _entries[index].attempts + 1);
    _entries = List<PendingUploadEntry>.of(_entries)..[index] = updated;
    await _persist();
    return updated.isSkipped;
  }
}
