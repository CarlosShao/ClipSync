import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * D1 存储层回归测试（local 后端）
 *
 * 防复发目标：`initStorage()` 此前全仓零调用点，设 STORAGE_TYPE=s3 时
 * s3Client 为 null，直到首次上传才崩。现 index.js 启动期显式调用
 * （启动即暴露配置错误），本文件锁定 local 后端的接口契约不变。
 *
 * S3/MinIO 路径的端到端验证需真实 MinIO，见交付说明中的实测记录
 * （write → read → merge → size → delete 全通过）。
 */

// local 后端在 import 时读取 UPLOAD_DIR，故必须先设环境再动态 import
const TMP_UPLOAD_DIR = path.join(os.tmpdir(), `clipsync-storage-test-${Date.now()}`);
process.env.UPLOAD_DIR = TMP_UPLOAD_DIR;

const {
  initStorage,
  writeChunk,
  readChunk,
  mergeChunks,
  deleteFile,
  getFileSize,
  getFilePath,
} = await import('../src/utils/storage.js');

describe('D1 存储层：local 后端接口契约', () => {
  it('initStorage() 可重复调用（幂等），创建上传目录', async () => {
    await initStorage();
    await initStorage(); // 不应抛错
    const stat = await fs.stat(TMP_UPLOAD_DIR);
    expect(stat.isDirectory()).toBe(true);
  });

  it('writeChunk → readChunk 往返一致', async () => {
    const uploadId = `t-${Date.now()}-a`;
    const payload = Buffer.from('chunk-payload-\u4e2d\u6587');
    await writeChunk(uploadId, 0, payload);
    const got = Buffer.from(await readChunk(uploadId, 0));
    expect(got.equals(payload)).toBe(true);
  });

  it('mergeChunks 按片序拼接并清理分片目录', async () => {
    const uploadId = `t-${Date.now()}-b`;
    const parts = [Buffer.from('AA'), Buffer.from('BB'), Buffer.from('CC')];
    for (let i = 0; i < parts.length; i++) await writeChunk(uploadId, i, parts[i]);

    const merged = await mergeChunks(uploadId, parts.length, 'x', '.bin');
    const content = await fs.readFile(merged);
    expect(content.toString()).toBe('AABBCC');

    // 分片目录应已清理
    const chunkDir = path.join(TMP_UPLOAD_DIR, 'chunks', uploadId);
    await expect(fs.access(chunkDir)).rejects.toThrow();
  });

  it('getFileSize 对存在/不存在文件分别返回真实大小与 0（不抛错）', async () => {
    const uploadId = `t-${Date.now()}-c`;
    await writeChunk(uploadId, 0, Buffer.from('12345'));
    const merged = await mergeChunks(uploadId, 1, 'y', '.bin');

    expect(await getFileSize(merged)).toBe(5);
    expect(await getFileSize(path.join(TMP_UPLOAD_DIR, 'nope.bin'))).toBe(0);
  });

  it('deleteFile 幂等：重复删除同一文件不抛错', async () => {
    const uploadId = `t-${Date.now()}-d`;
    await writeChunk(uploadId, 0, Buffer.from('z'));
    const merged = await mergeChunks(uploadId, 1, 'z', '.bin');

    await deleteFile(merged);
    await deleteFile(merged); // 第二次应被 try/catch 吞掉
    expect(await getFileSize(merged)).toBe(0);
  });

  it('getFilePath 返回 UPLOAD_DIR 下的绝对路径', async () => {
    const p = await getFilePath('abc.png');
    expect(p).toBe(path.join(TMP_UPLOAD_DIR, 'abc.png'));
  });
});
