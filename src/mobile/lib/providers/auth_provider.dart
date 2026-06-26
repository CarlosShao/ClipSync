import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';

class AuthProvider extends ChangeNotifier {
  final ApiService _api = ApiService();
  
  bool _isLoading = true;
  bool _isAuthenticated = false;
  String? _token;
  Map<String, dynamic>? _user;

  bool get isLoading => _isLoading;
  bool get isAuthenticated => _isAuthenticated;
  String? get token => _token;
  Map<String, dynamic>? get user => _user;

  AuthProvider() {
    _loadToken();
  }

  Future<void> _loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('auth_token');
    _isAuthenticated = _token != null;
    
    if (_isAuthenticated) {
      try {
        _user = await _api.getProfile(_token!);
      } catch (e) {
        _isAuthenticated = false;
        _token = null;
        await prefs.remove('auth_token');
      }
    }
    
    _isLoading = false;
    notifyListeners();
  }

  Future<void> sendVerificationCode(String phone) async {
    await _api.sendVerificationCode(phone);
  }

  Future<bool> login(String phone, String code) async {
    try {
      final result = await _api.login(phone, code);
      _token = result['token'];
      _user = result['user'];
      _isAuthenticated = true;

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('auth_token', _token!);

      notifyListeners();
      return true;
    } catch (e) {
      return false;
    }
  }

  Future<void> logout() async {
    _token = null;
    _user = null;
    _isAuthenticated = false;

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('auth_token');

    notifyListeners();
  }
}
