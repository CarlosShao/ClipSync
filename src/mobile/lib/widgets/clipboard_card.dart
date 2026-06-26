import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/clipboard_item.dart';
import '../theme/app_theme.dart';

class ClipboardCard extends StatefulWidget {
  final ClipboardItem item;

  const ClipboardCard({super.key, required this.item});

  @override
  State<ClipboardCard> createState() => _ClipboardCardState();
}

class _ClipboardCardState extends State<ClipboardCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 150),
      vsync: this,
    );
    _scaleAnimation = Tween<double>(
      begin: 1.0,
      end: 0.95,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '剪贴板项，类型：${widget.item.typeLabel}，内容：${widget.item.contentPreview}',
      button: true,
      child: GestureDetector(
        onTapDown: (_) => _controller.forward(),
        onTapUp: (_) {
          _controller.reverse();
          _copyToClipboard(context);
        },
        onTapCancel: () => _controller.reverse(),
        child: AnimatedBuilder(
          animation: _scaleAnimation,
          builder: (context, child) {
            return Transform.scale(
              scale: _scaleAnimation.value,
              child: child,
            );
          },
          child: Card(
            child: InkWell(
              onTap: () => _copyToClipboard(context),
              borderRadius: BorderRadius.circular(12),
              splashColor: AppTheme.primaryColor.withOpacity(0.2),
              highlightColor: AppTheme.primaryColor.withOpacity(0.1),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Header with type and favorite
                    Row(
                      children: [
                        _buildTypeBadge(),
                        const Spacer(),
                        Icon(
                          widget.item.isFavorite ? Icons.star : Icons.star_border,
                          color: widget.item.isFavorite ? AppTheme.warningColor : Colors.grey,
                          size: 20,
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),

                    // Content preview
                    Expanded(
                      child: Text(
                        widget.item.contentPreview,
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13,
                          height: 1.4,
                        ),
                      ),
                    ),

                    // Footer with device and time
                    Row(
                      children: [
                        Icon(
                          _getDeviceIcon(widget.item.sourceDevice?.platform),
                          size: 14,
                          color: AppTheme.textSecondary,
                        ),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            widget.item.sourceDevice?.name ?? '未知设备',
                            style: const TextStyle(
                              fontSize: 11,
                              color: AppTheme.textSecondary,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Text(
                          _formatTime(widget.item.createdAt),
                          style: const TextStyle(
                            fontSize: 11,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildTypeBadge() {
    Color color;
    IconData icon;

    switch (widget.item.contentType) {
      case 'text':
        color = AppTheme.primaryColor;
        icon = Icons.text_fields;
        break;
      case 'link':
        color = AppTheme.successColor;
        icon = Icons.link;
        break;
      case 'image':
        color = const Color(0xFFE17055);
        icon = Icons.image;
        break;
      case 'file':
        color = const Color(0xFF0984E3);
        icon = Icons.attach_file;
        break;
      default:
        color = AppTheme.primaryColor;
        icon = Icons.text_fields;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
          Text(
            widget.item.typeLabel,
            style: TextStyle(
              fontSize: 11,
              color: color,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  IconData _getDeviceIcon(String? platform) {
    switch (platform?.toLowerCase()) {
      case 'windows':
        return Icons.computer;
      case 'macos':
        return Icons.laptop_mac;
      case 'linux':
        return Icons.computer;
      case 'ios':
        return Icons.phone_iphone;
      case 'android':
        return Icons.phone_android;
      default:
        return Icons.devices_other;
    }
  }

  String _formatTime(DateTime dateTime) {
    final now = DateTime.now();
    final diff = now.difference(dateTime);

    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inHours < 1) return '${diff.inMinutes}分钟前';
    if (diff.inDays < 1) return '${diff.inHours}小时前';
    if (diff.inDays < 7) return '${diff.inDays}天前';
    return '${dateTime.month}/${dateTime.day}';
  }

  void _copyToClipboard(BuildContext context) {
    Clipboard.setData(ClipboardData(text: widget.item.contentPreview));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('已复制到剪贴板'),
        duration: Duration(seconds: 1),
      ),
    );
  }
}