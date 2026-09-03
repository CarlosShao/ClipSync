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

/// 通知中心页（C5 / Obsidian v2）。
///
/// 展示站内通知历史：
/// - 消息分类卡片（AppCard v2 + SurfaceTier.low）；
/// - 未读高亮点（品牌紫 #5A4BD1 / #C3B6FF）与渐变顶边；
/// - 相对时间展示；
/// - AppBar 提供「全部已读」与「一键清空」操作。
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
  // 已读与清空操作
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

  /// 一键清空通知列表（确认对话框采用 AppShapesV2.xl 28dp）。
  Future<void> _clearAll() async {
    final l10n = AppLocalizations.of(context);
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        final dialogL10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          shape: AppShapesV2.shapeXl,
          title: Text(dialogL10n.clearAll),
          content: Text(dialogL10n.clearCacheDesc),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(dialogL10n.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(
                dialogL10n.clearAll,
                style: TextStyle(
                  color: Theme.of(dialogContext).colorScheme.error,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        );
      },
    );

    if (confirmed != true || !mounted) {
      return;
    }

    // 后端标记已读并清空本地展示
    final List<NotificationItem> unread =
        _items.where((NotificationItem n) => !n.isRead).toList();
    for (final NotificationItem item in unread) {
      unawaited(_api.markRead(item.id).catchError((_) {}));
    }

    setState(() {
      _items = <NotificationItem>[];
    });

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(l10n.clearAll),
        duration: const Duration(seconds: 2),
      ),
    );
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
          if (_items.isNotEmpty)
            PopupMenuButton<String>(
              shape: AppShapesV2.shapeMd,
              icon: const Icon(Icons.more_vert_rounded),
              itemBuilder: (BuildContext menuContext) =>
                  <PopupMenuEntry<String>>[
                PopupMenuItem<String>(
                  value: 'clear',
                  child: Row(
                    children: <Widget>[
                      Icon(
                        Icons.delete_sweep_outlined,
                        size: 20,
                        color: Theme.of(context).colorScheme.error,
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Text(
                        l10n.clearAll,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              onSelected: (String action) {
                if (action == 'clear') {
                  unawaited(_clearAll());
                }
              },
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
    final l10n = AppLocalizations.of(context);

    if (_isLoading && _items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const <Widget>[
          SizedBox(height: AppSpacing.xl),
          SkeletonList(itemCount: 6),
        ],
      );
    }
    if (_error != null && _items.isEmpty) {
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
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          EmptyState(
            illustration: EmptyStateIllustration.generic,
            icon: Icons.notifications_none_rounded,
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

  /// 消息分类卡片 (Obsidian v2)：
  /// - AppCard v2 (SurfaceTier.low)；
  /// - 未读高亮点（品牌紫 #5A4BD1 / #C3B6FF）；
  /// - 相对时间展示与分类标签。
  Widget _buildNotificationCard(NotificationItem item) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final bool unread = !item.isRead;
    final Color brandPurple = isDark
        ? AppColorsV2.brandPrimaryDark
        : AppColorsV2.brandPrimaryLight;

    final (IconData iconData, Color categoryColor, String categoryLabel) =
        _resolveCategory(item.notificationType, isDark);

    return AppCard(
      surfaceTier: SurfaceTier.low,
      borderRadius: AppShapesV2.brMd,
      gradientLine: unread
          ? LinearGradient(
              colors: <Color>[
                brandPurple,
                brandPurple.withValues(alpha: 0.1),
              ],
            )
          : null,
      onTap: unread ? () => unawaited(_markRead(item)) : null,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // 类型图标
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: categoryColor.withValues(alpha: unread ? 0.16 : 0.08),
              borderRadius: AppShapesV2.brSm,
              border: Border.all(
                color: categoryColor.withValues(alpha: unread ? 0.35 : 0.15),
                width: 1.0,
              ),
            ),
            child: Icon(
              iconData,
              size: 20,
              color: categoryColor,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          // 标题、内容与分类
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: categoryColor.withValues(alpha: 0.12),
                        borderRadius: AppShapesV2.brPill,
                      ),
                      child: Text(
                        categoryLabel,
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          color: categoryColor,
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        item.title,
                        style: unread
                            ? theme.textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.w600,
                              )
                            : theme.textTheme.bodyMedium?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                if (item.content != null && item.content!.trim().isNotEmpty) ...<Widget>[
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    item.content!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                      height: 1.4,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: AppSpacing.sm),
                Row(
                  children: <Widget>[
                    Icon(
                      Icons.access_time_rounded,
                      size: 13,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      _formatTime(l10n, item),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          // 未读高亮点（品牌紫）
          if (unread) ...<Widget>[
            const SizedBox(width: AppSpacing.sm),
            Tooltip(
              message: l10n.markRead,
              child: Container(
                width: 9,
                height: 9,
                margin: const EdgeInsets.only(top: 4),
                decoration: BoxDecoration(
                  color: brandPurple,
                  shape: BoxShape.circle,
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: brandPurple.withValues(alpha: 0.45),
                      blurRadius: 6,
                      spreadRadius: 1,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 消息类型解析：图标 + 语义色 + 分类标签
  (IconData, Color, String) _resolveCategory(String type, bool isDark) {
    switch (type) {
      case 'sync_complete':
        return (
          Icons.sync_rounded,
          isDark ? AppColorsV2.typeTextDark : AppColorsV2.typeTextLight,
          '同步',
        );
      case 'device_online':
        return (
          Icons.devices_rounded,
          isDark ? AppColorsV2.typeLinkDark : AppColorsV2.typeLinkLight,
          '设备',
        );
      case 'subscription_expiring':
        return (
          Icons.workspace_premium_rounded,
          isDark ? AppColorsV2.typeImageDark : AppColorsV2.typeImageLight,
          '订阅',
        );
      case 'security_alert':
        return (
          Icons.security_rounded,
          isDark ? AppColorsV2.dangerDark : AppColorsV2.dangerLight,
          '安全',
        );
      default:
        return (
          Icons.notifications_rounded,
          isDark ? AppColorsV2.brandPrimaryDark : AppColorsV2.brandPrimaryLight,
          '通知',
        );
    }
  }

  /// 时间展示：相对时间与具体日期
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
