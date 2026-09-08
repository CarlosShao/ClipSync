import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/announcements_api_service.dart';
import '../../services/app_exception.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/skeleton_list.dart';

/// 系统公告页（CO-35 / Obsidian v2）。
///
/// 展示 `GET /api/app/announcements` 返回的公告（服务端已按当前用户受众
/// 过滤；未登录仅 audience='all'）：
/// - 列表卡片：display_mode 徽标（once / persistent）+ 标题 + 内容预览 + 时间；
/// - once 公告打开详情即上报已读回执（POST read，服务端幂等），
///   persistent 公告常驻展示、无已读语义；
/// - 已读状态仅本页内存标记（不做本地持久化，「只显示一次」的隐藏策略
///   由后续工单决定，本轮保持简单）。
class AnnouncementsScreen extends StatefulWidget {
  const AnnouncementsScreen({super.key});

  @override
  State<AnnouncementsScreen> createState() => _AnnouncementsScreenState();
}

class _AnnouncementsScreenState extends State<AnnouncementsScreen> {
  final AnnouncementsApiService _api = AnnouncementsApiService();

  List<Announcement> _items = <Announcement>[];
  bool _isLoading = false;

  /// once 公告本页已读标记（打开详情成功回执后置位，仅视觉态）
  final Set<String> _readIds = <String>{};

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
      final items = await _api.fetchAnnouncements();
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

  /// once 公告已读回执（点开即标记，尽力而为：未登录/网络失败仅提示，
  /// 不打断详情阅读；服务端 PK 幂等，重复上报无副作用）。
  Future<void> _markReadIfNeeded(Announcement item) async {
    if (!item.isOnce || _readIds.contains(item.id)) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    final ok = await _api.markRead(item.id);
    if (!mounted) {
      return;
    }
    if (ok) {
      setState(() => _readIds.add(item.id));
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.announcementMarkReadFailed)),
      );
    }
  }

  /// 打开公告详情（模态对话框）：once 公告在打开的同时上报已读回执。
  void _openDetail(Announcement item) {
    unawaited(_markReadIfNeeded(item));
    final theme = Theme.of(context);
    showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) {
        final dialogL10n = AppLocalizations.of(dialogContext);
        return AlertDialog(
          shape: AppShapesV2.shapeXl,
          title: Text(item.title),
          content: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  _formatTime(dialogL10n, item.sentAt),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                SelectableText(
                  item.content,
                  style: theme.textTheme.bodyMedium?.copyWith(height: 1.5),
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(dialogL10n.confirm),
            ),
          ],
        );
      },
    );
  }

  String _formatTime(AppLocalizations l10n, DateTime? time) {
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

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.announcements),
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
          SkeletonList(itemCount: 4),
        ],
      );
    }
    if (_error != null && _items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[
          const SizedBox(height: AppSpacing.xxl),
          ErrorState(
            title: l10n.announcementsLoadFailed,
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
            icon: Icons.campaign_outlined,
            title: l10n.noAnnouncements,
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
          _buildAnnouncementCard(_items[index]),
    );
  }

  /// 公告卡片：display_mode 徽标 + 标题 + 内容预览（2 行）+ 时间，
  /// once 公告未读时品牌紫高亮（点开详情上报回执后回落普通态）。
  Widget _buildAnnouncementCard(Announcement item) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final l10n = AppLocalizations.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final bool unread = item.isOnce && !_readIds.contains(item.id);
    final Color brandPurple = isDark
        ? AppColorsV2.brandPrimaryDark
        : AppColorsV2.brandPrimaryLight;
    final String modeLabel = item.isOnce
        ? l10n.announcementOnce
        : l10n.announcementPersistent;

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
      onTap: () => _openDetail(item),
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
                  color: brandPurple.withValues(alpha: unread ? 0.16 : 0.08),
                  borderRadius: AppShapesV2.brPill,
                ),
                child: Text(
                  modeLabel,
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: brandPurple,
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
          if (item.content.trim().isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.xs),
            Text(
              item.content,
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
                _formatTime(l10n, item.sentAt),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
