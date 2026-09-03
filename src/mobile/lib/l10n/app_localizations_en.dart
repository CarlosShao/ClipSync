// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'ClipSync';

  @override
  String get cancel => 'Cancel';

  @override
  String get confirm => 'Confirm';

  @override
  String get save => 'Save';

  @override
  String get delete => 'Delete';

  @override
  String get refresh => 'Refresh';

  @override
  String get retry => 'Retry';

  @override
  String get loading => 'Loading...';

  @override
  String get login => 'Sign in';

  @override
  String get loginSubtitle => 'Cross-device clipboard sync';

  @override
  String get phoneNumber => 'Phone number';

  @override
  String get phoneHint => 'Enter your phone number';

  @override
  String get verificationCode => 'Verification code';

  @override
  String get codeHint => 'Enter verification code';

  @override
  String get getCode => 'Get code';

  @override
  String codeCountdown(int seconds) {
    return '${seconds}s';
  }

  @override
  String get invalidPhone => 'Please enter a valid phone number';

  @override
  String get codeSent => 'Verification code sent';

  @override
  String get loginFailed =>
      'Sign-in failed, please check the verification code';

  @override
  String get enterSixDigitCode => 'Please enter the 6-digit code';

  @override
  String get codeInvalidOrExpired => 'Code invalid or expired, please retry';

  @override
  String get twoFactorTitle => 'Two-step verification';

  @override
  String get twoFactorDesc =>
      'Enter the 6-digit code from your authenticator app\n(or a backup code)';

  @override
  String get verifyAndLogin => 'Verify and sign in';

  @override
  String get backToLogin => 'Back to sign-in';

  @override
  String get phoneAndCodeRequired => 'Please enter phone number and code';

  @override
  String get twoFactorCodeLabel => 'Authentication code';

  @override
  String get tabClipboard => 'Clipboard';

  @override
  String get tabFavorites => 'Favorites';

  @override
  String get tabDevices => 'Devices';

  @override
  String get tabSettings => 'Settings';

  @override
  String get refreshDevices => 'Refresh devices';

  @override
  String get noDevices => 'No devices';

  @override
  String get noDevicesDesc => 'Sign in on other devices to start syncing';

  @override
  String get unbindDevice => 'Unbind device';

  @override
  String get unbind => 'Unbind';

  @override
  String unbindConfirm(String deviceName) {
    return 'Unbind \"$deviceName\"? The device will no longer be able to sync.';
  }

  @override
  String get devicesLoadFailed => 'Failed to load devices';

  @override
  String unbindCurrentDeviceConfirm(String deviceName) {
    return '\"$deviceName\" is the current device.\nUnbinding will stop sync on this device, and you will need to re-register the device to restore sync. Unbind anyway?';
  }

  @override
  String get biometricUnlockReason =>
      'Verify fingerprint or face to unlock ClipSync';

  @override
  String get biometricVerifyFailed => 'Verification failed, please retry';

  @override
  String get lockScreenMessage =>
      'App is locked. Verify your identity to continue';

  @override
  String get unlock => 'Unlock';

  @override
  String get backAgainToExit => 'Press back again to exit ClipSync';

  @override
  String get skip => 'Skip';

  @override
  String get next => 'Next';

  @override
  String get getStarted => 'Get Started';

  @override
  String get onboardingTitle1 => 'Welcome to ClipSync';

  @override
  String get onboardingDesc1 =>
      'Cross-device clipboard sync tool\nLet your clipboard flow freely between phones and computers';

  @override
  String get onboardingTitle2 => 'Background auto sync';

  @override
  String get onboardingDesc2 =>
      'ClipSync stays connected in the background\nContent copied on your computer syncs to your phone automatically';

  @override
  String get onboardingTitle3 => 'Instant notifications';

  @override
  String get onboardingDesc3 =>
      'When content is copied on your computer\nyour phone is notified right away';

  @override
  String get onboardingTitle4 => 'Clipboard sync';

  @override
  String get onboardingDesc4 =>
      'Content copied on your phone also syncs automatically\nFlowing seamlessly across all your devices';

  @override
  String get onboardingTitle5 => 'All set';

  @override
  String get onboardingDesc5 =>
      'You\'re ready to start using ClipSync!\nTry copying something 😊';

  @override
  String get sectionServer => 'Server';

  @override
  String get sectionGeneral => 'General';

  @override
  String get sectionAppearance => 'Appearance';

  @override
  String get sectionData => 'Data';

  @override
  String get sectionNotification => 'Notifications';

  @override
  String get sectionSubscription => 'Subscription';

  @override
  String get serverUrl => 'Server address';

  @override
  String get serverUrlDesc => 'ClipSync backend service address';

  @override
  String get serverUrlSaved => 'Server address saved';

  @override
  String get pushNotifications => 'Push notifications';

  @override
  String get pushNotificationsDesc => 'Receive clipboard sync notifications';

  @override
  String get clipboardCapture => 'Clipboard capture';

  @override
  String get clipboardCaptureDesc =>
      'When off, content copied on this device no longer syncs to other devices';

  @override
  String get theme => 'Theme';

  @override
  String get themeSystem => 'Follow system';

  @override
  String get themeLight => 'Light';

  @override
  String get themeDark => 'Dark';

  @override
  String get language => 'Language';

  @override
  String get langZh => '简体中文';

  @override
  String get langEn => 'English';

  @override
  String get clearCache => 'Clear cache';

  @override
  String get clearCacheDesc => 'Clear clipboard cache and temporary files';

  @override
  String get clearCacheTooltip => 'Clear';

  @override
  String get cacheCleared => 'Cache cleared';

  @override
  String clearCacheFailed(String error) {
    return 'Failed to clear: $error';
  }

  @override
  String get templates => 'Templates';

  @override
  String get templatesDesc => 'Browse and quickly use clipboard templates';

  @override
  String get notificationSettings => 'Notification settings';

  @override
  String get notificationSettingsDesc => 'Manage push notification preferences';

  @override
  String get subscriptionManagement => 'Subscription';

  @override
  String get subscriptionDesc => 'View or change your plan';

  @override
  String get logout => 'Sign out';

  @override
  String get logoutDesc => 'Clear local sign-in credentials';

  @override
  String get logoutConfirmMessage =>
      'Sign out of the current account? You will need to sign in with a verification code again.';

  @override
  String get logoutAction => 'Sign out';

  @override
  String get aboutDesc => 'Cross-device clipboard sync tool';

  @override
  String get clipboardSearchHint => 'Search clipboard content…';

  @override
  String get clearSearch => 'Clear search';

  @override
  String get typeAll => 'All';

  @override
  String get typeText => 'Text';

  @override
  String get typeLink => 'Link';

  @override
  String get typeImage => 'Image';

  @override
  String get typeFile => 'File';

  @override
  String get typeCode => 'Code';

  @override
  String get clipboardNoResultsTitle => 'No matches found';

  @override
  String get clipboardNoResultsMessage =>
      'Try different keywords, or clear the search and filters';

  @override
  String get clipboardClearFilters => 'Clear filters';

  @override
  String get clipboardEmptyTitle => 'No clipboard content yet';

  @override
  String get clipboardEmptyMessage =>
      'Copy anything on your computer and it will sync here automatically';

  @override
  String get clipboardLoadMoreFailed => 'Failed to load more';

  @override
  String get clipboardNoMore => 'No more items';

  @override
  String clipboardNewContentBar(int count) {
    return '$count new items, tap to view';
  }

  @override
  String get favorite => 'Favorite';

  @override
  String get unfavorite => 'Unfavorite';

  @override
  String get pinToTop => 'Pin to top';

  @override
  String get comingSoon => 'Coming soon';

  @override
  String get moreActions => 'More actions';

  @override
  String get deleteConfirmTitle => 'Delete this item?';

  @override
  String deleteConfirmMessage(String preview) {
    return '\"$preview\" will be permanently deleted.';
  }

  @override
  String get deleted => 'Deleted';

  @override
  String get deleteFailed => 'Delete failed, please try again later';

  @override
  String get placeholderFile => '(File)';

  @override
  String get placeholderImage => '(Image)';

  @override
  String get placeholderEmpty => '(Empty)';

  @override
  String get unknownDevice => 'Unknown device';

  @override
  String clipboardCardSemantics(String type, String preview) {
    return 'Clipboard $type, content: $preview';
  }

  @override
  String get relJustNow => 'Just now';

  @override
  String relMinutesAgo(int minutes) {
    return '$minutes min ago';
  }

  @override
  String relHoursAgo(int hours) {
    return '$hours h ago';
  }

  @override
  String relDaysAgo(int days) {
    return '$days d ago';
  }

  @override
  String relDateMD(int month, int day) {
    return '$month/$day';
  }

  @override
  String relDateYMD(int year, int month, int day) {
    return '$year/$month/$day';
  }

  @override
  String get copy => 'Copy';

  @override
  String get copied => 'Copied';

  @override
  String get noTextContent => 'No text content in this item';

  @override
  String get share => 'Share';

  @override
  String get shareFailed => 'Share failed, please try again later';

  @override
  String get favoriteFailed => 'Favorite action failed, please try again later';

  @override
  String get imageNoCredentials =>
      'Sign-in credentials missing, unable to load the image';

  @override
  String get imageLoadFailed =>
      'Image failed to load, check your network and retry';

  @override
  String get contentLoadFailed =>
      'Content failed to load, check your network and retry';

  @override
  String get linkHint =>
      'Link content · tap \"Copy\" below to copy the full link';

  @override
  String get unknownFile => 'Unknown file';

  @override
  String get downloading => 'Downloading…';

  @override
  String get openDownload => 'Open (download to device)';

  @override
  String get copyFileName => 'Copy file name';

  @override
  String get fileDownloadHint =>
      'Files are fetched via the server download API and saved to the app\'s temporary directory';

  @override
  String get fileLocalOnlyHint =>
      'The file is saved on the source device and cannot be fetched across devices yet';

  @override
  String fileSavedTo(String path) {
    return 'Saved to $path';
  }

  @override
  String get sectionSecurity => 'Security';

  @override
  String get biometricLock => 'Biometric lock';

  @override
  String get biometricLockDesc =>
      'Require fingerprint or face verification on cold start and app resume';

  @override
  String get biometricUnsupported =>
      'Biometric authentication is not supported on this device';

  @override
  String get biometricLockReason =>
      'Verify fingerprint or face to enable the biometric lock';

  @override
  String get biometricLockFailed =>
      'Verification failed, biometric lock not enabled';

  @override
  String get create => 'Create';

  @override
  String get createCollection => 'New collection';

  @override
  String collectionCreated(String name) {
    return 'Created \"$name\"';
  }

  @override
  String get deleteCollection => 'Delete collection';

  @override
  String deleteCollectionConfirm(String name) {
    return 'Delete \"$name\"?\n\nClipboard items in this collection stay in clipboard favorites; sub-collections under it will be deleted as well.';
  }

  @override
  String collectionDeleted(String name) {
    return 'Deleted \"$name\"';
  }

  @override
  String get collectionsEmptyTitle => 'No collections yet';

  @override
  String get collectionsEmptyMessage =>
      'Create a collection to organize your frequently used clipboard content';

  @override
  String collectionItemCount(int count) {
    return '$count items';
  }

  @override
  String collectionFolderCount(int count) {
    return '$count folders';
  }

  @override
  String get subCollectionsHeader => 'Sub-collections';

  @override
  String get itemsSectionHeader => 'Items';

  @override
  String get breadcrumbAll => 'All';

  @override
  String createUnderParentHint(String name) {
    return 'Will be created under \"$name\"';
  }

  @override
  String get collectionNameRequired => 'Please enter a collection name';

  @override
  String get collectionNameLabel => 'Collection name';

  @override
  String get noCopyableContent => 'No copyable content in this item';

  @override
  String get copyFailed => 'Copy failed, please retry';

  @override
  String get collectionItemsEmptyTitle => 'No items in this collection';

  @override
  String get collectionItemsEmptyMessage =>
      'Items added to favorites from the clipboard list will appear here';

  @override
  String get unknownSource => 'Unknown source';

  @override
  String get sessionsLoadFailed =>
      'Failed to load sessions, check your network and retry';

  @override
  String get activeSessions => 'Active sessions';

  @override
  String get activeSessionsDesc =>
      'Device sessions signed in to this account can be revoked remotely';

  @override
  String get refreshSessions => 'Refresh sessions';

  @override
  String get noActiveSessions => 'No active sessions';

  @override
  String get noActiveSessionsDesc =>
      'The current account has no active sign-in sessions';

  @override
  String get revokeCurrentSession => 'Revoke current session';

  @override
  String get revokeSession => 'Revoke session';

  @override
  String revokeCurrentSessionConfirm(String deviceName) {
    return '\"$deviceName\" is the current device.\nRevoking signs this device out immediately and requires signing in with a verification code again. Revoke anyway?';
  }

  @override
  String revokeSessionConfirm(String deviceName) {
    return 'Revoke the session of \"$deviceName\"? That device will be signed out immediately.';
  }

  @override
  String get revoke => 'Revoke';

  @override
  String get revokeFailed => 'Revoke failed, please try again later';

  @override
  String get currentSessionRevoked => 'Current session revoked, signed out';

  @override
  String sessionRevoked(String deviceName) {
    return 'Session of \"$deviceName\" revoked';
  }

  @override
  String get lastActivePrefix => 'Last active ';

  @override
  String get currentBadge => 'Current';

  @override
  String get cancelSubscription => 'Cancel subscription';

  @override
  String get cancelSubscriptionConfirm =>
      'Cancel your subscription? It will downgrade to the free plan after the current billing period ends, and benefits remain active until then.';

  @override
  String get subscriptionCancelled =>
      'Subscription cancelled, effective at the end of the current billing period';

  @override
  String get resumeSubscription => 'Resume subscription';

  @override
  String get resumeSubscriptionConfirm =>
      'Resume your subscription? Auto-renewal will continue after the current period ends.';

  @override
  String get subscriptionResumed =>
      'Subscription resumed, auto-renewal will continue';

  @override
  String get thinkAgain => 'Think again';

  @override
  String get statusCancelScheduled => 'Cancelled (ends at period end)';

  @override
  String get statusActive => 'Active';

  @override
  String get statusTrial => 'Trial';

  @override
  String get availablePlans => 'Available plans';

  @override
  String get billingRecords => 'Billing records';

  @override
  String get subscriptionStatusLabel => 'Subscription status';

  @override
  String get expiryDate => 'Expiry date';

  @override
  String get trialEndDate => 'Trial ends on';

  @override
  String subscriptionEndsOn(String date) {
    return 'Your subscription ends on $date and will automatically downgrade to the free plan.';
  }

  @override
  String get desktopPaymentHint =>
      'Payment is not supported on mobile yet. To upgrade or purchase a plan, sign in on the desktop app and complete the payment in Subscription.';

  @override
  String get currentPlanBadge => 'Current plan';

  @override
  String get payOnDesktop => 'Pay on desktop';

  @override
  String get noInvoices => 'No billing records';

  @override
  String get renderResultTitle => 'Render result';

  @override
  String get close => 'Close';

  @override
  String get renderResultCopied => 'Rendered result copied to clipboard';

  @override
  String get copyAll => 'Copy all';

  @override
  String get noTemplates => 'No templates';

  @override
  String get noTemplatesDesc =>
      'Templates saved from clipboard content on the desktop will sync here';

  @override
  String variableCount(int count) {
    return '$count variables';
  }

  @override
  String get emptyTemplateContent => '(Template content is empty)';

  @override
  String get useTemplate => 'Use';

  @override
  String get fillVariableTitle => 'Fill in variables';

  @override
  String variableProgress(int step, int total) {
    return 'Variable $step / $total';
  }

  @override
  String variableInputHint(String name) {
    return 'Enter a value for $name';
  }

  @override
  String get done => 'Done';

  @override
  String get nextItem => 'Next item';

  @override
  String get permissionGuideTitle => 'Permissions and keep-alive guide';

  @override
  String get permissionGuideIntro =>
      'To keep \"copy on computer, instantly on phone\" working, complete these 3 steps:';

  @override
  String get finishAndStart => 'Done, start using';

  @override
  String get stepNotifTitle => '1. Notification permission';

  @override
  String get stepNotifDesc =>
      'Receive instant \"clipboard updated\" notifications (authorization required on Android 13+).';

  @override
  String get statusOn => 'On';

  @override
  String get statusOff => 'Off';

  @override
  String get statusExempted => 'Exempted';

  @override
  String get statusNotExempted => 'Not exempted';

  @override
  String get requestNotifPermission => 'Request notification permission';

  @override
  String get notifPermissionGranted => 'Notification permission granted';

  @override
  String get notifPermissionDenied =>
      'Notification permission not granted. Enable it manually in system settings.';

  @override
  String get stepBatteryTitle => '2. Battery optimization exemption';

  @override
  String get stepBatteryDesc =>
      'Join the battery optimization whitelist to avoid sync disconnection and delayed notifications when the screen is off.';

  @override
  String get statusUndetected => 'Cannot auto-detect (requires native support)';

  @override
  String get batteryTitle => 'Battery optimization exemption';

  @override
  String get batteryManualGuide =>
      'Auto navigation failed. Set it manually:\n\nSystem settings → App management → ClipSync → Battery\n→ Choose \"Unrestricted / Allow background activity\"\n\nOn some devices: Settings → Battery → More battery settings → App sleep.';

  @override
  String get jumping => 'Opening…';

  @override
  String get gotoBatterySettings => 'Go to battery optimization settings';

  @override
  String get stepAutoStartTitle => '3. Auto-start settings';

  @override
  String get stepAutoStartDesc =>
      'Allow ClipSync to auto-start and run in the background, resuming sync after reboot.';

  @override
  String get autoStartTitle => 'Auto-start settings';

  @override
  String get autoStartGuide =>
      'Example paths by vendor:\n\n· Xiaomi MIUI: Security center → App management → Permissions → Auto-start management → Allow ClipSync\n· Huawei EMUI/HarmonyOS: Settings → Apps → App launch management → ClipSync → Manual management (allow auto-start, linked launch, background activity)\n· OPPO ColorOS: Phone Manager → Permission privacy → Auto-start management → Allow ClipSync\n· vivo OriginOS: i Manager → App management → Permission management → Auto-start → Allow ClipSync';

  @override
  String get autoStartStatusHint => 'Varies by vendor, verify manually';

  @override
  String get gotIt => 'Got it';

  @override
  String get gotoAutoStartSettings => 'Go to auto-start settings';

  @override
  String get unknown => 'Unknown';

  @override
  String get saveToClipboard => 'Save to clipboard';

  @override
  String get saveToClipboardDesc =>
      'Content will be uploaded to your ClipSync account and become visible on all signed-in devices.';

  @override
  String get nothingToSave => 'Nothing to save';

  @override
  String get saving => 'Saving…';

  @override
  String saveInFailed(String error) {
    return 'Save failed: $error';
  }

  @override
  String get saveInFailedRetry => 'Save failed, please try again later';

  @override
  String savedInCount(int count) {
    return 'Saved $count clipboard items';
  }

  @override
  String imageCount(int count) {
    return 'Images ($count)';
  }

  @override
  String deviceSemantics(String name, String status) {
    return 'Device: $name, status: $status';
  }

  @override
  String get deviceOnline => 'Online';

  @override
  String get deviceOffline => 'Offline';

  @override
  String get platformDesktop => 'Desktop';

  @override
  String get platformMobile => 'Mobile';

  @override
  String get platformTablet => 'Tablet';

  @override
  String get loadFailedTitle => 'Load failed';

  @override
  String get errorNoToken => 'Not signed in. Please sign in and try again.';

  @override
  String get errorSendCode => 'Failed to send verification code';

  @override
  String get errorFetchProfile => 'Failed to load profile';

  @override
  String get errorFetchClipboard => 'Failed to load clipboard items';

  @override
  String get errorFetchItemContent => 'Failed to load full content';

  @override
  String get errorRegisterDevice => 'Failed to register device';

  @override
  String get errorRemoveDevice => 'Failed to remove device';

  @override
  String get errorFetchTemplates => 'Failed to load templates';

  @override
  String get errorRenderTemplate => 'Failed to render template';

  @override
  String get errorFetchCollections => 'Failed to load collections';

  @override
  String get errorFetchCollectionItems => 'Failed to load collection items';

  @override
  String get errorCreateCollection => 'Failed to create collection';

  @override
  String get errorDeleteCollection => 'Failed to delete collection';

  @override
  String get errorFetchPlans => 'Failed to load plans';

  @override
  String get errorFetchCurrentSub => 'Failed to load subscription';

  @override
  String get errorCancelSub => 'Failed to cancel subscription';

  @override
  String get errorResumeSub => 'Failed to resume subscription';

  @override
  String get errorFetchInvoices => 'Failed to load invoices';

  @override
  String get errorUpload => 'Upload failed';

  @override
  String get errorDownload => 'Download failed';

  @override
  String get errorDeviceNotRegistered =>
      'Device not registered. Sign out and sign in again, then retry.';

  @override
  String get errorNetwork => 'Network error. Check your connection and retry.';

  @override
  String get errorUnknown => 'Something went wrong. Please try again later.';

  @override
  String get errorFetchNotificationPrefs =>
      'Failed to load notification preferences';

  @override
  String get errorUpdateNotificationPrefs =>
      'Failed to save notification preference';

  @override
  String get notifChannelClipboard => 'Clipboard sync';

  @override
  String get notifChannelClipboardDesc =>
      'Clipboard sync reminders between your devices (silent)';

  @override
  String get notifChannelAlert => 'Sync alerts';

  @override
  String get notifChannelAlertDesc =>
      'Sync errors, device alerts and other important reminders';

  @override
  String get notifClipboardUpdated => 'Clipboard updated';

  @override
  String get notifNewClipboardBody => 'New clipboard content received';

  @override
  String get serverNotifPrefs => 'Server notification preferences';

  @override
  String get notifTypeDeviceOnline => 'Device online';

  @override
  String get notifTypeSyncComplete => 'Sync complete';

  @override
  String get notifTypeSecurityAlert => 'Security alerts';

  @override
  String get notifTypeProductUpdate => 'Product updates';

  @override
  String get systemNotifSettings => 'System notification settings';

  @override
  String get systemNotifSettingsDesc =>
      'Manage ClipSync\'s notification permission and channels in system settings';

  @override
  String get systemNotifSettingsFailed =>
      'Could not open system notification settings';

  @override
  String get errorReportTitle => 'Error report';

  @override
  String get exportErrorLogs => 'Export error logs';

  @override
  String get errorLocalOnlyDesc =>
      'Errors are kept locally on this device (up to 20) and are never uploaded automatically.';

  @override
  String get clearAll => 'Clear all';

  @override
  String get errorQueueCleared => 'Error queue cleared';

  @override
  String get planFree => 'Free';

  @override
  String get perMonth => '/month';

  @override
  String get perYear => '/year';

  @override
  String planMaxDevices(int count) {
    return 'Up to $count devices';
  }

  @override
  String planDailyClips(int count) {
    return '$count clipboard items per day';
  }

  @override
  String planStorage(int size) {
    return 'Storage: $size MB';
  }

  @override
  String get featureOcr => 'OCR text recognition';

  @override
  String get featurePrioritySync => 'Priority sync';

  @override
  String get featureAiClassify => 'AI smart classification';

  @override
  String get featureTeamShare => 'Team sharing';

  @override
  String get renameCollection => 'Rename group';

  @override
  String get collectionRenamed => 'Group renamed';

  @override
  String get addToCollection => 'Add to group';

  @override
  String get removeFromCollection => 'Remove from group';

  @override
  String get selectGroup => 'Select a group';

  @override
  String get noAvailableGroups =>
      'No groups yet. Create one in Favorites first';

  @override
  String movedToCollection(String name) {
    return 'Added to \"$name\"';
  }

  @override
  String get removedFromCollection => 'Removed from group';

  @override
  String get sharedLinks => 'Shared links';

  @override
  String get sharedLinksDesc => 'Manage external share links for your content';

  @override
  String get noSharedLinks => 'No shared links';

  @override
  String get noSharedLinksDesc =>
      'Shared links created from item details will appear here';

  @override
  String get createSharedLink => 'Create shared link';

  @override
  String get sharedLinkCreated => 'Shared link created and copied';

  @override
  String get copyLink => 'Copy link';

  @override
  String get linkCopied => 'Link copied';

  @override
  String get revokeLink => 'Revoke link';

  @override
  String get revokeLinkConfirm =>
      'Revoke this shared link? It will stop working immediately.';

  @override
  String get sharedLinkRevoked => 'Link revoked';

  @override
  String expiresAt(String date) {
    return 'Expires $date';
  }

  @override
  String get neverExpires => 'Never expires';

  @override
  String get notificationsCenter => 'Notifications';

  @override
  String get notificationsCenterDesc => 'View in-app notifications and replies';

  @override
  String get noNotifications => 'No notifications';

  @override
  String get markAllRead => 'Mark all read';

  @override
  String get markRead => 'Mark as read';

  @override
  String get notifLoadFailed => 'Failed to load notifications';

  @override
  String get accountSection => 'Account';

  @override
  String get profileTitle => 'Profile';

  @override
  String get nickname => 'Nickname';

  @override
  String get editNickname => 'Edit nickname';

  @override
  String get nicknameSaved => 'Nickname updated';

  @override
  String get nicknameSaveFailed => 'Failed to save, please try again later';

  @override
  String get notLoggedIn => 'Not signed in';

  @override
  String get searchHistoryTitle => 'Search history';

  @override
  String get clearSearchHistory => 'Clear history';

  @override
  String get searchHistoryCleared => 'Search history cleared';

  @override
  String get advancedFilter => 'Filters';

  @override
  String get filterDateRange => 'Date range';

  @override
  String get filterToday => 'Today';

  @override
  String get filterWeek => 'Last 7 days';

  @override
  String get filterMonth => 'Last 30 days';

  @override
  String get filterAllTime => 'All time';

  @override
  String get filterCustom => 'Custom';

  @override
  String get filterDateFrom => 'Start';

  @override
  String get filterDateTo => 'End';

  @override
  String get filterDevice => 'Device';

  @override
  String get filterAllDevices => 'All devices';

  @override
  String get filterFavoritesOnly => 'Favorites only';

  @override
  String get applyFilter => 'Apply';

  @override
  String get resetFilter => 'Reset';

  @override
  String activeFilters(int count) {
    return '$count filters';
  }

  @override
  String get pinSuccess => 'Pinned';

  @override
  String get unpinSuccess => 'Unpinned';

  @override
  String get setExpiry => 'Set expiry';

  @override
  String get expiryNever => 'Never';

  @override
  String get expiryOneHour => '1 hour';

  @override
  String get expiryOneDay => '1 day';

  @override
  String get expiryOneWeek => '7 days';

  @override
  String get expiryOneMonth => '30 days';

  @override
  String get expirySet => 'Expiry updated';

  @override
  String get expiredBadge => 'Expired';

  @override
  String get archive => 'Archive';

  @override
  String get unarchive => 'Unarchive';

  @override
  String get archivedBadge => 'Archived';

  @override
  String get editTags => 'Edit tags';

  @override
  String get tagsHint => 'Separate tags with commas';

  @override
  String get tagsSaved => 'Tags updated';

  @override
  String get itemLocked => 'This item is protected';

  @override
  String get passwordLabel => 'Password';

  @override
  String get wrongPassword => 'Incorrect password';

  @override
  String get filterArchived => 'Archived';

  @override
  String get newTemplate => 'New template';

  @override
  String get editTemplate => 'Edit template';

  @override
  String get templateName => 'Template name';

  @override
  String get templateContent => 'Content';

  @override
  String get templateNameRequired => 'Template name is required';

  @override
  String get templateSaved => 'Template saved';

  @override
  String deleteTemplateConfirm(String name) {
    return 'Delete template \"$name\"?';
  }

  @override
  String get templateDeleted => 'Template deleted';

  @override
  String get templateVarsHint =>
      'Wrap a variable name in double braces in the content to declare it';

  @override
  String get variableDefaultValue => 'Default value (optional)';

  @override
  String get multiSelect => 'Select multiple';

  @override
  String selectedCount(int count) {
    return '$count selected';
  }

  @override
  String get selectAll => 'Select all';

  @override
  String get deselectAll => 'Deselect all';

  @override
  String get moveToCollection => 'Move to…';

  @override
  String moveSuccess(int count) {
    return 'Moved $count items';
  }

  @override
  String get clipboardWriteback => 'Auto write to system clipboard';

  @override
  String get clipboardWritebackDesc =>
      'When a new item syncs from other devices, write it into this device clipboard so you can paste anywhere directly';

  @override
  String get download => 'Download';

  @override
  String get open => 'Open';

  @override
  String get downloadAllZip => 'Download all (zip)';

  @override
  String filesCount(int count) {
    return '$count files';
  }

  @override
  String downloadingPercent(int percent) {
    return 'Downloading $percent%';
  }

  @override
  String get openFileFailed => 'No app found to open this file';

  @override
  String get limitSyncNotice =>
      'This file exceeded the plan limit on the source device and was not synced to the cloud';

  @override
  String get viewPlans => 'View plans';

  @override
  String get typeColor => 'Color';

  @override
  String get copyFirstItemGuide =>
      'Copy something on your computer to see it here';

  @override
  String get quickPaste => 'Quick Paste';

  @override
  String get recentCopied => 'Recent copied';

  @override
  String get pinnedSection => 'Pinned';

  @override
  String get sectionActiveSessions => 'Active Sessions';
}
