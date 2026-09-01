import 'dart:async';
import 'dart:io';

import '../l10n/app_localizations.dart';

/// 应用错误码（A3 服务层文案与 model 解耦）。
///
/// 服务层抛 [AppException] 时只携带错误码与可选技术 detail（如 HTTP 状态码、
/// 后端 error 文案），面向用户的文案由 UI 层按 code 经 l10n 映射。
class AppErrorCodes {
  AppErrorCodes._();

  /// 未登录：缺少访问令牌（TokenStore 无 access token）
  static const String noToken = 'noToken';

  /// 验证码发送失败
  static const String sendCodeFailed = 'sendCodeFailed';

  /// 登录失败
  static const String loginFailed = 'loginFailed';

  /// 获取用户资料失败
  static const String fetchProfileFailed = 'fetchProfileFailed';

  /// 剪贴板列表加载失败
  static const String fetchClipboardFailed = 'fetchClipboardFailed';

  /// 剪贴板条目完整内容获取失败
  static const String fetchItemContentFailed = 'fetchItemContentFailed';

  /// 收藏 toggle 失败
  static const String toggleFavoriteFailed = 'toggleFavoriteFailed';

  /// 剪贴板条目删除失败
  static const String deleteItemFailed = 'deleteItemFailed';

  /// 设备列表加载失败
  static const String fetchDevicesFailed = 'fetchDevicesFailed';

  /// 设备注册失败
  static const String registerDeviceFailed = 'registerDeviceFailed';

  /// 设备解绑失败
  static const String removeDeviceFailed = 'removeDeviceFailed';

  /// 活跃会话列表加载失败
  static const String fetchSessionsFailed = 'fetchSessionsFailed';

  /// 会话吊销失败
  static const String revokeFailed = 'revokeFailed';

  /// 模板列表加载失败
  static const String fetchTemplatesFailed = 'fetchTemplatesFailed';

  /// 模板渲染失败
  static const String renderTemplateFailed = 'renderTemplateFailed';

  /// 收藏夹分组列表加载失败
  static const String fetchCollectionsFailed = 'fetchCollectionsFailed';

  /// 收藏夹组内条目加载失败
  static const String fetchCollectionItemsFailed = 'fetchCollectionItemsFailed';

  /// 收藏夹分组创建失败
  static const String createCollectionFailed = 'createCollectionFailed';

  /// 收藏夹分组删除失败
  static const String deleteCollectionFailed = 'deleteCollectionFailed';

  /// 套餐列表获取失败
  static const String fetchPlansFailed = 'fetchPlansFailed';

  /// 当前订阅获取失败
  static const String fetchCurrentSubFailed = 'fetchCurrentSubFailed';

  /// 取消订阅失败
  static const String cancelSubFailed = 'cancelSubFailed';

  /// 恢复订阅失败
  static const String resumeSubFailed = 'resumeSubFailed';

  /// 账单列表获取失败
  static const String fetchInvoicesFailed = 'fetchInvoicesFailed';

  /// 剪贴板内容上传失败
  static const String uploadFailed = 'uploadFailed';

  /// 服务端通知偏好获取失败（B3 通知设置页）
  static const String fetchNotificationPrefsFailed = 'fetchNotificationPrefsFailed';

  /// 服务端通知偏好保存失败（B3 通知设置页）
  static const String updateNotificationPrefsFailed = 'updateNotificationPrefsFailed';

  /// 文件下载失败
  static const String downloadFailed = 'downloadFailed';

  /// 设备未注册（本机无有效设备 id，无法上传/同步）
  static const String deviceNotRegistered = 'deviceNotRegistered';

  /// 网络异常（Socket / 超时）
  static const String networkError = 'networkError';

  /// 未识别错误
  static const String unknown = 'unknown';
}

/// 带 code 的应用异常（服务层统一抛出，UI 层经 l10n 映射文案）。
///
/// - [code]：[AppErrorCodes] 中的稳定错误码，UI 据此选 l10n 文案；
/// - [detail]：可选技术详情（HTTP 状态码、后端 error 文案等），已知 code
///   时以「（detail）」附在文案尾部展示，未识别 code 时兜底展示。
class AppException implements Exception {
  const AppException(this.code, [this.detail]);

  /// 稳定错误码（[AppErrorCodes]）
  final String code;

  /// 可选技术详情（HTTP 状态码 / 后端错误文案）
  final String? detail;

  /// 映射为面向用户的文案：已知 code → l10n 文案（detail 非空时附在尾部）；
  /// 未识别 code → detail，detail 也为空 → 通用错误文案。
  String message(AppLocalizations l10n) {
    final String? d = (detail != null && detail!.isNotEmpty) ? detail : null;
    final String? base = _localizedMessage(l10n, code);
    if (base == null) {
      return d ?? l10n.errorUnknown;
    }
    return d == null ? base : '$base（$d）';
  }
}

/// code → l10n 文案映射；未识别的 code 返回 null（由调用方兜底）。
String? _localizedMessage(AppLocalizations l10n, String code) {
  switch (code) {
    case AppErrorCodes.noToken:
      return l10n.errorNoToken;
    case AppErrorCodes.sendCodeFailed:
      return l10n.errorSendCode;
    case AppErrorCodes.loginFailed:
      return l10n.loginFailed;
    case AppErrorCodes.fetchProfileFailed:
      return l10n.errorFetchProfile;
    case AppErrorCodes.fetchClipboardFailed:
      return l10n.errorFetchClipboard;
    case AppErrorCodes.fetchItemContentFailed:
      return l10n.errorFetchItemContent;
    case AppErrorCodes.toggleFavoriteFailed:
      return l10n.favoriteFailed;
    case AppErrorCodes.deleteItemFailed:
      return l10n.deleteFailed;
    case AppErrorCodes.fetchDevicesFailed:
      return l10n.devicesLoadFailed;
    case AppErrorCodes.registerDeviceFailed:
      return l10n.errorRegisterDevice;
    case AppErrorCodes.removeDeviceFailed:
      return l10n.errorRemoveDevice;
    case AppErrorCodes.fetchSessionsFailed:
      return l10n.sessionsLoadFailed;
    case AppErrorCodes.revokeFailed:
      return l10n.revokeFailed;
    case AppErrorCodes.fetchTemplatesFailed:
      return l10n.errorFetchTemplates;
    case AppErrorCodes.renderTemplateFailed:
      return l10n.errorRenderTemplate;
    case AppErrorCodes.fetchCollectionsFailed:
      return l10n.errorFetchCollections;
    case AppErrorCodes.fetchCollectionItemsFailed:
      return l10n.errorFetchCollectionItems;
    case AppErrorCodes.createCollectionFailed:
      return l10n.errorCreateCollection;
    case AppErrorCodes.deleteCollectionFailed:
      return l10n.errorDeleteCollection;
    case AppErrorCodes.fetchPlansFailed:
      return l10n.errorFetchPlans;
    case AppErrorCodes.fetchCurrentSubFailed:
      return l10n.errorFetchCurrentSub;
    case AppErrorCodes.cancelSubFailed:
      return l10n.errorCancelSub;
    case AppErrorCodes.resumeSubFailed:
      return l10n.errorResumeSub;
    case AppErrorCodes.fetchInvoicesFailed:
      return l10n.errorFetchInvoices;
    case AppErrorCodes.uploadFailed:
      return l10n.errorUpload;
    case AppErrorCodes.fetchNotificationPrefsFailed:
      return l10n.errorFetchNotificationPrefs;
    case AppErrorCodes.updateNotificationPrefsFailed:
      return l10n.errorUpdateNotificationPrefs;
    case AppErrorCodes.downloadFailed:
      return l10n.errorDownload;
    case AppErrorCodes.deviceNotRegistered:
      return l10n.errorDeviceNotRegistered;
    case AppErrorCodes.networkError:
      return l10n.errorNetwork;
    default:
      return null;
  }
}

/// UI 错误兜底转换：把任意抛出对象转为可展示文案。
///
/// - [AppException] → 按 code 映射 l10n（见 [AppException.message]）；
/// - 网络/超时异常 → errorNetwork 文案；
/// - 其余 Exception → 去掉「Exception: 」前缀的原样文本（历史兜底）；
/// - 其他类型（String 存量、null 等）→ 通用错误文案。
String friendlyError(Object? error, AppLocalizations l10n) {
  if (error is AppException) {
    return error.message(l10n);
  }
  if (error is SocketException || error is TimeoutException) {
    return l10n.errorNetwork;
  }
  if (error is Exception) {
    final String raw =
        error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '').trim();
    return raw.isEmpty ? l10n.errorUnknown : raw;
  }
  return l10n.errorUnknown;
}
