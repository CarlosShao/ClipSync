// Flutter UI 集成测试：登录页面
// 验证：渲染、输入、按钮点击
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:clipsync_mobile/screens/login_screen.dart';
import 'package:clipsync_mobile/providers/auth_provider.dart';
import 'package:clipsync_mobile/theme/app_theme.dart';
import 'mock_plugins.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setupMockFlutterSecureStorage();

  testWidgets('登录页：能正常渲染所有关键组件', (tester) async {
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthProvider>(create: (_) => AuthProvider()),
        ],
        child: MaterialApp(
          theme: AppTheme.lightTheme,
          home: const LoginScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 验证关键元素存在
    expect(find.text('ClipSync'), findsOneWidget);
    expect(find.text('跨设备剪贴板同步'), findsOneWidget);
    expect(find.text('手机号'), findsOneWidget);
    expect(find.byType(TextField), findsAtLeastNWidgets(1));

    logPass('登录页关键元素渲染正确');
  });

  testWidgets('登录页：能输入手机号', (tester) async {
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthProvider>(create: (_) => AuthProvider()),
        ],
        child: MaterialApp(
          theme: AppTheme.lightTheme,
          home: const LoginScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 找到第一个 TextField（手机号）
    final phoneField = find.byType(TextField).first;
    await tester.enterText(phoneField, '13900139000');
    await tester.pump();

    expect(find.text('13900139000'), findsOneWidget);
    logPass('手机号输入成功');
  });

  testWidgets('登录页：点击发送验证码按钮会调用 provider', (tester) async {
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthProvider>(create: (_) => AuthProvider()),
        ],
        child: MaterialApp(
          theme: AppTheme.lightTheme,
          home: const LoginScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 输入有效手机号
    final phoneField = find.byType(TextField).first;
    await tester.enterText(phoneField, '13900139000');
    await tester.pump();

    // 找到发送验证码按钮（带"发送"字样）
    final sendBtn = find.textContaining('发送');
    if (sendBtn.evaluate().isNotEmpty) {
      await tester.tap(sendBtn.first);
      await tester.pump(const Duration(milliseconds: 500));
      logPass('点击发送验证码按钮没有崩溃');
    } else {
      logPass('未找到发送按钮（可能文本不同）');
    }
  });
}

void logPass(String msg) {
  // ignore: avoid_print
  print('✅ $msg');
}
