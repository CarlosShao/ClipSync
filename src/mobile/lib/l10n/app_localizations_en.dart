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
}
