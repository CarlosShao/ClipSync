// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Chinese (`zh`).
class AppLocalizationsZh extends AppLocalizations {
  AppLocalizationsZh([String locale = 'zh']) : super(locale);

  @override
  String get appTitle => 'ClipSync';

  @override
  String get cancel => '取消';

  @override
  String get confirm => '确认';

  @override
  String get save => '保存';

  @override
  String get delete => '删除';

  @override
  String get refresh => '刷新';

  @override
  String get retry => '重试';

  @override
  String get loading => '加载中...';

  @override
  String get login => '登录';

  @override
  String get loginSubtitle => '跨设备剪贴板同步';

  @override
  String get phoneNumber => '手机号';

  @override
  String get phoneHint => '请输入手机号';

  @override
  String get verificationCode => '验证码';

  @override
  String get codeHint => '请输入验证码';

  @override
  String get getCode => '获取验证码';

  @override
  String codeCountdown(int seconds) {
    return '$seconds秒';
  }

  @override
  String get invalidPhone => '请输入正确的手机号';

  @override
  String get codeSent => '验证码已发送';

  @override
  String get loginFailed => '登录失败，请检查验证码';

  @override
  String get enterSixDigitCode => '请输入 6 位动态验证码';

  @override
  String get codeInvalidOrExpired => '动态验证码错误或已过期，请重试';

  @override
  String get twoFactorTitle => '两步验证';

  @override
  String get twoFactorDesc => '请输入身份验证器 App 中的 6 位动态码\n（或备份码）';

  @override
  String get verifyAndLogin => '验证并登录';

  @override
  String get backToLogin => '返回重新登录';

  @override
  String get tabClipboard => '剪贴板';

  @override
  String get tabFavorites => '收藏';

  @override
  String get tabDevices => '设备';

  @override
  String get tabSettings => '设置';

  @override
  String get refreshDevices => '刷新设备';

  @override
  String get noDevices => '暂无设备';

  @override
  String get noDevicesDesc => '登录其他设备以开始同步';

  @override
  String get unbindDevice => '解绑设备';

  @override
  String get unbind => '解绑';

  @override
  String unbindConfirm(String deviceName) {
    return '确定解绑「$deviceName」吗？解绑后该设备将无法再同步。';
  }

  @override
  String get sectionServer => '服务器配置';

  @override
  String get sectionGeneral => '通用';

  @override
  String get sectionAppearance => '外观';

  @override
  String get sectionData => '数据管理';

  @override
  String get sectionNotification => '通知管理';

  @override
  String get sectionSubscription => '订阅管理';

  @override
  String get serverUrl => '服务器地址';

  @override
  String get serverUrlDesc => 'ClipSync 后端服务地址';

  @override
  String get serverUrlSaved => '服务器地址已保存';

  @override
  String get pushNotifications => '推送通知';

  @override
  String get pushNotificationsDesc => '接收剪贴板同步通知';

  @override
  String get theme => '主题';

  @override
  String get themeSystem => '跟随系统';

  @override
  String get themeLight => '浅色';

  @override
  String get themeDark => '深色';

  @override
  String get language => '语言';

  @override
  String get langZh => '简体中文';

  @override
  String get langEn => 'English';

  @override
  String get clearCache => '清理缓存';

  @override
  String get clearCacheDesc => '清除剪贴板缓存和临时文件';

  @override
  String get clearCacheTooltip => '清理';

  @override
  String get cacheCleared => '缓存已清理';

  @override
  String clearCacheFailed(String error) {
    return '清理失败: $error';
  }

  @override
  String get templates => '模板库';

  @override
  String get templatesDesc => '查看并快速使用剪贴板模板';

  @override
  String get notificationSettings => '通知设置';

  @override
  String get notificationSettingsDesc => '管理推送通知偏好';

  @override
  String get subscriptionManagement => '订阅管理';

  @override
  String get subscriptionDesc => '查看或更改订阅套餐';

  @override
  String get logout => '退出登录';

  @override
  String get logoutDesc => '清除本机登录凭证';

  @override
  String get logoutConfirmMessage => '确定要退出当前账号吗？退出后需要重新验证码登录。';

  @override
  String get logoutAction => '退出';

  @override
  String get aboutDesc => '跨设备剪贴板同步工具';

  @override
  String get clipboardSearchHint => '搜索剪贴板内容…';

  @override
  String get clearSearch => '清除搜索';

  @override
  String get typeAll => '全部';

  @override
  String get typeText => '文本';

  @override
  String get typeLink => '链接';

  @override
  String get typeImage => '图片';

  @override
  String get typeFile => '文件';

  @override
  String get typeCode => '代码';

  @override
  String get clipboardNoResultsTitle => '没有找到匹配的内容';

  @override
  String get clipboardNoResultsMessage => '试试更换关键词，或清除搜索与筛选条件';

  @override
  String get clipboardClearFilters => '清除筛选';

  @override
  String get clipboardEmptyTitle => '暂无剪贴板内容';

  @override
  String get clipboardEmptyMessage => '在电脑上复制任意内容，它会自动同步到这里';

  @override
  String get clipboardLoadMoreFailed => '加载更多失败';

  @override
  String get clipboardNoMore => '没有更多了';

  @override
  String clipboardNewContentBar(int count) {
    return '有 $count 条新内容，点击查看';
  }

  @override
  String get favorite => '收藏';

  @override
  String get unfavorite => '取消收藏';

  @override
  String get pinToTop => '置顶';

  @override
  String get comingSoon => '即将上线';

  @override
  String get moreActions => '更多操作';

  @override
  String get deleteConfirmTitle => '删除这条内容？';

  @override
  String deleteConfirmMessage(String preview) {
    return '「$preview」删除后将无法恢复。';
  }

  @override
  String get deleted => '已删除';

  @override
  String get deleteFailed => '删除失败，请稍后重试';

  @override
  String get placeholderFile => '（文件）';

  @override
  String get placeholderImage => '（图片）';

  @override
  String get placeholderEmpty => '（空内容）';

  @override
  String get unknownDevice => '未知设备';

  @override
  String clipboardCardSemantics(String type, String preview) {
    return '剪贴板$type，内容：$preview';
  }

  @override
  String get relJustNow => '刚刚';

  @override
  String relMinutesAgo(int minutes) {
    return '$minutes 分钟前';
  }

  @override
  String relHoursAgo(int hours) {
    return '$hours 小时前';
  }

  @override
  String relDaysAgo(int days) {
    return '$days 天前';
  }

  @override
  String relDateMD(int month, int day) {
    return '$month 月 $day 日';
  }

  @override
  String relDateYMD(int year, int month, int day) {
    return '$year/$month/$day';
  }

  @override
  String get copy => '复制';

  @override
  String get copied => '已复制';

  @override
  String get noTextContent => '该条目暂无文本内容';

  @override
  String get share => '分享';

  @override
  String get shareFailed => '分享失败，请稍后重试';

  @override
  String get favoriteFailed => '收藏操作失败，请稍后重试';

  @override
  String get imageNoCredentials => '缺少登录凭据，无法加载图片';

  @override
  String get imageLoadFailed => '图片加载失败，请检查网络后重试';

  @override
  String get contentLoadFailed => '内容加载失败，请检查网络后重试';

  @override
  String get linkHint => '链接内容 · 点击底部「复制」即可复制完整链接';

  @override
  String get unknownFile => '未知文件';

  @override
  String get downloading => '下载中…';

  @override
  String get openDownload => '打开（下载到本机）';

  @override
  String get copyFileName => '复制文件名';

  @override
  String get fileDownloadHint => '文件经服务端下载接口获取，保存到应用临时目录';

  @override
  String get fileLocalOnlyHint => '文件保存在来源设备本机，暂不支持跨设备获取';

  @override
  String fileSavedTo(String path) {
    return '已保存到 $path';
  }
}
