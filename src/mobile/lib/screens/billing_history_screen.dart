import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';
import '../services/subscription_api_service.dart';

/// 账单历史页面
class BillingHistoryScreen extends StatefulWidget {
  const BillingHistoryScreen({Key? key}) : super(key: key);

  @override
  State<BillingHistoryScreen> createState() => _BillingHistoryScreenState();
}

class _BillingHistoryScreenState extends State<BillingHistoryScreen> {
  List<dynamic> _invoices = [];
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _fetchInvoices();
  }

  /// 获取发票列表
  Future<void> _fetchInvoices() async {
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

      // 调用后端 API GET /api/invoices
      final invoices = await SubscriptionApiService.getInvoices(token);

      setState(() {
        _invoices = invoices;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _errorMessage = '获取账单历史失败: $e';
        _isLoading = false;
      });
    }
  }

  /// 下载发票
  Future<void> _downloadInvoice(String invoiceId, String invoiceNo) async {
    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;

      if (token == null) {
        throw Exception('用户未登录');
      }

      // 调用后端 API GET /api/invoices/:id/download
      final url = 'https://api.clipsync.com/api/invoices/$invoiceId/download';
      
      // 显示下载提示
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('正在下载发票: $invoiceNo')),
        );
      }

      // 实际下载逻辑需要在移动端实现（使用 url_launcher 或 dio）
      print('📥 下载发票: $url');
      
      // 临时方案：在浏览器中打开
      // launch(url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('下载发票失败: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkMode = theme.brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        title: const Text('账单历史'),
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
                        onPressed: _fetchInvoices,
                        child: const Text('重试'),
                      ),
                    ],
                  ),
                )
              : _invoices.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.receipt_long,
                            size: 64,
                            color: isDarkMode ? Colors.white30 : Colors.black26,
                          ),
                          const SizedBox(height: 16),
                          Text(
                            '暂无账单记录',
                            style: TextStyle(
                              fontSize: 18,
                              color: isDarkMode ? Colors.white70 : Colors.black54,
                            ),
                          ),
                        ],
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: _fetchInvoices,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _invoices.length,
                        itemBuilder: (context, index) {
                          final invoice = _invoices[index];
                          final invoiceId = invoice['id'] ?? '';
                          final invoiceNo = invoice['invoiceNo'] ?? '未知';
                          final amount = invoice['totalAmount'] ?? 0;
                          final status = invoice['status'] ?? '未知';
                          final createdAt = invoice['createdAt'] ?? '';
                          final planName = invoice['planName'] ?? '未知';

                          return Card(
                            margin: const EdgeInsets.only(bottom: 12),
                            child: ListTile(
                              leading: Icon(
                                status == 'issued' ? Icons.receipt : Icons.pending,
                                color: status == 'issued' ? Colors.green : Colors.orange,
                                size: 40,
                              ),
                              title: Text(
                                '¥$amount - $planName',
                                style: const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              subtitle: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text('发票号: $invoiceNo'),
                                  Text('时间: $createdAt'),
                                  Text(
                                    '状态: ${status == 'issued' ? '已开票' : status}',
                                    style: TextStyle(
                                      color: status == 'issued' ? Colors.green : Colors.orange,
                                    ),
                                  ),
                                ],
                              ),
                              trailing: IconButton(
                                icon: const Icon(Icons.download),
                                onPressed: () => _downloadInvoice(invoiceId, invoiceNo),
                                tooltip: '下载发票',
                              ),
                              isThreeLine: true,
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
