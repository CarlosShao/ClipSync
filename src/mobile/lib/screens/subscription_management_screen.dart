import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/user_subscription.dart';
import '../providers/auth_provider.dart';
import '../services/subscription_api_service.dart';

/// 订阅管理页面
class SubscriptionManagementScreen extends StatefulWidget {
  const SubscriptionManagementScreen({Key? key}) : super(key: key);

  @override
  State<SubscriptionManagementScreen> createState() => _SubscriptionManagementScreenState();
}

class _SubscriptionManagementScreenState extends State<SubscriptionManagementScreen> {
  UserSubscription? _currentSubscription;
  List<dynamic> _paymentHistory = [];
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _fetchCurrentSubscription();
    _fetchPaymentHistory();
  }

  /// 获取当前订阅
  Future<void> _fetchCurrentSubscription() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;

      if (token == null) {
        throw Exception('用户未登录');
      }

      // 调用后端 API GET /api/subscriptions/current
      final data = await SubscriptionApiService.getCurrentSubscription(token);

      setState(() {
        if (data != null) {
          _currentSubscription = UserSubscription.fromJson(data['subscription']);
        }
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _errorMessage = '获取订阅信息失败: $e';
        _isLoading = false;
      });
    }
  }

  /// 获取支付历史
  Future<void> _fetchPaymentHistory() async {
    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;

      if (token == null) return;

      // 调用后端 API GET /api/payments/history
      final history = await SubscriptionApiService.getPaymentHistory(token);

      setState(() {
        _paymentHistory = history;
      });
    } catch (e) {
      print('⚠️ 获取支付历史失败: $e');
    }
  }

  /// 取消订阅
  Future<void> _cancelSubscription() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('取消订阅'),
        content: const Text('确定要取消订阅吗？取消后将在当前周期结束后降级到免费版。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('否'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('是'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    setState(() {
      _isLoading = true;
    });

    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;

      if (token == null) {
        throw Exception('用户未登录');
      }

      // 调用后端 API POST /api/subscriptions/cancel
      await SubscriptionApiService.cancelSubscription(token);

      // 刷新订阅信息
      await _fetchCurrentSubscription();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('订阅已取消')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('取消订阅失败: $e')),
        );
      }
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  /// 重新订阅
  Future<void> _resubscribe() async {
    // 导航到套餐选择页面
    Navigator.pushNamed(context, '/subscription-plans').catchError((e) {
      print('⚠️ 导航到套餐选择页面失败: $e');
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        title: const Text('订阅管理'),
        centerTitle: true,
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _errorMessage != null
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.error,
                        size: 64,
                        color: isDarkMode ? Colors.red[300] : Colors.red,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        _errorMessage!,
                        style: TextStyle(
                          fontSize: 16,
                          color: isDarkMode ? Colors.white70 : Colors.black54,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 24),
                      ElevatedButton(
                        onPressed: _fetchCurrentSubscription,
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                )
              : RefreshIndicator(
                  onRefresh: () async {
                    await _fetchCurrentSubscription();
                    await _fetchPaymentHistory();
                  },
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // 当前订阅卡片
                        _buildCurrentSubscriptionCard(theme, isDarkMode),
                        
                        const SizedBox(height: 24),
                        
                        // 支付历史
                        _buildPaymentHistorySection(theme, isDarkMode),
                      ],
                    ),
                  ),
                ),
    );
  }

  /// 构建当前订阅卡片
  Widget _buildCurrentSubscriptionCard(ThemeData theme, bool isDarkMode) {
    if (_currentSubscription == null) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '免费版',
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: isDarkMode ? Colors.white : Colors.black,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '您当前使用的是免费版',
                style: TextStyle(
                  fontSize: 16,
                  color: isDarkMode ? Colors.white70 : Colors.black54,
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _resubscribe,
                  child: const Text('升级到 Pro'),
                ),
              ),
            ],
          ),
        ),
      );
    }

    final planName = _currentSubscription!.planName;
    final status = _currentSubscription!.status;
    final isActive = status == 'active';
    final endDate = _currentSubscription!.currentPeriodEnd;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  planName,
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: isDarkMode ? Colors.white : Colors.black,
                  ),
                ),
                Chip(
                  label: Text(
                    isActive ? '活跃' : status,
                    style: const TextStyle(fontSize: 12, color: Colors.white),
                  ),
                  backgroundColor: isActive ? Colors.green : Colors.grey,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              '订阅周期: ${_currentSubscription!.currentPeriodStart.toString().substring(0, 10)} - ${endDate.toString().substring(0, 10)}',
              style: TextStyle(
                fontSize: 14,
                color: isDarkMode ? Colors.white70 : Colors.black54,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '自动续费: ${_currentSubscription!.autoRenew ? '已开启' : '未开启'}',
              style: TextStyle(
                fontSize: 14,
                color: isDarkMode ? Colors.white70 : Colors.black54,
              ),
            ),
            const SizedBox(height: 16),
            if (isActive)
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: _cancelSubscription,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.red,
                  ),
                  child: const Text('取消订阅'),
                ),
              )
            else
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _resubscribe,
                  child: const Text('重新订阅'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 构建支付历史部分
  Widget _buildPaymentHistorySection(ThemeData theme, bool isDarkMode) {
    if (_paymentHistory.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '支付历史',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: isDarkMode ? Colors.white : Colors.black,
            ),
          ),
          const SizedBox(height: 16),
          Center(
            child: Text(
              '暂无支付记录',
              style: TextStyle(
                fontSize: 16,
                color: isDarkMode ? Colors.white70 : Colors.black54,
              ),
            ),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '支付历史',
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.bold,
            color: isDarkMode ? Colors.white : Colors.black,
          ),
        ),
        const SizedBox(height: 16),
        ListView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: _paymentHistory.length,
          itemBuilder: (context, index) {
            final payment = _paymentHistory[index];
            final orderNo = payment['orderNo'] ?? '未知';
            final amount = payment['amount'] ?? 0;
            final status = payment['status'] ?? '未知';
            final createdAt = payment['createdAt'] ?? '';

            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                leading: Icon(
                  status == 'paid' ? Icons.check_circle : Icons.error,
                  color: status == 'paid' ? Colors.green : Colors.red,
                ),
                title: Text('订单号: $orderNo'),
                subtitle: Text('金额: ¥$amount\n时间: $createdAt'),
                trailing: Chip(
                  label: Text(
                    status == 'paid' ? '已支付' : status,
                    style: const TextStyle(fontSize: 12, color: Colors.white),
                  ),
                  backgroundColor: status == 'paid' ? Colors.green : Colors.orange,
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}
