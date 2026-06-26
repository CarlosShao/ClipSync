import 'package:flutter/material.dart';

/// 支付结果页面
class PaymentResultScreen extends StatelessWidget {
  final bool isSuccess;
  final String? orderNo;
  final String? errorMessage;

  const PaymentResultScreen({
    Key? key,
    required this.isSuccess,
    this.orderNo,
    this.errorMessage,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        title: Text(isSuccess ? '支付成功' : '支付失败'),
        centerTitle: true,
        automaticallyImplyLeading: false,
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // 结果图标
            Icon(
              isSuccess ? Icons.check_circle : Icons.error,
              size: 100,
              color: isSuccess
                  ? (isDarkMode ? Colors.green[300] : Colors.green)
                  : (isDarkMode ? Colors.red[300] : Colors.red),
            ),
            
            const SizedBox(height: 32),
            
            // 结果标题
            Text(
              isSuccess ? '支付成功！' : '支付失败',
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.bold,
                color: isDarkMode ? Colors.white : Colors.black,
              ),
            ),
            
            const SizedBox(height: 16),
            
            // 结果描述
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                isSuccess
                    ? '您的订阅已激活，感谢使用 ClipSync！'
                    : (errorMessage ?? '支付过程中出现问题，请重试。'),
                style: TextStyle(
                  fontSize: 16,
                  color: isDarkMode ? Colors.white70 : Colors.black54,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            
            if (isSuccess && orderNo != null) ...[
              const SizedBox(height: 24),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 32),
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Text(
                              '订单号',
                              style: TextStyle(fontSize: 14),
                            ),
                            Text(
                              orderNo!,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
            
            const SizedBox(height: 48),
            
            // 返回按钮
            SizedBox(
              width: 200,
              child: ElevatedButton(
                onPressed: () {
                  // 返回首页
                  Navigator.of(context).popUntil((route) => route.isFirst);
                },
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
                child: const Text(
                  '返回首页',
                  style: TextStyle(fontSize: 16),
                ),
              ),
            ),
            
            if (!isSuccess) ...[
              const SizedBox(height: 16),
              SizedBox(
                width: 200,
                child: OutlinedButton(
                  onPressed: () {
                    // 返回套餐选择页面
                    Navigator.pop(context);
                  },
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  child: const Text(
                    '重新支付',
                    style: TextStyle(fontSize: 16),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
