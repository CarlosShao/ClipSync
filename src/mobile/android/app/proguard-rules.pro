# ClipSync ProGuard 混淆规则
# 用于 Android 代码混淆（release 构建时启用）

# 保留 Flutter 相关类
-keep class io.flutter.app.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.util.** { *; }
-keep class io.flutter.view.** { *; }
-keep class io.flutter.FlutterActivity { *; }

# 保留 Firebase 相关类（如果使用）
# -keep class com.google.firebase.** { *; }

# 保留 JSON 序列化类（如果使用 Gson、Jackson 等）
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# 保留 Parcelable 实现
-keep class * implements android.os.Parcelable {
  public static final android.os.Parcelable$Creator *;
}

# 保留 Serializable 实现
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# 保留 Android 支持库
-keep class android.support.** { *; }
-keep interface android.support.** { *; }

# 保留 AndroidX
-keep class androidx.** { *; }
-keep interface androidx.** { *; }

# 保留 WebView JavaScript 接口
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 保留枚举
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# 保留 R 类（资源引用）
-keep class **.R$* { *; }

# 保留 Native 方法
-keepclasseswithmembernames class * {
    native <methods>;
}

# 移除冗余日志（S1-5：release logcat 不得泄漏凭据/验证码）。
# 只剥离 v/d/i；保留 w/e 以便崩溃与异常路径仍可诊断。
# 注：旧注释块拼写为 assumenosideffects（少一个 e），即便取消注释也不会生效。
# ⚠️ 本规则未经 release 构建实测验证（见 docs/audit fix-p0b-mobile.md）
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}

# Flutter 混淆规则（必须保留）
# 参考: https://flutter.dev/docs/deployment/obfuscate
-keep class androidx.lifecycle.ViewModel { *; }
-keep class * extends androidx.lifecycle.ViewModel { *; }

# 保留 ClipSync 模型类（防止 JSON 序列化失败）
-keep class com.clipsync.clipsync_mobile.models.** { *; }
