import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../services/api_service.dart';
import '../models/session.dart';

class DeviceManagementScreen extends StatefulWidget {
  const DeviceManagementScreen({Key? key}) : super(key: key);

  @override
  _DeviceManagementScreenState createState() => _DeviceManagementScreenState();
}

class _DeviceManagementScreenState extends State<DeviceManagementScreen> {
  List<Session> _sessions = [];
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  Future<void> _loadSessions() async {
    try {
      setState(() {
        _isLoading = true;
        _errorMessage = null;
      });

      final sessions = await ApiService().getSessions();
      
      setState(() {
        _sessions = sessions;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _errorMessage = e.toString();
        _isLoading = false;
      });
    }
  }

  Future<void> _revokeSession(String sessionId) async {
    try {
      await ApiService().revokeSession(sessionId);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('会话已撤销')),
      );
      _loadSessions();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('撤销失败: $e')),
      );
    }
  }

  Future<void> _revokeAllSessions() async {
    try {
      await ApiService().revokeAllSessions();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('所有会话已撤销')),
      );
      _loadSessions();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('撤销失败: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('设备管理'),
        actions: [
          IconButton(
            icon: const Icon(Icons.delete_forever),
            onPressed: () => _showRevokeAllDialog(),
            tooltip: '撤销所有会话',
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_errorMessage != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error, size: 64, color: Colors.red),
            const SizedBox(height: 16),
            Text(_errorMessage!),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: _loadSessions,
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    if (_sessions.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.devices, size: 64, color: Colors.grey),
            SizedBox(height: 16),
            Text('没有活跃会话'),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadSessions,
      child: ListView.builder(
        itemCount: _sessions.length,
        itemBuilder: (context, index) {
          final session = _sessions[index];
          return _buildSessionTile(session);
        },
      ),
    );
  }

  Widget _buildSessionTile(Session session) {
    final isCurrent = session.isCurrent;
    
    return ListTile(
      leading: _getDeviceIcon(session.platform),
      title: Text(session.deviceName),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('平台: ${session.platform}'),
          Text('IP: ${session.ipAddress}'),
          Text('最后活动: ${_formatDateTime(session.lastActiveAt)}'),
          if (isCurrent)
            const Text(
              '当前会话',
              style: TextStyle(color: Colors.green, fontWeight: FontWeight.bold),
            ),
        ],
      ),
      trailing: isCurrent
          ? null
          : IconButton(
              icon: const Icon(Icons.logout, color: Colors.red),
              onPressed: () => _showRevokeDialog(session),
              tooltip: '撤销会话',
            ),
      isThreeLine: true,
    );
  }

  Widget _getDeviceIcon(String platform) {
    switch (platform.toLowerCase()) {
      case 'windows':
        return const Icon(Icons.computer, color: Colors.blue);
      case 'macos':
        return const Icon(Icons.laptop_mac, color: Colors.grey);
      case 'android':
        return const Icon(Icons.smartphone, color: Colors.green);
      case 'ios':
        return const Icon(Icons.phone_iphone, color: Colors.grey);
      default:
        return const Icon(Icons.device_unknown, color: Colors.grey);
    }
  }

  String _formatDateTime(DateTime dateTime) {
    return '${dateTime.year}-${dateTime.month.toString().padLeft(2, '0')}-${dateTime.day.toString().padLeft(2, '0')} ${dateTime.hour.toString().padLeft(2, '0')}:${dateTime.minute.toString().padLeft(2, '0')}';
  }

  void _showRevokeDialog(Session session) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('撤销会话'),
        content: Text('确定要撤销"${session.deviceName}"的会话吗？\n撤销后该设备将被强制下线。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              _revokeSession(session.id);
            },
            child: const Text('撤销', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }

  void _showRevokeAllDialog() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('撤销所有会话'),
        content: const Text('确定要撤销所有会话吗？\n撤销后所有设备将被强制下线（除了当前设备）。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              _revokeAllSessions();
            },
            child: const Text('撤销所有', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }
}
