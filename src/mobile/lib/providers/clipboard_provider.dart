import 'package:flutter/material.dart';
import '../models/clipboard_item.dart';
import '../services/api_service.dart';
import '../utils/performance.dart';

class ClipboardProvider extends ChangeNotifier {
  final ApiService _api = ApiService();
  
  List<ClipboardItem> _items = [];
  bool _isLoading = false;
  String? _error;
  int _page = 1;
  bool _hasMore = true;
  
  // 节流器：限制 notifyListeners() 调用频率
  final Throttler _notifyThrottler = Throttler(interval: const Duration(milliseconds: 100));
  
  List<ClipboardItem> get items => _items;
  bool get isLoading => _isLoading;
  String? get error => _error;
  bool get hasMore => _hasMore;
  
  Future<void> loadItems(String token, {bool refresh = false, bool forceRefresh = false}) async {
    if (refresh) {
      _page = 1;
      _items = [];
      _hasMore = true;
    }
    
    if (!_hasMore || _isLoading) return;
    
    _isLoading = true;
    _error = null;
    bool shouldNotify = refresh || _items.isEmpty;
    if (shouldNotify) notifyListeners();
    
    try {
      final result = await _api.getClipboardItems(token, page: _page, forceRefresh: forceRefresh);
      final newItems = (result['items'] as List)
          .map((item) => ClipboardItem.fromJson(item))
          .toList();
      
      if (refresh) {
        _items = newItems;
      } else {
        _items.addAll(newItems);
      }
      
      _hasMore = newItems.length >= 50;
      _page++;
      
      notifyListeners();
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    } finally {
      _isLoading = false;
    }
  }
  
  Future<void> toggleFavorite(String token, String itemId) async {
    try {
      await _api.toggleFavorite(token, itemId);
      final index = _items.indexWhere((item) => item.id == itemId);
      if (index != -1) {
        _items[index] = _items[index].copyWith(
          isFavorite: !_items[index].isFavorite,
        );
        notifyListeners();
      }
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    }
  }
  
  Future<void> deleteItem(String token, String itemId) async {
    try {
      await _api.deleteClipboardItem(token, itemId);
      _items.removeWhere((item) => item.id == itemId);
      notifyListeners();
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    }
  }
  
  /// Handle real-time updates from WebSocket
  void handleNewItem(Map<String, dynamic> data) {
    final item = data['item'];
    if (item != null) {
      final newItem = ClipboardItem.fromJson(item);
      if (!_items.any((i) => i.id == newItem.id)) {
        _items.insert(0, newItem);
        _notifyThrottler(() {
          notifyListeners();
        });
      }
    }
  }
  
  /// Handle batch updates
  void handleBatchUpdate(List<Map<String, dynamic>> items) {
    var hasChanges = false;
    for (final itemData in items) {
      final newItem = ClipboardItem.fromJson(itemData);
      if (!_items.any((i) => i.id == newItem.id)) {
        _items.insert(0, newItem);
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      notifyListeners();
    }
  }
  
  void handleDeletedItem(String itemId) {
    _items.removeWhere((item) => item.id == itemId);
    notifyListeners();
  }
  
  void handleBatchDeleted(List<String> ids) {
    _items.removeWhere((item) => ids.contains(item.id));
    notifyListeners();
  }
  
  void handleFavoriteChanged(String itemId, bool isFavorite) {
    final index = _items.indexWhere((item) => item.id == itemId);
    if (index != -1) {
      _items[index] = _items[index].copyWith(isFavorite: isFavorite);
      notifyListeners();
    }
  }
  
  /// 清除缓存
  void clearCache() {
    _items.clear();
    notifyListeners();
  }
}
