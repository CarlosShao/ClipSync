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

  /// No description provided for @sectionSecurity.
  ///
  /// In en, this message translates to:
  /// **'Security'**
  String get sectionSecurity;

  /// No description provided for @biometricLock.
  ///
  /// In en, this message translates to:
  /// **'Biometric lock'**
  String get biometricLock;

  /// No description provided for @biometricLockDesc.
  ///
  /// In en, this message translates to:
  /// **'Require fingerprint or face verification on cold start and app resume'**
  String get biometricLockDesc;

  /// No description provided for @biometricUnsupported.
  ///
  /// In en, this message translates to:
  /// **'Biometric authentication is not supported on this device'**
  String get biometricUnsupported;

  /// No description provided for @biometricLockReason.
  ///
  /// In en, this message translates to:
  /// **'Verify fingerprint or face to enable the biometric lock'**
  String get biometricLockReason;

  /// No description provided for @biometricLockFailed.
  ///
  /// In en, this message translates to:
  /// **'Verification failed, biometric lock not enabled'**
  String get biometricLockFailed;

  /// No description provided for @create.
  ///
  /// In en, this message translates to:
  /// **'Create'**
  String get create;

  /// No description provided for @createCollection.
  ///
  /// In en, this message translates to:
  /// **'New collection'**
  String get createCollection;

  /// No description provided for @collectionCreated.
  ///
  /// In en, this message translates to:
  /// **'Created \"{name}\"'**
  String collectionCreated(String name);

  /// No description provided for @deleteCollection.
  ///
  /// In en, this message translates to:
  /// **'Delete collection'**
  String get deleteCollection;

  /// No description provided for @deleteCollectionConfirm.
  ///
  /// In en, this message translates to:
  /// **'Delete \"{name}\"?\n\nClipboard items in this collection stay in clipboard favorites; sub-collections under it will be deleted as well.'**
  String deleteCollectionConfirm(String name);

  /// No description provided for @collectionDeleted.
  ///
  /// In en, this message translates to:
  /// **'Deleted \"{name}\"'**
  String collectionDeleted(String name);

  /// No description provided for @collectionsEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'No collections yet'**
  String get collectionsEmptyTitle;

  /// No description provided for @collectionsEmptyMessage.
  ///
  /// In en, this message translates to:
  /// **'Create a collection to organize your frequently used clipboard content'**
  String get collectionsEmptyMessage;

  /// No description provided for @collectionItemCount.
  ///
  /// In en, this message translates to:
  /// **'{count} items'**
  String collectionItemCount(int count);

  /// No description provided for @collectionNameRequired.
  ///
  /// In en, this message translates to:
  /// **'Please enter a collection name'**
  String get collectionNameRequired;

  /// No description provided for @collectionNameLabel.
  ///
  /// In en, this message translates to:
  /// **'Collection name'**
  String get collectionNameLabel;

  /// No description provided for @noCopyableContent.
  ///
  /// In en, this message translates to:
  /// **'No copyable content in this item'**
  String get noCopyableContent;

  /// No description provided for @copyFailed.
  ///
  /// In en, this message translates to:
  /// **'Copy failed, please retry'**
  String get copyFailed;

  /// No description provided for @collectionItemsEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'No items in this collection'**
  String get collectionItemsEmptyTitle;

  /// No description provided for @collectionItemsEmptyMessage.
  ///
  /// In en, this message translates to:
  /// **'Items added to favorites from the clipboard list will appear here'**
  String get collectionItemsEmptyMessage;

  /// No description provided for @unknownSource.
  ///
  /// In en, this message translates to:
  /// **'Unknown source'**
  String get unknownSource;

  /// No description provided for @sessionsLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load sessions, check your network and retry'**
  String get sessionsLoadFailed;

  /// No description provided for @activeSessions.
  ///
  /// In en, this message translates to:
  /// **'Active sessions'**
  String get activeSessions;

  /// No description provided for @activeSessionsDesc.
  ///
  /// In en, this message translates to:
  /// **'Device sessions signed in to this account can be revoked remotely'**
  String get activeSessionsDesc;

  /// No description provided for @refreshSessions.
  ///
  /// In en, this message translates to:
  /// **'Refresh sessions'**
  String get refreshSessions;

  /// No description provided for @noActiveSessions.
  ///
  /// In en, this message translates to:
  /// **'No active sessions'**
  String get noActiveSessions;

  /// No description provided for @noActiveSessionsDesc.
  ///
  /// In en, this message translates to:
  /// **'The current account has no active sign-in sessions'**
  String get noActiveSessionsDesc;

  /// No description provided for @revokeCurrentSession.
  ///
  /// In en, this message translates to:
  /// **'Revoke current session'**
  String get revokeCurrentSession;

  /// No description provided for @revokeSession.
  ///
  /// In en, this message translates to:
  /// **'Revoke session'**
  String get revokeSession;

  /// No description provided for @revokeCurrentSessionConfirm.
  ///
  /// In en, this message translates to:
  /// **'\"{deviceName}\" is the current device.\nRevoking signs this device out immediately and requires signing in with a verification code again. Revoke anyway?'**
  String revokeCurrentSessionConfirm(String deviceName);

  /// No description provided for @revokeSessionConfirm.
  ///
  /// In en, this message translates to:
  /// **'Revoke the session of \"{deviceName}\"? That device will be signed out immediately.'**
  String revokeSessionConfirm(String deviceName);

  /// No description provided for @revoke.
  ///
  /// In en, this message translates to:
  /// **'Revoke'**
  String get revoke;

  /// No description provided for @revokeFailed.
  ///
  /// In en, this message translates to:
  /// **'Revoke failed, please try again later'**
  String get revokeFailed;

  /// No description provided for @currentSessionRevoked.
  ///
  /// In en, this message translates to:
  /// **'Current session revoked, signed out'**
  String get currentSessionRevoked;

  /// No description provided for @sessionRevoked.
  ///
  /// In en, this message translates to:
  /// **'Session of \"{deviceName}\" revoked'**
  String sessionRevoked(String deviceName);

  /// No description provided for @lastActivePrefix.
  ///
  /// In en, this message translates to:
  /// **'Last active '**
  String get lastActivePrefix;

  /// No description provided for @currentBadge.
  ///
  /// In en, this message translates to:
  /// **'Current'**
  String get currentBadge;

  /// No description provided for @cancelSubscription.
  ///
  /// In en, this message translates to:
  /// **'Cancel subscription'**
  String get cancelSubscription;

  /// No description provided for @cancelSubscriptionConfirm.
  ///
  /// In en, this message translates to:
  /// **'Cancel your subscription? It will downgrade to the free plan after the current billing period ends, and benefits remain active until then.'**
  String get cancelSubscriptionConfirm;

  /// No description provided for @subscriptionCancelled.
  ///
  /// In en, this message translates to:
  /// **'Subscription cancelled, effective at the end of the current billing period'**
  String get subscriptionCancelled;

  /// No description provided for @resumeSubscription.
  ///
  /// In en, this message translates to:
  /// **'Resume subscription'**
  String get resumeSubscription;

  /// No description provided for @resumeSubscriptionConfirm.
  ///
  /// In en, this message translates to:
  /// **'Resume your subscription? Auto-renewal will continue after the current period ends.'**
  String get resumeSubscriptionConfirm;

  /// No description provided for @subscriptionResumed.
  ///
  /// In en, this message translates to:
  /// **'Subscription resumed, auto-renewal will continue'**
  String get subscriptionResumed;

  /// No description provided for @thinkAgain.
  ///
  /// In en, this message translates to:
  /// **'Think again'**
  String get thinkAgain;

  /// No description provided for @statusCancelScheduled.
  ///
  /// In en, this message translates to:
  /// **'Cancelled (ends at period end)'**
  String get statusCancelScheduled;

  /// No description provided for @statusActive.
  ///
  /// In en, this message translates to:
  /// **'Active'**
  String get statusActive;

  /// No description provided for @statusTrial.
  ///
  /// In en, this message translates to:
  /// **'Trial'**
  String get statusTrial;

  /// No description provided for @availablePlans.
  ///
  /// In en, this message translates to:
  /// **'Available plans'**
  String get availablePlans;

  /// No description provided for @billingRecords.
  ///
  /// In en, this message translates to:
  /// **'Billing records'**
  String get billingRecords;

  /// No description provided for @subscriptionStatusLabel.
  ///
  /// In en, this message translates to:
  /// **'Subscription status'**
  String get subscriptionStatusLabel;

  /// No description provided for @expiryDate.
  ///
  /// In en, this message translates to:
  /// **'Expiry date'**
  String get expiryDate;

  /// No description provided for @trialEndDate.
  ///
  /// In en, this message translates to:
  /// **'Trial ends on'**
  String get trialEndDate;

  /// No description provided for @subscriptionEndsOn.
  ///
  /// In en, this message translates to:
  /// **'Your subscription ends on {date} and will automatically downgrade to the free plan.'**
  String subscriptionEndsOn(String date);

  /// No description provided for @desktopPaymentHint.
  ///
  /// In en, this message translates to:
  /// **'Payment is not supported on mobile yet. To upgrade or purchase a plan, sign in on the desktop app and complete the payment in Subscription.'**
  String get desktopPaymentHint;

  /// No description provided for @currentPlanBadge.
  ///
  /// In en, this message translates to:
  /// **'Current plan'**
  String get currentPlanBadge;

  /// No description provided for @payOnDesktop.
  ///
  /// In en, this message translates to:
  /// **'Pay on desktop'**
  String get payOnDesktop;

  /// No description provided for @noInvoices.
  ///
  /// In en, this message translates to:
  /// **'No billing records'**
  String get noInvoices;

  /// No description provided for @renderResultTitle.
  ///
  /// In en, this message translates to:
  /// **'Render result'**
  String get renderResultTitle;

  /// No description provided for @close.
  ///
  /// In en, this message translates to:
  /// **'Close'**
  String get close;

  /// No description provided for @renderResultCopied.
  ///
  /// In en, this message translates to:
  /// **'Rendered result copied to clipboard'**
  String get renderResultCopied;

  /// No description provided for @copyAll.
  ///
  /// In en, this message translates to:
  /// **'Copy all'**
  String get copyAll;

  /// No description provided for @noTemplates.
  ///
  /// In en, this message translates to:
  /// **'No templates'**
  String get noTemplates;

  /// No description provided for @noTemplatesDesc.
  ///
  /// In en, this message translates to:
  /// **'Templates saved from clipboard content on the desktop will sync here'**
  String get noTemplatesDesc;

  /// No description provided for @variableCount.
  ///
  /// In en, this message translates to:
  /// **'{count} variables'**
  String variableCount(int count);

  /// No description provided for @emptyTemplateContent.
  ///
  /// In en, this message translates to:
  /// **'(Template content is empty)'**
  String get emptyTemplateContent;

  /// No description provided for @useTemplate.
  ///
  /// In en, this message translates to:
  /// **'Use'**
  String get useTemplate;

  /// No description provided for @fillVariableTitle.
  ///
  /// In en, this message translates to:
  /// **'Fill in variables'**
  String get fillVariableTitle;

  /// No description provided for @variableProgress.
  ///
  /// In en, this message translates to:
  /// **'Variable {step} / {total}'**
  String variableProgress(int step, int total);

  /// No description provided for @variableInputHint.
  ///
  /// In en, this message translates to:
  /// **'Enter a value for {name}'**
  String variableInputHint(String name);

  /// No description provided for @done.
  ///
  /// In en, this message translates to:
  /// **'Done'**
  String get done;

  /// No description provided for @nextItem.
  ///
  /// In en, this message translates to:
  /// **'Next item'**
  String get nextItem;

  /// No description provided for @permissionGuideTitle.
  ///
  /// In en, this message translates to:
  /// **'Permissions and keep-alive guide'**
  String get permissionGuideTitle;

  /// No description provided for @permissionGuideIntro.
  ///
  /// In en, this message translates to:
  /// **'To keep \"copy on computer, instantly on phone\" working, complete these 3 steps:'**
  String get permissionGuideIntro;

  /// No description provided for @finishAndStart.
  ///
  /// In en, this message translates to:
  /// **'Done, start using'**
  String get finishAndStart;

  /// No description provided for @stepNotifTitle.
  ///
  /// In en, this message translates to:
  /// **'1. Notification permission'**
  String get stepNotifTitle;

  /// No description provided for @stepNotifDesc.
  ///
  /// In en, this message translates to:
  /// **'Receive instant \"clipboard updated\" notifications (authorization required on Android 13+).'**
  String get stepNotifDesc;

  /// No description provided for @statusOn.
  ///
  /// In en, this message translates to:
  /// **'On'**
  String get statusOn;

  /// No description provided for @statusOff.
  ///
  /// In en, this message translates to:
  /// **'Off'**
  String get statusOff;

  /// No description provided for @statusExempted.
  ///
  /// In en, this message translates to:
  /// **'Exempted'**
  String get statusExempted;

  /// No description provided for @statusNotExempted.
  ///
  /// In en, this message translates to:
  /// **'Not exempted'**
  String get statusNotExempted;

  /// No description provided for @requestNotifPermission.
  ///
  /// In en, this message translates to:
  /// **'Request notification permission'**
  String get requestNotifPermission;

  /// No description provided for @notifPermissionGranted.
  ///
  /// In en, this message translates to:
  /// **'Notification permission granted'**
  String get notifPermissionGranted;

  /// No description provided for @notifPermissionDenied.
  ///
  /// In en, this message translates to:
  /// **'Notification permission not granted. Enable it manually in system settings.'**
  String get notifPermissionDenied;

  /// No description provided for @stepBatteryTitle.
  ///
  /// In en, this message translates to:
  /// **'2. Battery optimization exemption'**
  String get stepBatteryTitle;

  /// No description provided for @stepBatteryDesc.
  ///
  /// In en, this message translates to:
  /// **'Join the battery optimization whitelist to avoid sync disconnection and delayed notifications when the screen is off.'**
  String get stepBatteryDesc;

  /// No description provided for @statusUndetected.
  ///
  /// In en, this message translates to:
  /// **'Cannot auto-detect (requires native support)'**
  String get statusUndetected;

  /// No description provided for @batteryTitle.
  ///
  /// In en, this message translates to:
  /// **'Battery optimization exemption'**
  String get batteryTitle;

  /// No description provided for @batteryManualGuide.
  ///
  /// In en, this message translates to:
  /// **'Auto navigation failed. Set it manually:\n\nSystem settings → App management → ClipSync → Battery\n→ Choose \"Unrestricted / Allow background activity\"\n\nOn some devices: Settings → Battery → More battery settings → App sleep.'**
  String get batteryManualGuide;

  /// No description provided for @jumping.
  ///
  /// In en, this message translates to:
  /// **'Opening…'**
  String get jumping;

  /// No description provided for @gotoBatterySettings.
  ///
  /// In en, this message translates to:
  /// **'Go to battery optimization settings'**
  String get gotoBatterySettings;

  /// No description provided for @stepAutoStartTitle.
  ///
  /// In en, this message translates to:
  /// **'3. Auto-start settings'**
  String get stepAutoStartTitle;

  /// No description provided for @stepAutoStartDesc.
  ///
  /// In en, this message translates to:
  /// **'Allow ClipSync to auto-start and run in the background, resuming sync after reboot.'**
  String get stepAutoStartDesc;

  /// No description provided for @autoStartTitle.
  ///
  /// In en, this message translates to:
  /// **'Auto-start settings'**
  String get autoStartTitle;

  /// No description provided for @autoStartGuide.
  ///
  /// In en, this message translates to:
  /// **'Example paths by vendor:\n\n· Xiaomi MIUI: Security center → App management → Permissions → Auto-start management → Allow ClipSync\n· Huawei EMUI/HarmonyOS: Settings → Apps → App launch management → ClipSync → Manual management (allow auto-start, linked launch, background activity)\n· OPPO ColorOS: Phone Manager → Permission privacy → Auto-start management → Allow ClipSync\n· vivo OriginOS: i Manager → App management → Permission management → Auto-start → Allow ClipSync'**
  String get autoStartGuide;

  /// No description provided for @autoStartStatusHint.
  ///
  /// In en, this message translates to:
  /// **'Varies by vendor, verify manually'**
  String get autoStartStatusHint;

  /// No description provided for @gotIt.
  ///
  /// In en, this message translates to:
  /// **'Got it'**
  String get gotIt;

  /// No description provided for @gotoAutoStartSettings.
  ///
  /// In en, this message translates to:
  /// **'Go to auto-start settings'**
  String get gotoAutoStartSettings;

  /// No description provided for @unknown.
  ///
  /// In en, this message translates to:
  /// **'Unknown'**
  String get unknown;

  /// No description provided for @saveToClipboard.
  ///
  /// In en, this message translates to:
  /// **'Save to clipboard'**
  String get saveToClipboard;

  /// No description provided for @saveToClipboardDesc.
  ///
  /// In en, this message translates to:
  /// **'Content will be uploaded to your ClipSync account and become visible on all signed-in devices.'**
  String get saveToClipboardDesc;

  /// No description provided for @nothingToSave.
  ///
  /// In en, this message translates to:
  /// **'Nothing to save'**
  String get nothingToSave;

  /// No description provided for @saving.
  ///
  /// In en, this message translates to:
  /// **'Saving…'**
  String get saving;

  /// No description provided for @saveInFailed.
  ///
  /// In en, this message translates to:
  /// **'Save failed: {error}'**
  String saveInFailed(String error);

  /// No description provided for @saveInFailedRetry.
  ///
  /// In en, this message translates to:
  /// **'Save failed, please try again later'**
  String get saveInFailedRetry;

  /// No description provided for @savedInCount.
  ///
  /// In en, this message translates to:
  /// **'Saved {count} clipboard items'**
  String savedInCount(int count);

  /// No description provided for @imageCount.
  ///
  /// In en, this message translates to:
  /// **'Images ({count})'**
  String imageCount(int count);

  /// No description provided for @deviceSemantics.
  ///
  /// In en, this message translates to:
  /// **'Device: {name}, status: {status}'**
  String deviceSemantics(String name, String status);

  /// No description provided for @deviceOnline.
  ///
  /// In en, this message translates to:
  /// **'Online'**
  String get deviceOnline;

  /// No description provided for @deviceOffline.
  ///
  /// In en, this message translates to:
  /// **'Offline'**
  String get deviceOffline;

  /// No description provided for @platformDesktop.
  ///
  /// In en, this message translates to:
  /// **'Desktop'**
  String get platformDesktop;

  /// No description provided for @platformMobile.
  ///
  /// In en, this message translates to:
  /// **'Mobile'**
  String get platformMobile;

  /// No description provided for @platformTablet.
  ///
  /// In en, this message translates to:
  /// **'Tablet'**
  String get platformTablet;

  /// No description provided for @loadFailedTitle.
  ///
  /// In en, this message translates to:
  /// **'Load failed'**
  String get loadFailedTitle;

  /// No description provided for @errorNoToken.
  ///
  /// In en, this message translates to:
  /// **'Not signed in. Please sign in and try again.'**
  String get errorNoToken;

  /// No description provided for @errorSendCode.
  ///
  /// In en, this message translates to:
  /// **'Failed to send verification code'**
  String get errorSendCode;

  /// No description provided for @errorFetchProfile.
  ///
  /// In en, this message translates to:
  /// **'Failed to load profile'**
  String get errorFetchProfile;

  /// No description provided for @errorFetchClipboard.
  ///
  /// In en, this message translates to:
  /// **'Failed to load clipboard items'**
  String get errorFetchClipboard;

  /// No description provided for @errorFetchItemContent.
  ///
  /// In en, this message translates to:
  /// **'Failed to load full content'**
  String get errorFetchItemContent;

  /// No description provided for @errorRegisterDevice.
  ///
  /// In en, this message translates to:
  /// **'Failed to register device'**
  String get errorRegisterDevice;

  /// No description provided for @errorRemoveDevice.
  ///
  /// In en, this message translates to:
  /// **'Failed to remove device'**
  String get errorRemoveDevice;

  /// No description provided for @errorFetchTemplates.
  ///
  /// In en, this message translates to:
  /// **'Failed to load templates'**
  String get errorFetchTemplates;

  /// No description provided for @errorRenderTemplate.
  ///
  /// In en, this message translates to:
  /// **'Failed to render template'**
  String get errorRenderTemplate;

  /// No description provided for @errorFetchCollections.
  ///
  /// In en, this message translates to:
  /// **'Failed to load collections'**
  String get errorFetchCollections;

  /// No description provided for @errorFetchCollectionItems.
  ///
  /// In en, this message translates to:
  /// **'Failed to load collection items'**
  String get errorFetchCollectionItems;

  /// No description provided for @errorCreateCollection.
  ///
  /// In en, this message translates to:
  /// **'Failed to create collection'**
  String get errorCreateCollection;

  /// No description provided for @errorDeleteCollection.
  ///
  /// In en, this message translates to:
  /// **'Failed to delete collection'**
  String get errorDeleteCollection;

  /// No description provided for @errorFetchPlans.
  ///
  /// In en, this message translates to:
  /// **'Failed to load plans'**
  String get errorFetchPlans;

  /// No description provided for @errorFetchCurrentSub.
  ///
  /// In en, this message translates to:
  /// **'Failed to load subscription'**
  String get errorFetchCurrentSub;

  /// No description provided for @errorCancelSub.
  ///
  /// In en, this message translates to:
  /// **'Failed to cancel subscription'**
  String get errorCancelSub;

  /// No description provided for @errorResumeSub.
  ///
  /// In en, this message translates to:
  /// **'Failed to resume subscription'**
  String get errorResumeSub;

  /// No description provided for @errorFetchInvoices.
  ///
  /// In en, this message translates to:
  /// **'Failed to load invoices'**
  String get errorFetchInvoices;

  /// No description provided for @errorUpload.
  ///
  /// In en, this message translates to:
  /// **'Upload failed'**
  String get errorUpload;

  /// No description provided for @errorDownload.
  ///
  /// In en, this message translates to:
  /// **'Download failed'**
  String get errorDownload;

  /// No description provided for @errorDeviceNotRegistered.
  ///
  /// In en, this message translates to:
  /// **'Device not registered. Sign out and sign in again, then retry.'**
  String get errorDeviceNotRegistered;

  /// No description provided for @errorNetwork.
  ///
  /// In en, this message translates to:
  /// **'Network error. Check your connection and retry.'**
  String get errorNetwork;

  /// No description provided for @errorUnknown.
  ///
  /// In en, this message translates to:
  /// **'Something went wrong. Please try again later.'**
  String get errorUnknown;

  /// No description provided for @notifChannelClipboard.
  ///
  /// In en, this message translates to:
  /// **'Clipboard sync'**
  String get notifChannelClipboard;

  /// No description provided for @notifChannelClipboardDesc.
  ///
  /// In en, this message translates to:
  /// **'Clipboard sync reminders between your devices (silent)'**
  String get notifChannelClipboardDesc;

  /// No description provided for @notifChannelAlert.
  ///
  /// In en, this message translates to:
  /// **'Sync alerts'**
  String get notifChannelAlert;

  /// No description provided for @notifChannelAlertDesc.
  ///
  /// In en, this message translates to:
  /// **'Sync errors, device alerts and other important reminders'**
  String get notifChannelAlertDesc;

  /// No description provided for @notifClipboardUpdated.
  ///
  /// In en, this message translates to:
  /// **'Clipboard updated'**
  String get notifClipboardUpdated;

  /// No description provided for @notifNewClipboardBody.
  ///
  /// In en, this message translates to:
  /// **'New clipboard content received'**
  String get notifNewClipboardBody;

  /// No description provided for @errorReportTitle.
  ///
  /// In en, this message translates to:
  /// **'Error report'**
  String get errorReportTitle;

  /// No description provided for @pendingReportsCount.
  ///
  /// In en, this message translates to:
  /// **'Pending error reports: {count}'**
  String pendingReportsCount(int count);

  /// No description provided for @errorReportDesc.
  ///
  /// In en, this message translates to:
  /// **'These errors will be sent automatically when the app next goes online.'**
  String get errorReportDesc;

  /// No description provided for @clearAll.
  ///
  /// In en, this message translates to:
  /// **'Clear all'**
  String get clearAll;

  /// No description provided for @errorQueueCleared.
  ///
  /// In en, this message translates to:
  /// **'Error queue cleared'**
  String get errorQueueCleared;

  /// No description provided for @planFree.
  ///
  /// In en, this message translates to:
  /// **'Free'**
  String get planFree;

  /// No description provided for @perMonth.
  ///
  /// In en, this message translates to:
  /// **'/month'**
  String get perMonth;

  /// No description provided for @perYear.
  ///
  /// In en, this message translates to:
  /// **'/year'**
  String get perYear;

  /// No description provided for @planMaxDevices.
  ///
  /// In en, this message translates to:
  /// **'Up to {count} devices'**
  String planMaxDevices(int count);

  /// No description provided for @planDailyClips.
  ///
  /// In en, this message translates to:
  /// **'{count} clipboard items per day'**
  String planDailyClips(int count);

  /// No description provided for @planStorage.
  ///
  /// In en, this message translates to:
  /// **'Storage: {size} MB'**
  String planStorage(int size);

  /// No description provided for @featureOcr.
  ///
  /// In en, this message translates to:
  /// **'OCR text recognition'**
  String get featureOcr;

  /// No description provided for @featurePrioritySync.
  ///
  /// In en, this message translates to:
  /// **'Priority sync'**
  String get featurePrioritySync;

  /// No description provided for @featureAiClassify.
  ///
  /// In en, this message translates to:
  /// **'AI smart classification'**
  String get featureAiClassify;

  /// No description provided for @featureTeamShare.
  ///
  /// In en, this message translates to:
  /// **'Team sharing'**
  String get featureTeamShare;
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
