import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';
import '../theme/app_theme.dart';

/// 调查类型枚举
enum SurveyType {
  nps, // 净推荐值
  csat, // 客户满意度
  ces, // 客户费力度
}

/// 调查问题
class SurveyQuestion {
  final String id;
  final String text;
  final SurveyType type;
  final bool isRequired;
  final List<String>? options;

  SurveyQuestion({
    required this.id,
    required this.text,
    required this.type,
    this.isRequired = true,
    this.options,
  });
}

/// 调查回答
class SurveyAnswer {
  final String questionId;
  final dynamic answer;
  final DateTime timestamp;

  SurveyAnswer({
    required this.questionId,
    required this.answer,
    required this.timestamp,
  });

  Map<String, dynamic> toJson() => {
    'questionId': questionId,
    'answer': answer,
    'timestamp': timestamp.toIso8601String(),
  };
}

/// 调查问卷
class Survey {
  final String id;
  final String title;
  final String description;
  final List<SurveyQuestion> questions;
  final bool isActive;
  final DateTime createdAt;
  final DateTime? expiresAt;

  Survey({
    required this.id,
    required this.title,
    required this.description,
    required this.questions,
    this.isActive = true,
    required this.createdAt,
    this.expiresAt,
  });

  bool get isExpired => expiresAt != null && DateTime.now().isAfter(expiresAt!);
}

/// 用户满意度调查页面
class SurveyScreen extends StatefulWidget {
  final Survey survey;
  
  const SurveyScreen({Key? key, required this.survey}) : super(key: key);

  @override
  State<SurveyScreen> createState() => _SurveyScreenState();
}

class _SurveyScreenState extends State<SurveyScreen> {
  final PageController _pageController = PageController();
  final Map<String, dynamic> _answers = {};
  int _currentPage = 0;
  bool _isSubmitting = false;

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.survey.title),
        backgroundColor: AppTheme.primaryColor,
        foregroundColor: Colors.white,
        actions: [
          TextButton(
            onPressed: _skipSurvey,
            child: const Text(
              '跳过',
              style: TextStyle(color: Colors.white70),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          // 进度指示器
          LinearProgressIndicator(
            value: (_currentPage + 1) / widget.survey.questions.length,
            backgroundColor: Colors.grey[200],
            valueColor: AlwaysStoppedAnimation<Color>(AppTheme.primaryColor),
          ),
          
          // 问题内容
          Expanded(
            child: PageView.builder(
              controller: _pageController,
              itemCount: widget.survey.questions.length,
              onPageChanged: (page) {
                setState(() {
                  _currentPage = page;
                });
              },
              itemBuilder: (context, page) {
                final question = widget.survey.questions[page];
                return _buildQuestionPage(question);
              },
            ),
          ),
          
          // 底部导航按钮
          _buildBottomNavigation(),
        ],
      ),
    );
  }

  Widget _buildQuestionPage(SurveyQuestion question) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 问题编号
          Text(
            '问题 ${_currentPage + 1}/${widget.survey.questions.length}',
            style: TextStyle(
              fontSize: 14,
              color: AppTheme.textSecondary,
            ),
          ),
          const SizedBox(height: 8),
          
          // 问题文本
          Text(
            question.text,
            style: const TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 32),
          
          // 根据问题类型构建不同的输入
          _buildQuestionInput(question),
        ],
      ),
    );
  }

  Widget _buildQuestionInput(SurveyQuestion question) {
    switch (question.type) {
      case SurveyType.nps:
        return _buildNPSInput(question);
      case SurveyType.csat:
        return _buildCSATInput(question);
      case SurveyType.ces:
        return _buildCESInput(question);
    }
  }

  Widget _buildNPSInput(SurveyQuestion question) {
    final currentAnswer = _answers[question.id] as int?;
    
    return Column(
      children: [
        // 评分标签
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              '完全不可能',
              style: TextStyle(
                fontSize: 12,
                color: AppTheme.textSecondary,
              ),
            ),
            Text(
              '非常可能',
              style: TextStyle(
                fontSize: 12,
                color: AppTheme.textSecondary,
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        
        // 评分选择
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: List.generate(11, (index) {
            final isSelected = currentAnswer == index;
            final color = _getNPSColor(index);
            
            return GestureDetector(
              onTap: () {
                setState(() {
                  _answers[question.id] = index;
                });
              },
              child: Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: isSelected ? color : Colors.grey[100],
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: isSelected ? color : Colors.grey[300]!,
                    width: isSelected ? 2 : 1,
                  ),
                ),
                child: Center(
                  child: Text(
                    '$index',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: isSelected ? Colors.white : AppTheme.textPrimary,
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
        
        // 解释文本
        if (currentAnswer != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(
              _getNPSExplanation(currentAnswer),
              style: TextStyle(
                fontSize: 14,
                color: AppTheme.textSecondary,
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildCSATInput(SurveyQuestion question) {
    final currentAnswer = _answers[question.id] as int?;
    
    return Column(
      children: [
        // 表情选择
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: List.generate(5, (index) {
            final isSelected = currentAnswer == index;
            final emotion = _getCSATEmotion(index);
            
            return GestureDetector(
              onTap: () {
                setState(() {
                  _answers[question.id] = index;
                });
              },
              child: Column(
                children: [
                  Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: isSelected ? AppTheme.primaryColor.withOpacity(0.1) : Colors.transparent,
                      borderRadius: BorderRadius.circular(32),
                      border: Border.all(
                        color: isSelected ? AppTheme.primaryColor : Colors.grey[300]!,
                        width: isSelected ? 2 : 1,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        emotion['emoji']!,
                        style: const TextStyle(fontSize: 32),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    emotion['label']!,
                    style: TextStyle(
                      fontSize: 12,
                      color: isSelected ? AppTheme.primaryColor : AppTheme.textSecondary,
                      fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
                    ),
                  ),
                ],
              ),
            );
          }),
        ),
        
        // 解释文本
        if (currentAnswer != null)
          Padding(
            padding: const EdgeInsets.only(top: 24),
            child: Text(
              _getCSATExplanation(currentAnswer),
              style: TextStyle(
                fontSize: 14,
                color: AppTheme.textSecondary,
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildCESInput(SurveyQuestion question) {
    final currentAnswer = _answers[question.id] as int?;
    
    return Column(
      children: [
        // 评分标签
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              '非常困难',
              style: TextStyle(
                fontSize: 12,
                color: AppTheme.textSecondary,
              ),
            ),
            Text(
              '非常简单',
              style: TextStyle(
                fontSize: 12,
                color: AppTheme.textSecondary,
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        
        // 评分选择
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: List.generate(7, (index) {
            final isSelected = currentAnswer == index;
            final color = _getCESColor(index);
            
            return GestureDetector(
              onTap: () {
                setState(() {
                  _answers[question.id] = index;
                });
              },
              child: Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: isSelected ? color : Colors.grey[100],
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: isSelected ? color : Colors.grey[300]!,
                    width: isSelected ? 2 : 1,
                  ),
                ),
                child: Center(
                  child: Text(
                    '${index + 1}',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: isSelected ? Colors.white : AppTheme.textPrimary,
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
        
        // 解释文本
        if (currentAnswer != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(
              _getCESExplanation(currentAnswer),
              style: TextStyle(
                fontSize: 14,
                color: AppTheme.textSecondary,
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildBottomNavigation() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.05),
            blurRadius: 10,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          // 上一页按钮
          if (_currentPage > 0)
            OutlinedButton(
              onPressed: () {
                _pageController.previousPage(
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeInOut,
                );
              },
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                side: const BorderSide(color: AppTheme.primaryColor),
              ),
              child: const Text('上一页'),
            )
          else
            const SizedBox(width: 100),
          
          // 页码指示
          Text(
            '${_currentPage + 1} / ${widget.survey.questions.length}',
            style: TextStyle(
              color: AppTheme.textSecondary,
              fontWeight: FontWeight.w500,
            ),
          ),
          
          // 下一页/提交按钮
          if (_currentPage < widget.survey.questions.length - 1)
            ElevatedButton(
              onPressed: _canProceed() ? _nextPage : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.primaryColor,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              ),
              child: const Text('下一页'),
            )
          else
            ElevatedButton(
              onPressed: _canSubmit() ? _submitSurvey : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.primaryColor,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              ),
              child: _isSubmitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                      ),
                    )
                  : const Text('提交'),
            ),
        ],
      ),
    );
  }

  bool _canProceed() {
    final question = widget.survey.questions[_currentPage];
    if (!question.isRequired) return true;
    return _answers.containsKey(question.id);
  }

  bool _canSubmit() {
    // 检查所有必填问题是否已回答
    for (final question in widget.survey.questions) {
      if (question.isRequired && !_answers.containsKey(question.id)) {
        return false;
      }
    }
    return true;
  }

  void _nextPage() {
    _pageController.nextPage(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOut,
    );
  }

  void _skipSurvey() {
    Navigator.of(context).pop();
  }

  Future<void> _submitSurvey() async {
    if (!_canSubmit()) return;

    setState(() {
      _isSubmitting = true;
    });

    try {
      // 构建答案列表
      final answers = _answers.entries.map((entry) {
        return SurveyAnswer(
          questionId: entry.key,
          answer: entry.value,
          timestamp: DateTime.now(),
        );
      }).toList();

      // 这里应该调用实际的提交API
      // 暂时模拟提交
      await Future.delayed(const Duration(seconds: 2));

      // 模拟成功
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('感谢您的反馈！您的意见对我们非常重要。'),
            backgroundColor: Colors.green,
          ),
        );

        // 返回上一页
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('提交失败：${e.toString()}'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _isSubmitting = false;
        });
      }
    }
  }

  // 辅助方法
  
  Color _getNPSColor(int score) {
    if (score <= 6) return Colors.red;
    if (score <= 8) return Colors.orange;
    return Colors.green;
  }

  String _getNPSExplanation(int score) {
    if (score <= 6) {
      return '感谢您的诚实反馈。我们会努力改进，让您有更好的体验。';
    } else if (score <= 8) {
      return '谢谢您的认可！我们会继续努力，让您更加满意。';
    } else {
      return '太棒了！很高兴您喜欢 ClipSync。我们会继续保持！';
    }
  }

  Map<String, String> _getCSATEmotion(int index) {
    const emotions = [
      {'emoji': '😡', 'label': '非常不满意'},
      {'emoji': '😟', 'label': '不满意'},
      {'emoji': '😐', 'label': '一般'},
      {'emoji': '😊', 'label': '满意'},
      {'emoji': '😍', 'label': '非常满意'},
    ];
    return emotions[index];
  }

  String _getCSATExplanation(int score) {
    const explanations = [
      '很抱歉给您带来了不好的体验。请告诉我们具体问题，我们会尽快解决。',
      '我们理解您的不满。请分享更多细节，帮助我们改进。',
      '感谢您的反馈。我们会努力提升服务质量。',
      '很高兴您对我们的服务满意！我们会继续保持。',
      '太开心了！您的满意是我们最大的动力！',
    ];
    return explanations[score];
  }

  Color _getCESColor(int score) {
    if (score <= 2) return Colors.red;
    if (score <= 4) return Colors.orange;
    return Colors.green;
  }

  String _getCESExplanation(int score) {
    if (score <= 2) {
      return '我们理解使用过程中遇到了困难。请告诉我们具体问题，我们会简化操作流程。';
    } else if (score <= 4) {
      return '感谢您的反馈。我们会优化界面设计，让操作更简单直观。';
    } else {
      return '很高兴您觉得使用简单！我们会保持简洁的设计理念。';
    }
  }
}

/// 调查触发器
class SurveyTrigger {
  final String surveyId;
  final String triggerEvent;
  final int cooldownDays;
  final int maxDisplays;
  final DateTime? lastDisplayed;
  final int displayCount;

  SurveyTrigger({
    required this.surveyId,
    required this.triggerEvent,
    this.cooldownDays = 30,
    this.maxDisplays = 3,
    this.lastDisplayed,
    this.displayCount = 0,
  });

  bool get shouldShow {
    // 检查显示次数
    if (displayCount >= maxDisplays) return false;
    
    // 检查冷却期
    if (lastDisplayed != null) {
      final daysSinceLastDisplay = DateTime.now().difference(lastDisplayed!).inDays;
      if (daysSinceLastDisplay < cooldownDays) return false;
    }
    
    return true;
  }

  Map<String, dynamic> toJson() => {
    'surveyId': surveyId,
    'triggerEvent': triggerEvent,
    'cooldownDays': cooldownDays,
    'maxDisplays': maxDisplays,
    'lastDisplayed': lastDisplayed?.toIso8601String(),
    'displayCount': displayCount,
  };

  factory SurveyTrigger.fromJson(Map<String, dynamic> json) => SurveyTrigger(
    surveyId: json['surveyId'],
    triggerEvent: json['triggerEvent'],
    cooldownDays: json['cooldownDays'] ?? 30,
    maxDisplays: json['maxDisplays'] ?? 3,
    lastDisplayed: json['lastDisplayed'] != null 
        ? DateTime.parse(json['lastDisplayed'])
        : null,
    displayCount: json['displayCount'] ?? 0,
  );
}

/// 调查管理器
class SurveyManager {
  static SurveyManager? _instance;
  static SurveyManager get instance => _instance ??= SurveyManager._();
  
  SurveyManager._();
  
  final List<Survey> _surveys = [];
  final List<SurveyTrigger> _triggers = [];
  final List<SurveyAnswer> _answers = [];
  
  /// 初始化调查管理器
  Future<void> initialize() async {
    // 加载调查数据
    await _loadSurveys();
    await _loadTriggers();
    await _loadAnswers();
    
    // 创建默认调查
    _createDefaultSurveys();
    
    debugPrint('SurveyManager initialized');
  }
  
  /// 检查是否应该显示调查
  bool shouldShowSurvey(String triggerEvent) {
    for (final trigger in _triggers) {
      if (trigger.triggerEvent == triggerEvent && trigger.shouldShow) {
        return true;
      }
    }
    return false;
  }
  
  /// 获取触发调查
  Survey? getSurveyForTrigger(String triggerEvent) {
    for (final trigger in _triggers) {
      if (trigger.triggerEvent == triggerEvent && trigger.shouldShow) {
        return _surveys.firstWhere(
          (survey) => survey.id == trigger.surveyId,
          orElse: () => null as Survey,
        );
      }
    }
    return null;
  }
  
  /// 记录调查显示
  void recordSurveyDisplay(String surveyId) {
    final triggerIndex = _triggers.indexWhere((t) => t.surveyId == surveyId);
    if (triggerIndex != -1) {
      final trigger = _triggers[triggerIndex];
      _triggers[triggerIndex] = SurveyTrigger(
        surveyId: trigger.surveyId,
        triggerEvent: trigger.triggerEvent,
        cooldownDays: trigger.cooldownDays,
        maxDisplays: trigger.maxDisplays,
        lastDisplayed: DateTime.now(),
        displayCount: trigger.displayCount + 1,
      );
      
      _saveTriggers();
    }
  }
  
  /// 提交调查答案
  Future<void> submitAnswers(String surveyId, List<SurveyAnswer> answers) async {
    _answers.addAll(answers);
    await _saveAnswers();
    
    // 这里应该调用实际的提交API
    debugPrint('Survey answers submitted for survey: $surveyId');
  }
  
  /// 获取调查统计
  Map<String, dynamic> getStats() {
    return {
      'totalSurveys': _surveys.length,
      'totalTriggers': _triggers.length,
      'totalAnswers': _answers.length,
    };
  }
  
  // 私有方法
  
  void _createDefaultSurveys() {
    if (_surveys.isEmpty) {
      // NPS调查
      _surveys.add(Survey(
        id: 'nps_survey',
        title: '净推荐值调查',
        description: '帮助我们了解您向朋友推荐 ClipSync 的可能性',
        questions: [
          SurveyQuestion(
            id: 'nps_score',
            text: '您有多大可能向朋友或同事推荐 ClipSync？',
            type: SurveyType.nps,
          ),
          SurveyQuestion(
            id: 'nps_reason',
            text: '请告诉我们您给出这个评分的原因（可选）',
            type: SurveyType.csat,
            isRequired: false,
          ),
        ],
        createdAt: DateTime.now(),
      ));
      
      // CSAT调查
      _surveys.add(Survey(
        id: 'csat_survey',
        title: '客户满意度调查',
        description: '请告诉我们您对 ClipSync 的满意度',
        questions: [
          SurveyQuestion(
            id: 'csat_score',
            text: '您对 ClipSync 的整体满意度如何？',
            type: SurveyType.csat,
          ),
          SurveyQuestion(
            id: 'csat_feedback',
            text: '请告诉我们您喜欢或不喜欢 ClipSync 的哪些方面（可选）',
            type: SurveyType.csat,
            isRequired: false,
          ),
        ],
        createdAt: DateTime.now(),
      ));
      
      // CES调查
      _surveys.add(Survey(
        id: 'ces_survey',
        title: '客户费力度调查',
        description: '请告诉我们使用 ClipSync 的难易程度',
        questions: [
          SurveyQuestion(
            id: 'ces_score',
            text: '使用 ClipSync 完成任务有多容易？',
            type: SurveyType.ces,
          ),
          SurveyQuestion(
            id: 'ces_feedback',
            text: '请告诉我们哪些地方可以改进（可选）',
            type: SurveyType.csat,
            isRequired: false,
          ),
        ],
        createdAt: DateTime.now(),
      ));
      
      _saveSurveys();
    }
    
    // 创建默认触发器
    if (_triggers.isEmpty) {
      _triggers.add(SurveyTrigger(
        surveyId: 'nps_survey',
        triggerEvent: 'app_usage_7_days',
        cooldownDays: 90,
        maxDisplays: 3,
      ));
      
      _triggers.add(SurveyTrigger(
        surveyId: 'csat_survey',
        triggerEvent: 'feature_used',
        cooldownDays: 30,
        maxDisplays: 5,
      ));
      
      _triggers.add(SurveyTrigger(
        surveyId: 'ces_survey',
        triggerEvent: 'first_sync',
        cooldownDays: 60,
        maxDisplays: 2,
      ));
      
      _saveTriggers();
    }
  }
  
  Future<void> _loadSurveys() async {
    // 这里应该从本地存储或API加载调查
    // 暂时使用空列表
  }
  
  Future<void> _loadTriggers() async {
    // 这里应该从本地存储加载触发器
    // 暂时使用空列表
  }
  
  Future<void> _loadAnswers() async {
    // 这里应该从本地存储加载答案
    // 暂时使用空列表
  }
  
  Future<void> _saveSurveys() async {
    // 这里应该保存调查到本地存储
  }
  
  Future<void> _saveTriggers() async {
    // 这里应该保存触发器到本地存储
  }
  
  Future<void> _saveAnswers() async {
    // 这里应该保存答案到本地存储
  }
}

/// 调查按钮组件
class SurveyButton extends StatelessWidget {
  final VoidCallback? onPressed;
  
  const SurveyButton({Key? key, this.onPressed}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return ElevatedButton.icon(
      onPressed: onPressed ?? () => _showSurvey(context),
      icon: const Icon(Icons.poll, size: 18),
      label: const Text('参与调查'),
      style: ElevatedButton.styleFrom(
        backgroundColor: AppTheme.primaryColor,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      ),
    );
  }

  void _showSurvey(BuildContext context) {
    final surveyManager = SurveyManager.instance;
    final survey = surveyManager.getSurveyForTrigger('manual');
    
    if (survey != null) {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (context) => SurveyScreen(survey: survey),
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('目前没有可用的调查'),
        ),
      );
    }
  }
}