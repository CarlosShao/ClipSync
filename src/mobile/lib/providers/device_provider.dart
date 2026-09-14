import 'package:flutter/material.dart';
import '../models/device.dart';
import '../services/api_service.dart';
import '../services/e2e_crypto.dart';

class DeviceProvider extends ChangeNotifier {
  final ApiService _api = ApiService();

  List<Device> _devices = [];
  bool _isLoading = false;

  /// 最近一次失败的原始错误对象，UI 层经 friendlyError 映射 l10n 文案后
  /// 展示（A3 解耦：不再存 e.toString()）
  Object? _error;

  List<Device> get devices => _devices;
  bool get isLoading => _isLoading;
  Object? get error => _error;

  Future<void> loadDevices(String token, {bool forceRefresh = false}) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _devices = await _api.getDevices(token, forceRefresh: forceRefresh);
    } on Exception catch (e) {
      _error = e;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  /// 注册新设备。
  ///
  /// [publicKey]（B8/E2E）：本机 E2E 公钥（65B 未压缩点 base64），可选。
  ///
  /// B8 接线说明：本方法经 ApiService.registerDevice 发送注册请求，而该 service
  /// 的请求体不含 publicKey 字段——api_service.dart 不在 B8 允许改动清单内，
  /// 不能越界修改。当前真实的注册路径是 AuthProvider._doRegisterDevice
  /// （自行构造 POST /api/devices 请求体，已接线 publicKey）；这里仅在注册前
  /// 确保本机 E2E 密钥对已生成（未显式传入 publicKey 时自动 ensure），为后续
  /// 上传/解密就绪；[publicKey] 参数为预留，待 ApiService.registerDevice
  /// 支持透传后接线。
  Future<Device?> registerDevice(String token, {
    required String deviceName,
    required String deviceType,
    required String platform,
    String? platformVersion,
    String? appVersion,
    String? publicKey,
  }) async {
    try {
      await E2eCrypto.instance.ensureKeypair();
    } catch (e) {
      // 密钥生成失败不阻塞设备注册（服务端按未提供公钥处理，可后续补交）
      debugPrint('[DeviceProvider] e2e keypair ensure failed: $e');
    }
    try {
      final device = await _api.registerDevice(
        token,
        deviceName: deviceName,
        deviceType: deviceType,
        platform: platform,
        platformVersion: platformVersion,
        appVersion: appVersion,
      );
      _devices.add(device);
      notifyListeners();
      return device;
    } on Exception catch (e) {
      _error = e;
      notifyListeners();
      return null;
    }
  }

  Future<void> removeDevice(String token, String deviceId) async {
    try {
      await _api.removeDevice(token, deviceId);
      _devices.removeWhere((device) => device.id == deviceId);
      notifyListeners();
    } on Exception catch (e) {
      _error = e;
      notifyListeners();
    }
  }
}
