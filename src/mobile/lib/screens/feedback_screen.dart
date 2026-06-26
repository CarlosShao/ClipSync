import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../theme/app_theme.dart';

/// 反馈类型枚举
enum FeedbackType {
  bug,
  feature,
  improvement,
  other,
}

/// 反馈优先级枚举
enum FeedbackPriority {
  low,
  medium,
  high,
  critical,
}

/// 反馈页面
class FeedbackScreen extends StatefulWidget {
  const FeedbackScreen({Key? key}) : super(key: key);

  @override
  State<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends State<FeedbackScreen> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _descriptionController = TextEditingController();
  final _emailController = TextEditingController();
  
  FeedbackType _feedbackType = FeedbackType.bug;
  FeedbackPriority _feedbackPriority = FeedbackPriority.medium;
  bool _isSubmitting = false;
  bool _includeScreenshot = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    // 预填用户邮箱
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final auth = context.read<AuthProvider>();
      if (auth.user != null) {
        _emailController.text = auth.user!['email'] ?? '';
      }
    });
  }

  @override
  void dispose() {
    _titleController.dispose();
    _descriptionController.dispose();
    _emailController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('反馈与建议'),
        backgroundColor: AppTheme.primaryColor,
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 标题说明
              const Text(
                '帮助我们改进 ClipSync',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '您的反馈对我们非常重要，请详细描述您遇到的问题或建议。',
                style: TextStyle(
                  fontSize: 14,
                  color: AppTheme.textSecondary,
                ),
              ),
              const SizedBox(height: 24),

              // 反馈类型选择
              const Text(
                '反馈类型',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              _buildFeedbackTypeSelector(),
              const SizedBox(height: 16),

              // 优先级选择
              const Text(
                '紧急程度',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              _buildPrioritySelector(),
              const SizedBox(height: 16),

              // 标题输入
              const Text(
                '标题',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _titleController,
                decoration: InputDecoration(
                  hintText: '请简要描述您的问题或建议',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  contentPadding: const EdgeInsets.all(12),
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return '请输入标题';
                  }
                  if (value.length < 5) {
                    return '标题至少需要5个字符';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 16),

              // 详细描述
              const Text(
                '详细描述',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _descriptionController,
                maxLines: 5,
                decoration: InputDecoration(
                  hintText: '请详细描述您遇到的问题、期望的功能或改进建议...',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  contentPadding: const EdgeInsets.all(12),
                ),
                validator: (value) {
                  if (value == null || value.isEmpty) {
                    return '请输入详细描述';
                  }
                  if (value.length < 10) {
                    return '详细描述至少需要10个字符';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 16),

              // 邮箱输入
              const Text(
                '联系邮箱（可选）',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
                decoration: InputDecoration(
                  hintText: 'your@email.com',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  contentPadding: const EdgeInsets.all(12),
                ),
                validator: (value) {
                  if (value != null && value.isNotEmpty) {
                    final emailRegex = RegExp(r'^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$');
                    if (!emailRegex.hasMatch(value)) {
                      return '请输入有效的邮箱地址';
                    }
                  }
                  return null;
                },
              ),
              const SizedBox(height: 16),

              // 包含截图选项
              Row(
                children: [
                  Checkbox(
                    value: _includeScreenshot,
                    onChanged: (value) {
                      setState(() {
                        _includeScreenshot = value ?? true;
                      });
                    },
                    activeColor: AppTheme.primaryColor,
                  ),
                  const Text(
                    '包含当前页面截图（可选）',
                    style: TextStyle(
                      fontSize: 14,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),

              // 错误信息显示
              if (_errorMessage != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: Colors.red[50],
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.red[200]!),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.error_outline, color: Colors.red[700]),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _errorMessage!,
                          style: TextStyle(color: Colors.red[700]),
                        ),
                      ),
                    ],
                  ),
                ),

              // 提交按钮
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton(
                  onPressed: _isSubmitting ? null : _submitFeedback,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryColor,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  child: _isSubmitting
                      ? const SizedBox(
                          width: 24,
                          height: 24,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                          ),
                        )
                      : const Text(
                          '提交反馈',
                          style: TextStyle(fontSize: 16),
                        ),
                ),
              ),
              const SizedBox(height: 16),

              // 底部说明
              Text(
                '提交后，我们的团队会尽快处理您的反馈。感谢您帮助我们改进 ClipSync！',
                style: TextStyle(
                  fontSize: 12,
                  color: AppTheme.textSecondary,
                ),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildFeedbackTypeSelector() {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: FeedbackType.values.map((type) {
        final isSelected = _feedbackType == type;
        return ChoiceChip(
          label: Text(_getFeedbackTypeLabel(type)),
          selected: isSelected,
          onSelected: (selected) {
            setState(() {
              _feedbackType = type;
            });
          },
          selectedColor: AppTheme.primaryColor.withOpacity(0.2),
          labelStyle: TextStyle(
            color: isSelected ? AppTheme.primaryColor : AppTheme.textPrimary,
            fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
          ),
        );
      }).toList(),
    );
  }

  Widget _buildPrioritySelector() {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: FeedbackPriority.values.map((priority) {
        final isSelected = _feedbackPriority == priority;
        return ChoiceChip(
          label: Text(_getPriorityLabel(priority)),
          selected: isSelected,
          onSelected: (selected) {
            setState(() {
              _feedbackPriority = priority;
            });
          },
          selectedColor: _getPriorityColor(priority).withOpacity(0.2),
          labelStyle: TextStyle(
            color: isSelected ? _getPriorityColor(priority) : AppTheme.textPrimary,
            fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
          ),
        );
      }).toList(),
    );
  }

  String _getFeedbackTypeLabel(FeedbackType type) {
    switch (type) {
      case FeedbackType.bug:
        return '🐛 Bug报告';
      case FeedbackType.feature:
        return '✨ 功能建议';
      case FeedbackType.improvement:
        return '🔧 改进建议';
      case FeedbackType.other:
        return '💬 其他';
    }
  }

  String _getPriorityLabel(FeedbackPriority priority) {
    switch (priority) {
      case FeedbackPriority.low:
        return '低优先级';
      case FeedbackPriority.medium:
        return '中优先级';
      case FeedbackPriority.high:
        return '高优先级';
      case FeedbackPriority.critical:
        return '紧急问题';
    }
  }

  Color _getPriorityColor(FeedbackPriority priority) {
    switch (priority) {
      case FeedbackPriority.low:
        return Colors.green;
      case FeedbackPriority.medium:
        return Colors.orange;
      case FeedbackPriority.high:
        return Colors.red;
      case FeedbackPriority.critical:
        return Colors.purple;
    }
  }

  Future<void> _submitFeedback() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      final auth = context.read<AuthProvider>();
      final token = auth.token;
      
      if (token == null) {
        throw Exception('请先登录');
      }

      // 这里应该调用实际的反馈API
      // 暂时模拟API调用
      await Future.delayed(const Duration(seconds: 2));
      
      // 模拟成功
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('感谢您的反馈！我们会尽快处理。'),
            backgroundColor: Colors.green,
          ),
        );
        
        // 返回上一页
        Navigator.of(context).pop();
      }
    } catch (e) {
      setState(() {
        _errorMessage = '提交失败：${e.toString()}';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isSubmitting = false;
        });
      }
    }
  }
}

/// 反馈按钮组件
class FeedbackButton extends StatelessWidget {
  const FeedbackButton({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: const Icon(Icons.feedback, color: AppTheme.primaryColor),
      title: const Text('反馈与建议'),
      subtitle: const Text('帮助我们改进 ClipSync'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () {
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (context) => const FeedbackScreen(),
          ),
        );
      },
    );
  }
}