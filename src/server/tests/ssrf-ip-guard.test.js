/**
 * P0-B 修复 2：SSRF 防护单元测试（isPrivateIp / assertSafeUpstreamUrl / safeUpstreamFetch）
 *
 * 背景：旧实现对带方括号的 IPv6 字面量（[::1]、[::ffff:a9fe:a9fe]）恒判"非内网"而放行，
 * 且 DNS 解析失败与内网判定 throw 混在同一 catch 里被吞掉（fail-open）。
 * 本文件全部离线：DNS 用 vi.mock 打桩，不发真实外网请求。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const lookupMock = vi.fn()
vi.mock('node:dns', async () => {
  const actual = await vi.importActual('node:dns')
  return {
    ...actual,
    default: {
      ...actual.default,
      promises: { ...actual.default.promises, lookup: (...a) => lookupMock(...a) },
      lookup: (...a) => lookupMock(...a),
    },
    promises: { ...actual.promises, lookup: (...a) => lookupMock(...a) },
  }
})

const { isPrivateIp, assertSafeUpstreamUrl, safeUpstreamFetch } = await import('../src/utils/aiProviders.js')

beforeEach(() => {
  lookupMock.mockReset()
})

describe('isPrivateIp — IPv4', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', // loopback 127/8
    '10.0.0.1', '10.255.255.255', // 10/8
    '172.16.0.1', '172.31.255.255', // 172.16/12
    '192.168.0.1', '192.168.255.255', // 192.168/16
    '169.254.169.254', '169.254.0.1', // link-local（云元数据）
    '0.0.0.0', '0.1.2.3', // 0/8
    '100.64.0.1', '100.127.255.255', // 100.64/10 CGNAT
    '224.0.0.1', '239.255.255.255', // 224/4 组播
    '240.0.0.1', '255.255.255.255', // 保留 + 广播
  ]
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true))
  }
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1', '100.128.0.1', '192.169.0.1', '11.0.0.1']
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => expect(isPrivateIp(ip)).toBe(false))
  }
})

describe('isPrivateIp — IPv6（含方括号 / 缩写 / 映射形态）', () => {
  const blocked = [
    '[::1]', '::1', // 环回（方括号形态是旧实现被绕过的根因）
    '[::]', '::', // 未指定
    '[::ffff:a9fe:a9fe]', '::ffff:a9fe:a9fe', // IPv4-mapped = 169.254.169.254
    '[::ffff:127.0.0.1]', '::ffff:127.0.0.1', // IPv4-mapped 点分形态
    '::ffff:10.0.0.1',
    '::127.0.0.1', // IPv4-compatible（废弃段，一律拒绝）
    'fe80::1', '[fe80::1]', 'febf:ffff::1', // fe80::/10 link-local
    'fc00::1', 'fd12:3456::1', // fc00::/7 ULA
    'ff02::1', // 组播
    'fe80::1%eth0', // 带 zone
    '2002:7f00:0001::1', // 6to4 内嵌 127.0.0.1
    '2001:0000:4136:e378:8000:63bf:3fff:fdd1', // Teredo（内嵌地址按 v4 规则）
    '100::1', // discard-only
    '2001:db8::1', // 文档段
  ]
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true))
  }
  const allowed = [
    '[2606:4700:4700::1111]', '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '[::ffff:8.8.8.8]', // IPv4-mapped 公网
    'fec0::1', // 不在 fe80::/10 内（旧实现 startsWith 误判形态的反例）
    '2002:0808:0808::1', // 6to4 内嵌 8.8.8.8（公网）
  ]
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => expect(isPrivateIp(ip)).toBe(false))
  }
  it('fail-closed：非 IP 字面量 / 空值 / 垃圾输入一律视为被禁', () => {
    expect(isPrivateIp('localhost')).toBe(true)
    expect(isPrivateIp('not-an-ip')).toBe(true)
    expect(isPrivateIp('')).toBe(true)
    expect(isPrivateIp(null)).toBe(true)
    expect(isPrivateIp(undefined)).toBe(true)
    expect(isPrivateIp('999.1.1.1')).toBe(true)
  })
})

describe('assertSafeUpstreamUrl', () => {
  const blockedUrls = [
    'http://[::1]:8080/x',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:6379/',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://localhost:3000/',
    'http://metadata.google.internal/',
    'http://foo.internal/', 'http://bar.local/', 'http://kube.svc/',
    'ftp://8.8.8.8/', 'file:///etc/passwd',
  ]
  for (const u of blockedUrls) {
    it(`rejects ${u}`, async () => {
      await expect(assertSafeUpstreamUrl(u)).rejects.toThrow()
    })
  }

  it('放行公网 IP 字面量（正向用例，防止把功能修死）', async () => {
    await expect(assertSafeUpstreamUrl('http://8.8.8.8/v1')).resolves.toBeUndefined()
    await expect(assertSafeUpstreamUrl('https://[2606:4700:4700::1111]/v1')).resolves.toBeUndefined()
  })

  it('主机名解析为内网地址 → 拒绝（多地址逐一校验）', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])
    await expect(assertSafeUpstreamUrl('https://evil.example.com/')).rejects.toThrow(/blocked internal/)
  })

  it('主机名解析为公网地址 → 放行', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(assertSafeUpstreamUrl('https://api.example.com/v1')).resolves.toBeUndefined()
  })

  it('DNS 解析失败 → fail-closed 拒绝（旧实现此处放行交给 fetch）', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
    await expect(assertSafeUpstreamUrl('https://no-such-host.example/')).rejects.toThrow(/cannot be resolved/)
  })

  it('DNS 解析结果为空 → fail-closed 拒绝', async () => {
    lookupMock.mockResolvedValue([])
    await expect(assertSafeUpstreamUrl('https://empty.example/')).rejects.toThrow(/cannot be resolved/)
  })
})

describe('safeUpstreamFetch', () => {
  it('内网 IP 字面量在建立连接前即被拒绝（不触网）', async () => {
    await expect(safeUpstreamFetch('http://[::1]:9/')).rejects.toThrow(/blocked internal/)
    await expect(safeUpstreamFetch('http://169.254.169.254/')).rejects.toThrow(/blocked internal/)
    await expect(safeUpstreamFetch('http://[::ffff:a9fe:a9fe]/')).rejects.toThrow(/blocked internal/)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('主机名在 DNS 阶段解析到内网 → 拒绝且不发起连接', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.8', family: 4 }])
    await expect(safeUpstreamFetch('https://rebind.example.com/v1')).rejects.toThrow(/blocked internal/)
  })
})
