import 'package:flutter/material.dart';
import '../models/device.dart';
import '../theme/app_theme.dart';

class DeviceCard extends StatefulWidget {
  final Device device;

  const DeviceCard({super.key, required this.device});

  @override
  State<DeviceCard> createState() => _DeviceCardState();
}

class _DeviceCardState extends State<DeviceCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 150),
      vsync: this,
    );
    _scaleAnimation = Tween<double>(
      begin: 1.0,
      end: 0.97,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    ));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '设备：${widget.device.deviceName}，状态：${widget.device.isOnline ? '在线' : '离线'}',
      button: true,
      child: GestureDetector(
        onTapDown: (_) => _controller.forward(),
        onTapUp: (_) => _controller.reverse(),
        onTapCancel: () => _controller.reverse(),
        child: AnimatedBuilder(
          animation: _scaleAnimation,
          builder: (context, child) {
            return Transform.scale(
              scale: _scaleAnimation.value,
              child: child,
            );
          },
          child: Card(
            child: InkWell(
              onTap: () {},
              borderRadius: BorderRadius.circular(12),
              splashColor: AppTheme.primaryColor.withOpacity(0.15),
              highlightColor: AppTheme.primaryColor.withOpacity(0.08),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    // Device icon with online pulse animation
                    _buildDeviceIcon(),
                    const SizedBox(width: 16),

                    // Device info
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.device.deviceName,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Row(
                            children: [
                              AnimatedContainer(
                                duration: const Duration(milliseconds: 300),
                                width: 8,
                                height: 8,
                                decoration: BoxDecoration(
                                  color: widget.device.isOnline
                                      ? AppTheme.successColor
                                      : AppTheme.textSecondary,
                                  shape: BoxShape.circle,
                                  boxShadow: widget.device.isOnline
                                      ? [
                                          BoxShadow(
                                            color: AppTheme.successColor.withOpacity(0.5),
                                            blurRadius: 4,
                                            spreadRadius: 1,
                                          ),
                                        ]
                                      : null,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Text(
                                widget.device.isOnline ? '在线' : widget.device.platform,
                                style: const TextStyle(
                                  fontSize: 13,
                                  color: AppTheme.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),

                    // Device type badge
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: AppTheme.primaryLight.withOpacity(0.1),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        _getDeviceTypeLabel(),
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppTheme.primaryColor,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildDeviceIcon() {
    return Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        color: widget.device.isOnline
            ? AppTheme.primaryColor
            : AppTheme.textSecondary.withOpacity(0.2),
        borderRadius: BorderRadius.circular(12),
        boxShadow: widget.device.isOnline
            ? [
                BoxShadow(
                  color: AppTheme.primaryColor.withOpacity(0.3),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
              ]
            : null,
      ),
      child: Icon(
        _getDeviceIcon(),
        color: widget.device.isOnline ? Colors.white : AppTheme.textSecondary,
        size: 24,
      ),
    );
  }

  IconData _getDeviceIcon() {
    switch (widget.device.deviceType) {
      case 'desktop':
        return Icons.computer;
      case 'mobile':
        return Icons.phone_iphone;
      case 'tablet':
        return Icons.tablet_mac;
      default:
        return Icons.devices_other;
    }
  }

  String _getDeviceTypeLabel() {
    switch (widget.device.deviceType) {
      case 'desktop':
        return '桌面端';
      case 'mobile':
        return '移动端';
      case 'tablet':
        return '平板';
      default:
        return widget.device.deviceType;
    }
  }
}