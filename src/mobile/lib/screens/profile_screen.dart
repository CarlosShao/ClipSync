import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import "package:clipsync_mobile/l10n/app_localizations.dart";
import "package:clipsync_mobile/providers/auth_provider.dart";
import "package:clipsync_mobile/services/profile_api_service.dart";
import "package:clipsync_mobile/theme/app_theme.dart";
import "package:clipsync_mobile/utils/avatar_utils.dart";
import "package:clipsync_mobile/widgets/common/app_card.dart";
import "package:clipsync_mobile/widgets/common/section_divider.dart";

/// 个人资料编辑页（对齐桌面端 ProfileView）。
///
/// - 头像：点击更换（相册选择 → 压缩 → base64 dataURL → PUT /api/auth/profile），
///   支持 dataURL（本端上传后）与网络 URL（服务端既有头像）两种展示；
/// - 昵称：点击弹编辑对话框，同步服务端；
/// - 手机号 / 邮箱 / 套餐：只读展示（邮箱/套餐变更走桌面端）。
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final ImagePicker _picker = ImagePicker();

  /// 本次会话内刚选中的头像 dataURL（未落服务端前先做本地预览）
  String? _pendingAvatarDataUrl;

  AuthProvider get _auth => context.read<AuthProvider>();

  /// 头像数据源：优先本地预览 dataURL → 服务端 avatarUrl（dataURL 或网络 URL）。
  ImageProvider? _avatarProvider(String? avatarUrl) {
    return avatarImageProvider(_pendingAvatarDataUrl ?? avatarUrl);
  }

  /// 根据文件名推断 mimeType（头像走 dataURL 上传时使用）。
  static String _mimeFromName(String name) {
    final lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
    return 'image/jpeg';
  }

  /// 从相册选择头像：压缩到 512×512 / 85% 质量，转 base64 dataURL，
  /// 本地预览 + 同步服务端 + 更新 AuthProvider.user。
  Future<void> _changeAvatar() async {
    final l10n = AppLocalizations.of(context);
    try {
      final picked = await _picker.pickImage(
        source: ImageSource.gallery,
        maxWidth: 512,
        maxHeight: 512,
        imageQuality: 85,
      );
      if (picked == null) return; // 用户取消

      final bytes = await picked.readAsBytes();
      final dataUrl =
          'data:${_mimeFromName(picked.name)};base64,${base64Encode(bytes)}';

      setState(() => _pendingAvatarDataUrl = dataUrl);

      final auth = _auth;
      await ProfileApiService().updateAvatar(auth.token, dataUrl);

      final currentUser = auth.user;
      if (currentUser != null) {
        final updated = Map<String, dynamic>.from(currentUser);
        updated['avatarUrl'] = dataUrl;
        auth.updateUser(updated);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.avatarUpdated)),
      );
    } catch (e) {
      debugPrint('[Profile] avatar upload failed: $e');
      if (!mounted) return;
      // 上传失败时回滚本地预览，避免界面与服务端不一致
      setState(() => _pendingAvatarDataUrl = null);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.avatarSaveFailed)),
      );
    }
  }

  /// 昵称编辑对话框——独立 StatefulWidget 自持 TextEditingController，
  /// 在自身 dispose() 中释放（避免弹窗退场动画期间 dispose 导致
  /// _dependents.isEmpty 框架断言崩溃）。
  Future<String?> _showEditNicknameDialog(String initial) async {
    final l10n = AppLocalizations.of(context);
    return showDialog<String>(
      context: context,
      builder: (_) => _NicknameEditDialog(
        initial: initial,
        l10n: l10n,
      ),
    );
  }

  Future<void> _editNickname() async {
    final auth = _auth;
    final current = ((auth.user?['nickname'] as String?) ?? '').trim();
    final nickname = await _showEditNicknameDialog(current);
    if (nickname == null || nickname == current || !mounted) return;

    final currentUser = auth.user;
    if (currentUser != null) {
      final updated = Map<String, dynamic>.from(currentUser);
      updated['nickname'] = nickname;
      auth.updateUser(updated);
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(AppLocalizations.of(context).nicknameSaved)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final user = context.watch<AuthProvider>().user;

    if (user == null) {
      return Scaffold(
        appBar: AppBar(title: Text(l10n.profileTitle)),
        body: Center(child: Text(l10n.notLoggedIn)),
      );
    }

    final nickname = ((user["nickname"] as String?) ?? "").trim();
    final phone = ((user["phone"] as String?) ?? "").trim();
    final email = ((user["email"] as String?) ?? "").trim();
    final avatarUrl = ((user["avatarUrl"] as String?) ?? "").trim();
    final plan = ((user["plan"] as String?) ?? "").trim();
    final display = nickname.isNotEmpty ? nickname : phone;

    final avatar = _avatarProvider(avatarUrl);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.profileTitle)),
      body: ListView(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.sm,
        ),
        children: [
          SectionDivider(title: l10n.accountSection),
          // 头像 + 资料卡片
          AppCard(
            surfaceTier: SurfaceTier.low,
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                // 头像区：居中展示 + 相机角标，点击更换
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.xl),
                  child: InkWell(
                    onTap: _changeAvatar,
                    customBorder: const CircleBorder(),
                    child: Stack(
                      alignment: Alignment.bottomRight,
                      children: [
                        CircleAvatar(
                          radius: 44,
                          backgroundColor: Theme.of(context).primaryColor,
                          backgroundImage: avatar,
                          child: avatar != null
                              ? null
                              : display.isEmpty
                                  ? const Icon(
                                      Icons.person_outline,
                                      color: Colors.white,
                                      size: 44,
                                    )
                                  : Text(
                                      String.fromCharCode(display.runes.first),
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontWeight: FontWeight.bold,
                                        fontSize: 30,
                                      ),
                                    ),
                        ),
                        // 相机角标（更换头像提示）
                        Container(
                          width: 28,
                          height: 28,
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.primary,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: Theme.of(context).colorScheme.surface,
                              width: 2,
                            ),
                          ),
                          child: const Icon(
                            Icons.photo_camera,
                            size: 14,
                            color: Colors.white,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                // 更换头像提示文字
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: Text(
                    l10n.changeAvatar,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                  ),
                ),
                const Divider(height: 1),
                // 昵称（可编辑）
                ListTile(
                  leading: const Icon(Icons.badge_outlined),
                  title: Text(l10n.nickname),
                  subtitle: Text(display.isEmpty ? l10n.notLoggedIn : display),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _editNickname,
                ),
                const Divider(height: 1),
                // 手机号（只读）
                ListTile(
                  leading: const Icon(Icons.phone_outlined),
                  title: Text(l10n.phoneNumber),
                  subtitle: Text(phone.isEmpty ? '-' : phone),
                ),
                const Divider(height: 1),
                // 邮箱（只读，变更走桌面端）
                ListTile(
                  leading: const Icon(Icons.mail_outline),
                  title: Text(l10n.email),
                  subtitle: Text(email.isEmpty ? '-' : email),
                ),
                const Divider(height: 1),
                // 套餐（只读徽标）
                ListTile(
                  leading: const Icon(Icons.workspace_premium_outlined),
                  title: Text(l10n.planLabel),
                  trailing: plan.isEmpty
                      ? null
                      : _PlanBadge(plan: plan),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
        ],
      ),
    );
  }
}

/// 套餐徽标小 Chip——Free（不区分大小写）灰色，付费套餐主题色。
class _PlanBadge extends StatelessWidget {
  const _PlanBadge({required this.plan});

  final String plan;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final TextTheme textTheme = Theme.of(context).textTheme;
    final bool isFree = plan.toLowerCase() == "free";
    final (Color background, Color foreground) = isFree
        ? (scheme.surfaceContainerHighest, scheme.onSurfaceVariant)
        : (scheme.primaryContainer, scheme.onPrimaryContainer);
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppShapesV2.sm),
      ),
      child: Text(
        plan,
        style: textTheme.labelSmall?.copyWith(
          color: foreground,
          fontWeight: FontWeight.w600,
        ),
        maxLines: 1,
      ),
    );
  }
}

/// 昵称编辑对话框：自持 TextEditingController，dispose 在自身生命周期内。
class _NicknameEditDialog extends StatefulWidget {
  const _NicknameEditDialog({required this.initial, required this.l10n});

  final String initial;
  final AppLocalizations l10n;

  @override
  State<_NicknameEditDialog> createState() => _NicknameEditDialogState();
}

class _NicknameEditDialogState extends State<_NicknameEditDialog> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initial);
  bool _saving = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final nickname = _controller.text.trim();
    if (nickname.isEmpty) return;

    setState(() => _saving = true);
    try {
      await ProfileApiService().updateNickname(null, nickname);
      if (!mounted) return;
      Navigator.pop(context, nickname);
    } catch (e) {
      debugPrint('[Profile] update nickname failed: $e');
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(widget.l10n.nicknameSaveFailed)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = widget.l10n;
    return AlertDialog(
      title: Text(l10n.editNickname),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLength: 30,
        decoration: InputDecoration(labelText: l10n.nickname),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context),
          child: Text(l10n.cancel),
        ),
        TextButton(
          onPressed: _saving ? null : _save,
          child: _saving
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(l10n.save),
        ),
      ],
    );
  }
}
