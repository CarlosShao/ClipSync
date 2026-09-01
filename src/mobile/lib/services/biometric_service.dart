// lib/services/biometric_service.dart

import 'package:flutter/foundation.dart';
import 'package:local_auth/local_auth.dart';

/// 生物识别服务封装（T4.6）。
///
/// 基于 local_auth 提供两个能力：
/// - [canAuthenticate]：设备是否具备可用的指纹/面容能力
///   （canCheckBiometrics + isDeviceSupported 双重判定，设置页据此
///   决定「生物识别锁」开关是否可用）；
/// - [authenticate]：弹出系统生物验证对话框（锁定页与设置页开关
///   开启确认共用），返回验证是否通过。
///
/// 所有平台通道异常均吞掉并回退为 false——包括 local_auth 要求宿主
/// Activity 继承 FlutterFragmentActivity 而当前 MainActivity 继承
/// FlutterActivity 时抛出的 no_fragment_activity 异常——UI 层据此显示
/// 「设备不支持」禁用态，不会崩溃（配置完成后能力自动生效）。
class BiometricService {
  BiometricService._();

  static final LocalAuthentication _auth = LocalAuthentication();

  /// 设备是否支持且已录入生物识别（指纹/面容/虹膜）。
  ///
  /// 双重判定：
  /// - canCheckBiometrics：硬件具备生物识别能力；
  /// - isDeviceSupported：系统层面支持生物认证。
  /// 任一平台异常（含插件未就绪/宿主 Activity 不兼容）返回 false。
  static Future<bool> canAuthenticate() async {
    try {
      final canCheck = await _auth.canCheckBiometrics;
      final supported = await _auth.isDeviceSupported();
      return canCheck && supported;
    } catch (e) {
      debugPrint('[BiometricService] canAuthenticate failed: $e');
      return false;
    }
  }

  /// 弹出系统生物验证，验证通过返回 true。
  ///
  /// - [reason]：展示在系统验证对话框中的文案（调用方传 l10n 文案）；
  /// - biometricOnly 保持默认 false —— 允许回落到设备密码/图案，避免
  ///   用户清除指纹/面容录入后被永久锁在锁定页外；
  /// - stickyAuth: true —— 验证过程中 App 被切到后台再回来时流程不中断；
  /// - useErrorDialogs 保持默认 true —— 系统级错误（如未录入）由插件
  ///   弹引导对话框。
  /// 验证失败（指纹不匹配/用户取消）返回 false，调用方可重试。
  static Future<bool> authenticate({required String reason}) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(
          stickyAuth: true,
        ),
      );
    } catch (e) {
      debugPrint('[BiometricService] authenticate failed: $e');
      return false;
    }
  }
}
