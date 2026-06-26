import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

// GET /api/app/version - 返回当前版本信息
router.get('/version', (req, res) => {
  try {
    const packagePath = path.resolve('package.json');
    const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    
    res.json({
      version: packageData.version || '0.1.0',
      name: packageData.name || 'clipsync-server',
      description: packageData.description || '',
      releaseDate: '2026-06-24',
      notes: 'Bug fixes and performance improvements',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read version info' });
  }
});

// GET /api/app/update.json - Tauri updater 需要的更新元数据
router.get('/update.json', (req, res) => {
  const currentVersion = '0.1.0';
  const latestVersion = '0.1.0'; // 生产环境中从配置或数据库读取
  
  // 当前没有新版本
  const hasUpdate = false;
    
  if (!hasUpdate) {
    return res.json({
      version: currentVersion,
      notes: 'No update available',
      pubDate: new Date().toISOString(),
    });
  }
    
  // 有新版本时返回下载信息
  res.json({
    version: latestVersion,
    notes: 'New version available with bug fixes and performance improvements',
    pubDate: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        url: `https://example.com/downloads/clipsync_${latestVersion}_x64_en-US.msi`,
      },
    },
  });
});

export default router;
