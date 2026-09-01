import 'package:flutter/material.dart';
import '../models/clipboard_item.dart';
import '../services/api_service.dart';
import '../services/app_exception.dart';
import '../services/search_history_api_service.dart';
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
/// - 搜索历史（C2）：[setSearchQuery] 成功后自动记录（去重防抖词），
///   [searchHistory] / [loadSearchHistory] / [clearSearchHistory] 供浮层使用
/// - 高级筛选（C2）：[filterDateRange] / [filterDeviceId]（[applyFilters] /
///   [resetAdvancedFilters]），应用即重置分页重拉；[activeFilterCount] 供徽标
class ClipboardProvider extends ChangeNotifier {
  final ApiService _api = ApiService();
  final SearchHistoryApiService _searchHistoryApi = SearchHistoryApiService();

  List<ClipboardItem> _items = [];
  bool _isLoading = false;

  /// 最近一次失败的原始错误对象（AppException / 其他 Exception），
  /// UI 层经 friendlyError 映射 l10n 文案后展示（A3 解耦）
  Object? _error;
  int _page = 1;
  bool _hasMore = true;
  int _totalItems = 0;

  // 搜索 / 筛选状态（切换后从第 1 页重拉）
  String? _searchQuery;
  String? _contentTypeFilter;
  bool _favoritesOnly = false;

  // C2 高级筛选：时间范围（null = 全部时间）与来源设备（null = 全部设备）
  String? _filterDateRange;
  String? _filterDeviceId;

  // C2 搜索历史：本地镜像（≤[kSearchHistoryLimit] 条），聚焦浮层直接读
  static const int kSearchHistoryLimit = 10;
  List<SearchHistoryItem> _searchHistory = const <SearchHistoryItem>[];

  /// 最近一次成功记录到服务端的搜索词（连续重复搜索不重复记录）
  String? _lastRecordedQuery;

  // F2：WS 到达但与当前类型筛选不匹配、暂未插入列表的新条目数
  int _pendingNewCount = 0;

  // 节流器：限制 notifyListeners() 调用频率
  final Throttler _notifyThrottler = Throttler(interval: const Duration(milliseconds: 100));

  List<ClipboardItem> get items => _items;
  bool get isLoading => _isLoading;
  Object? get error => _error;
  bool get hasMore => _hasMore;

  /// 服务端报告的当前筛选条件下的总数（pagination.total）
  int get totalItems => _totalItems;

  /// 当前搜索关键字（null/空 = 无搜索）
  String? get searchQuery => _searchQuery;

  /// 当前类型筛选：null/空 = 全部；'text' / 'link' / 'image' / 'file' / 'code'
  String? get contentTypeFilter => _contentTypeFilter;

  /// 是否只看收藏
  bool get favoritesOnly => _favoritesOnly;

  /// 当前搜索历史（最近搜索在前，本地镜像 ≤[kSearchHistoryLimit] 条）
  List<SearchHistoryItem> get searchHistory => _searchHistory;

  /// 时间范围筛选：null = 全部时间；'today' / 'week' / 'month'（FilterPanel 单选）
  String? get filterDateRange => _filterDateRange;

  /// 来源设备筛选：null = 全部设备（FilterPanel 单选，设备列表复用 DeviceProvider）
  String? get filterDeviceId => _filterDeviceId;

  /// 已激活的高级筛选数（时间范围 / 来源设备 / 仅收藏各计 1），
  /// 供筛选入口徽标 activeFilters{count} 展示。
  int get activeFilterCount =>
      (_filterDateRange != null ? 1 : 0) +
      (_filterDeviceId != null ? 1 : 0) +
      (_favoritesOnly ? 1 : 0);

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

  /// 拉取一页；返回是否成功（搜索历史记录等后续动作据此决定是否触发）。
  Future<bool> _fetchPage({
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
        deviceId: _filterDeviceId,
        dateFrom: _resolveDateFrom(),
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
      return true;
    } on Exception catch (e) {
      _error = e;
      notifyListeners();
      return false;
    } finally {
      _isLoading = false;
    }
  }

  /// 时间范围筛选 → `dateFrom` 请求参数（本地时区 [DateTime.now] 计算；
  /// `dateTo` 不传 = 至今，对齐后端 GET /api/clipboard 的 `new Date(dateFrom)` 解析）。
  String? _resolveDateFrom() {
    final DateTime now = DateTime.now();
    switch (_filterDateRange) {
      case kDateRangeToday:
        return DateTime(now.year, now.month, now.day).toUtc().toIso8601String();
      case kDateRangeWeek:
        return now.subtract(const Duration(days: 7)).toUtc().toIso8601String();
      case kDateRangeMonth:
        return now.subtract(const Duration(days: 30)).toUtc().toIso8601String();
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 搜索 / 筛选（Wave 2 UI 数据层；防抖由 UI 层负责）
  // ---------------------------------------------------------------------------

  // 时间范围筛选值（FilterPanel 单选；与 l10n filterToday/Week/Month 对应）
  static const String kDateRangeToday = 'today';
  static const String kDateRangeWeek = 'week';
  static const String kDateRangeMonth = 'month';

  /// 设置搜索关键字并重拉第 1 页；传 null/空串清除搜索。
  ///
  /// C2：防抖触发的那次搜索**成功后**记录搜索历史——非空词、且与上次已记录
  /// 词不同才 POST /api/search-history（记录失败静默，不影响搜索主流程）。
  Future<void> setSearchQuery(String? query) async {
    final next = (query == null || query.trim().isEmpty) ? null : query.trim();
    if (next == _searchQuery) return;
    _searchQuery = next;
    final ok = await _reloadWithCurrentFilters();
    if (ok && next != null && next != _lastRecordedQuery) {
      _lastRecordedQuery = next;
      await _recordSearchQuery(next);
    }
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

  /// 应用高级筛选（C2 FilterPanel「应用」； favoritesOnly 传 null = 维持现值）。
  ///
  /// 任一字段变化即重置分页从第 1 页重拉（与搜索/类型筛选切换同路径）。
  Future<void> applyFilters({
    String? dateRange,
    String? deviceId,
    bool? favoritesOnly,
  }) async {
    final nextDateRange = (dateRange == null || dateRange.isEmpty) ? null : dateRange;
    final nextDeviceId = (deviceId == null || deviceId.isEmpty) ? null : deviceId;
    final nextFavorites = favoritesOnly ?? _favoritesOnly;
    if (nextDateRange == _filterDateRange &&
        nextDeviceId == _filterDeviceId &&
        nextFavorites == _favoritesOnly) {
      return;
    }
    _filterDateRange = nextDateRange;
    _filterDeviceId = nextDeviceId;
    _favoritesOnly = nextFavorites;
    await _reloadWithCurrentFilters();
  }

  /// 重置高级筛选（C2 FilterPanel「重置」：时间/设备/仅收藏全清，重拉第 1 页）。
  Future<void> resetAdvancedFilters() async {
    if (_filterDateRange == null && _filterDeviceId == null && !_favoritesOnly) {
      return;
    }
    _filterDateRange = null;
    _filterDeviceId = null;
    _favoritesOnly = false;
    await _reloadWithCurrentFilters();
  }

  /// 清空全部搜索/筛选（含 C2 高级筛选）并重拉第 1 页
  Future<void> clearFilters() async {
    if (_searchQuery == null &&
        _contentTypeFilter == null &&
        !_favoritesOnly &&
        _filterDateRange == null &&
        _filterDeviceId == null) {
      return;
    }
    _searchQuery = null;
    _contentTypeFilter = null;
    _favoritesOnly = false;
    _filterDateRange = null;
    _filterDeviceId = null;
    await _reloadWithCurrentFilters();
  }

  Future<bool> _reloadWithCurrentFilters() async {
    final token = await _resolveToken();
    if (token == null) {
      _error = const AppException(AppErrorCodes.noToken);
      notifyListeners();
      return false;
    }
    return _fetchPage(token: token, page: 1, isRefresh: true);
  }

  // ---------------------------------------------------------------------------
  // 搜索历史（C2）
  // ---------------------------------------------------------------------------

  /// 拉取搜索历史到本地镜像（搜索栏聚焦浮层展示前调用）；失败静默保留旧数据。
  Future<void> loadSearchHistory() async {
    try {
      final items = await _searchHistoryApi.fetchHistory(limit: kSearchHistoryLimit);
      _searchHistory = items;
      notifyListeners();
    } on Exception catch (_) {
      // 静默失败：浮层沿用旧镜像或空态，不阻塞搜索栏交互
    }
  }

  /// 记录搜索词（fire-and-forget 语义）：成功后乐观顶到本地镜像最前。
  Future<void> _recordSearchQuery(String term) async {
    try {
      await _searchHistoryApi.recordQuery(term);
      final merged = <SearchHistoryItem>[
        SearchHistoryItem.local(term),
        ..._searchHistory.where((SearchHistoryItem e) => e.keyword != term),
      ];
      _searchHistory = merged.length > kSearchHistoryLimit
          ? merged.sublist(0, kSearchHistoryLimit)
          : merged;
      notifyListeners();
    } on Exception catch (_) {
      // 静默失败：历史记录不影响搜索主流程
    }
  }

  /// 清空搜索历史（浮层「清空」按钮）；返回是否成功（SnackBar 用）。
  Future<bool> clearSearchHistory() async {
    try {
      await _searchHistoryApi.clearHistory();
      _searchHistory = const <SearchHistoryItem>[];
      // 服务端已清空：下次搜索重新开始记录
      _lastRecordedQuery = null;
      notifyListeners();
      return true;
    } on Exception catch (_) {
      return false;
    }
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
    } on Exception catch (e) {
      _error = e;
      notifyListeners();
    }
  }

  Future<void> deleteItem(String? token, String itemId) async {
    try {
      await _api.deleteClipboardItem(token, itemId);
      _items.removeWhere((item) => item.id == itemId);
      if (_totalItems > 0) _totalItems--;
      notifyListeners();
    } on Exception catch (e) {
      _error = e;
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
