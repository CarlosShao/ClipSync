import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:receive_sharing_intent/receive_sharing_intent.dart';

import 'share_receive_screen.dart';

/// 系统分享面板接入（T3.5 分享接收）。
///
/// main.dart 启动时调用 [ShareIntentListener.start]：
/// - 冷启动被分享动作拉起：`getInitialMedia()` 取缓存的一次性数据；
/// - 运行中分享：`getMediaStream()` 持续监听；
/// - 任一来源拿到内容后 `reset()` 消费清空，并在路由就绪（已登录、进入
///   /home/** 主页）时 push `/share/receive` 确认页。
///
/// 路由就绪等待：冷启动时认证链路（splash → login/onboarding → home）需要
/// 数秒，期间路由守卫会把任意路由重定向走，因此轮询当前 location 直到进入
/// 主页再导航（上限 20s，超时丢弃并打日志）。
class ShareIntentListener {
  ShareIntentListener._();

  static final ShareIntentListener instance = ShareIntentListener._();

  GoRouter? _router;
  StreamSubscription<List<SharedMediaFile>>? _subscription;
  bool _started = false;

  void start(GoRouter router) {
    _router = router;
    if (_started) return;
    _started = true;

    // 冷启动携带的分享内容（App 被系统分享面板拉起）
    unawaited(_consumeInitialMedia());

    // 运行中的分享事件
    _subscription = ReceiveSharingIntent.instance.getMediaStream().listen(
      _handleMedia,
      onError: (Object e) => debugPrint('[ShareIntent] media stream error: $e'),
    );
  }

  Future<void> _consumeInitialMedia() async {
    try {
      final initial = await ReceiveSharingIntent.instance.getInitialMedia();
      if (initial.isNotEmpty) {
        await _handleMedia(initial);
      }
    } catch (e) {
      debugPrint('[ShareIntent] getInitialMedia failed: $e');
    }
  }

  Future<void> _handleMedia(List<SharedMediaFile> media) async {
    // 消费即清空，避免同一批分享重复弹出
    try {
      await ReceiveSharingIntent.instance.reset();
    } catch (_) {
      // 清空失败不影响本次处理
    }

    final payload = SharePayload.fromSharedMedia(media);
    if (payload.isEmpty) return;
    await _navigateWhenReady(payload);
  }

  Future<void> _navigateWhenReady(SharePayload payload) async {
    final router = _router;
    if (router == null) return;
    for (var i = 0; i < 40; i++) {
      final location = router.routeInformationProvider.value.uri.toString();
      if (location.startsWith('/home/')) {
        router.push('/share/receive', extra: payload);
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    debugPrint('[ShareIntent] 路由 20s 内未就绪（未登录或认证中），丢弃本次分享');
  }

  void dispose() {
    _subscription?.cancel();
    _subscription = null;
  }
}
