import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_service.dart';

/// Offline queue item
class OfflineAction {
  final String id;
  final String action; // 'create', 'update', 'delete'
  final Map<String, dynamic> data;
  final DateTime clientTimestamp;
  bool synced;

  OfflineAction({
    required this.id,
    required this.action,
    required this.data,
    required this.clientTimestamp,
    this.synced = false,
  });

  Map<String, dynamic> toMap() => {
    'id': id,
    'action': action,
    'data': data,
    'clientTimestamp': clientTimestamp.toIso8601String(),
    'synced': synced,
  };

  factory OfflineAction.fromMap(Map<String, dynamic> map) => OfflineAction(
    id: map['id'],
    action: map['action'],
    data: map['data'],
    clientTimestamp: DateTime.parse(map['clientTimestamp']),
    synced: map['synced'] ?? false,
  );
}

/// Manages offline operations queue and sync
class OfflineService {
  static const String _queueKey = 'offline_queue';
  static const String _lastSyncKey = 'last_sync_timestamp';
  static const int _maxQueueSize = 200;

  final ApiService _api;
  List<OfflineAction> _queue = [];
  bool _isSyncing = false;

  OfflineService(this._api);

  List<OfflineAction> get pendingActions => _queue.where((a) => !a.synced).toList();
  bool get isSyncing => _isSyncing;
  bool get hasPendingActions => pendingActions.isNotEmpty;

  /// Load queue from local storage
  Future<void> loadQueue() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final json = prefs.getString(_queueKey);
      if (json != null) {
        final List<dynamic> list = jsonDecode(json);
        _queue = list.map((e) => OfflineAction.fromMap(e)).toList();
      }
    } catch (e) {
      _queue = [];
    }
  }

  /// Save queue to local storage
  Future<void> _saveQueue() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final json = jsonEncode(_queue.map((a) => a.toMap()).toList());
      await prefs.setString(_queueKey, json);
    } catch (e) {
      // Ignore save errors
    }
  }

  /// Add action to offline queue
  Future<void> addAction(String action, Map<String, dynamic> data) async {
    final item = OfflineAction(
      id: '${DateTime.now().millisecondsSinceEpoch}_${_queue.length}',
      action: action,
      data: data,
      clientTimestamp: DateTime.now(),
    );

    _queue.add(item);

    // Trim queue if too large
    if (_queue.length > _maxQueueSize) {
      final syncedItems = _queue.where((a) => a.synced).toList();
      if (syncedItems.length > 50) {
        _queue.removeWhere((a) => a.synced);
      }
    }

    await _saveQueue();
  }

  /// Sync offline queue to server
  Future<int> syncQueue(String token, String deviceId) async {
    if (_isSyncing) return 0;
    if (!hasPendingActions) return 0;

    _isSyncing = true;
    int syncedCount = 0;

    try {
      final pending = pendingActions;
      final batchSize = 50;

      for (var i = 0; i < pending.length; i += batchSize) {
        final batch = pending.sublist(
          i,
          i + batchSize > pending.length ? pending.length : i + batchSize,
        );

        final changes = batch.map((a) => {
          'clientId': a.id,
          'action': a.action,
          'data': a.data,
          'clientTimestamp': a.clientTimestamp.toIso8601String(),
        }).toList();

        final result = await _api.syncPush(token, deviceId, changes);

        if (result != null && result['results'] != null) {
          for (var r in result['results']) {
            final clientId = r['clientId'];
            if (r['status'] == 'ok') {
              final item = _queue.firstWhere(
                (a) => a.id == clientId,
                orElse: () => OfflineAction(id: '', action: '', data: {}, clientTimestamp: DateTime.now()),
              );
              if (item.id.isNotEmpty) {
                item.synced = true;
                syncedCount++;
              }
            }
          }
        }
      }

      // Remove fully synced items older than 1 hour
      final now = DateTime.now();
      _queue.removeWhere((a) =>
        a.synced && now.difference(a.clientTimestamp).inHours > 1
      );

      await _saveQueue();
      await _saveLastSyncTime();
    } catch (e) {
      // Sync failed, will retry later
    } finally {
      _isSyncing = false;
    }

    return syncedCount;
  }

  /// Get last sync timestamp
  Future<DateTime?> getLastSyncTime() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final ts = prefs.getString(_lastSyncKey);
      if (ts != null) return DateTime.parse(ts);
    } catch (e) {}
    return null;
  }

  Future<void> _saveLastSyncTime() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_lastSyncKey, DateTime.now().toIso8601String());
    } catch (e) {}
  }

  /// Clear all queued items
  Future<void> clearQueue() async {
    _queue.clear();
    await _saveQueue();
  }
}
