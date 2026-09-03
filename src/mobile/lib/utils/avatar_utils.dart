import 'dart:convert';

import 'package:flutter/material.dart';

/// 根据服务端 avatarUrl 构造可用的头像 ImageProvider。
///
/// 头像支持两种形态：
/// - base64 dataURL（`data:image/...;base64,...`，移动端/桌面端上传后存储），
///   用 [MemoryImage] 解码——避免 NetworkImage 无法加载 dataURL 导致头像
///   显示为纯色占位（设置页账号栏曾因此看不到头像）；
/// - 常规图片 URL（http/https）用 [NetworkImage]。
///
/// 空值或非法 dataURL 返回 null（由调用方回退到首字/图标占位）。
ImageProvider? avatarImageProvider(String? avatarUrl) {
  final source = (avatarUrl ?? '').trim();
  if (source.isEmpty) return null;

  if (source.startsWith('data:image/')) {
    final comma = source.indexOf(',');
    if (comma <= 0) return null;
    try {
      return MemoryImage(base64Decode(source.substring(comma + 1)));
    } catch (_) {
      return null;
    }
  }
  return NetworkImage(source);
}
