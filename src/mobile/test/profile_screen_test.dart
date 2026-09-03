import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:clipsync_mobile/l10n/app_localizations.dart';
import 'package:clipsync_mobile/providers/auth_provider.dart';
import 'package:clipsync_mobile/screens/profile_screen.dart';

/// 回归测试：昵称编辑弹窗「取消」不应触发框架断言崩溃
/// （_dependents.isEmpty —— 根因是旧实现 showDialog 返回后立即 dispose
/// TextEditingController，而弹窗退场动画期间 TextField 仍在树中）。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<AuthProvider> buildAuth() async {
    SharedPreferences.setMockInitialValues({});
    final auth = AuthProvider();
    auth.updateUser({
      'nickname': 'Carlos',
      'phone': '13505110772',
      'email': 'swqcarlos@gmail.com',
      'plan': 'Pro',
    });
    return auth;
  }

  Future<void> pumpProfile(WidgetTester tester, AuthProvider auth) async {
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: ChangeNotifierProvider<AuthProvider>.value(
          value: auth,
          child: const ProfileScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('昵称弹窗取消不崩溃且弹窗关闭', (WidgetTester tester) async {
    final auth = await buildAuth();
    await pumpProfile(tester, auth);

    // 打开昵称编辑弹窗
    await tester.tap(find.text('Carlos'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    // 点击「取消」
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    // 弹窗已关闭，无异常抛出
    expect(find.byType(TextField), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('资料页头像/昵称/手机号/邮箱/套餐渲染', (WidgetTester tester) async {
    final auth = await buildAuth();
    await pumpProfile(tester, auth);

    expect(find.text('Carlos'), findsOneWidget);
    expect(find.text('13505110772'), findsOneWidget);
    expect(find.text('swqcarlos@gmail.com'), findsOneWidget);
    expect(find.text('Pro'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
