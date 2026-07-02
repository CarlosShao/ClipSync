// flutter_secure_storage 测试 Mock
// 在测试文件顶部导入并调用 setupMockFlutterSecureStorage()

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';

void setupMockFlutterSecureStorage() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  
  TestWidgetsFlutterBinding.ensureInitialized();

  // 内存存储
  final mockStorage = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance!.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
    switch (call.method) {
      case 'write':
        final Map<dynamic, dynamic> args = call.arguments;
        mockStorage['${args['key']}'] = args['value'];
        return null;
      case 'read':
        final Map<dynamic, dynamic> args = call.arguments;
        return mockStorage['${args['key']}'];
      case 'delete':
        final Map<dynamic, dynamic> args = call.arguments;
        mockStorage.remove('${args['key']}');
        return null;
      case 'readAll':
        return Map<String, String>.from(mockStorage);
      case 'deleteAll':
        mockStorage.clear();
        return null;
      case 'containsKey':
        final Map<dynamic, dynamic> args = call.arguments;
        return mockStorage.containsKey('${args['key']}');
      default:
        return null;
    }
  });
}
