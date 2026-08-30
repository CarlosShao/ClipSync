import 'package:flutter/material.dart';
import '../models/clipboard_item.dart';
import '../services/api_service.dart';
import '../services/token_store.dart';
import '../utils/performance.dart';

/// 剪贴板数据层（T1.1）
///
/// 供 Wave 2 UI 使用的能力：
/// - 列表加载：[loadItems]（兼容旧签名）/ [refresh] / [loadMore]，分页基于服务端 pagination
/// - 搜索/筛选：[searchQuery] / [contentTypeFilter] / [favoritesOnly] +
///   [setSearchQuery] / [setContentTypeFilter] / [setFavoritesOnly]（切换即重置分页并重拉）
/// - WS 新条目过滤（F2）：与当前 [contentTypeFilter] 不匹配的新条目不插入列表，
///   累计到 [pendingNewCount]（「有 N 条新内容」浮条数据源），点击浮条后经
///   [clearPendingNewCount] 清零并 [refresh] 重拉
/// - 收藏：[toggleFavorite]（PUT /api/clipboard/:id/favorite，以服务端返回状态回写）
/// - 全量内容：[resolveCopyText]（预览疑似截断时经内容接口拉取完整内容并回填缓存）
/// - 实时同步：handleNewItem / handleBatchUpdate / handleDeletedItem /
///   handleBatchDeleted / handleFavoriteChanged（WS 回调接线，签名不变）
class ClipboardProvider extends ChangeNotifier {
  final ApiService _api = ApiService();

  List<ClipboardItem> _items = [];
  bool _isLoading = false;
  String? _error;
  int _page = 1;
  bool _hasMore = true;
  int _totalItems = 0;

  // 搜索 / 筛选状态（切换后从第 1 页重拉）
  String? _searchQuery;
  String? _contentTypeFilter;
  bool _favoritesOnly = false;

  // F2：WS 到达但与当前类型筛选不匹配、暂未插入列表的新条目数
  int _pendingNewCount = 0;

  // 节流器：限制 notifyListeners() 调用频率
  final Throttler _notifyThrottler = Throttler(interval: const Duration(milliseconds: 100));

  List<ClipboardItem> get items => _items;
  bool get isLoading => _isLoading;
  String? get error => _error;
  bool get hasMore => _hasMore;

  /// 服务端报告的当前筛选条件下的总数（pagination.total）
  int get totalItems => _totalItems;

  /// 当前搜索关键字（null/空 = 无搜索）
  String? get searchQuery => _searchQuery;

  /// 当前类型筛选：null/空 = 全部；'text' / 'link' / 'image' / 'file' / 'code'
  String? get contentTypeFilter => _contentTypeFilter;

  /// 是否只看收藏
  bool get favoritesOnly => _favoritesOnly;

  /// WS 到达、但与当前类型筛选不匹配而未插入列表的新条目数（F2）。
  ///
  /// >0 时 UI 显示「有 N 条新内容」浮条；任何第 1 页成功刷新
  /// （下拉刷新 / 切换筛选 / 清除筛选，服务端已按当前筛选重同步）后清零。
  int get pendingNewCount => _pendingNewCount;

  /// 清零 [pendingNewCount]（浮条点击时调用，随后应 [refresh] 重拉列表）。
  void clearPendingNewCount() {
    if (_pendingNewCount == 0) return;
    _pendingNewCount = 0;
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // 列表加载（分页）
  // ---------------------------------------------------------------------------

  /// 兼容旧签名：home_screen 调用 `loadItems(token, refresh: true)` 与 `loadItems(token)`。
  Future<void> loadItems(String token, {bool refresh = false, bool forceRefresh = false}) async {
    if (refresh) {
      await _fetchPage(token: token, page: 1, isRefresh: true, forceRefresh: forceRefresh);
    } else {
      await _loadMoreWithToken(token, forceRefresh: forceRefresh);
    }
  }

  /// 按当前搜索/筛选状态刷新第 1 页（Wave 2 下拉刷新入口；token 从 TokenStore 解析）
  Future<void> refresh({bool forceRefresh = false}) async {
    final token = await _resolveToken();
    if (token == null) return;
    await _fetchPage(token: token, page: 1, isRefresh: true, forceRefresh: forceRefresh);
  }

  Future<void> _loadMoreWithToken(String token, {bool forceRefresh = false}) async {
    if (!_hasMore || _isLoading) return;
    await _fetchPage(token: token, page: _page, isRefresh: false, forceRefresh: forceRefresh);
  }

  Future<void> _fetchPage({
    required String token,
    required int page,
    required bool isRefresh,
    bool forceRefresh = false,
  }) async {
    _isLoading = true;
    _error = null;
    final shouldNotify = isRefresh || _items.isEmpty;
    if (shouldNotify) notifyListeners();

    try {
      final result = await _api.getClipboardItems(
        token,
        page: page,
        contentType: _contentTypeFilter,
        search: _searchQuery,
        favorites: _favoritesOnly ? true : null,
        forceRefresh: forceRefresh,
      );

      final newItems = result.items;
      if (isRefresh) {
        _items = newItems;
      } else {
        // 追加去重：WS 实时插入的条目可能与分页返回重复
        final existingIds = _items.map((e) => e.id).toSet();
        _items.addAll(newItems.where((e) => !existingIds.contains(e.id)));
      }

      _totalItems = result.total;
      _hasMore = result.hasMore;
      // 只在成功时推进页码：失败保留页码，重试拿到的是同一页
      _page = page + 1;

      // 第 1 页刷新成功 = 服务端已按当前筛选重同步，被筛选挡住的新条目
      // 要么已进入本页、要么已被用户主动放弃（F2 浮条清零）
      if (isRefresh && page == 1 && _pendingNewCount != 0) {
        _pendingNewCount = 0;
      }

      notifyListeners();
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    } finally {
      _isLoading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 搜索 / 筛选（Wave 2 UI 数据层；防抖由 UI 层负责）
  // ---------------------------------------------------------------------------

  /// 设置搜索关键字并重拉第 1 页；传 null/空串清除搜索
  Future<void> setSearchQuery(String? query) async {
    final next = (query == null || query.trim().isEmpty) ? null : query.trim();
    if (next == _searchQuery) return;
    _searchQuery = next;
    await _reloadWithCurrentFilters();
  }

  /// 设置类型筛选并重拉第 1 页；传 null 清除筛选
  Future<void> setContentTypeFilter(String? contentType) async {
    final next = (contentType == null || contentType.isEmpty) ? null : contentType;
    if (next == _contentTypeFilter) return;
    _contentTypeFilter = next;
    await _reloadWithCurrentFilters();
  }

  /// 设置"只看收藏"并重拉第 1 页
  Future<void> setFavoritesOnly(bool value) async {
    if (value == _favoritesOnly) return;
    _favoritesOnly = value;
    await _reloadWithCurrentFilters();
  }

  /// 清空全部搜索/筛选并重拉第 1 页
  Future<void> clearFilters() async {
    if (_searchQuery == null && _contentTypeFilter == null && !_favoritesOnly) return;
    _searchQuery = null;
    _contentTypeFilter = null;
    _favoritesOnly = false;
    await _reloadWithCurrentFilters();
  }

  Future<void> _reloadWithCurrentFilters() async {
    final token = await _resolveToken();
    if (token == null) {
      _error = '未登录：缺少访问令牌';
      notifyListeners();
      return;
    }
    await _fetchPage(token: token, page: 1, isRefresh: true);
  }

  Future<String?> _resolveToken() => TokenStore.getAccessToken();

  // ---------------------------------------------------------------------------
  // 收藏 / 删除
  // ---------------------------------------------------------------------------

  /// 收藏 toggle：以服务端返回的 isFavorite/favoritedAt 权威状态回写本地
  Future<void> toggleFavorite(String? token, String itemId) async {
    try {
      final result = await _api.toggleFavorite(token, itemId);
      final index = _items.indexWhere((item) => item.id == itemId);
      if (index != -1) {
        final serverFavorite = result?['isFavorite'];
        _items[index] = _items[index].copyWith(
          isFavorite: serverFavorite is bool ? serverFavorite : !_items[index].isFavorite,
          favoritedAt: _parseDate(result?['favoritedAt']),
        );
        notifyListeners();
      }
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    }
  }

  Future<void> deleteItem(String? token, String itemId) async {
    try {
      await _api.deleteClipboardItem(token, itemId);
      _items.removeWhere((item) => item.id == itemId);
      if (_totalItems > 0) _totalItems--;
      notifyListeners();
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    }
  }

  // ---------------------------------------------------------------------------
  // 全量内容（复制用；对齐桌面端 useClipboard.ts 的取数路径）
  // ---------------------------------------------------------------------------

  /// 解析复制文本：已有完整内容直接返回；预览疑似截断（contentSize 未知或
  /// 预览长度 < contentSize）且为文本类条目时，拉取完整内容并回填本地缓存。
  /// 任何失败都退化为预览文本，不阻塞复制动作。
  Future<String> resolveCopyText(String? token, String itemId) async {
    final index = _items.indexWhere((item) => item.id == itemId);
    if (index == -1) return '';

    final item = _items[index];
    if (!item.mayBeTruncated) return item.copyText;

    const fullTextTypes = {'text', 'link', 'code'};
    if (!fullTextTypes.contains(item.contentType)) return item.copyText;

    try {
      final full = await _api.getItemContent(token, itemId);
      if (full != null && full.isNotEmpty) {
        _items[index] = item.copyWith(fullContent: full);
        notifyListeners();
        return full;
      }
    } catch (_) {
      // 拉取失败：退化为预览文本（仅 >5000 字符时才会失真，属可接受降级）
    }
    return item.copyText;
  }

  // ---------------------------------------------------------------------------
  // WebSocket 实时同步（签名与接线保持不变）
  // ---------------------------------------------------------------------------

  /// 当前类型筛选是否放行该 contentType（null/空筛选 = 全部，恒放行）。
  bool _matchesContentTypeFilter(String contentType) {
    final filter = _contentTypeFilter;
    return filter == null || filter.isEmpty || filter == contentType;
  }

  /// Handle real-time updates from WebSocket
  ///
  /// F2：新条目与当前 [contentTypeFilter] 不匹配时不插入列表（否则会出现
  /// 「文本筛选下冒出图片条目」），改为累计 [pendingNewCount] 交由浮条提示；
  /// 匹配则头插并清零 pending 计数（列表头部已是最新可见内容）。
  void handleNewItem(Map<String, dynamic> data) {
    final raw = data['item'];
    final itemJson = raw is Map<String, dynamic> ? raw : data;
    if (itemJson['id'] == null) return;
    final newItem = ClipboardItem.fromJson(itemJson);
    if (_items.any((i) => i.id == newItem.id)) return;

    if (!_matchesContentTypeFilter(newItem.contentType)) {
      _pendingNewCount++;
      _notifyThrottler(() {
        notifyListeners();
      });
      return;
    }

    _items.insert(0, newItem);
    if (_totalItems > 0) _totalItems++;
    if (_pendingNewCount != 0) _pendingNewCount = 0;
    _notifyThrottler(() {
      notifyListeners();
    });
  }

  /// Handle batch updates
  void handleBatchUpdate(List<Map<String, dynamic>> items) {
    var hasChanges = false;
    for (final itemData in items) {
      final newItem = ClipboardItem.fromJson(itemData);
      if (!_items.any((i) => i.id == newItem.id)) {
        _items.insert(0, newItem);
        if (_totalItems > 0) _totalItems++;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      notifyListeners();
    }
  }

  void handleDeletedItem(String itemId) {
    final before = _items.length;
    _items.removeWhere((item) => item.id == itemId);
    if (_items.length < before && _totalItems > 0) _totalItems--;
    notifyListeners();
  }

  void handleBatchDeleted(List<String> ids) {
    final before = _items.length;
    _items.removeWhere((item) => ids.contains(item.id));
    final removedCount = before - _items.length;
    if (removedCount > 0 && _totalItems > 0) {
      _totalItems = _totalItems > removedCount ? _totalItems - removedCount : 0;
    }
    notifyListeners();
  }

  void handleFavoriteChanged(String itemId, bool isFavorite) {
    final index = _items.indexWhere((item) => item.id == itemId);
    if (index != -1) {
      _items[index] = _items[index].copyWith(
        isFavorite: isFavorite,
        favoritedAt: isFavorite ? DateTime.now() : null,
      );
      notifyListeners();
    }
  }

  /// 清除缓存
  void clearCache() {
    _items.clear();
    _totalItems = 0;
    _page = 1;
    _hasMore = true;
    _pendingNewCount = 0;
    notifyListeners();
  }

  static DateTime? _parseDate(dynamic v) =>
      v is String ? DateTime.tryParse(v) : null;
}
