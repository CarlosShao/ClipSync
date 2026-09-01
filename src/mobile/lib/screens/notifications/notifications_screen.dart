import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/app_exception.dart';
import '../../services/notifications_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';

/// 通知中心页（C5）。
///
/// 展示站内通知历史（GET /api/notifications/history）：类型图标 / 标题 /
/// 内容 / 时间 / 已读状态，未读高亮（标题加粗 + 未读圆点）。
///
/// 操作：
/// - 点击未读条目 → PUT history/:id/read 标为已读（本地即时更新 UI）；
/// - AppBar「全部已读」→ 后端无批量端点，逐条调用单条已读接口
///   （部分失败时成功的仍生效，失败经 SnackBar 提示）。
///
/// 三态：SkeletonList（加载中）/ ErrorState（失败可重试，文案
/// notifLoadFailed）/ EmptyState（noNotifications），支持下拉刷新。
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final NotificationsApiService _api = NotificationsApiService();

  List<NotificationItem> _items = <NotificationItem>[];
  bool _isLoading = false;
  bool _markingAll = false;

  /// 最近一次加载失败的原始错误对象（UI 层经 friendlyError 映射 l10n 文案）
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final items = await _api.fetchHistory();
      if (!mounted) {
        return;
      }
      setState(() {
        _items = items;
        _isLoading = false;
      });
    } on Exception catch (e) {
      if (!mounted) {
        return;
      }
      setState(() {
        _isLoading = false;
        _error = e;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 已读操作
  // ---------------------------------------------------------------------------

  /// 点击条目标为已读（已读条目点击无操作）。
  Future<void> _markRead(NotificationItem item) async {
    if (item.isRead) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    try {
      await _api.markRead(item.id);
      if (!mounted) {
        return;
      }
      setState(() {
        _items = _items
            .map((NotificationItem n) => n.id == item.id ? n.markedRead() : n)
            .toList();
      });
    } on Exception catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(friendlyError(e, l10n))),
      );
    }
  }

  /// 全部已读：后端无批量端点，逐条调用单条已读接口。
  /// 部分失败时成功的仍生效，失败经 SnackBar 提示。
  Future<void> _markAllRead() async {
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    final List<NotificationItem> unread =
        _items.where((NotificationItem n) => !n.isRead).toList();
    if (unread.isEmpty) {
      return;
    }
    setState(() => _markingAll = true);
    Object? firstError;
    final List<String> failedIds = <String>[];
    for (final NotificationItem item in unread) {
      try {
        await _api.markRead(item.id);
      } on Exception catch (e) {
        failedIds.add(item.id);
        firstError ??= e;
      }
    }
    if (!mounted) {
      return;
    }
    setState(() {
      _markingAll = false;
      _items = _items
          .map(
            (NotificationItem n) =>
                (!n.isRead && !failedIds.contains(n.id)) ? n.markedRead() : n,
          )
          .toList();
    });
    if (firstError != null) {
      messenger.showSnackBar(
        SnackBar(content: Text(friendlyError(firstError, l10n))),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final bool hasUnread = _items.any((NotificationItem n) => !n.isRead);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.notificationsCenter),
        actions: <Widget>[
          if (hasUnread)
            TextButton(
              onPressed: _markingAll ? null : _markAllRead,
              child: _markingAll
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(l10n.markAllRead),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading && _items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xl),
          SkeletonList(itemCount: 6),
        ],
      );
    }
    if (_error != null && _items.isEmpty) {
      final l10n = AppLocalizations.of(context);
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          ErrorState(
            message: friendlyError(_error!, l10n),
            onRetry: _load,
          ),
        ],
      );
    }
    if (_items.isEmpty) {
      final l10n = AppLocalizations.of(context);
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          EmptyState(
            icon: Icons.notifications_none,
            title: l10n.noNotifications,
          ),
        ],
      );
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.lg),
      itemCount: _items.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: AppSpacing.md),
      itemBuilder: (BuildContext context, int index) =>
          _buildNotificationCard(_items[index]),
    );
  }

  Widget _buildNotificationCard(NotificationItem item) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final bool unread = !item.isRead;

    return AppCard(
      onTap: unread ? () => unawaited(_markRead(item)) : null,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: unread ? scheme.primaryContainer : scheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(AppRadius.sm),
            ),
            child: Icon(
              _typeIcon(item.notificationType),
              size: 20,
              color: unread ? scheme.onPrimaryContainer : scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  item.title,
                  style: unread
                      ? theme.textTheme.titleSmall
                      : theme.textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (item.content != null && item.content!.trim().isNotEmpty) ...<Widget>[
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    item.content!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: AppSpacing.sm),
                Text(
                  _formatTime(l10n, item),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          if (unread) ...<Widget>[
            const SizedBox(width: AppSpacing.sm),
            Tooltip(
              message: l10n.markRead,
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: scheme.primary,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 通知类型 → 图标（对齐后端 notification_type 预置值）
  IconData _typeIcon(String type) {
    switch (type) {
      case 'sync_complete':
        return Icons.sync;
      case 'device_online':
        return Icons.devices;
      case 'subscription_expiring':
        return Icons.workspace_premium;
      case 'security_alert':
        return Icons.security;
      default:
        return Icons.notifications;
    }
  }

  /// 时间展示：优先 sent_at，缺失回退 created_at
  String _formatTime(AppLocalizations l10n, NotificationItem item) {
    final DateTime? time = item.sentAt ?? item.createdAt;
    if (time == null) {
      return '';
    }
    final diff = DateTime.now().difference(time);
    if (diff.inMinutes < 1) {
      return l10n.relJustNow;
    }
    if (diff.inHours < 1) {
      return l10n.relMinutesAgo(diff.inMinutes);
    }
    if (diff.inDays < 1) {
      return l10n.relHoursAgo(diff.inHours);
    }
    if (diff.inDays < 7) {
      return l10n.relDaysAgo(diff.inDays);
    }
    return l10n.relDateYMD(time.year, time.month, time.day);
  }
}
