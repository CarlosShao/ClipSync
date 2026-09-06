import {
  AndroidOutlined,
  AppleOutlined,
  GlobalOutlined,
  LinuxOutlined,
  WindowsOutlined,
} from '@ant-design/icons';
import type { ComponentType, CSSProperties } from 'react';
import type { DeviceKind, DevicePlatform } from '@/api/types';

/** 页头平台徽章的展示顺序（Windows → Linux，与工单一致） */
export const PLATFORM_ORDER: DevicePlatform[] = ['windows', 'macos', 'android', 'ios', 'linux'];

export const platformLabel: Record<DevicePlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  android: 'Android',
  ios: 'iOS',
  linux: 'Linux',
  ipados: 'iPadOS',
  web: 'Web',
};

/** 平台图标：iOS/iPadOS 共用 Apple 图标，浏览器端用地球 */
export const platformIcon: Record<DevicePlatform, ComponentType<{ className?: string; style?: CSSProperties }>> = {
  windows: WindowsOutlined,
  macos: AppleOutlined,
  android: AndroidOutlined,
  ios: AppleOutlined,
  linux: LinuxOutlined,
  ipados: AppleOutlined,
  web: GlobalOutlined,
};

export const kindLabel: Record<DeviceKind, string> = {
  desktop: '桌面端',
  mobile: '移动端',
  tablet: '平板',
  browser: '浏览器',
};
