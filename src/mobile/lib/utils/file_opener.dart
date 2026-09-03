import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';

/// 文件打开与分享封装（F2.2）。
///
/// - [open]：经 OpenFilex 按 mimeType / 扩展名调起系统匹配应用打开本地文件；
/// - [share]：经 share_plus 调系统分享面板分享本地文件。
///
/// 权限说明：文件保存于应用私有临时目录（getTemporaryDirectory），
/// Android 由 open_filex / share_plus 各自自带的 FileProvider 授权，
/// 无需额外存储权限、无需宿主 manifest 配置。
class FileOpener {
  const FileOpener._();

  /// 打开本地文件。返回是否成功（ResultType.done 之外——无匹配应用 /
  /// 权限拒绝等——一律视为失败，由调用方提示）。
  static Future<bool> open(String path) async {
    final OpenResult result = await OpenFilex.open(path);
    return result.type == ResultType.done;
  }

  /// 调系统分享面板分享本地文件（单文件）。失败由调用方捕获提示。
  static Future<void> share(String path, {String? mimeType}) {
    return Share.shareXFiles(<XFile>[
      XFile(path, mimeType: mimeType),
    ]);
  }
}
