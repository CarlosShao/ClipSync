import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../providers/auth_provider.dart';
import '../../providers/ws_provider.dart';
import '../../router/app_router.dart';
import '../../services/sessions_api_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common/app_card.dart';
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/error_state.dart';
import '../../widgets/common/section_header.dart';
import '../../widgets/common/skeleton_list.dart';

/// 会话区块加载阶段：加载中 / 就绪 / 出错（空态由就绪阶段下空列表表达）。
enum _SessionsPhase { loading, ready, error }

/// 活跃会话管理区块（T4.3）。
///
/// 挂载于设备 tab 设备列表下方（home_screen.dart 的 [DevicesTab]），
/// 自管理数据与状态，消费 [SessionsApiService]：
/// - 列表项：设备名 + 最近活跃时间/IP + 「当前」会话标记；
/// - 每项支持吊销单个会话（带确认对话框）；
/// - 吊销当前会话 = 退出登录效果：服务端已将该会话 jti 拉黑（access token
///   立即失效），客户端同步清空本地凭证并断开 WS，go_router 守卫跳回登录页；
/// - 空态 / 加载骨架 / 错误重试三态复用 `lib/widgets/common/` 组件。
class SessionsSection extends StatefulWidget {
  const SessionsSection({super.key});

  @override
  State<SessionsSection> createState() => _SessionsSectionState();
}

class _SessionsSectionState extends State<SessionsSection> {
  final SessionsApiService _service = SessionsApiService();

  _SessionsPhase _phase = _SessionsPhase.loading;
  List<ActiveSession> _sessions = const <ActiveSession>[];

  /// 加载失败的展示文案（错误态）
  String _errorMessage = '';

  /// 正在吊销的会话 id（行内转圈，防重复提交）
  String? _revokingId;

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  /// 拉取活跃会话列表（进入区块与手动刷新共用）。
  Future<void> _loadSessions() async {
    setState(() {
      _phase = _SessionsPhase.loading;
      _errorMessage = '';
    });
    try {
      final List<ActiveSession> sessions = await _service.listSessions();
      if (!mounted) return;
      setState(() {
        _sessions = sessions;
        _phase = _SessionsPhase.ready;
      });
    } on Exception catch (e) {
      debugPrint('[SessionsSection] load sessions failed: $e');
      if (!mounted) return;
      setState(() {
        _errorMessage = '会话列表加载失败，请检查网络后重试';
        _phase = _SessionsPhase.error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final TextTheme textTheme = Theme.of(context).textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SectionHeader(
          title: '活跃会话',
          subtitle: '已登录本账号的设备会话，可远程吊销下线',
          trailing: IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: '刷新会话',
            onPressed:
                _phase == _SessionsPhase.loading ? null : _loadSessions,
          ),
        ),
        if (_phase == _SessionsPhase.loading)
          const SkeletonList(itemCount: 2, padding: EdgeInsets.zero)
        else if (_phase == _SessionsPhase.error)
          ErrorState(
            icon: Icons.phonelink_off,
            message: _errorMessage,
            onRetry: _loadSessions,
          )
        else if (_sessions.isEmpty)
          const EmptyState(
            icon: Icons.devices_other,
            title: '暂无活跃会话',
            message: '当前账号没有活跃的登录会话',
          )
        else
          for (final ActiveSession session in _sessions)
            _buildSessionCard(session, textTheme),
      ],
    );
  }

  /// 单条会话卡片：平台图标 + 设备名（含当前标记）+ 最近活跃信息 + 吊销操作。
  Widget _buildSessionCard(ActiveSession session, TextTheme textTheme) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final bool revoking = _revokingId == session.id;

    return AppCard(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Row(
        children: <Widget>[
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHigh,
              shape: BoxShape.circle,
            ),
            child: Icon(
              _platformIcon(session.platform),
              size: 20,
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        session.deviceName,
                        style: textTheme.titleSmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (session.isCurrent) ...<Widget>[
                      const SizedBox(width: AppSpacing.sm),
                      _CurrentSessionBadge(textTheme: textTheme),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  _sessionSubtitle(session),
                  style: textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          _buildRevokeAction(session, revoking),
        ],
      ),
    );
  }

  /// 吊销操作：进行中显示小转圈，否则显示吊销按钮（危险色）。
  Widget _buildRevokeAction(ActiveSession session, bool revoking) {
    if (revoking) {
      return const SizedBox(
        width: 24,
        height: 24,
        child: Padding(
          padding: EdgeInsets.all(AppSpacing.xs),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    return IconButton(
      icon: const Icon(Icons.logout),
      tooltip: session.isCurrent ? '吊销当前会话' : '吊销会话',
      color: Theme.of(context).colorScheme.error,
      onPressed: () => _confirmRevoke(session),
    );
  }

  /// 吊销确认对话框：当前会话给出「将退出登录」的强提示。
  Future<void> _confirmRevoke(ActiveSession session) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(session.isCurrent ? '吊销当前会话' : '吊销会话'),
        content: Text(
          session.isCurrent
              ? '「${session.deviceName}」是当前设备。\n'
                  '吊销后本机将立即退出登录，需要重新验证码登录。确定吊销吗？'
              : '确定吊销「${session.deviceName}」的会话吗？'
                  '吊销后该设备将被强制下线。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            child: const Text('吊销'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    await _revoke(session);
  }

  /// 执行吊销：
  /// - 其他设备会话 → 成功后本地乐观移除该行并提示；
  /// - 当前会话 → 服务端已拉黑本机 access token（jti 黑名单），同步
  ///   「退出登录」：断开 WS、清空本地凭证（AuthProvider.logout）并
  ///   跳回登录页，效果与设置页退出登录一致。
  Future<void> _revoke(ActiveSession session) async {
    if (!mounted) return;
    setState(() => _revokingId = session.id);

    try {
      await _service.revokeSession(session.id);
    } on Exception catch (e) {
      debugPrint('[SessionsSection] revoke session failed: $e');
      if (!mounted) return;
      setState(() => _revokingId = null);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('吊销失败，请稍后重试')));
      return;
    }

    if (session.isCurrent) {
      final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
      final AuthProvider auth = context.read<AuthProvider>();
      context.read<WsProvider>().disconnect();
      await auth.logout();
      if (mounted) {
        // 守卫兜底跳转（与设置页退出登录流程一致）；若 router 已因
        // logout 触发重定向导致本组件卸载，则跳过即可
        context.go(AppRoutes.login);
      }
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(content: Text('当前会话已吊销，已退出登录')),
        );
      return;
    }

    if (!mounted) return;
    setState(() {
      _sessions = _sessions
          .where((ActiveSession item) => item.id != session.id)
          .toList();
      _revokingId = null;
    });
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text('已吊销「${session.deviceName}」的会话')),
      );
  }

  /// 副标题：最近活跃时间（相对时间，过旧回退日期）+ 来源 IP。
  static String _sessionSubtitle(ActiveSession session) {
    final StringBuffer buffer = StringBuffer('最近活跃 ');
    buffer.write(_relativeTime(session.lastActiveAt));
    if (session.ipAddress.isNotEmpty) {
      buffer.write(' · ${session.ipAddress}');
    }
    return buffer.toString();
  }

  /// 相对时间文案；服务端当前以 created_at 充当最近活跃时间。
  static String _relativeTime(DateTime? time) {
    if (time == null) {
      return '未知';
    }
    final Duration elapsed = DateTime.now().difference(time);
    // 服务器时钟略超前时差值为负，按「刚刚」处理
    if (elapsed < const Duration(minutes: 1)) {
      return '刚刚';
    }
    if (elapsed < const Duration(hours: 1)) {
      return '${elapsed.inMinutes} 分钟前';
    }
    if (elapsed < const Duration(hours: 24)) {
      return '${elapsed.inHours} 小时前';
    }
    if (elapsed < const Duration(days: 30)) {
      return '${elapsed.inDays} 天前';
    }
    final DateTime local = time.toLocal();
    final String month = local.month.toString().padLeft(2, '0');
    final String day = local.day.toString().padLeft(2, '0');
    return '${local.year}-$month-$day';
  }

  /// 平台 → 图标（后端 platform 取 device_type/platform，见 sessions.js:40）。
  static IconData _platformIcon(String platform) {
    final String p = platform.toLowerCase();
    if (p.contains('android') ||
        p.contains('ios') ||
        p.contains('mobile') ||
        p.contains('phone')) {
      return Icons.smartphone;
    }
    if (p.contains('windows') ||
        p.contains('macos') ||
        p.contains('mac') ||
        p.contains('linux') ||
        p.contains('desktop')) {
      return Icons.computer;
    }
    if (p.contains('web') || p.contains('browser')) {
      return Icons.language;
    }
    return Icons.devices_other;
  }
}

/// 「当前」会话小徽标。
class _CurrentSessionBadge extends StatelessWidget {
  const _CurrentSessionBadge({required this.textTheme});

  final TextTheme textTheme;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Text(
        '当前',
        style: textTheme.labelSmall?.copyWith(color: scheme.onPrimaryContainer),
      ),
    );
  }
}
