import {
  Banner,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Stack,
  Stat,
  Table,
  Text,
  Timeline,
} from 'qoder/canvas';

const tickets: Array<[string, string, string, string]> = [
  ['F0.1', '迁移 042 套餐阈值 + 新列 + 部分索引', '后端', 'PASS'],
  ['F0.2', 'planLimits 配额校验接入两上传入口，413 结构化', '后端', 'PASS'],
  ['F0.3', 'GET /api/storage/usage + current 补三字段', '后端', 'PASS'],
  ['F0.4', '桌面端阈值改后端下发，删三处硬编码', '桌面端', 'PASS'],
  ['F1.1', '文本文件统一落盘，content 不再存路径', '桌面端', 'PASS'],
  ['F1.2', 'media/file 多文件单条目 + 双字段兼容', '后端', 'PASS'],
  ['F1.3', 'download 支持 fileIndex 与流式 zip', '后端', 'PASS'],
  ['F1.4', '解除多文件 localOnly 限制', '桌面端', 'PASS'],
  ['F2.1', '移动端多文件列表 + 降级判定收窄', '移动端', 'PASS'],
  ['F2.2', '下载后打开与分享（open_filex / share_plus）', '移动端', 'PASS'],
  ['F2.3', '多文件打包下载（zip）', '移动端', 'PASS'],
  ['F3.1', '桌面端超限提示 + 升级引导 + 24h 节流', '桌面端', 'PASS'],
  ['F3.2', '移动端 limitReason 提示 + 套餐入口', '移动端', 'PASS'],
  ['F3.3', '文件保留期清理任务（含磁盘清扫）', '后端', 'PASS'],
  ['F4.x', 'Wave 4 端到端验证（API 级全覆盖）', '验证', 'PASS'],
];

const reviewFixes: Array<[string, string, string]> = [
  ['High', 'H1 保留期清理首轮即删存量条目', '基线宽限 + 跳过 fileEncoding=text + 首跑延迟 5 分钟'],
  ['High', 'H2 archiver 顶层 import 旧镜像启动崩溃', '改为 zip 分支内动态 import，失败降级 500'],
  ['Medium', 'M-1 下载正文流无超时导致永久卡死', '移动端 30s 停滞超时 + 半截文件清理'],
  ['Medium', 'M-2 localOnly 占位条目计入配额（幽灵用量）', '用量统计排除 localOnly=true'],
  ['Medium', 'M-3 白名单外代码扩展名预览退化为文件名', '扩充 tsx/jsx/vue/swift/kt 等 9 项'],
  ['Medium', 'M-1/M-2 桌面端单文件误提示、share/reveal 失效', 'files.length>1 条件 + metadata.paths 回退'],
  ['Low', 'CHUNK_DIR 忽略 UPLOAD_DIR / 兜底值矛盾 / zip 条目名净化 / 缓存竞态', '逐项修复并复验'],
];

export default function FileSyncV1CompletionReport() {
  return (
    <Stack gap={20}>
      <H1>ClipSync 跨设备文件同步 v1 — 交付报告</H1>
      <Text tone="secondary">
        方案：docs/plans/file-sync-v1-plan.md · 工单：docs/plans/file-sync-v1-tickets.md · 2026-09-02
      </Text>

      <Banner tone="success" title="交付结论：可交付">
        方案事实核查全部通过，15 张工单全部落地，Ultra Review 三个维度审查后修复 11 项发现，
        修复轮复验 7 大项全部 PASS、0 返工。
      </Banner>

      <Grid columns={4} gap={16}>
        <Stat value="6/6" label="差距 D1-D6 核实属实" tone="success" />
        <Stat value="15/15" label="工单完成" tone="success" />
        <Stat value="23" label="改动文件（+2581/-651）" />
        <Stat value="167" label="后端测试全绿（0 fail）" tone="success" />
      </Grid>

      <Divider />

      <H2>一、方案审核结论</H2>
      <Text>
        三位研究代理（简洁性 / 性能 / 风险视角）逐条核查方案事实论断：D1–D6 六个差距全部属实（含精确行号验证）；
        B6 解除——E2EE 为历史命名，不覆盖文件，移动端下载无需解密。
      </Text>
      <Table
        headers={['修正', '原方案', '采纳修正', '依据']}
        rows={[
          ['C1', 'contentEncrypted 改存结构化 JSON', '保持服务端落盘文件名，新语义走 metadata.files[]', '服务端 4 处消费方按文件名解析'],
          ['C2', 'metadata.textPreview 存 64KB 明文', '改写 content_preview 前 4KB + 复用 text-preview 端点', '列表接口 SELECT metadata 会膨胀'],
          ['C3', '迁移名 037', '迁移编号 042', '037 已被占用，最大编号 041'],
          ['C4', 'multer .array(files)', '.fields 双字段兼容 file+files', '旧桌面端发 file 字段否则全部 400'],
        ]}
      />
      <Text tone="secondary">用户拍板：阈值方案 B（Free 20MB/200MB/3个/3天 · Pro 128MB/20GB/10个/30天 · Ent 512MB/200GB/50个/90天）；容量校验、保留期清理、一条目N文件、打开+分享均按建议执行。</Text>

      <Divider />

      <H2>二、工单执行情况（15/15）</H2>
      <Table
        headers={['工单', '内容', '端', '结论']}
        rows={tickets.map(t => [t[0], t[1], t[2], t[3]])}
        rowTone={tickets.map(() => 'success' as const)}
      />

      <Divider />

      <H2>三、Ultra Review 修复轮</H2>
      <Text>
        三位审查代理按完整性 / 正确性 / 影响面独立审查：完整性达标、安全面干净（无注入、无路径穿越、无越权），
        影响面 8 项兼容承诺全部兑现；发现 2 High + 5 Medium + 若干 Low，已全部修复并复验。
      </Text>
      <Table
        headers={['级别', '发现', '修复']}
        rows={reviewFixes.map(f => [f[0], f[1], f[2]])}
        rowTone={reviewFixes.map(f => (f[0] === 'High' ? 'danger' as const : f[0] === 'Medium' ? 'warning' as const : undefined))}
      />

      <Divider />

      <H2>四、验证证据</H2>
      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader title="后端" />
          <CardBody>
            <Stack gap={8}>
              <Text>· node --check 全部改动文件通过</Text>
              <Text>· vitest 167 passed / 0 failed</Text>
              <Text>· docker 重启后 API 端到端全过：四组样本（小文本/小二进制/大文件分片/多文件混合）、413 三种 code、fileIndex 逐字节校验、zip 解包验证、存量条目零崩溃</Text>
              <Text>· 日志无 EISDIR / uncaughtException；测试数据零残留</Text>
            </Stack>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="桌面端 / 移动端" />
          <CardBody>
            <Stack gap={8}>
              <Text>· 桌面端 vue-tsc --noEmit 零错误 + vite build 成功</Text>
              <Text>· 三端契约交叉检查通过（上传字段、下载 URL、i18n 双语 key 成对）</Text>
              <Text>· 移动端 flutter analyze 0 error + flutter build apk --debug 成功</Text>
              <Text>· 修复轮复验 7 大项全 PASS（含 zip/tsx 预览/localOnly 配额/基线哨兵）</Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <H2>五、遗留项与人工验收</H2>
      <Callout tone="warning" title="需要人工完成">
        真机 GUI 联调（PC 复制 → 移动端点开/分享）无法由代理执行：请按 F4.1 四组样本（.md 小文本 / .png 小二进制 / 大于10MB 分片 / 3-5 个多文件）在模拟器验收。
      </Callout>
      <Stack gap={8}>
        <Text>· 部署需重建镜像（archiver 新依赖）：docker compose build && up -d --build</Text>
        <Text>· Free 单文件上限按方案 B 收紧为 20MB，旧客户端同样受限（用户拍板行为）</Text>
        <Text>· 已知小项不阻塞：WS 通知对多文件条目显示文本片段；chunked metadata 读改写并发窗口（已声明接受）；flutter analyze 29 条历史基线 warning</Text>
        <Text>· 保留期对存量的保护依赖 file_sync_meta 基线表，删除该表等同重置基线（方向安全）</Text>
      </Stack>

      <H3>执行时间线</H3>
      <Timeline
        events={[
          { time: 'Step 1', title: '事实核查', description: '3 个研究代理核查方案 D1-D6 与 E2EE 疑问，产出 4 处修正' },
          { time: 'Step 2', title: 'Wave 0 配额地基', description: '迁移 042 + planLimits + storage/usage + 桌面端阈值下发' },
          { time: 'Step 3', title: 'Wave 1 统一落盘', description: '多文件单条目 + fileIndex/zip 下载 + 桌面端文本落盘与兼容读' },
          { time: 'Step 4', title: 'Wave 2/3', description: '移动端接收/打开/分享 + 两端超限提示 + 保留期清理' },
          { time: 'Step 5', title: '验证与审查', description: '全量验证 + 三维 Ultra Review + 11 项修复 + 复验全 PASS' },
        ]}
      />
    </Stack>
  );
}
