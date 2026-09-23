import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:clipsync_mobile/services/cache_service.dart';
import 'package:clipsync_mobile/services/pending_upload_queue.dart';
import 'package:clipsync_mobile/services/session_cleanup.dart';

/// P0-B S0-1 回归：换账号不得串数据。
///
/// 场景：用户 A 登录并在弱网下产生离线队列（剪贴板明文）→ 登出 →
/// 用户 B 登录 → B 的重放管线里不得出现 A 的任何条目。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const legacyKey = 'pending_upload_queue_v1';
  const userAKey = 'pending_upload_queue_v1:u_userA';
  const userBKey = 'pending_upload_queue_v1:u_userB';

  String encodeEntry(String text) =>
      '[{"idempotencyKey":"k-$text","contentType":"text","text":"$text",'
      '"createdAt":1735689600000,"attempts":0}]';

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    // 单例跨用例复用：每个用例从干净状态开始
    await PendingUploadQueue.instance.clear();
    await PendingUploadQueue.instance.bindUser(null);
  });

  test('旧版无命名空间队列数据被丢弃（归属不可判定，不得重放给任何用户）', () async {
    SharedPreferences.setMockInitialValues({
      legacyKey: encodeEntry('legacy-secret'),
    });
    await PendingUploadQueue.instance.bindUser('userA');

    expect(await PendingUploadQueue.instance.length(), 0);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(legacyKey), isNull);
  });

  test('A 的离线队列按 userId 命名空间持久化', () async {
    await PendingUploadQueue.instance.bindUser('userA');
    await PendingUploadQueue.instance.enqueue(
      idempotencyKey: 'k-a1',
      contentType: 'text',
      text: 'A-private-content',
    );

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(userAKey), contains('A-private-content'));
    expect(prefs.getString(userBKey), isNull);
    expect(prefs.getString(legacyKey), isNull);
  });

  test('核心场景：A 产生队列 → 登出(purgeAll) → B 登录，B 不重放 A 的条目', () async {
    // 用户 A：绑定并积压两条明文
    await PendingUploadQueue.instance.bindUser('userA');
    await PendingUploadQueue.instance.enqueue(
      idempotencyKey: 'k-a1',
      contentType: 'text',
      text: 'A-secret-1',
    );
    await PendingUploadQueue.instance.enqueue(
      idempotencyKey: 'k-a2',
      contentType: 'text',
      text: 'A-secret-2',
    );
    expect(await PendingUploadQueue.instance.length(), 2);

    // 登出：SessionCleanup.purgeAll（AuthProvider.logout 收敛路径）
    await SessionCleanup.purgeAll();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(userAKey), isNull, reason: 'A 的持久化队列必须被删除');

    // 用户 B：登录绑定
    await SessionCleanup.onUserSignedIn('userB');

    final uploaded = <String>[];
    PendingUploadQueue.instance.bindUploader((entry) async {
      uploaded.add(entry.text ?? '');
      return true;
    });

    expect(await PendingUploadQueue.instance.hasPending(), isFalse);
    final count = await PendingUploadQueue.instance.replayPending();
    expect(count, 0);
    expect(uploaded, isEmpty, reason: 'B 的重放管线不得出现 A 的任何条目');

    // B 自己的入队/重放仍然正常
    await PendingUploadQueue.instance.enqueue(
      idempotencyKey: 'k-b1',
      contentType: 'text',
      text: 'B-content',
    );
    expect(await PendingUploadQueue.instance.replayPending(), 1);
    expect(uploaded, ['B-content']);
    expect(prefs.getString(userBKey) ?? '', isNot(contains('A-secret')));
  });

  test('登出清理即使漏掉，命名空间隔离也能兜底（B 读不到 A 的键）', () async {
    // 模拟"清理遗漏"：A 的键仍在磁盘上（purgeAll 未执行）
    SharedPreferences.setMockInitialValues({
      userAKey: encodeEntry('A-secret-1'),
    });

    await PendingUploadQueue.instance.bindUser('userB');
    expect(await PendingUploadQueue.instance.hasPending(), isFalse);

    final uploaded = <String>[];
    PendingUploadQueue.instance.bindUploader((entry) async {
      uploaded.add(entry.text ?? '');
      return true;
    });
    await PendingUploadQueue.instance.replayPending();
    expect(uploaded, isEmpty);
  });

  test('CacheService 键按用户命名空间隔离', () async {
    final cache = CacheService.instance;
    cache.setUserScope('userA');
    await cache.set<String>(
      'user_profile',
      'A-profile',
      strategy: CacheStrategy.memoryOnly,
    );
    expect(
      await cache.get<String>(
        'user_profile',
        strategy: CacheStrategy.memoryOnly,
      ),
      'A-profile',
    );

    // 切换用户：内存缓存整体丢弃，旧 scope 数据不可见
    cache.setUserScope('userB');
    expect(
      await cache.get<String>(
        'user_profile',
        strategy: CacheStrategy.memoryOnly,
      ),
      isNull,
    );

    cache.setUserScope(null);
    expect(
      await cache.get<String>(
        'user_profile',
        strategy: CacheStrategy.memoryOnly,
      ),
      isNull,
    );
  });

  test('purgeAll 清空 CacheService 内存缓存并复位命名空间', () async {
    final cache = CacheService.instance;
    cache.setUserScope('userA');
    await cache.set<String>(
      'clipboard_list_page_1',
      'A-list',
      strategy: CacheStrategy.memoryOnly,
    );

    await SessionCleanup.purgeAll();

    expect(
      await cache.get<String>(
        'clipboard_list_page_1',
        strategy: CacheStrategy.memoryOnly,
      ),
      isNull,
    );
    // purgeAll 后 scope 复位为 anonymous：新写入不与 A 的旧键混用
    await cache.set<String>(
      'clipboard_list_page_1',
      'anon-list',
      strategy: CacheStrategy.memoryOnly,
    );
    expect(
      await cache.get<String>(
        'clipboard_list_page_1',
        strategy: CacheStrategy.memoryOnly,
      ),
      'anon-list',
    );
  });

  test('purgeAll 清除本地错误报告（含 userId）', () async {
    SharedPreferences.setMockInitialValues({
      'pending_error_reports': ['{"id":"e1","userId":"userA"}'],
    });
    await SessionCleanup.purgeAll();
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getStringList('pending_error_reports'), isNull);
  });
}
