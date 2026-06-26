import 'package:flutter/material.dart';

/// 通知设置页面（占位符）
class NotificationSettingsScreen extends StatelessWidget {
  const NotificationSettingsScreen({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('通知设置'),
      ),
      body: const Center(
        child: Text('通知设置功能开发中...'),
      ),
    );
  }
}
