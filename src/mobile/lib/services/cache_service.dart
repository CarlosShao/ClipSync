import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 缓存策略枚举
enum CacheStrategy {
  /// 仅内存缓存
  memoryOnly,
  
  /// 仅磁盘缓存
  diskOnly,
  
  /// 内存 + 磁盘缓存
  memoryAndDisk,
  
  /// 不缓存
  noCache,
}

/// 缓存项
class CacheItem<T> {
  final String key;
  final T value;
  final DateTime expiresAt;
  final DateTime createdAt;
  final int size;

  CacheItem({
    required this.key,
    required this.value,
    required this.expiresAt,
    required this.createdAt,
    this.size = 0,
  });

  bool get isExpired => DateTime.now().isAfter(expiresAt);
  
  Map<String, dynamic> toJson() => {
    'key': key,
    'value': value,
    'expiresAt': expiresAt.toIso8601String(),
    'createdAt': createdAt.toIso8601String(),
    'size': size,
  };

  factory CacheItem.fromJson(Map<String, dynamic> json) => CacheItem(
    key: json['key'],
    value: json['value'],
    expiresAt: DateTime.parse(json['expiresAt']),
    createdAt: DateTime.parse(json['createdAt']),
    size: json['size'] ?? 0,
  );
}

/// 缓存服务
class CacheService {
  static CacheService? _instance;
  static CacheService get instance => _instance ??= CacheService._();
  
  CacheService._();
  
  /// 内存缓存
  final Map<String, CacheItem> _memoryCache = {};
  
  /// 磁盘缓存目录
  Directory? _cacheDir;
  
  /// 缓存配置
  int _maxMemoryCacheSize = 100; // 最大内存缓存项数
  int _maxDiskCacheSize = 50 * 1024 * 1024; // 50MB
  Duration _defaultTTL = const Duration(hours: 1); // 默认过期时间
  
  /// 初始化缓存服务
  Future<void> initialize({
    int maxMemoryCacheSize = 100,
    int maxDiskCacheSize = 50 * 1024 * 1024,
    Duration defaultTTL = const Duration(hours: 1),
  }) async {
    _maxMemoryCacheSize = maxMemoryCacheSize;
    _maxDiskCacheSize = maxDiskCacheSize;
    _defaultTTL = defaultTTL;
    
    // 获取缓存目录
    final appDir = await getApplicationDocumentsDirectory();
    _cacheDir = Directory('${appDir.path}/cache');
    if (!await _cacheDir!.exists()) {
      await _cacheDir!.create(recursive: true);
    }
    
    // 清理过期缓存
    await _cleanupExpiredCache();
    
    debugPrint('CacheService initialized with memory limit: $maxMemoryCacheSize, disk limit: ${maxDiskCacheSize ~/ 1024}KB');
  }
  
  /// 获取缓存
  Future<T?> get<T>(String key, {CacheStrategy strategy = CacheStrategy.memoryAndDisk}) async {
    switch (strategy) {
      case CacheStrategy.memoryOnly:
        return _getFromMemory<T>(key);
        
      case CacheStrategy.diskOnly:
        return await _getFromDisk<T>(key);
        
      case CacheStrategy.memoryAndDisk:
        // 先从内存获取
        final memoryValue = _getFromMemory<T>(key);
        if (memoryValue != null) {
          return memoryValue;
        }
        
        // 再从磁盘获取
        final diskValue = await _getFromDisk<T>(key);
        if (diskValue != null) {
          // 放入内存缓存
          _putToMemory(key, diskValue, _defaultTTL);
          return diskValue;
        }
        
        return null;
        
      case CacheStrategy.noCache:
        return null;
    }
  }
  
  /// 设置缓存
  Future<void> set<T>(String key, T value, {
    Duration? ttl,
    CacheStrategy strategy = CacheStrategy.memoryAndDisk,
  }) async {
    final effectiveTTL = ttl ?? _defaultTTL;
    
    switch (strategy) {
      case CacheStrategy.memoryOnly:
        _putToMemory(key, value, effectiveTTL);
        break;
        
      case CacheStrategy.diskOnly:
        await _putToDisk(key, value, effectiveTTL);
        break;
        
      case CacheStrategy.memoryAndDisk:
        _putToMemory(key, value, effectiveTTL);
        await _putToDisk(key, value, effectiveTTL);
        break;
        
      case CacheStrategy.noCache:
        break;
    }
  }
  
  /// 删除缓存
  Future<void> remove(String key, {CacheStrategy strategy = CacheStrategy.memoryAndDisk}) async {
    switch (strategy) {
      case CacheStrategy.memoryOnly:
        _removeFromMemory(key);
        break;
        
      case CacheStrategy.diskOnly:
        await _removeFromDisk(key);
        break;
        
      case CacheStrategy.memoryAndDisk:
        _removeFromMemory(key);
        await _removeFromDisk(key);
        break;
        
      case CacheStrategy.noCache:
        break;
    }
  }
  
  /// 清空所有缓存
  Future<void> clear({CacheStrategy strategy = CacheStrategy.memoryAndDisk}) async {
    switch (strategy) {
      case CacheStrategy.memoryOnly:
        _memoryCache.clear();
        break;
        
      case CacheStrategy.diskOnly:
        await _clearDiskCache();
        break;
        
      case CacheStrategy.memoryAndDisk:
        _memoryCache.clear();
        await _clearDiskCache();
        break;
        
      case CacheStrategy.noCache:
        break;
    }
  }
  
  /// 获取缓存统计信息
  Future<Map<String, dynamic>> getStats() async {
    final memoryStats = _getMemoryStats();
    final diskStats = await _getDiskStats();
    
    return {
      'memory': memoryStats,
      'disk': diskStats,
    };
  }
  
  // 内存缓存操作
  T? _getFromMemory<T>(String key) {
    final item = _memoryCache[key];
    if (item == null) return null;
    
    if (item.isExpired) {
      _memoryCache.remove(key);
      return null;
    }
    
    return item.value as T;
  }
  
  void _putToMemory<T>(String key, T value, Duration ttl) {
    // 检查内存缓存大小限制
    if (_memoryCache.length >= _maxMemoryCacheSize) {
      _evictOldestMemoryCache();
    }
    
    _memoryCache[key] = CacheItem(
      key: key,
      value: value,
      expiresAt: DateTime.now().add(ttl),
      createdAt: DateTime.now(),
      size: _estimateSize(value),
    );
  }
  
  void _removeFromMemory(String key) {
    _memoryCache.remove(key);
  }
  
  void _evictOldestMemoryCache() {
    if (_memoryCache.isEmpty) return;
    
    String? oldestKey;
    DateTime? oldestTime;
    
    for (final entry in _memoryCache.entries) {
      if (oldestTime == null || entry.value.createdAt.isBefore(oldestTime)) {
        oldestTime = entry.value.createdAt;
        oldestKey = entry.key;
      }
    }
    
    if (oldestKey != null) {
      _memoryCache.remove(oldestKey);
    }
  }
  
  Map<String, dynamic> _getMemoryStats() {
    int totalSize = 0;
    int expiredCount = 0;
    
    for (final item in _memoryCache.values) {
      totalSize += item.size;
      if (item.isExpired) {
        expiredCount++;
      }
    }
    
    return {
      'count': _memoryCache.length,
      'totalSize': totalSize,
      'expiredCount': expiredCount,
      'maxSize': _maxMemoryCacheSize,
    };
  }
  
  // 磁盘缓存操作
  Future<T?> _getFromDisk<T>(String key) async {
    if (_cacheDir == null) return null;
    final cacheDir = _cacheDir!;
    
    final file = File('${_cacheDir!.path}/$key.cache');
    if (!await file.exists()) return null;
    
    try {
      final content = await file.readAsString();
      final json = jsonDecode(content) as Map<String, dynamic>;
      final item = CacheItem.fromJson(json);
      
      if (item.isExpired) {
        await file.delete();
        return null;
      }
      
      return item.value as T;
    } catch (e) {
      debugPrint('Error reading disk cache: $e');
      await file.delete();
      return null;
    }
  }
  
  Future<void> _putToDisk<T>(String key, T value, Duration ttl) async {
    if (_cacheDir == null) return;
    
    // 检查磁盘缓存大小限制
    await _checkDiskCacheSize();
    
    final item = CacheItem(
      key: key,
      value: value,
      expiresAt: DateTime.now().add(ttl),
      createdAt: DateTime.now(),
      size: _estimateSize(value),
    );
    
    final file = File('${_cacheDir!.path}/$key.cache');
    await file.writeAsString(jsonEncode(item.toJson()));
  }
  
  Future<void> _removeFromDisk(String key) async {
    if (_cacheDir == null) return;
    
    final file = File('${_cacheDir!.path}/$key.cache');
    if (await file.exists()) {
      await file.delete();
    }
  }
  
  Future<void> _clearDiskCache() async {
    if (_cacheDir == null) return;
    
    if (await _cacheDir!.exists()) {
      await _cacheDir!.delete(recursive: true);
      await _cacheDir!.create(recursive: true);
    }
  }
  
  Future<void> _checkDiskCacheSize() async {
    if (_cacheDir == null) return;
    
    final files = await _cacheDir!.list().toList();
    int totalSize = 0;
    
    for (final file in files) {
      if (file is File) {
        final stat = await file.stat();
        totalSize += stat.size;
      }
    }
    
    // 如果超过限制，删除最旧的文件
    if (totalSize > _maxDiskCacheSize) {
      await _evictOldestDiskCache(totalSize - _maxDiskCacheSize);
    }
  }
  
  Future<void> _evictOldestDiskCache(int bytesToFree) async {
    if (_cacheDir == null) return;
    
    final files = await _cacheDir!.list().toList();
    final cacheFiles = <File>[];
    
    for (final file in files) {
      if (file is File && file.path.endsWith('.cache')) {
        cacheFiles.add(file);
      }
    }
    
    // 按创建时间排序
    cacheFiles.sort((a, b) {
      final aStat = a.statSync();
      final bStat = b.statSync();
      return aStat.modified.compareTo(bStat.modified);
    });
    
    int freedBytes = 0;
    for (final file in cacheFiles) {
      if (freedBytes >= bytesToFree) break;
      
      final stat = await file.stat();
      freedBytes += stat.size;
      await file.delete();
    }
  }
  
  Future<void> _cleanupExpiredCache() async {
    if (_cacheDir == null) return;
    
    final files = await _cacheDir!.list().toList();
    for (final file in files) {
      if (file is File && file.path.endsWith('.cache')) {
        try {
          final content = await file.readAsString();
          final json = jsonDecode(content) as Map<String, dynamic>;
          final item = CacheItem.fromJson(json);
          
          if (item.isExpired) {
            await file.delete();
          }
        } catch (e) {
          await file.delete();
        }
      }
    }
  }
  
  Future<Map<String, dynamic>> _getDiskStats() async {
    if (_cacheDir == null) return {'count': 0, 'totalSize': 0};
    
    final files = await _cacheDir!.list().toList();
    int count = 0;
    int totalSize = 0;
    
    for (final file in files) {
      if (file is File && file.path.endsWith('.cache')) {
        count++;
        final stat = await file.stat();
        totalSize += stat.size;
      }
    }
    
    return {
      'count': count,
      'totalSize': totalSize,
      'maxSize': _maxDiskCacheSize,
    };
  }
  
  int _estimateSize(dynamic value) {
    if (value is String) {
      return value.length * 2; // 假设每个字符2字节
    } else if (value is List) {
      return value.length * 100; // 估算
    } else if (value is Map) {
      return value.length * 100; // 估算
    } else {
      return 100; // 默认估算
    }
  }
}

/// 缓存装饰器，为现有服务添加缓存功能
class CacheDecorator {
  final CacheService _cacheService = CacheService.instance;
  
  /// 带缓存的异步方法执行
  Future<T?> cachedOperation<T>(
    String key,
    Future<T> Function() operation, {
    Duration? ttl,
    CacheStrategy strategy = CacheStrategy.memoryAndDisk,
    bool forceRefresh = false,
  }) async {
    if (!forceRefresh) {
      final cached = await _cacheService.get<T>(key, strategy: strategy);
      if (cached != null) {
        return cached;
      }
    }
    
    final result = await operation();
    if (result != null) {
      await _cacheService.set<T>(key, result, ttl: ttl, strategy: strategy);
    }
    
    return result;
  }
}

/// 缓存键生成器
class CacheKeys {
  static String userList() => 'user_list';
  static String userListWithPage(int page) => 'user_list_page_$page';
  static String userDetail(String id) => 'user_detail_$id';
  static String clipboardList() => 'clipboard_list';
  static String clipboardListWithPage(int page) => 'clipboard_list_page_$page';
  static String clipboardDetail(String id) => 'clipboard_detail_$id';
  static String deviceList() => 'device_list';
  static String deviceDetail(String id) => 'device_detail_$id';
  static String settings() => 'settings';
  static String userProfile() => 'user_profile';
}