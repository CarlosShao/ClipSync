import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// ClipSync 设计系统 — 间距 Token。
///
/// 全部间距为 4 的倍数，构成统一节奏体系；
/// 页面与组件禁止出现魔数间距，优先引用这里的常量。
abstract final class AppSpacing {
  /// 4 — 极小间距（图标与文字间、元素内微调）。
  static const double xs = 4;

  /// 8 — 小间距（列表项内部行间、相关元素之间）。
  static const double sm = 8;

  /// 12 — 中间距（紧凑卡片内边距、筛选条内间隙）。
  static const double md = 12;

  /// 16 — 标准间距（页面水平边距、卡片内边距、列表项之间）。
  static const double lg = 16;

  /// 24 — 大间距（区块与区块之间）。
  static const double xl = 24;

  /// 32 — 特大间距（页面级分区、空状态上下留白）。
  static const double xxl = 32;
}

/// ClipSync 设计系统 — 圆角 Token。
///
/// 卡片类容器统一 12-16 圆角；小型元素（Chip、骨架块）用小圆角。
abstract final class AppRadius {
  /// 8 — 小圆角（Chip、骨架块、嵌入元素）。
  static const double sm = 8;

  /// 12 — 中圆角（按钮、输入框、弹层内嵌元素）。
  static const double md = 12;

  /// 16 — 大圆角（卡片、底部弹层、对话框、图片容器）。
  static const double lg = 16;
}

/// ClipSync 设计系统 — 动效时长 Token（克制原则：150-250ms）。
///
/// 任何自定义动画时长都应落在该区间内，引用这里的常量而非魔数。
abstract final class AppDurations {
  /// 150ms — 按压缩放、微交互反馈。
  static const Duration fast = Duration(milliseconds: 150);

  /// 200ms — 常规状态切换（选中态、颜色过渡）。
  static const Duration normal = Duration(milliseconds: 200);

  /// 250ms — 面板与弹层出入场。
  static const Duration slow = Duration(milliseconds: 250);
}

/// ClipSync 设计系统 — 语义状态色（亮/暗两套变体）。
///
/// 用于收藏、在线状态、错误提示等非品牌语义场景；
/// 不要用它们替代 [ColorScheme.primary] 做品牌强调。
abstract final class AppColors {
  /// 成功（亮色底）— 在线、同步完成。
  static const Color success = Color(0xFF16A34A);

  /// 成功（暗色底）。
  static const Color successDark = Color(0xFF4ADE80);

  /// 警告（亮色底）— 收藏星标、待处理。
  static const Color warning = Color(0xFFF59E0B);

  /// 警告（暗色底）。
  static const Color warningDark = Color(0xFFFBBF24);

  /// 危险（亮色底）— 删除、断开。
  static const Color danger = Color(0xFFDC2626);

  /// 危险（暗色底）。
  static const Color dangerDark = Color(0xFFF87171);
}

/// ClipSync 全局设计系统（Material 3 + shadcn 风格中性底）。
///
/// 设计原则：
/// - 中性底色 + 品牌紫点缀：亮色底 #FAFAFA / 暗色近黑 #0E0E10，
///   品牌色仅用于主按钮、选中态、焦点等强调位置。
/// - 卡片圆角 12-16、无阴影、1px 描边（见 [AppRadius]）。
/// - 文字四级阶梯：headline（页面大标题）/ title（区块与小标题）/
///   body（正文）/ caption（辅助说明），对应 [TextTheme] 各档。
/// - 克制动效：150-250ms（见 [AppDurations]）。
/// - 间距 4 的倍数体系（见 [AppSpacing]）。
///
/// 消费方式：`MaterialApp(theme: AppTheme.lightTheme, darkTheme: AppTheme.darkTheme)`。
/// 亮暗取色一律走 `Theme.of(context).colorScheme`，禁止页面内硬编码颜色。
abstract final class AppTheme {
  /// 品牌种子色（紫）。所有 ColorScheme 由它派生。
  static const Color seedColor = Color(0xFF5A4BD1);

  // ---------------------------------------------------------------------------
  // 兼容层：以下静态色供存量页面过渡期引用；Wave 2/3 页面重写后
  // 应改用 Theme.of(context).colorScheme，这些常量届时移除。
  // ---------------------------------------------------------------------------

  /// 品牌主色（= [seedColor]）。
  static const Color primaryColor = seedColor;

  /// 品牌浅紫（渐变辅助、暗色点缀）。
  static const Color primaryLight = Color(0xFF8C7AE6);

  /// 品牌深紫。
  static const Color primaryDark = Color(0xFF3D3399);

  /// 亮色页面底色（中性 #FAFAFA 系）。
  static const Color backgroundColor = Color(0xFFFAFAFA);

  /// 亮色卡片底色。
  static const Color cardColor = Colors.white;

  /// 亮色主文字。
  static const Color textPrimary = Color(0xFF18181B);

  /// 亮色次要文字。
  static const Color textSecondary = Color(0xFF52525B);

  /// 亮色分隔/描边。
  static const Color borderColor = Color(0xFFE4E4E7);

  /// 成功色（亮色底）。
  static const Color successColor = AppColors.success;

  /// 危险色（亮色底）。
  static const Color dangerColor = AppColors.danger;

  /// 警告色（亮色底）。
  static const Color warningColor = AppColors.warning;

  /// 暗色页面底色（近黑）。
  static const Color darkBackground = Color(0xFF0E0E10);

  /// 暗色面板底色。
  static const Color darkSurface = Color(0xFF17171A);

  /// 暗色卡片底色。
  static const Color darkCard = Color(0xFF1C1C1F);

  /// 暗色分隔/描边。
  static const Color darkBorder = Color(0xFF27272A);

  /// 暗色主文字。
  static const Color darkTextPrimary = Color(0xFFE4E4E7);

  /// 暗色次要文字。
  static const Color darkTextSecondary = Color(0xFFA1A1AA);

  /// 亮色主题。
  static ThemeData get lightTheme => _buildTheme(Brightness.light);

  /// 暗色主题。
  static ThemeData get darkTheme => _buildTheme(Brightness.dark);

  /// 亮色 [ColorScheme]：品牌紫直出 + 纯中性灰面层（zinc 系）。
  static ColorScheme _lightScheme() {
    return ColorScheme.fromSeed(
      seedColor: seedColor,
      brightness: Brightness.light,
    ).copyWith(
      primary: seedColor,
      onPrimary: Colors.white,
      primaryContainer: const Color(0xFFE7E3FB),
      onPrimaryContainer: const Color(0xFF1C1553),
      surface: const Color(0xFFFAFAFA),
      onSurface: const Color(0xFF18181B),
      surfaceContainerLowest: Colors.white,
      surfaceContainerLow: const Color(0xFFF5F5F6),
      surfaceContainer: const Color(0xFFF0F0F2),
      surfaceContainerHigh: const Color(0xFFEBEBED),
      surfaceContainerHighest: const Color(0xFFE4E4E7),
      onSurfaceVariant: const Color(0xFF52525B),
      outline: const Color(0xFFD4D4D8),
      outlineVariant: const Color(0xFFE4E4E7),
      error: const Color(0xFFDC2626),
      onError: Colors.white,
      errorContainer: const Color(0xFFFEE2E2),
      onErrorContainer: const Color(0xFF7F1D1D),
      inverseSurface: const Color(0xFF27272A),
      onInverseSurface: const Color(0xFFFAFAFA),
      inversePrimary: const Color(0xFFC4B9FF),
      scrim: Colors.black,
    );
  }

  /// 暗色 [ColorScheme]：近黑中性面层，品牌紫提亮保证对比度。
  static ColorScheme _darkScheme() {
    return ColorScheme.fromSeed(
      seedColor: seedColor,
      brightness: Brightness.dark,
    ).copyWith(
      primary: const Color(0xFFC3B6FF),
      onPrimary: const Color(0xFF2B1F6E),
      primaryContainer: const Color(0xFF413490),
      onPrimaryContainer: const Color(0xFFE5DEFF),
      surface: const Color(0xFF0E0E10),
      onSurface: const Color(0xFFE4E4E7),
      surfaceContainerLowest: const Color(0xFF0A0A0B),
      surfaceContainerLow: const Color(0xFF161619),
      surfaceContainer: const Color(0xFF1C1C1F),
      surfaceContainerHigh: const Color(0xFF26262A),
      surfaceContainerHighest: const Color(0xFF313135),
      onSurfaceVariant: const Color(0xFFA1A1AA),
      outline: const Color(0xFF3F3F46),
      outlineVariant: const Color(0xFF27272A),
      error: const Color(0xFFF87171),
      onError: const Color(0xFF450A0A),
      errorContainer: const Color(0xFF7F1D1D),
      onErrorContainer: const Color(0xFFFECACA),
      inverseSurface: const Color(0xFFE4E4E7),
      onInverseSurface: const Color(0xFF18181B),
      inversePrimary: seedColor,
      scrim: Colors.black,
    );
  }

  /// 文字四级阶梯：headline / title / body / caption(label)。
  ///
  /// 只定义字号、字重、行高与字距；颜色统一注入 [color]，
  /// 局部强调请在页面用 `style.copyWith` 调整。
  static TextTheme _buildTextTheme(Color color) {
    const TextStyle base = TextStyle(fontFamily: 'sans-serif');
    return TextTheme(
      // headline — 页面大标题（32/28/24）
      headlineLarge: base.copyWith(
        fontSize: 32,
        fontWeight: FontWeight.w700,
        height: 1.25,
        letterSpacing: -0.5,
      ),
      headlineMedium: base.copyWith(
        fontSize: 28,
        fontWeight: FontWeight.w600,
        height: 1.25,
        letterSpacing: -0.25,
      ),
      headlineSmall: base.copyWith(fontSize: 24, fontWeight: FontWeight.w600, height: 1.3),
      // title — 区块标题与小标题（20/16/14）
      titleLarge: base.copyWith(fontSize: 20, fontWeight: FontWeight.w600, height: 1.3),
      titleMedium: base.copyWith(fontSize: 16, fontWeight: FontWeight.w600, height: 1.4),
      titleSmall: base.copyWith(fontSize: 14, fontWeight: FontWeight.w600, height: 1.4),
      // body — 正文（16/14/12）
      bodyLarge: base.copyWith(fontSize: 16, fontWeight: FontWeight.w400, height: 1.5),
      bodyMedium: base.copyWith(fontSize: 14, fontWeight: FontWeight.w400, height: 1.5),
      bodySmall: base.copyWith(fontSize: 12, fontWeight: FontWeight.w400, height: 1.4),
      // caption/label — 辅助说明与控件文字（14/12/11）
      labelLarge: base.copyWith(fontSize: 14, fontWeight: FontWeight.w600, height: 1.2),
      labelMedium: base.copyWith(fontSize: 12, fontWeight: FontWeight.w500, height: 1.2),
      labelSmall: base.copyWith(
        fontSize: 11,
        fontWeight: FontWeight.w500,
        height: 1.2,
        letterSpacing: 0.4,
      ),
    ).apply(bodyColor: color, displayColor: color);
  }

  /// 统一构建亮/暗主题：所有组件主题在此收口，禁止页面级 ThemeData 覆盖。
  static ThemeData _buildTheme(Brightness brightness) {
    final bool isLight = brightness == Brightness.light;
    final ColorScheme scheme = isLight ? _lightScheme() : _darkScheme();
    final TextTheme textTheme = _buildTextTheme(scheme.onSurface);
    final OutlineInputBorder inputBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(AppRadius.md),
      borderSide: BorderSide(color: scheme.outline),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      textTheme: textTheme,
      scaffoldBackgroundColor: scheme.surface,
      splashFactory: InkRipple.splashFactory,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge,
        iconTheme: IconThemeData(color: scheme.onSurface),
      ),
      cardTheme: CardThemeData(
        color: isLight ? scheme.surfaceContainerLowest : scheme.surfaceContainerLow,
        elevation: 0,
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.lg),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: isLight ? scheme.surfaceContainerLowest : scheme.surfaceContainerLow,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg)),
        titleTextStyle: textTheme.titleLarge,
        contentTextStyle: textTheme.bodyMedium,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: isLight ? scheme.surfaceContainerLowest : scheme.surfaceContainerLow,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        dragHandleColor: scheme.outline,
        dragHandleSize: const Size(32, 4),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.lg)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: textTheme.bodyMedium?.copyWith(color: scheme.onInverseSurface),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isLight ? scheme.surfaceContainerLowest : scheme.surfaceContainerLow,
        contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
        border: inputBorder,
        enabledBorder: inputBorder,
        focusedBorder: inputBorder.copyWith(
          borderSide: BorderSide(color: scheme.primary, width: 1.5),
        ),
        errorBorder: inputBorder.copyWith(borderSide: BorderSide(color: scheme.error)),
        focusedErrorBorder: inputBorder.copyWith(
          borderSide: BorderSide(color: scheme.error, width: 1.5),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: scheme.surfaceContainerLow,
        selectedColor: scheme.secondaryContainer,
        checkmarkColor: scheme.onSecondaryContainer,
        labelStyle: textTheme.labelMedium?.copyWith(color: scheme.onSurfaceVariant),
        secondaryLabelStyle: textTheme.labelMedium?.copyWith(color: scheme.onSecondaryContainer),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
        labelPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: scheme.secondaryContainer,
        elevation: 0,
        height: 64,
        labelTextStyle: WidgetStatePropertyAll<TextStyle?>(textTheme.labelMedium),
      ),
      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: scheme.surface,
        selectedItemColor: scheme.primary,
        unselectedItemColor: scheme.onSurfaceVariant,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
        selectedLabelStyle: textTheme.labelMedium,
        unselectedLabelStyle: textTheme.labelMedium,
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: scheme.onSurface,
        unselectedLabelColor: scheme.onSurfaceVariant,
        indicatorColor: scheme.primary,
        dividerColor: Colors.transparent,
        indicatorSize: TabBarIndicatorSize.label,
      ),
      listTileTheme: ListTileThemeData(
        iconColor: scheme.onSurfaceVariant,
        contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
      ),
      dividerTheme: DividerThemeData(color: scheme.outlineVariant, thickness: 1, space: 1),
      popupMenuTheme: PopupMenuThemeData(
        color: isLight ? scheme.surfaceContainerLowest : scheme.surfaceContainerLow,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
        textStyle: textTheme.bodyMedium,
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
        elevation: 0,
        highlightElevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHigh,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          elevation: 0,
          minimumSize: const Size(0, 44),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl, vertical: AppSpacing.md),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
          textStyle: textTheme.labelLarge,
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          minimumSize: const Size(0, 44),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl, vertical: AppSpacing.md),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
          textStyle: textTheme.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: scheme.onSurface,
          minimumSize: const Size(0, 44),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xl, vertical: AppSpacing.md),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
          side: BorderSide(color: scheme.outline),
          textStyle: textTheme.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: scheme.primary,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
          textStyle: textTheme.labelLarge,
        ),
      ),
    );
  }
}

/// 亮暗模式切换 Provider（与 SettingsProvider 共享 `theme_mode` int 键）。
///
/// 读取键值为 [ThemeMode] 枚举下标：0=system / 1=light / 2=dark；
/// 读写仅发生在显式用户动作时，不做样式重算（桌面端教训）。
class ThemeProvider extends ChangeNotifier {
  static const String _themeKey = 'theme_mode';
  ThemeMode _themeMode = ThemeMode.system;

  /// 当前主题模式。
  ThemeMode get themeMode => _themeMode;

  /// 创建 Provider 并异步读取持久化的主题模式。
  ThemeProvider() {
    _loadTheme();
  }

  Future<void> _loadTheme() async {
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final int index = prefs.getInt(_themeKey) ?? 0;
      _themeMode = ThemeMode.values[index];
      notifyListeners();
    } catch (e) {
      // SharedPreferences 不可用时保持默认 system 模式，不阻塞启动。
      _themeMode = ThemeMode.system;
    }
  }

  /// 切换主题模式并持久化（用户在设置页显式触发）。
  Future<void> setThemeMode(ThemeMode mode) async {
    _themeMode = mode;
    notifyListeners();
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setInt(_themeKey, mode.index);
    } catch (e) {
      // 持久化失败不影响本次会话的主题生效。
    }
  }

  /// 当前是否处于暗色（含跟随系统的展开判断）。
  bool get isDark =>
      _themeMode == ThemeMode.dark ||
      (_themeMode == ThemeMode.system &&
          WidgetsBinding.instance.platformDispatcher.platformBrightness == Brightness.dark);
}
