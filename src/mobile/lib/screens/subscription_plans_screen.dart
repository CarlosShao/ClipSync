import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/subscription_plan.dart';
import '../providers/auth_provider.dart';
import '../services/subscription_api_service.dart';

/// 套餐选择页面
class SubscriptionPlansScreen extends StatefulWidget {
  const SubscriptionPlansScreen({Key? key}) : super(key: key);

  @override
  State<SubscriptionPlansScreen> createState() => _SubscriptionPlansScreenState();
}

class _SubscriptionPlansScreenState extends State<SubscriptionPlansScreen> {
  List<SubscriptionPlan> _plans = [];
  bool _isLoading = true;
  String? _errorMessage;
  String? _currentSubscriptionId;

  @override
  void initState() {
    super.initState();
    _fetchPlans();
    _fetchCurrentSubscription();
  }

  /// 获取套餐列表
  Future<void> _fetchPlans() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      // 调用后端 API GET /api/subscriptions/plans
      final plans = await SubscriptionApiService.getPlans();
      
      setState(() {
        _plans = plans;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _errorMessage = '获取套餐列表失败: $e';
        _isLoading = false;
      });
    }
  }

  /// 获取当前订阅
  Future<void> _fetchCurrentSubscription() async {
    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;
      
      if (token == null) return;
      
      // 调用后端 API GET /api/subscriptions/current
      final data = await SubscriptionApiService.getCurrentSubscription(token);
      
      if (data != null && mounted) {
        setState(() {
          _currentSubscriptionId = data['subscription']?['planId'];
        });
      }
    } catch (e) {
      print('⚠️ 获取当前订阅失败: $e');
    }
  }

  /// 选择套餐（创建订阅）
  Future<void> _selectPlan(SubscriptionPlan plan) async {
    if (plan.price == 0) {
      // 免费版，直接激活
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已切换到免费版')),
      );
      return;
    }

    setState(() {
      _isLoading = true;
    });

    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;
      
      if (token == null) {
        throw Exception('用户未登录');
      }

      // 调用后端 API POST /api/subscriptions/subscribe
      final result = await SubscriptionApiService.subscribe(
        token: token,
        planId: plan.id,
        paymentMethod: 'mock', // 暂时使用模拟支付
      );
      
      if (!mounted) return;
      
      setState(() {
        _currentSubscriptionId = plan.id;
        _isLoading = false;
      });
      
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已选择 ${plan.name} 套餐')),
      );
      
      // 跳转到支付结果页面（模拟支付成功）
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (context) => PaymentResultScreen(
            isSuccess: true,
            orderNo: 'MOCK-${DateTime.now().millisecondsSinceEpoch}',
          ),
        ),
      );
    } catch (e) {
      setState(() {
        _isLoading = false;
      });
      
      if (!mounted) return;
      
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('选择套餐失败: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        title: const Text('选择套餐'),
        centerTitle: true,
      ),
      body: _isLoading
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircularProgressIndicator(
                    color: isDarkMode ? Colors.white : const Color(0xFF6C5CE7),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    '加载中...',
                    style: TextStyle(
                      color: isDarkMode ? Colors.white70 : Colors.black54,
                    ),
                  ),
                ],
              ),
            )
          : _errorMessage != null
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.error_outline,
                        size: 64,
                        color: Colors.red,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        _errorMessage!,
                        style: const TextStyle(color: Colors.red),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 16),
                      ElevatedButton(
                        onPressed: _fetchPlans,
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _plans.length,
                  itemBuilder: (context, index) {
                    final plan = _plans[index];
                    final isCurrentPlan = plan.id == _currentSubscriptionId;
                    
                    return _buildPlanCard(plan, isCurrentPlan, isDarkMode);
                  },
                ),
    );
  }

  /// 构建套餐卡片
  Widget _buildPlanCard(SubscriptionPlan plan, bool isCurrentPlan, bool isDarkMode) {
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      elevation: isCurrentPlan ? 8 : 2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: isCurrentPlan
            ? BorderSide(color: plan.color, width: 2)
            : BorderSide.none,
      ),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          gradient: isCurrentPlan
              ? LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    plan.color.withOpacity(0.1),
                    plan.color.withOpacity(0.05),
                  ],
                )
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 套餐标题和图标
            Row(
              children: [
                Icon(
                  plan.icon,
                  size: 32,
                  color: plan.color,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        plan.name,
                        style: TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                          color: plan.color,
                        ),
                      ),
                      if (plan.description != null)
                        Text(
                          plan.description!,
                          style: TextStyle(
                            fontSize: 14,
                            color: isDarkMode ? Colors.white70 : Colors.black54,
                          ),
                        ),
                    ],
                  ),
                ),
                if (isCurrentPlan)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: plan.color,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Text(
                      '当前套餐',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
              ],
            ),
            
            const SizedBox(height: 16),
            
            // 价格
            Text(
              plan.formattedPrice,
              style: TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.bold,
                color: isDarkMode ? Colors.white : Colors.black,
              ),
            ),
            
            const SizedBox(height: 16),
            
            // 功能列表
            ...plan.features.map((feature) {
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Icon(
                      Icons.check_circle,
                      size: 16,
                      color: plan.color,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        feature,
                        style: TextStyle(
                          fontSize: 14,
                          color: isDarkMode ? Colors.white : Colors.black87,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            }).toList(),
            
            const SizedBox(height: 20),
            
            // 选择按钮
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: isCurrentPlan ? null : () => _selectPlan(plan),
                style: ElevatedButton.styleFrom(
                  backgroundColor: plan.color,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  disabledBackgroundColor: isDarkMode ? Colors.grey[700] : Colors.grey[300],
                  disabledForegroundColor: isDarkMode ? Colors.grey[500] : Colors.grey[600],
                ),
                child: Text(
                  isCurrentPlan ? '当前使用' : (plan.price == 0 ? '免费使用' : '选择套餐'),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
