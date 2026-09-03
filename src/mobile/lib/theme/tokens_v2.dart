import 'package:flutter/material.dart';

/// 表面层级枚举（Obsidian v2 tonal 体系，替代阴影）。
enum SurfaceTier {
  /// 基础屏底色（亮 #FAFAFA / 暗 #0E0E10）
  base,

  /// 卡片底色（亮 #FFFFFF / 暗 #1A1A1E）
  low,

  /// 浮层/弹层底色（亮 #FFFFFF / 暗 #232328）
  mid,

  /// 悬浮控件/选中底（亮 #F4F4F5 / 暗 #2C2C32）
  high,

  /// 最高强调面（亮 #E4E4E7 / 暗 #36363E）
  highest,
}

/// ClipSync 设计系统 v2 (Obsidian) — 色彩 Token。
abstract final class AppColorsV2 {
  // ---------------------------------------------------------------------------
  // 品牌色
  // ---------------------------------------------------------------------------

  /// 品牌种子色（不变：#5A4BD1）。
  static const Color brandSeed = Color(0xFF5A4BD1);

  /// 亮色品牌强调色（= [brandSeed]）。
  static const Color brandPrimaryLight = Color(0xFF5A4BD1);

  /// 暗色品牌强调色（提亮以确保对比度 ≥4.5:1）。
  static const Color brandPrimaryDark = Color(0xFFC3B6FF);

  // ---------------------------------------------------------------------------
  // 表面层级（tonal，替代阴影，暗色优先设计）
  // ---------------------------------------------------------------------------

  /// 亮色 — surfaceBase: 页面底色 (#FAFAFA)。
  static const Color surfaceBaseLight = Color(0xFFFAFAFA);

  /// 暗色 — surfaceBase: 页面底色 (#0E0E10)。
  static const Color surfaceBaseDark = Color(0xFF0E0E10);

  /// 亮色 — surfaceLow: 卡片底色 (#FFFFFF)。
  static const Color surfaceLowLight = Color(0xFFFFFFFF);

  /// 暗色 — surfaceLow: 卡片底色 (#1A1A1E)。
  static const Color surfaceLowDark = Color(0xFF1A1A1E);

  /// 亮色 — surfaceMid: 浮层/弹层 (#FFFFFF)。
  static const Color surfaceMidLight = Color(0xFFFFFFFF);

  /// 暗色 — surfaceMid: 浮层/弹层 (#232328)。
  static const Color surfaceMidDark = Color(0xFF232328);

  /// 亮色 — surfaceHigh: 悬浮控件/选中底 (#F4F4F5)。
  static const Color surfaceHighLight = Color(0xFFF4F4F5);

  /// 暗色 — surfaceHigh: 悬浮控件/选中底 (#2C2C32)。
  static const Color surfaceHighDark = Color(0xFF2C2C32);

  /// 亮色 — surfaceHighest: 最高强调面 (#E4E4E7)。
  static const Color surfaceHighestLight = Color(0xFFE4E4E7);

  /// 暗色 — surfaceHighest: 最高强调面 (#36363E)。
  static const Color surfaceHighestDark = Color(0xFF36363E);

  /// 根据 [BuildContext] 与 [SurfaceTier] 获取对应表面色。
  static Color surface(BuildContext context, {required SurfaceTier tier}) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return surfaceFor(tier: tier, isDark: isDark);
  }

  /// 根据明暗状态与 [SurfaceTier] 获取对应表面色。
  static Color surfaceFor({required SurfaceTier tier, required bool isDark}) {
    if (isDark) {
      return switch (tier) {
        SurfaceTier.base => surfaceBaseDark,
        SurfaceTier.low => surfaceLowDark,
        SurfaceTier.mid => surfaceMidDark,
        SurfaceTier.high => surfaceHighDark,
        SurfaceTier.highest => surfaceHighestDark,
      };
    } else {
      return switch (tier) {
        SurfaceTier.base => surfaceBaseLight,
        SurfaceTier.low => surfaceLowLight,
        SurfaceTier.mid => surfaceMidLight,
        SurfaceTier.high => surfaceHighLight,
        SurfaceTier.highest => surfaceHighestLight,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 类型识别色（fixed，6 色，独立明暗版本，暗色提亮 +20% L，不随 seed 变）
  // ---------------------------------------------------------------------------

  /// 文本类型识别色（亮色：#7C6FE8）。
  static const Color typeTextLight = Color(0xFF7C6FE8);

  /// 文本类型识别色（暗色提亮：#A78BFA）。
  static const Color typeTextDark = Color(0xFFA78BFA);

  /// 链接类型识别色（亮色：#0EA5E9）。
  static const Color typeLinkLight = Color(0xFF0EA5E9);

  /// 链接类型识别色（暗色提亮：#38BDF8）。
  static const Color typeLinkDark = Color(0xFF38BDF8);

  /// 图片类型识别色（亮色：#F59E0B）。
  static const Color typeImageLight = Color(0xFFF59E0B);

  /// 图片类型识别色（暗色提亮：#FBBF24）。
  static const Color typeImageDark = Color(0xFFFBBF24);

  /// 文件类型识别色（亮色：#EC4899）。
  static const Color typeFileLight = Color(0xFFEC4899);

  /// 文件类型识别色（暗色提亮：#F472B6）。
  static const Color typeFileDark = Color(0xFFF472B6);

  /// 颜色类型识别色（亮色：#14B8A6）。
  static const Color typeColorLight = Color(0xFF14B8A6);

  /// 颜色类型识别色（暗色提亮：#2DD4BF）。
  static const Color typeColorDark = Color(0xFF2DD4BF);

  /// 代码类型识别色（亮色：#64748B）。
  static const Color typeCodeLight = Color(0xFF64748B);

  /// 代码类型识别色（暗色提亮：#94A3B8）。
  static const Color typeCodeDark = Color(0xFF94A3B8);

  /// 根据内容类型字符串 ('text', 'link', 'image', 'file', 'color', 'code') 获取对应的语义色。
  static Color getColorForType(String type, bool isDark) {
    return switch (type.toLowerCase().trim()) {
      'text' => isDark ? typeTextDark : typeTextLight,
      'link' || 'url' => isDark ? typeLinkDark : typeLinkLight,
      'image' || 'img' => isDark ? typeImageDark : typeImageLight,
      'file' => isDark ? typeFileDark : typeFileLight,
      'color' => isDark ? typeColorDark : typeColorLight,
      'code' => isDark ? typeCodeDark : typeCodeLight,
      _ => isDark ? typeTextDark : typeTextLight,
    };
  }

  /// 快捷通过 [BuildContext] 获取内容类型的语义色。
  static Color colorForType(BuildContext context, String type) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return getColorForType(type, isDark);
  }

  // ---------------------------------------------------------------------------
  // 安全语义（1Password Knox 模式）与危险色
  // ---------------------------------------------------------------------------

  /// Knox 安全强调色（石墨色 #64748B，安全态不使用品牌紫）。
  static const Color secureAccent = Color(0xFF64748B);

  /// 危险色（亮色底 #DC2626）。
  static const Color dangerLight = Color(0xFFDC2626);

  /// 危险色（暗色底 #F87171）。
  static const Color dangerDark = Color(0xFFF87171);

  /// 默认危险色。
  static const Color danger = dangerLight;

  /// 根据明暗模式获取危险色。
  static Color dangerFor({required bool isDark}) => isDark ? dangerDark : dangerLight;

  /// 快捷通过 [BuildContext] 获取危险色。
  static Color dangerColor(BuildContext context) =>
      dangerFor(isDark: Theme.of(context).brightness == Brightness.dark);

  // ---------------------------------------------------------------------------
  // 动效与边框
  // ---------------------------------------------------------------------------

  /// 同步脉冲光晕色（品牌紫 12% 透明度，一次性 300ms）。
  static const Color syncGlow = Color(0x1F5A4BD1);

  /// 亮色描边 (#E4E4E7)。
  static const Color borderLight = Color(0xFFE4E4E7);

  /// 暗色描边 (#2A2A30)。
  static const Color borderDark = Color(0xFF2A2A30);

  /// 根据明暗模式获取描边色。
  static Color borderFor({required bool isDark}) => isDark ? borderDark : borderLight;

  /// 快捷通过 [BuildContext] 获取描边色。
  static Color borderColor(BuildContext context) =>
      borderFor(isDark: Theme.of(context).brightness == Brightness.dark);
}

/// ClipSync 设计系统 v2 (Obsidian) — 形状与圆角 Token (M3E corner scale)。
abstract final class AppShapesV2 {
  /// 8.0 — Chip、小徽章、骨架块。
  static const double xs = 8;

  /// 12.0 — 按钮、输入框、嵌入缩略图。
  static const double sm = 12;

  /// 16.0 — 标准卡片、列表项容器。
  static const double md = 16;

  /// 20.0 — 大卡片、NavigationBar 指示器。
  static const double lg = 20;

  /// 28.0 — 对话框、底部弹层、全屏 sheet（M3E extra-large）。
  static const double xl = 28;

  /// 999.0 — FAB、类型徽章、搜索栏胶囊形。
  static const double pill = 999;

  // Radius 常量
  static const Radius rXs = Radius.circular(xs);
  static const Radius rSm = Radius.circular(sm);
  static const Radius rMd = Radius.circular(md);
  static const Radius rLg = Radius.circular(lg);
  static const Radius rXl = Radius.circular(xl);
  static const Radius rPill = Radius.circular(pill);

  // BorderRadius 常量
  static const BorderRadius brXs = BorderRadius.all(rXs);
  static const BorderRadius brSm = BorderRadius.all(rSm);
  static const BorderRadius brMd = BorderRadius.all(rMd);
  static const BorderRadius brLg = BorderRadius.all(rLg);
  static const BorderRadius brXl = BorderRadius.all(rXl);
  static const BorderRadius brPill = BorderRadius.all(rPill);

  // RoundedRectangleBorder 常量
  static const RoundedRectangleBorder shapeXs = RoundedRectangleBorder(borderRadius: brXs);
  static const RoundedRectangleBorder shapeSm = RoundedRectangleBorder(borderRadius: brSm);
  static const RoundedRectangleBorder shapeMd = RoundedRectangleBorder(borderRadius: brMd);
  static const RoundedRectangleBorder shapeLg = RoundedRectangleBorder(borderRadius: brLg);
  static const RoundedRectangleBorder shapeXl = RoundedRectangleBorder(borderRadius: brXl);
  static const RoundedRectangleBorder shapePill = RoundedRectangleBorder(borderRadius: brPill);
}

/// ClipSync 设计系统 v2 (Obsidian) — 动效与时长 Token。
abstract final class AppMotionV2 {
  // ---------------------------------------------------------------------------
  // Easing 曲线 Token
  // ---------------------------------------------------------------------------

  /// 位移类默认：emphasized Cubic(0.2, 0.0, 0.0, 1.0)。
  static const Curve emphasized = Cubic(0.2, 0, 0, 1);

  /// 入场动效：decelerateE Cubic(0.05, 0.7, 0.1, 1.0)。
  static const Curve decelerateE = Cubic(0.05, 0.7, 0.1, 1);

  /// 出场动效：accelerateE Cubic(0.3, 0.0, 0.8, 0.15)。
  static const Curve accelerateE = Cubic(0.3, 0, 0.8, 0.15);

  /// swipe / 微交互物理弹簧 (stiffness: 400.0, damping: 28.0)。
  static const SpringDescription spring = SpringDescription(
    mass: 1,
    stiffness: 400,
    damping: 28,
  );

  /// 庆祝时刻物理弹簧，如同步成功微动效 (damping: 18.2)。
  static const SpringDescription springBouncy = SpringDescription(
    mass: 1,
    stiffness: 400,
    damping: 18.2,
  );

  // ---------------------------------------------------------------------------
  // 时长体系 Token
  // ---------------------------------------------------------------------------

  /// 100ms — 色彩/透明度切换。
  static const Duration micro = Duration(milliseconds: 100);

  /// 150ms — 按压反馈。
  static const Duration fast = Duration(milliseconds: 150);

  /// 200ms — 选中态/常规状态过渡。
  static const Duration normal = Duration(milliseconds: 200);

  /// 350ms — 面板与弹层出入场。
  static const Duration slow = Duration(milliseconds: 350);

  /// 450ms — 容器变换、大面板过渡。
  static const Duration morph = Duration(milliseconds: 450);
}

/// ClipSync 设计系统 v2 (Obsidian) — 层级与 Elevation Token。
abstract final class AppElevationV2 {
  /// 0.0 — 基础屏、标准卡片（纯 tonal 层次）。
  static const double flat = 0;

  /// 3.0 — 浮动控件（FAB、悬浮工具条、拖拽中的卡片）。
  static const double floating = 3;

  /// 6.0 — 弹出菜单、下拉浮层。
  static const double popover = 6;
}
