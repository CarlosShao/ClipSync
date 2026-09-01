import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_zh.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('zh'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In en, this message translates to:
  /// **'ClipSync'**
  String get appTitle;

  /// No description provided for @cancel.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancel;

  /// No description provided for @confirm.
  ///
  /// In en, this message translates to:
  /// **'Confirm'**
  String get confirm;

  /// No description provided for @save.
  ///
  /// In en, this message translates to:
  /// **'Save'**
  String get save;

  /// No description provided for @delete.
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get delete;

  /// No description provided for @refresh.
  ///
  /// In en, this message translates to:
  /// **'Refresh'**
  String get refresh;

  /// No description provided for @retry.
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get retry;

  /// No description provided for @loading.
  ///
  /// In en, this message translates to:
  /// **'Loading...'**
  String get loading;

  /// No description provided for @login.
  ///
  /// In en, this message translates to:
  /// **'Sign in'**
  String get login;

  /// No description provided for @loginSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Cross-device clipboard sync'**
  String get loginSubtitle;

  /// No description provided for @phoneNumber.
  ///
  /// In en, this message translates to:
  /// **'Phone number'**
  String get phoneNumber;

  /// No description provided for @phoneHint.
  ///
  /// In en, this message translates to:
  /// **'Enter your phone number'**
  String get phoneHint;

  /// No description provided for @verificationCode.
  ///
  /// In en, this message translates to:
  /// **'Verification code'**
  String get verificationCode;

  /// No description provided for @codeHint.
  ///
  /// In en, this message translates to:
  /// **'Enter verification code'**
  String get codeHint;

  /// No description provided for @getCode.
  ///
  /// In en, this message translates to:
  /// **'Get code'**
  String get getCode;

  /// No description provided for @codeCountdown.
  ///
  /// In en, this message translates to:
  /// **'{seconds}s'**
  String codeCountdown(int seconds);

  /// No description provided for @invalidPhone.
  ///
  /// In en, this message translates to:
  /// **'Please enter a valid phone number'**
  String get invalidPhone;

  /// No description provided for @codeSent.
  ///
  /// In en, this message translates to:
  /// **'Verification code sent'**
  String get codeSent;

  /// No description provided for @loginFailed.
  ///
  /// In en, this message translates to:
  /// **'Sign-in failed, please check the verification code'**
  String get loginFailed;

  /// No description provided for @enterSixDigitCode.
  ///
  /// In en, this message translates to:
  /// **'Please enter the 6-digit code'**
  String get enterSixDigitCode;

  /// No description provided for @codeInvalidOrExpired.
  ///
  /// In en, this message translates to:
  /// **'Code invalid or expired, please retry'**
  String get codeInvalidOrExpired;

  /// No description provided for @twoFactorTitle.
  ///
  /// In en, this message translates to:
  /// **'Two-step verification'**
  String get twoFactorTitle;

  /// No description provided for @twoFactorDesc.
  ///
  /// In en, this message translates to:
  /// **'Enter the 6-digit code from your authenticator app\n(or a backup code)'**
  String get twoFactorDesc;

  /// No description provided for @verifyAndLogin.
  ///
  /// In en, this message translates to:
  /// **'Verify and sign in'**
  String get verifyAndLogin;

  /// No description provided for @backToLogin.
  ///
  /// In en, this message translates to:
  /// **'Back to sign-in'**
  String get backToLogin;

  /// No description provided for @sendCodeFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to send: {error}'**
  String sendCodeFailed(String error);

  /// No description provided for @phoneAndCodeRequired.
  ///
  /// In en, this message translates to:
  /// **'Please enter phone number and code'**
  String get phoneAndCodeRequired;

  /// No description provided for @twoFactorCodeLabel.
  ///
  /// In en, this message translates to:
  /// **'Authentication code'**
  String get twoFactorCodeLabel;

  /// No description provided for @tabClipboard.
  ///
  /// In en, this message translates to:
  /// **'Clipboard'**
  String get tabClipboard;

  /// No description provided for @tabFavorites.
  ///
  /// In en, this message translates to:
  /// **'Favorites'**
  String get tabFavorites;

  /// No description provided for @tabDevices.
  ///
  /// In en, this message translates to:
  /// **'Devices'**
  String get tabDevices;

  /// No description provided for @tabSettings.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get tabSettings;

  /// No description provided for @refreshDevices.
  ///
  /// In en, this message translates to:
  /// **'Refresh devices'**
  String get refreshDevices;

  /// No description provided for @noDevices.
  ///
  /// In en, this message translates to:
  /// **'No devices'**
  String get noDevices;

  /// No description provided for @noDevicesDesc.
  ///
  /// In en, this message translates to:
  /// **'Sign in on other devices to start syncing'**
  String get noDevicesDesc;

  /// No description provided for @unbindDevice.
  ///
  /// In en, this message translates to:
  /// **'Unbind device'**
  String get unbindDevice;

  /// No description provided for @unbind.
  ///
  /// In en, this message translates to:
  /// **'Unbind'**
  String get unbind;

  /// No description provided for @unbindConfirm.
  ///
  /// In en, this message translates to:
  /// **'Unbind \"{deviceName}\"? The device will no longer be able to sync.'**
  String unbindConfirm(String deviceName);

  /// No description provided for @devicesLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load devices'**
  String get devicesLoadFailed;

  /// No description provided for @unbindCurrentDeviceConfirm.
  ///
  /// In en, this message translates to:
  /// **'\"{deviceName}\" is the current device.\nUnbinding will stop sync on this device, and you will need to re-register the device to restore sync. Unbind anyway?'**
  String unbindCurrentDeviceConfirm(String deviceName);

  /// No description provided for @biometricUnlockReason.
  ///
  /// In en, this message translates to:
  /// **'Verify fingerprint or face to unlock ClipSync'**
  String get biometricUnlockReason;

  /// No description provided for @biometricVerifyFailed.
  ///
  /// In en, this message translates to:
  /// **'Verification failed, please retry'**
  String get biometricVerifyFailed;

  /// No description provided for @lockScreenMessage.
  ///
  /// In en, this message translates to:
  /// **'App is locked. Verify your identity to continue'**
  String get lockScreenMessage;

  /// No description provided for @unlock.
  ///
  /// In en, this message translates to:
  /// **'Unlock'**
  String get unlock;

  /// No description provided for @backAgainToExit.
  ///
  /// In en, this message translates to:
  /// **'Press back again to exit ClipSync'**
  String get backAgainToExit;

  /// No description provided for @skip.
  ///
  /// In en, this message translates to:
  /// **'Skip'**
  String get skip;

  /// No description provided for @next.
  ///
  /// In en, this message translates to:
  /// **'Next'**
  String get next;

  /// No description provided for @getStarted.
  ///
  /// In en, this message translates to:
  /// **'Get Started'**
  String get getStarted;

  /// No description provided for @onboardingTitle1.
  ///
  /// In en, this message translates to:
  /// **'Welcome to ClipSync'**
  String get onboardingTitle1;

  /// No description provided for @onboardingDesc1.
  ///
  /// In en, this message translates to:
  /// **'Cross-device clipboard sync tool\nLet your clipboard flow freely between phones and computers'**
  String get onboardingDesc1;

  /// No description provided for @onboardingTitle2.
  ///
  /// In en, this message translates to:
  /// **'Background auto sync'**
  String get onboardingTitle2;

  /// No description provided for @onboardingDesc2.
  ///
  /// In en, this message translates to:
  /// **'ClipSync stays connected in the background\nContent copied on your computer syncs to your phone automatically'**
  String get onboardingDesc2;

  /// No description provided for @onboardingTitle3.
  ///
  /// In en, this message translates to:
  /// **'Instant notifications'**
  String get onboardingTitle3;

  /// No description provided for @onboardingDesc3.
  ///
  /// In en, this message translates to:
  /// **'When content is copied on your computer\nyour phone is notified right away'**
  String get onboardingDesc3;

  /// No description provided for @onboardingTitle4.
  ///
  /// In en, this message translates to:
  /// **'Clipboard sync'**
  String get onboardingTitle4;

  /// No description provided for @onboardingDesc4.
  ///
  /// In en, this message translates to:
  /// **'Content copied on your phone also syncs automatically\nFlowing seamlessly across all your devices'**
  String get onboardingDesc4;

  /// No description provided for @onboardingTitle5.
  ///
  /// In en, this message translates to:
  /// **'All set'**
  String get onboardingTitle5;

  /// No description provided for @onboardingDesc5.
  ///
  /// In en, this message translates to:
  /// **'You\'re ready to start using ClipSync!\nTry copying something 😊'**
  String get onboardingDesc5;

  /// No description provided for @sectionServer.
  ///
  /// In en, this message translates to:
  /// **'Server'**
  String get sectionServer;

  /// No description provided for @sectionGeneral.
  ///
  /// In en, this message translates to:
  /// **'General'**
  String get sectionGeneral;

  /// No description provided for @sectionAppearance.
  ///
  /// In en, this message translates to:
  /// **'Appearance'**
  String get sectionAppearance;

  /// No description provided for @sectionData.
  ///
  /// In en, this message translates to:
  /// **'Data'**
  String get sectionData;

  /// No description provided for @sectionNotification.
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get sectionNotification;

  /// No description provided for @sectionSubscription.
  ///
  /// In en, this message translates to:
  /// **'Subscription'**
  String get sectionSubscription;

  /// No description provided for @serverUrl.
  ///
  /// In en, this message translates to:
  /// **'Server address'**
  String get serverUrl;

  /// No description provided for @serverUrlDesc.
  ///
  /// In en, this message translates to:
  /// **'ClipSync backend service address'**
  String get serverUrlDesc;

  /// No description provided for @serverUrlSaved.
  ///
  /// In en, this message translates to:
  /// **'Server address saved'**
  String get serverUrlSaved;

  /// No description provided for @pushNotifications.
  ///
  /// In en, this message translates to:
  /// **'Push notifications'**
  String get pushNotifications;

  /// No description provided for @pushNotificationsDesc.
  ///
  /// In en, this message translates to:
  /// **'Receive clipboard sync notifications'**
  String get pushNotificationsDesc;

  /// No description provided for @theme.
  ///
  /// In en, this message translates to:
  /// **'Theme'**
  String get theme;

  /// No description provided for @themeSystem.
  ///
  /// In en, this message translates to:
  /// **'Follow system'**
  String get themeSystem;

  /// No description provided for @themeLight.
  ///
  /// In en, this message translates to:
  /// **'Light'**
  String get themeLight;

  /// No description provided for @themeDark.
  ///
  /// In en, this message translates to:
  /// **'Dark'**
  String get themeDark;

  /// No description provided for @language.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get language;

  /// No description provided for @langZh.
  ///
  /// In en, this message translates to:
  /// **'简体中文'**
  String get langZh;

  /// No description provided for @langEn.
  ///
  /// In en, this message translates to:
  /// **'English'**
  String get langEn;

  /// No description provided for @clearCache.
  ///
  /// In en, this message translates to:
  /// **'Clear cache'**
  String get clearCache;

  /// No description provided for @clearCacheDesc.
  ///
  /// In en, this message translates to:
  /// **'Clear clipboard cache and temporary files'**
  String get clearCacheDesc;

  /// No description provided for @clearCacheTooltip.
  ///
  /// In en, this message translates to:
  /// **'Clear'**
  String get clearCacheTooltip;

  /// No description provided for @cacheCleared.
  ///
  /// In en, this message translates to:
  /// **'Cache cleared'**
  String get cacheCleared;

  /// No description provided for @clearCacheFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to clear: {error}'**
  String clearCacheFailed(String error);

  /// No description provided for @templates.
  ///
  /// In en, this message translates to:
  /// **'Templates'**
  String get templates;

  /// No description provided for @templatesDesc.
  ///
  /// In en, this message translates to:
  /// **'Browse and quickly use clipboard templates'**
  String get templatesDesc;

  /// No description provided for @notificationSettings.
  ///
  /// In en, this message translates to:
  /// **'Notification settings'**
  String get notificationSettings;

  /// No description provided for @notificationSettingsDesc.
  ///
  /// In en, this message translates to:
  /// **'Manage push notification preferences'**
  String get notificationSettingsDesc;

  /// No description provided for @subscriptionManagement.
  ///
  /// In en, this message translates to:
  /// **'Subscription'**
  String get subscriptionManagement;

  /// No description provided for @subscriptionDesc.
  ///
  /// In en, this message translates to:
  /// **'View or change your plan'**
  String get subscriptionDesc;

  /// No description provided for @logout.
  ///
  /// In en, this message translates to:
  /// **'Sign out'**
  String get logout;

  /// No description provided for @logoutDesc.
  ///
  /// In en, this message translates to:
  /// **'Clear local sign-in credentials'**
  String get logoutDesc;

  /// No description provided for @logoutConfirmMessage.
  ///
  /// In en, this message translates to:
  /// **'Sign out of the current account? You will need to sign in with a verification code again.'**
  String get logoutConfirmMessage;

  /// No description provided for @logoutAction.
  ///
  /// In en, this message translates to:
  /// **'Sign out'**
  String get logoutAction;

  /// No description provided for @aboutDesc.
  ///
  /// In en, this message translates to:
  /// **'Cross-device clipboard sync tool'**
  String get aboutDesc;

  /// No description provided for @clipboardSearchHint.
  ///
  /// In en, this message translates to:
  /// **'Search clipboard content…'**
  String get clipboardSearchHint;

  /// No description provided for @clearSearch.
  ///
  /// In en, this message translates to:
  /// **'Clear search'**
  String get clearSearch;

  /// No description provided for @typeAll.
  ///
  /// In en, this message translates to:
  /// **'All'**
  String get typeAll;

  /// No description provided for @typeText.
  ///
  /// In en, this message translates to:
  /// **'Text'**
  String get typeText;

  /// No description provided for @typeLink.
  ///
  /// In en, this message translates to:
  /// **'Link'**
  String get typeLink;

  /// No description provided for @typeImage.
  ///
  /// In en, this message translates to:
  /// **'Image'**
  String get typeImage;

  /// No description provided for @typeFile.
  ///
  /// In en, this message translates to:
  /// **'File'**
  String get typeFile;

  /// No description provided for @typeCode.
  ///
  /// In en, this message translates to:
  /// **'Code'**
  String get typeCode;

  /// No description provided for @clipboardNoResultsTitle.
  ///
  /// In en, this message translates to:
  /// **'No matches found'**
  String get clipboardNoResultsTitle;

  /// No description provided for @clipboardNoResultsMessage.
  ///
  /// In en, this message translates to:
  /// **'Try different keywords, or clear the search and filters'**
  String get clipboardNoResultsMessage;

  /// No description provided for @clipboardClearFilters.
  ///
  /// In en, this message translates to:
  /// **'Clear filters'**
  String get clipboardClearFilters;

  /// No description provided for @clipboardEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'No clipboard content yet'**
  String get clipboardEmptyTitle;

  /// No description provided for @clipboardEmptyMessage.
  ///
  /// In en, this message translates to:
  /// **'Copy anything on your computer and it will sync here automatically'**
  String get clipboardEmptyMessage;

  /// No description provided for @clipboardLoadMoreFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load more'**
  String get clipboardLoadMoreFailed;

  /// No description provided for @clipboardNoMore.
  ///
  /// In en, this message translates to:
  /// **'No more items'**
  String get clipboardNoMore;

  /// No description provided for @clipboardNewContentBar.
  ///
  /// In en, this message translates to:
  /// **'{count} new items, tap to view'**
  String clipboardNewContentBar(int count);

  /// No description provided for @favorite.
  ///
  /// In en, this message translates to:
  /// **'Favorite'**
  String get favorite;

  /// No description provided for @unfavorite.
  ///
  /// In en, this message translates to:
  /// **'Unfavorite'**
  String get unfavorite;

  /// No description provided for @pinToTop.
  ///
  /// In en, this message translates to:
  /// **'Pin to top'**
  String get pinToTop;

  /// No description provided for @comingSoon.
  ///
  /// In en, this message translates to:
  /// **'Coming soon'**
  String get comingSoon;

  /// No description provided for @moreActions.
  ///
  /// In en, this message translates to:
  /// **'More actions'**
  String get moreActions;

  /// No description provided for @deleteConfirmTitle.
  ///
  /// In en, this message translates to:
  /// **'Delete this item?'**
  String get deleteConfirmTitle;

  /// No description provided for @deleteConfirmMessage.
  ///
  /// In en, this message translates to:
  /// **'\"{preview}\" will be permanently deleted.'**
  String deleteConfirmMessage(String preview);

  /// No description provided for @deleted.
  ///
  /// In en, this message translates to:
  /// **'Deleted'**
  String get deleted;

  /// No description provided for @deleteFailed.
  ///
  /// In en, this message translates to:
  /// **'Delete failed, please try again later'**
  String get deleteFailed;

  /// No description provided for @placeholderFile.
  ///
  /// In en, this message translates to:
  /// **'(File)'**
  String get placeholderFile;

  /// No description provided for @placeholderImage.
  ///
  /// In en, this message translates to:
  /// **'(Image)'**
  String get placeholderImage;

  /// No description provided for @placeholderEmpty.
  ///
  /// In en, this message translates to:
  /// **'(Empty)'**
  String get placeholderEmpty;

  /// No description provided for @unknownDevice.
  ///
  /// In en, this message translates to:
  /// **'Unknown device'**
  String get unknownDevice;

  /// No description provided for @clipboardCardSemantics.
  ///
  /// In en, this message translates to:
  /// **'Clipboard {type}, content: {preview}'**
  String clipboardCardSemantics(String type, String preview);

  /// No description provided for @relJustNow.
  ///
  /// In en, this message translates to:
  /// **'Just now'**
  String get relJustNow;

  /// No description provided for @relMinutesAgo.
  ///
  /// In en, this message translates to:
  /// **'{minutes} min ago'**
  String relMinutesAgo(int minutes);

  /// No description provided for @relHoursAgo.
  ///
  /// In en, this message translates to:
  /// **'{hours} h ago'**
  String relHoursAgo(int hours);

  /// No description provided for @relDaysAgo.
  ///
  /// In en, this message translates to:
  /// **'{days} d ago'**
  String relDaysAgo(int days);

  /// No description provided for @relDateMD.
  ///
  /// In en, this message translates to:
  /// **'{month}/{day}'**
  String relDateMD(int month, int day);

  /// No description provided for @relDateYMD.
  ///
  /// In en, this message translates to:
  /// **'{year}/{month}/{day}'**
  String relDateYMD(int year, int month, int day);

  /// No description provided for @copy.
  ///
  /// In en, this message translates to:
  /// **'Copy'**
  String get copy;

  /// No description provided for @copied.
  ///
  /// In en, this message translates to:
  /// **'Copied'**
  String get copied;

  /// No description provided for @noTextContent.
  ///
  /// In en, this message translates to:
  /// **'No text content in this item'**
  String get noTextContent;

  /// No description provided for @share.
  ///
  /// In en, this message translates to:
  /// **'Share'**
  String get share;

  /// No description provided for @shareFailed.
  ///
  /// In en, this message translates to:
  /// **'Share failed, please try again later'**
  String get shareFailed;

  /// No description provided for @favoriteFailed.
  ///
  /// In en, this message translates to:
  /// **'Favorite action failed, please try again later'**
  String get favoriteFailed;

  /// No description provided for @imageNoCredentials.
  ///
  /// In en, this message translates to:
  /// **'Sign-in credentials missing, unable to load the image'**
  String get imageNoCredentials;

  /// No description provided for @imageLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Image failed to load, check your network and retry'**
  String get imageLoadFailed;

  /// No description provided for @contentLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Content failed to load, check your network and retry'**
  String get contentLoadFailed;

  /// No description provided for @linkHint.
  ///
  /// In en, this message translates to:
  /// **'Link content · tap \"Copy\" below to copy the full link'**
  String get linkHint;

  /// No description provided for @unknownFile.
  ///
  /// In en, this message translates to:
  /// **'Unknown file'**
  String get unknownFile;

  /// No description provided for @downloading.
  ///
  /// In en, this message translates to:
  /// **'Downloading…'**
  String get downloading;

  /// No description provided for @openDownload.
  ///
  /// In en, this message translates to:
  /// **'Open (download to device)'**
  String get openDownload;

  /// No description provided for @copyFileName.
  ///
  /// In en, this message translates to:
  /// **'Copy file name'**
  String get copyFileName;

  /// No description provided for @fileDownloadHint.
  ///
  /// In en, this message translates to:
  /// **'Files are fetched via the server download API and saved to the app\'s temporary directory'**
  String get fileDownloadHint;

  /// No description provided for @fileLocalOnlyHint.
  ///
  /// In en, this message translates to:
  /// **'The file is saved on the source device and cannot be fetched across devices yet'**
  String get fileLocalOnlyHint;

  /// No description provided for @fileSavedTo.
  ///
  /// In en, this message translates to:
  /// **'Saved to {path}'**
  String fileSavedTo(String path);
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'zh'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'zh':
      return AppLocalizationsZh();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
