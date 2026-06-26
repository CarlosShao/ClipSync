import 'package:flutter/material.dart';
import '../models/device.dart';
import '../services/api_service.dart';

class DeviceProvider extends ChangeNotifier {
  final ApiService _api = ApiService();
  
  List<Device> _devices = [];
  bool _isLoading = false;
  String? _error;

  List<Device> get devices => _devices;
  bool get isLoading => _isLoading;
  String? get error => _error;

  Future<void> loadDevices(String token, {bool forceRefresh = false}) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _devices = await _api.getDevices(token, forceRefresh: forceRefresh);
    } catch (e) {
      _error = e.toString();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<Device?> registerDevice(String token, {
    required String deviceName,
    required String deviceType,
    required String platform,
    String? platformVersion,
    String? appVersion,
  }) async {
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
    } catch (e) {
      _error = e.toString();
      notifyListeners();
      return null;
    }
  }

  Future<void> removeDevice(String token, String deviceId) async {
    try {
      await _api.removeDevice(token, deviceId);
      _devices.removeWhere((device) => device.id == deviceId);
      notifyListeners();
    } catch (e) {
      _error = e.toString();
      notifyListeners();
    }
  }
}
