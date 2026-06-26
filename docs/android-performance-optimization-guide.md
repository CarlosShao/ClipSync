# Android 客户端性能优化指南

## 优化目标

| 指标 | 目标值 | 当前值 | 状态 |
|------|--------|--------|------|
| 启动时间 | < 2秒 | ~3秒 | 🔄 优化中 |
| 内存占用 | < 100MB | ~150MB | 🔄 优化中 |
| 帧率 | ≥ 55fps | ~50fps | 🔄 优化中 |
| 包大小 | < 10MB | ~15MB | ✅ 已完成 |

## 1. 内存优化

### 1.1 图片缓存优化

**优化前**：
```dart
// 默认图片缓存配置
PaintingBinding.instance.imageCache.maximumSize = 100;
PaintingBinding.instance.imageCache.maximumSizeBytes = 50 * 1024 * 1024;
```

**优化后**（`lib/utils/performance.dart`）：
```dart
class OptimizedImageCache {
  static const int _maxSize = 50; // 减少缓存数量
  static const int _maxSizeBytes = 30 * 1024 * 1024; // 减少缓存大小到30MB
  
  static void initialize() {
    PaintingBinding.instance.imageCache.maximumSize = _maxSize;
    PaintingBinding.instance.imageCache.maximumSizeBytes = _maxSizeBytes;
  }
  
  // 主动清理内存
  static void clearIfNeeded() {
    final currentBytes = PaintingBinding.instance.imageCache.currentSizeBytes;
    if (currentBytes > _maxSizeBytes * 0.8) {
      PaintingBinding.instance.imageCache.clear();
      PaintingBinding.instance.imageCache.clearLiveImages();
    }
  }
}
```

### 1.2 使用 `cached_network_image` 优化网络图片

**优化前**：
```dart
Image.network(url), // 每次都重新下载
```

**优化后**：
```dart
import 'package:cached_network_image/cached_network_image.dart';

CachedNetworkImage(
  imageUrl: url,
  placeholder: (context, url) => CircularProgressIndicator(),
  errorWidget: (context, url, error) => Icon(Icons.error),
  memCacheWidth: 200, // 限制内存缓存大小
  maxWidthDiskCache: 400, // 限制磁盘缓存大小
),
```

### 1.3 图片压缩

使用 `flutter_native_image` 压缩图片：

```dart
import 'package:flutter_native_image/flutter_native_image.dart';

Future<File> compressImage(File file) async {
  final compressedFile = await FlutterNativeImage.compressImage(
    file.path,
    quality: 80, // 压缩质量
    targetWidth: 1024, // 目标宽度
    targetHeight: 1024, // 目标高度
  );
  return File(compressedFile.path);
}
```

## 2. 卡顿优化

### 2.1 主线程耗时操作移到后台

**优化前**：
```dart
void loadData() {
  final data = fetchDataFromNetwork(); // 主线程耗时
  setState(() {
    _data = data;
  });
}
```

**优化后**：
```dart
import 'package:flutter/foundation.dart';

void loadData() async {
  // 在后台线程执行
  final data = await compute(fetchDataFromNetwork, null);
  
  if (!mounted) return;
  setState(() {
    _data = data;
  });
}

// 静态方法（compute 要求）
static List<dynamic> fetchDataFromNetwork(void _) {
  // 耗时操作
  return result;
}
```

### 2.2 使用 `ListView.builder` 优化长列表

**优化前**：
```dart
Column(
  children: items.map((item) => ListTile(title: Text(item))).toList(),
)
```

**优化后**：
```dart
ListView.builder(
  itemCount: items.length,
  itemBuilder: (context, index) {
    final item = items[index];
    return ListTile(title: Text(item));
  },
)
```

### 2.3 使用 `const` 构造函数优化 Widget 重建

**优化前**：
```dart
ListTile(
  title: Text('Hello'), // 每次重建
)
```

**优化后**：
```dart
const ListTile(
  title: Text('Hello'), // 缓存 Widget
)
```

### 2.4 使用 `RepaintBoundary` 隔离重绘

```dart
RepaintBoundary(
  child: MyHeavyWidget(), // 只有这个 Widget 会重绘
)
```

## 3. 启动优化

### 3.1 延迟初始化非关键服务

**优化前**（`lib/main.dart`）：
```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // 所有服务都同步初始化
  await CacheService.instance.initialize(...);
  await ErrorReportService.instance.initialize();
  await AnalyticsService.instance.initialize();
  
  runApp(MyApp());
}
```

**优化后**：
```dart
void main() async {
  // 记录启动开始时间
  PerformanceUtils.recordAppStart();
  
  WidgetsFlutterBinding.ensureInitialized();
  
  // 只初始化关键服务
  await CacheService.instance.initialize(...);
  
  // 延迟初始化非关键服务
  runApp(MyApp());
  
  // 首帧渲染完成后初始化
  WidgetsBinding.instance.addPostFrameCallback((_) {
    PerformanceUtils.recordFirstFrameRendered();
    
    // 延迟初始化错误报告（不阻塞首帧）
    Future.delayed(Duration(milliseconds: 500), () {
      ErrorReportService.instance.initialize();
    });
  });
}
```

### 3.2 使用 `flutter_native_splash` 优化启动体验

`pubspec.yaml`：
```yaml
dependencies:
  flutter_native_splash: ^2.3.0
```

生成启动闪屏：
```bash
flutter pub run flutter_native_splash:create
```

## 4. 包大小优化（已完成）

### 4.1 Split per ABI

`android/app/build.gradle.kts`：
```kotlin
android {
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }
}
```

### 4.2 启用资源压缩和代码混淆

```kotlin
buildTypes {
    release {
        isMinifyEnabled = true
        isShrinkResources = true
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
}
```

### 4.3 图片资源转 WebP

```bash
# 批量转换 PNG/JPG 到 WebP
for file in assets/images/*.png; do
  cwebp -q 80 "$file" -o "${file%.png}.webp"
done
```

## 5. 监控和分析工具

### 5.1 性能监控（`lib/utils/performance.dart`）

```dart
// 启动性能监控
PerformanceUtils.recordAppStart();
PerformanceUtils.recordInitializationComplete();
PerformanceUtils.recordFirstFrameRendered();

// 获取性能报告
final report = PerformanceUtils.getStartupPerformanceReport();
print('Startup: ${report['firstFrameDurationMs']}ms');

// 内存监控
final memory = PerformanceUtils.getMemoryUsage();
print('Memory: ${memory['imageCacheBytes']} bytes');

// 帧率监控
PerformanceUtils.startFrameRateMonitoring();
final frameReport = PerformanceUtils.getFrameRateReport();
print('FPS: ${frameReport['fps']}');
```

### 5.2 使用 Flutter DevTools 分析性能

```bash
# 运行应用
flutter run --profile

# 打开 DevTools
open chrome://inspect
```

**分析工具**：
1. **Memory**（内存）：查看内存占用、图片缓存
2. **Performance**（性能）：查看帧率、卡顿
3. **CPU Profiler**（CPU）：查看耗时函数

## 6. 最佳实践

### 6.1 Widget 优化清单

- [ ] 使用 `const` 构造函数
- [ ] 使用 `ListView.builder` 渲染长列表
- [ ] 使用 `RepaintBoundary` 隔离重绘
- [ ] 使用 `AnimatedBuilder` 替代 `setState`
- [ ] 使用 `Provider` 选择性重建

### 6.2 内存优化清单

- [ ] 主动清理图片缓存
- [ ] 使用 `WeakReference` 避免内存泄漏
- [ ] 及时释放 `StreamSubscription`
- [ ] 及时销毁 `Timer`
- [ ] 使用 `DisposableBuildContext`

### 6.3 卡顿优化清单

- [ ] 耗时操作移到 `compute`
- [ ] 使用 `FutureBuilder` 延迟加载
- [ ] 使用 `StreamBuilder` 响应式更新
- [ ] 避免在 `build` 方法中执行耗时操作
- [ ] 使用 `throttle`/`debounce` 限制事件频率

## 7. 验证和测试

### 7.1 性能测试

```bash
# 运行性能测试
flutter test test/performance_test.dart

# 生成性能报告
flutter build apk --profile
flutter analyze
```

### 7.2 内存泄漏检测

```dart
// 在 Widget 销毁时打印日志
@override
void dispose() {
  print('${widget.runtimeType} disposed');
  super.dispose();
}
```

### 7.3 帧率测试

```dart
// 使用 PerformanceMonitor 包装 Widget
PerformanceMonitor(
  name: 'HomeScreen',
  child: HomeScreen(),
  onBuild: () {
    // 首帧渲染完成后的回调
  },
)
```

## 8. 故障排查

### 问题1：内存占用过高

**排查步骤**：
1. 使用 DevTools Memory 工具查看内存分配
2. 检查图片缓存大小（`PerformanceUtils.getMemoryUsage()`）
3. 检查是否有内存泄漏（`StreamSubscription` 未取消、`Timer` 未销毁）
4. 主动清理图片缓存（`OptimizedImageCache.clearIfNeeded()`）

**解决方案**：
```dart
@override
void didChangeAppLifecycleState(AppLifecycleState state) {
  if (state == AppLifecycleState.paused) {
    // 应用进入后台，清理内存
    PerformanceUtils.cleanMemory();
  }
}
```

### 问题2：列表滚动卡顿

**排查步骤**：
1. 使用 DevTools Performance 工具查看帧率
2. 检查是否使用 `ListView.builder`
3. 检查是否在 `build` 方法中执行耗时操作
4. 检查是否频繁调用 `setState`

**解决方案**：
```dart
// 使用 AnimatedBuilder 选择性重建
AnimatedBuilder(
  animation: _controller,
  builder: (context, child) {
    return Transform.rotate(
      angle: _controller.value * 2.0 * pi,
      child: child,
    );
  },
  child: const Icon(Icons.refresh), // 不重建
)
```

### 问题3：启动速度慢

**排查步骤**：
1. 查看启动性能报告（`PerformanceUtils.getStartupPerformanceReport()`）
2. 检查是否所有服务都在 `main()` 中初始化
3. 检查是否有同步的网络请求
4. 检查是否有耗时的文件读写

**解决方案**：
```dart
// 延迟初始化非关键服务
Future.delayed(Duration(milliseconds: 500), () {
  AnalyticsService.instance.initialize();
  ErrorReportService.instance.initialize();
});
```

## 9. 参考资料

- [Flutter 性能优化官方文档](https://docs.flutter.dev/perf)
- [Flutter DevTools 使用指南](https://docs.flutter.dev/development/tools/devtools)
- [Flutter 内存优化最佳实践](https://flutter.dev/docs/development/data-and-backend/state-mgmt/performance)
- [Flutter 包大小优化](https://docs.flutter.dev/perf/app-size)

---

**优化完成标准**：

- [ ] 启动时间 < 2秒
- [ ] 内存占用 < 100MB
- [ ] 帧率 ≥ 55fps
- [ ] 包大小 < 10MB（每架构）
- [ ] 通过性能测试
- [ ] 无内存泄漏
- [ ] 无主线程卡顿

**预计工作量**：2-3天

**完成日期**：2026-06-25
