import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/clipboard_item.dart';
import '../providers/clipboard_provider.dart';
import 'package:provider/provider.dart';

/// 快速粘贴面板
/// 通过全局快捷键 (Ctrl+Shift+V) 触发
class QuickPastePanel extends StatefulWidget {
  final VoidCallback? onClose;

  const QuickPastePanel({Key? key, this.onClose}) : super(key: key);

  @override
  State<QuickPastePanel> createState() => _QuickPastePanelState();
}

class _QuickPastePanelState extends State<QuickPastePanel> {
  final TextEditingController _searchController = TextEditingController();
  List<ClipboardItem> _filteredItems = [];
  int _selectedIndex = 0;
  ClipboardItem? _selectedItem;
  bool _showFavoritesOnly = false; // 是否只显示收藏

  @override
  void initState() {
    super.initState();
    _loadItems();
    _searchController.addListener(_onSearchChanged);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadItems() async {
    final provider = Provider.of<ClipboardProvider>(context, listen: false);
    await provider.loadItems();
    _filterItems();
  }

  void _onSearchChanged() {
    _filterItems();
  }

  void _filterItems() {
    final provider = Provider.of<ClipboardProvider>(context, listen: false);
    final query = _searchController.text.toLowerCase();
    
    setState(() {
      Iterable<ClipboardItem> items = provider.items;
      
      // 只显示收藏
      if (_showFavoritesOnly) {
        items = items.where((item) => item.isFavorite);
      }
      
      // 搜索过滤
      if (query.isNotEmpty) {
        items = items.where((item) =>
            item.contentPreview?.toLowerCase().contains(query) ?? false);
      }
      
      _filteredItems = items.take(20).toList();
      _selectedIndex = 0;
    });
  }

  void _onItemTap(ClipboardItem item) async {
    setState(() {
      _selectedItem = item;
    });

    // 复制到剪贴板
    await Clipboard.setData(ClipboardData(text: item.decryptedContent ?? ''));
    
    // 触发粘贴（模拟 Ctrl+V）
    await Future.delayed(const Duration(milliseconds: 100));
    // 注意：实际应用中需要使用系统级粘贴，这里只是复制到剪贴板
    
    if (widget.onClose != null) {
      widget.onClose!();
    }
  }

  Future<void> _toggleFavorite(ClipboardItem item) async {
    final provider = Provider.of<ClipboardProvider>(context, listen: false);
    await provider.toggleFavorite(item.id!);
    setState(() {});
  }

  void _onKeyDown(KeyEvent event) {
    if (event is KeyDownEvent) {
      if (event.logicalKey == LogicalKeyboardKey.escape) {
        if (widget.onClose != null) {
          widget.onClose!();
        }
      } else if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
        setState(() {
          _selectedIndex = (_selectedIndex + 1).clamp(0, _filteredItems.length - 1);
        });
      } else if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
        setState(() {
          _selectedIndex = (_selectedIndex - 1).clamp(0, _filteredItems.length - 1);
        });
      } else if (event.logicalKey == LogicalKeyboardKey.enter) {
        if (_filteredItems.isNotEmpty) {
          _onItemTap(_filteredItems[_selectedIndex]);
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return KeyboardListener(
      focusNode: FocusNode()..requestFocus(),
      onKeyEvent: _onKeyDown,
      child: Material(
        elevation: 8,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          width: 480,
          height: 500,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            color: Theme.of(context).cardColor,
          ),
          child: Column(
            children: [
              _buildSearchBar(),
              const Divider(height: 1),
              Expanded(child: _buildItemList()),
              const Divider(height: 1),
              _buildPreview(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSearchBar() {
    return Row(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(8.0),
            child: TextField(
              controller: _searchController,
              autofocus: true,
              decoration: InputDecoration(
                hintText: '搜索剪贴板历史...',
                prefixIcon: const Icon(Icons.search),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              ),
            ),
          ),
        ),
        IconButton(
          icon: Icon(_showFavoritesOnly ? Icons.favorite : Icons.favorite_border),
          color: _showFavoritesOnly ? Colors.red : null,
          tooltip: _showFavoritesOnly ? '显示全部' : '仅显示收藏',
          onPressed: () {
            setState(() {
              _showFavoritesOnly = !_showFavoritesOnly;
            });
            _filterItems();
          },
        ),
      ],
    );
  }

  Widget _buildItemList() {
    if (_filteredItems.isEmpty) {
      return const Center(
        child: Text('暂无剪贴板历史'),
      );
    }

    return ListView.builder(
      itemCount: _filteredItems.length,
      itemBuilder: (context, index) {
        final item = _filteredItems[index];
        final isSelected = index == _selectedIndex;
        
        return ListTile(
          selected: isSelected,
          leading: _getIconForContentType(item.contentType),
          title: Text(
            item.contentPreview ?? '无预览',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
            ),
          ),
          subtitle: Text(
            _formatTimestamp(item.createdAt),
            style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).textTheme.caption?.color,
            ),
          ),
          trailing: IconButton(
            icon: Icon(
              item.isFavorite ? Icons.favorite : Icons.favorite_border,
              color: item.isFavorite ? Colors.red : null,
            ),
            onPressed: () => _toggleFavorite(item),
          ),
          onTap: () => _onItemTap(item),
        );
      },
    );
  }

  Widget _getIconForContentType(String? contentType) {
    if (contentType == null) return const Icon(Icons.description);
    
    if (contentType.startsWith('image/')) {
      return const Icon(Icons.image);
    } else if (contentType == 'text/html') {
      return const Icon(Icons.html);
    } else if (contentType.contains('pdf')) {
      return const Icon(Icons.picture_as_pdf);
    } else {
      return const Icon(Icons.description);
    }
  }

  String _formatTimestamp(DateTime? dateTime) {
    if (dateTime == null) return '';
    
    final now = DateTime.now();
    final difference = now.difference(dateTime);
    
    if (difference.inMinutes < 1) {
      return '刚刚';
    } else if (difference.inMinutes < 60) {
      return '${difference.inMinutes}分钟前';
    } else if (difference.inHours < 24) {
      return '${difference.inHours}小时前';
    } else {
      return '${difference.inDays}天前';
    }
  }

  /// 构建预览区域
  Widget _buildPreview() {
    if (_selectedItem == null) {
      return const Center(
        child: Text('选择一个条目以预览'),
      );
    }

    final item = _selectedItem!;
    final contentType = item.contentType ?? 'text';

    if (contentType.startsWith('image/')) {
      // 图片预览
      final previewUrl = item.id != null
          ? 'http://localhost:3001/api/media/${item.id}/preview'
          : null;
      if (previewUrl != null) {
        return Image.network(
          previewUrl,
          fit: BoxFit.contain,
          errorBuilder: (context, error, stackTrace) => const Icon(Icons.broken_image, size: 48),
        );
      }
    }

    // 文本预览（前200字）
    final previewText = (item.contentPreview ?? '').length > 200
        ? item.contentPreview!.substring(0, 200) + '...'
        : (item.contentPreview ?? '无预览');
    return Padding(
      padding: const EdgeInsets.all(12.0),
      child: Text(
        previewText,
        style: const TextStyle(fontSize: 14),
        maxLines: 10,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}
