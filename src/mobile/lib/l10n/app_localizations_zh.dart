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
  String get phoneAndCodeRequired => '请输入手机号和验证码';

  @override
  String get twoFactorCodeLabel => '动态验证码';

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
  String get devicesLoadFailed => '设备列表加载失败';

  @override
  String unbindCurrentDeviceConfirm(String deviceName) {
    return '「$deviceName」是当前设备。\n解绑后将停止本机同步，且需要重新注册设备才能恢复。确定解绑吗？';
  }

  @override
  String get biometricUnlockReason => '验证指纹或面容以进入 ClipSync';

  @override
  String get biometricVerifyFailed => '验证未通过，请重试';

  @override
  String get lockScreenMessage => '应用已锁定，请验证身份后继续';

  @override
  String get unlock => '解锁';

  @override
  String get backAgainToExit => '再按一次返回键退出 ClipSync';

  @override
  String get skip => '跳过';

  @override
  String get next => '下一步';

  @override
  String get getStarted => '开始使用';

  @override
  String get onboardingTitle1 => '欢迎使用 ClipSync';

  @override
  String get onboardingDesc1 => '跨设备剪贴板同步工具\n让您的剪贴板在手机、电脑间自由流转';

  @override
  String get onboardingTitle2 => '后台自动同步';

  @override
  String get onboardingDesc2 => 'ClipSync 在后台保持连接\n电脑复制的内容自动同步到手机';

  @override
  String get onboardingTitle3 => '即时通知';

  @override
  String get onboardingDesc3 => '电脑复制内容后\n手机第一时间收到通知提醒';

  @override
  String get onboardingTitle4 => '剪贴板同步';

  @override
  String get onboardingDesc4 => '手机复制的内容也会自动同步\n在所有设备间无缝流转';

  @override
  String get onboardingTitle5 => '准备就绪';

  @override
  String get onboardingDesc5 => '现在可以开始使用 ClipSync 了！\n复制内容试试吧 😊';

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
  String get clipboardCapture => '剪贴板采集';

  @override
  String get clipboardCaptureDesc => '关闭后，本机复制的内容不再自动同步到其他设备';

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

  @override
  String get sectionSecurity => '安全';

  @override
  String get biometricLock => '生物识别锁';

  @override
  String get biometricLockDesc => '冷启动与回到前台时需通过指纹/面容验证';

  @override
  String get biometricUnsupported => '设备不支持生物识别';

  @override
  String get biometricLockReason => '验证指纹或面容以开启生物识别锁';

  @override
  String get biometricLockFailed => '验证未通过，未开启生物识别锁';

  @override
  String get create => '创建';

  @override
  String get createCollection => '新建分组';

  @override
  String collectionCreated(String name) {
    return '已创建「$name」';
  }

  @override
  String get deleteCollection => '删除分组';

  @override
  String deleteCollectionConfirm(String name) {
    return '确定删除「$name」吗？\n\n组内的剪贴板条目不会被删除，仍保留在剪贴板收藏中；该分组下的子分组会被一并删除。';
  }

  @override
  String collectionDeleted(String name) {
    return '已删除「$name」';
  }

  @override
  String get collectionsEmptyTitle => '暂无收藏夹分组';

  @override
  String get collectionsEmptyMessage => '新建一个分组，把常用的剪贴板内容整理在一起';

  @override
  String collectionItemCount(int count) {
    return '$count 条内容';
  }

  @override
  String collectionFolderCount(int count) {
    return '$count 个子分组';
  }

  @override
  String get subCollectionsHeader => '子收藏夹';

  @override
  String get itemsSectionHeader => '内容';

  @override
  String get breadcrumbAll => '全部';

  @override
  String createUnderParentHint(String name) {
    return '将创建到「$name」下';
  }

  @override
  String get collectionNameRequired => '请输入分组名称';

  @override
  String get collectionNameLabel => '分组名称';

  @override
  String get noCopyableContent => '该条目暂无可复制的内容';

  @override
  String get copyFailed => '复制失败，请重试';

  @override
  String get collectionItemsEmptyTitle => '该分组暂无内容';

  @override
  String get collectionItemsEmptyMessage => '在剪贴板列表中将内容加入收藏后，会出现在这里';

  @override
  String get unknownSource => '未知来源';

  @override
  String get sessionsLoadFailed => '会话列表加载失败，请检查网络后重试';

  @override
  String get activeSessions => '活跃会话';

  @override
  String get activeSessionsDesc => '已登录本账号的设备会话，可远程吊销下线';

  @override
  String get refreshSessions => '刷新会话';

  @override
  String get noActiveSessions => '暂无活跃会话';

  @override
  String get noActiveSessionsDesc => '当前账号没有活跃的登录会话';

  @override
  String get revokeCurrentSession => '吊销当前会话';

  @override
  String get revokeSession => '吊销会话';

  @override
  String revokeCurrentSessionConfirm(String deviceName) {
    return '「$deviceName」是当前设备。\n吊销后本机将立即退出登录，需要重新验证码登录。确定吊销吗？';
  }

  @override
  String revokeSessionConfirm(String deviceName) {
    return '确定吊销「$deviceName」的会话吗？吊销后该设备将被强制下线。';
  }

  @override
  String get revoke => '吊销';

  @override
  String get revokeFailed => '吊销失败，请稍后重试';

  @override
  String get currentSessionRevoked => '当前会话已吊销，已退出登录';

  @override
  String sessionRevoked(String deviceName) {
    return '已吊销「$deviceName」的会话';
  }

  @override
  String get lastActivePrefix => '最近活跃 ';

  @override
  String get currentBadge => '当前';

  @override
  String get cancelSubscription => '取消订阅';

  @override
  String get cancelSubscriptionConfirm =>
      '确定要取消订阅吗？取消后将在当前计费周期结束后自动降级为免费版，到期前订阅权益仍可正常使用。';

  @override
  String get subscriptionCancelled => '订阅已取消，将于当前计费周期结束后生效';

  @override
  String get resumeSubscription => '恢复订阅';

  @override
  String get resumeSubscriptionConfirm => '确定要恢复订阅吗？恢复后订阅将在当前周期结束后继续自动续订。';

  @override
  String get subscriptionResumed => '订阅已恢复，将继续自动续订';

  @override
  String get thinkAgain => '再想想';

  @override
  String get statusCancelScheduled => '已取消（期末生效）';

  @override
  String get statusActive => '生效中';

  @override
  String get statusTrial => '试用中';

  @override
  String get availablePlans => '可选套餐';

  @override
  String get billingRecords => '账单记录';

  @override
  String get subscriptionStatusLabel => '订阅状态';

  @override
  String get expiryDate => '到期时间';

  @override
  String get trialEndDate => '试用期至';

  @override
  String subscriptionEndsOn(String date) {
    return '订阅将于 $date 到期后终止，届时自动降级为免费版。';
  }

  @override
  String get desktopPaymentHint => '移动端暂不支持支付。升级或购买套餐请在桌面端登录后，在「订阅管理」中完成支付。';

  @override
  String get currentPlanBadge => '当前套餐';

  @override
  String get payOnDesktop => '请在桌面端完成支付';

  @override
  String get noInvoices => '暂无账单记录';

  @override
  String get renderResultTitle => '渲染结果';

  @override
  String get close => '关闭';

  @override
  String get renderResultCopied => '已复制渲染结果到剪贴板';

  @override
  String get copyAll => '复制全文';

  @override
  String get noTemplates => '暂无模板';

  @override
  String get noTemplatesDesc => '在桌面端保存剪贴板内容为模板后，会同步到这里';

  @override
  String variableCount(int count) {
    return '$count 个变量';
  }

  @override
  String get emptyTemplateContent => '（模板内容为空）';

  @override
  String get useTemplate => '使用';

  @override
  String get fillVariableTitle => '填写变量';

  @override
  String variableProgress(int step, int total) {
    return '第 $step / $total 个变量';
  }

  @override
  String variableInputHint(String name) {
    return '请输入 $name 的值';
  }

  @override
  String get done => '完成';

  @override
  String get nextItem => '下一项';

  @override
  String get permissionGuideTitle => '权限与保活引导';

  @override
  String get permissionGuideIntro => '为了让「电脑复制 → 手机秒到」持续生效，建议完成以下 3 步设置：';

  @override
  String get finishAndStart => '完成，开始使用';

  @override
  String get stepNotifTitle => '1. 通知权限';

  @override
  String get stepNotifDesc => '接收「剪贴板已更新」即时通知（Android 13+ 需授权）。';

  @override
  String get statusOn => '已开启';

  @override
  String get statusOff => '未开启';

  @override
  String get statusExempted => '已豁免';

  @override
  String get statusNotExempted => '未豁免';

  @override
  String get requestNotifPermission => '申请通知权限';

  @override
  String get notifPermissionGranted => '通知权限已开启';

  @override
  String get notifPermissionDenied => '通知权限未授予，可在系统设置中手动开启';

  @override
  String get stepBatteryTitle => '2. 电池优化豁免';

  @override
  String get stepBatteryDesc => '加入电池优化白名单，避免息屏后同步断连、通知延迟。';

  @override
  String get statusUndetected => '暂无法自动检测（需应用原生支持）';

  @override
  String get batteryTitle => '电池优化豁免';

  @override
  String get batteryManualGuide =>
      '未能自动跳转，请手动设置：\n\n系统设置 → 应用管理 → ClipSync → 电池\n→ 选择「不受限制 / 允许后台活动」\n\n部分机型路径为：设置 → 电池 → 更多电池设置 → 应用休眠。';

  @override
  String get jumping => '跳转中…';

  @override
  String get gotoBatterySettings => '前往电池优化设置';

  @override
  String get stepAutoStartTitle => '3. 自启动设置';

  @override
  String get stepAutoStartDesc => '允许 ClipSync 自启动与后台运行，开机后自动恢复同步。';

  @override
  String get autoStartTitle => '自启动设置';

  @override
  String get autoStartGuide =>
      '不同厂商路径示例：\n\n· 小米 MIUI：安全中心 → 应用管理 → 权限 → 自启动管理 → 允许 ClipSync\n· 华为 EMUI/HarmonyOS：设置 → 应用 → 应用启动管理 → ClipSync → 手动管理（允许自启动/关联启动/后台活动）\n· OPPO ColorOS：手机管家 → 权限隐私 → 自启动管理 → 允许 ClipSync\n· vivo OriginOS：i管家 → 应用管理 → 权限管理 → 自启动 → 允许 ClipSync';

  @override
  String get autoStartStatusHint => '按厂商规则各异，建议手动确认';

  @override
  String get gotIt => '知道了';

  @override
  String get gotoAutoStartSettings => '前往自启动设置';

  @override
  String get unknown => '未知';

  @override
  String get saveToClipboard => '存入剪贴板';

  @override
  String get saveToClipboardDesc => '内容将上传到你的 ClipSync 账号，所有已登录设备可见。';

  @override
  String get nothingToSave => '没有可存入的内容';

  @override
  String get saving => '存入中…';

  @override
  String saveInFailed(String error) {
    return '存入失败：$error';
  }

  @override
  String get saveInFailedRetry => '存入失败，请稍后重试';

  @override
  String savedInCount(int count) {
    return '已存入 $count 条剪贴板内容';
  }

  @override
  String imageCount(int count) {
    return '图片（$count 张）';
  }

  @override
  String deviceSemantics(String name, String status) {
    return '设备：$name，状态：$status';
  }

  @override
  String get deviceOnline => '在线';

  @override
  String get deviceOffline => '离线';

  @override
  String get platformDesktop => '桌面端';

  @override
  String get platformMobile => '移动端';

  @override
  String get platformTablet => '平板';

  @override
  String get loadFailedTitle => '加载失败';

  @override
  String get errorNoToken => '未登录，请先登录后重试';

  @override
  String get errorSendCode => '验证码发送失败';

  @override
  String get errorFetchProfile => '获取用户信息失败';

  @override
  String get errorFetchClipboard => '剪贴板列表加载失败';

  @override
  String get errorFetchItemContent => '获取完整内容失败';

  @override
  String get errorRegisterDevice => '设备注册失败';

  @override
  String get errorRemoveDevice => '设备解绑失败';

  @override
  String get errorFetchTemplates => '模板列表加载失败';

  @override
  String get errorRenderTemplate => '模板渲染失败';

  @override
  String get errorFetchCollections => '收藏夹分组加载失败';

  @override
  String get errorFetchCollectionItems => '分组内容加载失败';

  @override
  String get errorCreateCollection => '创建收藏夹分组失败';

  @override
  String get errorDeleteCollection => '删除收藏夹分组失败';

  @override
  String get errorFetchPlans => '获取套餐列表失败';

  @override
  String get errorFetchCurrentSub => '获取当前订阅失败';

  @override
  String get errorCancelSub => '取消订阅失败';

  @override
  String get errorResumeSub => '恢复订阅失败';

  @override
  String get errorFetchInvoices => '获取账单失败';

  @override
  String get errorUpload => '上传失败';

  @override
  String get errorDownload => '下载失败';

  @override
  String get errorDeviceNotRegistered => '设备未注册，请退出重新登录后重试';

  @override
  String get errorNetwork => '网络连接异常，请检查网络后重试';

  @override
  String get errorUnknown => '操作失败，请稍后重试';

  @override
  String get errorFetchNotificationPrefs => '获取通知偏好失败';

  @override
  String get errorUpdateNotificationPrefs => '保存通知偏好失败';

  @override
  String get notifChannelClipboard => '剪贴板同步';

  @override
  String get notifChannelClipboardDesc => '设备间剪贴板内容同步提醒（静默，不发出声音）';

  @override
  String get notifChannelAlert => '同步告警';

  @override
  String get notifChannelAlertDesc => '同步异常、设备告警等重要提醒';

  @override
  String get notifClipboardUpdated => '剪贴板已更新';

  @override
  String get notifNewClipboardBody => '收到新的剪贴板内容';

  @override
  String get serverNotifPrefs => '服务端通知偏好';

  @override
  String get notifTypeDeviceOnline => '设备上线通知';

  @override
  String get notifTypeSyncComplete => '同步完成通知';

  @override
  String get notifTypeSecurityAlert => '安全告警通知';

  @override
  String get notifTypeProductUpdate => '产品更新通知';

  @override
  String get systemNotifSettings => '系统通知设置';

  @override
  String get systemNotifSettingsDesc => '在系统设置中管理 ClipSync 的通知权限与渠道';

  @override
  String get systemNotifSettingsFailed => '无法打开系统通知设置';

  @override
  String get errorReportTitle => '错误报告';

  @override
  String get exportErrorLogs => '导出错误日志';

  @override
  String get errorLocalOnlyDesc => '错误仅记录在本机（最多保留 20 条），不会自动上传。';

  @override
  String get clearAll => '清空';

  @override
  String get errorQueueCleared => '已清空错误队列';

  @override
  String get planFree => '免费';

  @override
  String get perMonth => '/月';

  @override
  String get perYear => '/年';

  @override
  String planMaxDevices(int count) {
    return '最多 $count 台设备';
  }

  @override
  String planDailyClips(int count) {
    return '每日 $count 条剪贴板';
  }

  @override
  String planStorage(int size) {
    return '存储空间 ${size}MB';
  }

  @override
  String get featureOcr => 'OCR 文字识别';

  @override
  String get featurePrioritySync => '优先同步';

  @override
  String get featureAiClassify => 'AI 智能分类';

  @override
  String get featureTeamShare => '团队共享';

  @override
  String get renameCollection => '重命名分组';

  @override
  String get collectionRenamed => '已重命名';

  @override
  String get addToCollection => '加入分组';

  @override
  String get removeFromCollection => '移出分组';

  @override
  String get selectGroup => '选择分组';

  @override
  String get noAvailableGroups => '暂无可用分组，先在收藏页新建一个';

  @override
  String movedToCollection(String name) {
    return '已加入「$name」';
  }

  @override
  String get removedFromCollection => '已移出分组';

  @override
  String get sharedLinks => '共享链接';

  @override
  String get sharedLinksDesc => '管理内容的外部分享链接';

  @override
  String get noSharedLinks => '暂无共享链接';

  @override
  String get noSharedLinksDesc => '在条目详情页创建共享链接后，会显示在这里';

  @override
  String get createSharedLink => '创建共享链接';

  @override
  String get sharedLinkCreated => '共享链接已创建并复制';

  @override
  String get copyLink => '复制链接';

  @override
  String get linkCopied => '链接已复制';

  @override
  String get revokeLink => '撤销链接';

  @override
  String get revokeLinkConfirm => '确定撤销该共享链接吗？撤销后链接立即失效。';

  @override
  String get sharedLinkRevoked => '链接已撤销';

  @override
  String expiresAt(String date) {
    return '有效期至 $date';
  }

  @override
  String get neverExpires => '永久有效';

  @override
  String get notificationsCenter => '通知中心';

  @override
  String get notificationsCenterDesc => '查看站内通知与回复';

  @override
  String get noNotifications => '暂无通知';

  @override
  String get markAllRead => '全部已读';

  @override
  String get markRead => '标为已读';

  @override
  String get notifLoadFailed => '通知加载失败';

  @override
  String get accountSection => '账号';

  @override
  String get profileTitle => '个人资料';

  @override
  String get nickname => '昵称';

  @override
  String get editNickname => '修改昵称';

  @override
  String get nicknameSaved => '昵称已更新';

  @override
  String get nicknameSaveFailed => '保存失败，请稍后重试';

  @override
  String get notLoggedIn => '未登录';

  @override
  String get searchHistoryTitle => '搜索历史';

  @override
  String get clearSearchHistory => '清空历史';

  @override
  String get searchHistoryCleared => '搜索历史已清空';

  @override
  String get advancedFilter => '筛选';

  @override
  String get filterDateRange => '时间范围';

  @override
  String get filterToday => '今天';

  @override
  String get filterWeek => '最近 7 天';

  @override
  String get filterMonth => '最近 30 天';

  @override
  String get filterAllTime => '全部时间';

  @override
  String get filterCustom => '自定义';

  @override
  String get filterDateFrom => '开始';

  @override
  String get filterDateTo => '结束';

  @override
  String get filterDevice => '来源设备';

  @override
  String get filterAllDevices => '全部设备';

  @override
  String get filterFavoritesOnly => '仅收藏';

  @override
  String get applyFilter => '应用';

  @override
  String get resetFilter => '重置';

  @override
  String activeFilters(int count) {
    return '$count 项筛选';
  }

  @override
  String get pinSuccess => '已置顶';

  @override
  String get unpinSuccess => '已取消置顶';

  @override
  String get setExpiry => '设置过期时间';

  @override
  String get expiryNever => '永不过期';

  @override
  String get expiryOneHour => '1 小时';

  @override
  String get expiryOneDay => '1 天';

  @override
  String get expiryOneWeek => '7 天';

  @override
  String get expiryOneMonth => '30 天';

  @override
  String get expirySet => '过期时间已设置';

  @override
  String get expiredBadge => '已过期';

  @override
  String get archive => '归档';

  @override
  String get unarchive => '取消归档';

  @override
  String get archivedBadge => '已归档';

  @override
  String get editTags => '编辑标签';

  @override
  String get tagsHint => '多个标签用逗号分隔';

  @override
  String get tagsSaved => '标签已更新';

  @override
  String get itemLocked => '此条目已加密保护';

  @override
  String get passwordLabel => '密码';

  @override
  String get wrongPassword => '密码错误';

  @override
  String get filterArchived => '已归档';

  @override
  String get newTemplate => '新建模板';

  @override
  String get editTemplate => '编辑模板';

  @override
  String get templateName => '模板名称';

  @override
  String get templateContent => '模板内容';

  @override
  String get templateNameRequired => '请输入模板名称';

  @override
  String get templateSaved => '模板已保存';

  @override
  String deleteTemplateConfirm(String name) {
    return '确定删除模板「$name」吗？';
  }

  @override
  String get templateDeleted => '模板已删除';

  @override
  String get templateVarsHint => '内容中用双大括号包裹变量名即可声明变量';

  @override
  String get variableDefaultValue => '默认值（可选）';

  @override
  String get multiSelect => '多选';

  @override
  String selectedCount(int count) {
    return '已选 $count 项';
  }

  @override
  String get selectAll => '全选';

  @override
  String get deselectAll => '取消全选';

  @override
  String get moveToCollection => '移动到…';

  @override
  String moveSuccess(int count) {
    return '已移动 $count 项';
  }
}
