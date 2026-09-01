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
  String sendCodeFailed(String error) {
    return 'Failed to send: $error';
  }

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
}
