import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../services/server_config.dart';

/// 菜单能力注册表键（MA-04，与桌面端 useMenuAccess.ts MENU_CAPABILITIES
/// 键名逐字对齐，两端文档对齐、各自维护）。
abstract final class MenuAccessKeys {
  /// AI 入口（桌面端底部导航/侧栏 AI 入口；移动端预留）
  static const String navAi = 'nav.ai';

  /// 订阅管理入口（settings_screen 订阅区块）
  static const String navSubscription = 'nav.subscription';

  /// 注册入口（CO-31：enable_signup 关闭时隐藏注册入口；桌面端
  /// AuthPage.vue 直判 isFlagOn('enable_signup')，移动端经注册表消费）
  static const String navSignup = 'nav.signup';

  /// 创建共享链接（settings 共享链接 tile + 条目详情页分享入口）
  static const String shareCreate = 'share.create';

  /// OCR 能力（plan.features.hasOcr，MA-05）
  static const String featureOcr = 'feature.ocr';

  /// AI 分类能力（plan.features.hasAICategories，MA-05）
  static const String featureAiCategories = 'feature.ai_categories';

  /// 优先同步能力（plan.features.hasPrioritySync，MA-05）
  static const String featurePrioritySync = 'feature.priority_sync';

  /// 团队共享能力（plan.features.hasTeamSharing，MA-05）
  static const String featureTeamSharing = 'feature.team_sharing';
}

/// 菜单项能力声明（MA-04 注册表条目，与桌面端 MenuCapability 接口对齐）。
///
/// - [flags]：全局功能开关键列表（全部开启才可见）；
/// - [minPlan]：套餐门槛（或 [planFeature]，二选一声明）；
/// - [planFeature]：plan.features 中的布尔键（如 hasOcr）；
/// - [mode]：不满足时的表现（hide=隐藏入口 / disable=置灰），默认 hide。
class MenuCapability {
  final List<String> flags;
  final String? minPlan;
  final String? planFeature;
  final MenuAccessMode mode;

  const MenuCapability({
    this.flags = const <String>[],
    this.minPlan,
    this.planFeature,
    this.mode = MenuAccessMode.hide,
  });
}

/// 能力判定结果模式（对齐桌面端 modeOf 的 ok/hide/disable）。
enum MenuAccessMode { ok, hide, disable }

/// 菜单能力注册表（MA-04；键与桌面端 MENU_CAPABILITIES 对齐，新增键两端同步）。
///
/// 未注册的键一律放行（等价接入前现状，不会因接入本机制意外消失）。
const Map<String, MenuCapability> kMenuCapabilities =
    <String, MenuCapability>{
  MenuAccessKeys.navAi: MenuCapability(
    flags: <String>['enable_ai_agent'],
  ),
  MenuAccessKeys.navSubscription: MenuCapability(
    flags: <String>['enable_subscription'],
  ),
  // CO-31：注册总开关。移动端登录页无独立注册入口（注册=首次验证码登录，
  // 与存量用户登录共用同一路径，不可单独隐藏），注册表键先行落位对齐
  // 两端契约；新用户注册尝试由服务端 403「暂未开放注册」兜底
  MenuAccessKeys.navSignup: MenuCapability(
    flags: <String>['enable_signup'],
  ),
  MenuAccessKeys.shareCreate: MenuCapability(
    flags: <String>['enable_public_sharing'],
    planFeature: 'team_management',
  ),
  // MA-05 差异化能力键：按 subscription_plans.features 真实布尔键判定（Wave2-H 核实），
  // 禁止硬编码套餐名（planFeature 与 minPlan 二选一声明）；planFeature 求值 fail-open，
  // 服务端 requirePlanFeature 403 权威兜底
  MenuAccessKeys.featureAiCategories: MenuCapability(
    planFeature: 'ai_classify',
  ),
};

/// 功能开关（feature flags）移动端消费层。
///
/// 唯一数据源：后端 `GET /api/app/feature-flags`（公开只读快照）+
/// WS `feature_flags.updated` 推送。服务端权威强制（403 + flagDisabled）
/// 始终兜底；本层负责把「开关关闭」提前到 UI：隐藏分享/订阅等入口。
///
/// 未知键 / 未拉取 / 拉取失败一律视为开启（true）：与后端
/// isFlagEnabled fallback=true 的哲学一致——开关基础设施异常时
/// 客户端不隐藏入口，越权行为仍由服务端 403 兜底。
///
/// MA-04：本层同时承载菜单访问层 can()/modeOf()（数据源 = flags +
/// auth.user 的 plan/roleKey + plan.features 快照）与维护模式快照
/// （CO-21：refresh() 顺带拉 `/api/app/maintenance`，WS
/// `maintenance.updated` 经全局钩子直达 [applyMaintenance]）。
class FeatureFlagsProvider extends ChangeNotifier {
  Map<String, bool> _flags = {};
  bool _loaded = false;
  bool _loading = false;

  // MA-04 菜单访问层数据源：套餐名与超管标记来自 AuthProvider.user
  // （main.dart 监听 authProvider 变化后经 applyUserProfile 注入）；
  // plan.features 快照（MA-05）由订阅管理页拉取 /api/subscriptions/current
  // 后经 applyPlanFeatures 注入，未拉取前为空（判定 fail-open）。
  String _plan = '';
  bool _isSuperAdmin = false;
  Map<String, bool> _planFeatures = {};

  // CO-21 维护模式快照：GET /api/app/maintenance（'on'|'off'）+
  // WS maintenance.updated；true 时 home_screen 显示横幅并暂停剪贴板采集。
  bool _maintenanceMode = false;

  bool get loaded => _loaded;

  /// 维护模式是否开启（CO-21）。快照缺失 / 拉取失败按未维护处理（fail-open，
  /// 服务端 maintenanceGuard 503 仍会拦截同步请求）。
  bool get maintenanceMode => _maintenanceMode;

  /// 读取单个开关。未知键默认 true（放行）。
  bool isEnabled(String key) {
    final v = _flags[key];
    return v == null ? true : v;
  }

  /// 注入用户档案（MA-04）：plan 与 roleKey 来自 AuthProvider.user 原始 Map。
  /// 由 main.dart 的 authProvider 监听器调用；值不变时不重复通知。
  void applyUserProfile(Map<String, dynamic>? user) {
    final plan = ((user?['plan'] as String?) ?? '').trim();
    final roleKey = ((user?['roleKey'] as String?) ?? '').trim();
    // 决策记录（2026-09-07）：超管判定收紧为 roleKey === 'super_admin'，
    // 不是 roleLevel >= 50
    final superAdmin = roleKey == 'super_admin';
    if (plan == _plan && superAdmin == _isSuperAdmin) return;
    _plan = plan;
    _isSuperAdmin = superAdmin;
    notifyListeners();
  }

  /// 注入 plan.features 布尔快照（MA-05）。
  ///
  /// 数据流：订阅管理页拉取 GET /api/subscriptions/current 后，把响应
  /// plan.features（服务端 JSONB，真实键如 ai_classify / team_management）
  /// 归一的布尔表整体替换进本快照（套餐升级/降级/取消以最新拉取为准）。
  /// 未拉取前快照为空，can() 的 planFeature 层 fail-open 放行，
  /// 服务端 requirePlanFeature 403 套餐墙兜底。
  void applyPlanFeatures(Map<String, dynamic>? features) {
    if (features == null) return;
    final next = features.map((k, v) => MapEntry(k, v == true));
    if (mapEquals(next, _planFeatures)) return;
    _planFeatures = next;
    notifyListeners();
  }

  /// 菜单能力判定（MA-04）：三层与判定 = flags 层 ∧（超管 ∨ 套餐层）。
  ///
  /// - 未知键（注册表未声明）一律放行 true；
  /// - flags 层对所有用户生效（全局开关，管理台权威）；
  /// - 套餐层（minPlan / planFeature）对超管豁免；
  /// - 套餐未知 / features 缺失时 fail-open 放行，服务端配额与 403 兜底。
  bool can(String key) {
    final cap = kMenuCapabilities[key];
    if (cap == null) return true; // 未知键放行（等价接入前现状）
    for (final flag in cap.flags) {
      if (!isEnabled(flag)) return false;
    }
    if (_isSuperAdmin) return true; // 超管豁免套餐层
    final minPlan = cap.minPlan;
    if (minPlan != null && !_planSatisfies(minPlan)) return false;
    final planFeature = cap.planFeature;
    if (planFeature != null && !_hasPlanFeature(planFeature)) return false;
    return true;
  }

  /// 能力模式（MA-04）：对齐桌面端 modeOf——ok / hide / disable。
  /// 不满足时取注册表声明的 mode（默认 hide）。
  MenuAccessMode modeOf(String key) {
    if (can(key)) return MenuAccessMode.ok;
    return kMenuCapabilities[key]?.mode ?? MenuAccessMode.hide;
  }

  /// 套餐门槛判定：Free < Pro < Enterprise（与 subscription_plans 命名对齐）。
  /// 当前套餐或门槛名无法识别时 fail-open 放行（套餐信息基础设施异常
  /// 不应在客户端隐藏入口，服务端配额强制兜底）。
  bool _planSatisfies(String minPlan) {
    const rank = <String, int>{'free': 0, 'pro': 1, 'enterprise': 2};
    final current = rank[_plan.toLowerCase()];
    final required = rank[minPlan.toLowerCase()];
    if (current == null || required == null) return true;
    return current >= required;
  }

  /// plan.features 布尔键判定：快照未拉取（空）或键未知时 fail-open
  /// 放行——服务端订阅配额 / 功能墙（并行工单 H）强制兜底，客户端仅做
  /// 提前显隐，不在基础设施异常时误伤入口。
  bool _hasPlanFeature(String featureKey) {
    final v = _planFeatures[featureKey];
    return v == null ? true : v;
  }

  /// WS 推送直达：无网络往返，管理台切换后全端即时生效。
  void applyFlags(Map<String, dynamic>? flags) {
    if (flags == null) return;
    _flags = {..._flags, ...flags.map((k, v) => MapEntry(k, v == true))};
    _loaded = true;
    notifyListeners();
  }

  /// 维护模式推送/拉取直达（CO-21）：mode 'on' 开启、其余（含 'off'/null）
  /// 关闭；值不变时不重复通知。
  void applyMaintenance(String? mode) {
    final on = mode == 'on';
    if (on == _maintenanceMode) return;
    _maintenanceMode = on;
    notifyListeners();
  }

  /// 登出清理，避免下一个账号继承上一个账号感知的开关状态。
  void reset() {
    _flags = {};
    _loaded = false;
    // 套餐/超管/维护快照一并复位：与 flags 同属会话感知状态
    _plan = '';
    _isSuperAdmin = false;
    _planFeatures = {};
    _maintenanceMode = false;
    notifyListeners();
  }

  /// 拉取最新快照（公开端点，无需鉴权）。失败保留上次快照并静默。
  ///
  /// CO-21：同一刷新周期并行拉取维护模式快照 /api/app/maintenance
  /// （home_screen._loadData 已调用本方法，无需额外入口）。
  Future<void> refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final results = await Future.wait(<Future<http.Response>>[
        http
            .get(Uri.parse('${ServerConfig.baseUrl}/api/app/feature-flags'))
            .timeout(const Duration(seconds: 10)),
        http
            .get(Uri.parse('${ServerConfig.baseUrl}/api/app/maintenance'))
            .timeout(const Duration(seconds: 10)),
      ]);
      final flagsResponse = results[0];
      final maintenanceResponse = results[1];

      if (flagsResponse.statusCode == 200) {
        final decoded = jsonDecode(flagsResponse.body);
        if (decoded is Map<String, dynamic>) {
          final flags = decoded['flags'];
          if (flags is Map<String, dynamic>) {
            applyFlags(flags);
          } else if (decoded.isNotEmpty) {
            // 兼容直接返回 { key: bool } 的平铺结构
            applyFlags(decoded);
          }
        }
      }

      // 契约：{ maintenance: 'on' | 'off' }（CO-20 公开端点）
      if (maintenanceResponse.statusCode == 200) {
        final decoded = jsonDecode(maintenanceResponse.body);
        if (decoded is Map<String, dynamic>) {
          final mode = decoded['maintenance'];
          applyMaintenance(mode is String ? mode : null);
        }
      }
    } catch (_) {
      // 静默失败：保留上次快照，未加载键默认放行
    } finally {
      _loading = false;
    }
  }
}
