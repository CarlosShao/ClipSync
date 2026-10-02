/**
 * SSRF 地址策略测试（v2：自托管优先）—— isPrivateIp / classifyUpstreamIp /
 * isBlockedUpstreamIp / checkUpstreamUrl / assertSafeUpstreamUrl / safeUpstreamFetch
 *
 * 背景演进：
 *  - 旧实现（P0-B 修复 2）把「私网/环回 IP」等同于「SSRF 攻击」。桌面端配置**本地聚合网关**
 *    （Base URL = http://127.0.0.1:3800/v1，one-api / vLLM / Ollama 这类）时被以
 *    「Base URL resolves to a blocked internal address」拒绝 —— 用户反馈：这是正当的自托管用法。
 *  - v2 策略（本文件钉住的契约）：
 *    ① 默认放行回环 / 私网 / IPv6 ULA（环回 127.0.0.0/8、::1、localhost；10/8、172.16/12、
 *       192.168/16；fc00::/7），开关 AI_ALLOW_LOCAL_BASE_URL 默认 true；
 *    ② **永不放开**（与开关无关的安全底线）：云元数据 / 链路本地 169.254.0.0/16
 *       （含 169.254.169.254）与 fe80::/10；组播 / 广播 / 保留 / 未指定段；
 *       非 http(s) 协议；带用户信息（user:pass@）、畸形 / 超长 URL；
 *    ③ DNS 重绑定防护不退化：主机名先解析、再对**每条**解析结果判定，解析失败 / 无记录
 *       fail-closed；建连期 guardedLookup 对 socket 实际 IP 再判一次；
 *    ④ 开关设 false 时恢复旧行为（一律禁止内网/环回）。
 *
 * 本文件全部离线：DNS 用 vi.mock 打桩或注入解析器，不发任何真实网络请求。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

const {
  isPrivateIp,
  classifyUpstreamIp,
  isLocalUpstreamIp,
  isBlockedUpstreamIp,
  allowLocalBaseUrl,
  checkUpstreamUrl,
  assertSafeUpstreamUrl,
  safeUpstreamFetch,
  UPSTREAM_URL_CODES,
} = await import('../src/utils/aiProviders.js')

beforeEach(() => {
  lookupMock.mockReset()
})

// 开关是环境变量读取的：任何用例结束后都必须还原，避免污染同进程内的其它测试文件
afterEach(() => {
  delete process.env.AI_ALLOW_LOCAL_BASE_URL
})

/** 断言"必定拒绝"并拿回错误对象（错误上带稳定 code / addressClass） */
async function rejectionOf(fn) {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to reject, but it resolved')
}

/** 注入式解析器：给主机名一个确定的解析结果，完全不依赖真实 DNS */
const resolvingTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('isPrivateIp — IPv4（既有分类语义保持不变）', () => {
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

describe('classifyUpstreamIp / isLocalUpstreamIp — 分类是分类，放行是放行', () => {
  it('本地可达类别（回环 / 私网 / ULA，含封装形态）', () => {
    const local = {
      '127.0.0.1': 'loopback',
      '127.1.2.3': 'loopback',
      '::1': 'loopback',
      '[::1]': 'loopback',
      '::ffff:127.0.0.1': 'loopback',
      '10.1.2.3': 'private',
      '172.16.0.1': 'private',
      '192.168.1.10': 'private',
      'fd12:3456::1': 'ula',
      'fc00::1': 'ula',
      '2002:0a00:0001::1': 'private', // 6to4 内嵌 10.0.0.1
    }
    for (const [ip, kind] of Object.entries(local)) {
      expect(classifyUpstreamIp(ip), ip).toBe(kind)
      expect(isLocalUpstreamIp(ip), ip).toBe(true)
    }
  })

  it('永不放开类别：链路本地/元数据、未指定、组播、广播、保留、CGNAT', () => {
    const alwaysBlocked = {
      '169.254.169.254': 'link-local',
      '169.254.0.1': 'link-local',
      'fe80::1': 'link-local',
      '[::ffff:a9fe:a9fe]': 'link-local',
      '0.0.0.0': 'unspecified',
      '::': 'unspecified',
      '224.0.0.1': 'multicast',
      'ff02::1': 'multicast',
      '255.255.255.255': 'broadcast',
      '240.0.0.1': 'reserved',
      '192.0.2.5': 'reserved',
      '100::1': 'reserved',
      '100.64.0.1': 'cgNAT',
      'garbage': 'invalid',
    }
    for (const [ip, kind] of Object.entries(alwaysBlocked)) {
      expect(classifyUpstreamIp(ip), ip).toBe(kind)
      expect(isBlockedUpstreamIp(ip), ip).toBe(true)
      // 即使显式放行本地地址，这些类别也必须仍然被禁
      expect(isBlockedUpstreamIp(ip, { allowLocal: true }), ip).toBe(true)
    }
    expect(isLocalUpstreamIp('169.254.169.254')).toBe(false)
  })

  it('公网地址永远放行（开关不影响）', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isBlockedUpstreamIp(ip, { allowLocal: false })).toBe(false)
      expect(isBlockedUpstreamIp(ip, { allowLocal: true })).toBe(false)
    }
  })

  it('本地地址的放行只由 allowLocal 决定', () => {
    expect(isBlockedUpstreamIp('127.0.0.1', { allowLocal: true })).toBe(false)
    expect(isBlockedUpstreamIp('127.0.0.1', { allowLocal: false })).toBe(true)
    expect(isBlockedUpstreamIp('192.168.1.10', { allowLocal: true })).toBe(false)
    expect(isBlockedUpstreamIp('192.168.1.10', { allowLocal: false })).toBe(true)
    expect(isBlockedUpstreamIp('fd12:3456::1', { allowLocal: false })).toBe(true)
  })
})

describe('allowLocalBaseUrl — AI_ALLOW_LOCAL_BASE_URL 开关（默认 true）', () => {
  it('未设置 / 空串 → true（自托管优先，默认放行本地网关）', () => {
    delete process.env.AI_ALLOW_LOCAL_BASE_URL
    expect(allowLocalBaseUrl()).toBe(true)
    process.env.AI_ALLOW_LOCAL_BASE_URL = ''
    expect(allowLocalBaseUrl()).toBe(true)
  })

  it('显式 false / 0 / no / off（大小写不敏感）→ false（恢复旧行为）', () => {
    for (const v of ['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', ' off ']) {
      process.env.AI_ALLOW_LOCAL_BASE_URL = v
      expect(allowLocalBaseUrl(), v).toBe(false)
    }
  })

  it('其它取值（true/1/yes/on/垃圾值）→ true', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', 'whatever']) {
      process.env.AI_ALLOW_LOCAL_BASE_URL = v
      expect(allowLocalBaseUrl(), v).toBe(true)
    }
  })
})

describe('checkUpstreamUrl — ① 默认放行自托管网关地址（回环 / 私网 / ULA / localhost）', () => {
  const localUrls = [
    'http://127.0.0.1:3800/v1', // 用户反馈里的本地聚合服务
    'http://127.0.0.1:11434/v1',
    'http://127.1.2.3:8000/v1',
    'http://localhost:11434/v1',
    'http://localhost/v1',
    'http://[::1]:8000/v1',
    'http://[::ffff:127.0.0.1]:8000/v1',
    'http://192.168.1.10:8000/v1',
    'http://10.0.0.5:8000/v1',
    'http://172.16.3.4:8000/v1',
    'http://[fd12:3456::1]:8000/v1',
    'https://192.168.1.10/v1',
  ]
  for (const u of localUrls) {
    it(`放行 ${u}`, async () => {
      await expect(checkUpstreamUrl(u)).resolves.toMatchObject({ ok: true })
      await expect(assertSafeUpstreamUrl(u)).resolves.toBeUndefined()
    })
  }

  it('公网地址（正向用例，防止把功能修死）', async () => {
    await expect(assertSafeUpstreamUrl('http://8.8.8.8/v1')).resolves.toBeUndefined()
    await expect(assertSafeUpstreamUrl('https://[2606:4700:4700::1111]/v1')).resolves.toBeUndefined()
  })
})

describe('checkUpstreamUrl — ② 仍然拒绝：云元数据 / 链路本地 / 组播 / 保留 / 未指定', () => {
  const blocked = [
    ['http://169.254.169.254/latest/meta-data', UPSTREAM_URL_CODES.blockedAddress, 'link-local'],
    ['http://169.254.0.1/', UPSTREAM_URL_CODES.blockedAddress, 'link-local'],
    ['http://[fe80::1]/', UPSTREAM_URL_CODES.blockedAddress, 'link-local'],
    ['http://[::ffff:a9fe:a9fe]/latest/meta-data/', UPSTREAM_URL_CODES.blockedAddress, 'link-local'],
    ['http://0.0.0.0:8000/v1', UPSTREAM_URL_CODES.blockedAddress, 'unspecified'],
    ['http://[::]/v1', UPSTREAM_URL_CODES.blockedAddress, 'unspecified'],
    ['http://224.0.0.1/', UPSTREAM_URL_CODES.blockedAddress, 'multicast'],
    ['http://255.255.255.255/', UPSTREAM_URL_CODES.blockedAddress, 'broadcast'],
    ['http://240.0.0.1/', UPSTREAM_URL_CODES.blockedAddress, 'reserved'],
    ['http://100.64.0.1/', UPSTREAM_URL_CODES.blockedAddress, 'cgNAT'],
    ['http://[2001:db8::1]/', UPSTREAM_URL_CODES.blockedAddress, 'reserved'],
  ]
  for (const [u, code, cls] of blocked) {
    it(`拒绝 ${u}（code=${code}, class=${cls}）`, async () => {
      const r = await checkUpstreamUrl(u)
      expect(r.ok).toBe(false)
      expect(r.code).toBe(code)
      expect(r.addressClass).toBe(cls)
      // 文案必须说清"哪一类地址被拒 + 怎么解决"，不能再是 blocked internal address 这种黑话
      expect(r.message).toMatch(/always blocked/i)
      expect(r.message).toMatch(/AI_ALLOW_LOCAL_BASE_URL/)
      const err = await rejectionOf(() => assertSafeUpstreamUrl(u))
      expect(err.code).toBe(code)
      expect(err.addressClass).toBe(cls)
    })
  }

  it('拒绝 169.254.169.254 的文案明确说明开关也救不了（含正确写法指引）', async () => {
    const r = await checkUpstreamUrl('http://169.254.169.254/latest/meta-data')
    expect(r.message).toMatch(/169\.254\.0\.0\/16/)
    expect(r.message).toMatch(/http:\/\/127\.0\.0\.1:3800\/v1/)
  })
})

describe('checkUpstreamUrl — ② 仍然拒绝：协议 / 用户信息 / 主机名 / 畸形 / 超长', () => {
  it('非 http(s) 协议 → scheme_not_allowed（file: / gopher: / ftp:）', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://127.0.0.1:3800/', 'ftp://8.8.8.8/']) {
      const r = await checkUpstreamUrl(u)
      expect(r.ok, u).toBe(false)
      expect(r.code, u).toBe(UPSTREAM_URL_CODES.scheme)
      expect(r.message).toBe('Base URL must use http or https')
    }
  })

  it('带用户信息（user:pass@）→ userinfo_not_allowed（即使目标是本地网关）', async () => {
    const r = await checkUpstreamUrl('http://user:pass@127.0.0.1:3800/v1')
    expect(r.ok).toBe(false)
    expect(r.code).toBe(UPSTREAM_URL_CODES.userinfo)
  })

  it('云元数据主机名与内网域名后缀 → host_not_allowed', async () => {
    for (const u of ['http://metadata.google.internal/', 'http://metadata/', 'http://foo.internal/', 'http://bar.local/', 'http://kube.svc/']) {
      const r = await checkUpstreamUrl(u)
      expect(r.ok, u).toBe(false)
      expect(r.code, u).toBe(UPSTREAM_URL_CODES.host)
    }
  })

  it('容器"宿主机"别名放行（否则我们给的排障建议自己就被拒了），但仍按解析结果判定', async () => {
    // host.docker.internal / host.containers.internal 虽然落在 .internal 后缀里，但必须允许解析：
    // 刷新失败提示让用户改成 http://host.docker.internal:<端口>/v1 —— 照做必须能生效。
    const aliases = ['host.docker.internal', 'gateway.docker.internal', 'host.containers.internal']
    for (const host of aliases) {
      const ok = await checkUpstreamUrl(`http://${host}:3800/v1`, { lookup: resolvingTo('192.168.65.254') })
      expect(ok.ok, host).toBe(true)
      expect(ok.addressClass, host).toBe('private')
      // 解析结果仍是私网 ⇒ 关掉本地放行时照样拒绝（别名不是免检通道）
      const strict = await checkUpstreamUrl(`http://${host}:3800/v1`, {
        allowLocal: false,
        lookup: resolvingTo('192.168.65.254'),
      })
      expect(strict.code, host).toBe(UPSTREAM_URL_CODES.localDisabled)
      // 解析到元数据地址时依旧拒绝
      const meta = await checkUpstreamUrl(`http://${host}:3800/v1`, { lookup: resolvingTo('169.254.169.254') })
      expect(meta.code, host).toBe(UPSTREAM_URL_CODES.blockedAddress)
    }
  })

  it('畸形 URL / 空串 → invalid', async () => {
    for (const u of ['not a url', 'http://', '://x', '']) {
      const r = await checkUpstreamUrl(u)
      expect(r.ok, u).toBe(false)
      expect(r.code, u).toBe(UPSTREAM_URL_CODES.invalid)
    }
  })

  it('超长 URL（>2048）→ too_long', async () => {
    const r = await checkUpstreamUrl(`http://127.0.0.1/${'a'.repeat(3000)}`)
    expect(r.ok).toBe(false)
    expect(r.code).toBe(UPSTREAM_URL_CODES.tooLong)
  })
})

describe('checkUpstreamUrl — ③ AI_ALLOW_LOCAL_BASE_URL=false 恢复旧行为', () => {
  const localUrls = ['http://127.0.0.1:3800/v1', 'http://192.168.1.10:8000/v1', 'http://localhost:11434/v1', 'http://[::1]:8000/v1']

  for (const u of localUrls) {
    it(`开关关闭后 ${u} 重新被拒（code=local_disabled）`, async () => {
      process.env.AI_ALLOW_LOCAL_BASE_URL = 'false'
      const r = await checkUpstreamUrl(u)
      expect(r.ok).toBe(false)
      expect(r.code).toBe(UPSTREAM_URL_CODES.localDisabled)
      // 可行动文案：说清"这是本地地址 + 把开关改回 true 即可"
      expect(r.message).toMatch(/local\/private address/i)
      expect(r.message).toMatch(/AI_ALLOW_LOCAL_BASE_URL=true/)
      const err = await rejectionOf(() => assertSafeUpstreamUrl(u))
      expect(err.code).toBe(UPSTREAM_URL_CODES.localDisabled)
    })
  }

  it('开关关闭不影响公网地址，也不影响"永远拒绝"的类别', async () => {
    process.env.AI_ALLOW_LOCAL_BASE_URL = 'false'
    await expect(assertSafeUpstreamUrl('http://8.8.8.8/v1')).resolves.toBeUndefined()
    const meta = await checkUpstreamUrl('http://169.254.169.254/')
    expect(meta.code).toBe(UPSTREAM_URL_CODES.blockedAddress)
  })

  it('检查器支持显式 allowLocal 覆盖（不依赖环境变量）', async () => {
    const r = await checkUpstreamUrl('http://127.0.0.1:3800/v1', { allowLocal: false })
    expect(r.code).toBe(UPSTREAM_URL_CODES.localDisabled)
    const r2 = await checkUpstreamUrl('http://169.254.169.254/', { allowLocal: true })
    expect(r2.code).toBe(UPSTREAM_URL_CODES.blockedAddress)
  })
})

describe('checkUpstreamUrl — ④ 主机名按解析结果判定（注入解析器，不依赖真实 DNS）', () => {
  it('解析到私网 → 默认放行；开关关闭 → 拒绝', async () => {
    const r = await checkUpstreamUrl('http://lan-gateway.example.test:8000/v1', {
      lookup: resolvingTo('192.168.1.10'),
    })
    expect(r.ok).toBe(true)
    expect(r.host).toBe('lan-gateway.example.test')

    const strict = await checkUpstreamUrl('http://lan-gateway.example.test:8000/v1', {
      allowLocal: false,
      lookup: resolvingTo('192.168.1.10'),
    })
    expect(strict.ok).toBe(false)
    expect(strict.code).toBe(UPSTREAM_URL_CODES.localDisabled)
  })

  it('解析到环回（域名 A 记录指向 127.0.0.1）→ 默认放行', async () => {
    const r = await checkUpstreamUrl('http://my-domain.example.test:9090/', { lookup: resolvingTo('127.0.0.1') })
    expect(r.ok).toBe(true)
    expect(r.addressClass).toBe('loopback')
  })

  it('多地址只要有一条落在永禁类别 → 整条拒绝（DNS rebinding 防护）', async () => {
    const r = await checkUpstreamUrl('http://rebind.example.test/v1', {
      lookup: resolvingTo('93.184.216.34', '169.254.169.254'),
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(UPSTREAM_URL_CODES.blockedAddress)
    expect(r.address).toBe('169.254.169.254')

    // 私网 + 元数据混合：即使开关开着也必须拒绝（放行内网不等于放行元数据）
    const mixed = await checkUpstreamUrl('http://rebind2.example.test/v1', {
      allowLocal: true,
      lookup: resolvingTo('10.0.0.5', '169.254.169.254'),
    })
    expect(mixed.ok).toBe(false)
    expect(mixed.code).toBe(UPSTREAM_URL_CODES.blockedAddress)
  })

  it('解析失败 / 无记录 → fail-closed（unresolved）', async () => {
    const failing = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    const r = await checkUpstreamUrl('https://no-such-host.example/', { lookup: failing })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(UPSTREAM_URL_CODES.unresolved)
    expect(r.message).toMatch(/cannot be resolved/)

    const empty = await checkUpstreamUrl('https://empty.example/', { lookup: async () => [] })
    expect(empty.code).toBe(UPSTREAM_URL_CODES.unresolved)
  })

  it('默认解析器走 node:dns（vitest 里已打桩，验证链路而非真实 DNS）', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }])
    const r = await checkUpstreamUrl('https://stubbed.example/v1')
    expect(r.ok).toBe(true)
    expect(lookupMock).toHaveBeenCalled()

    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }])
    const r2 = await checkUpstreamUrl('https://stubbed2.example/v1')
    expect(r2.code).toBe(UPSTREAM_URL_CODES.blockedAddress)

    lookupMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
    const r3 = await checkUpstreamUrl('https://stubbed3.example/v1')
    expect(r3.code).toBe(UPSTREAM_URL_CODES.unresolved)
  })
})

describe('safeUpstreamFetch — 出站门禁与判定同源', () => {
  it('永禁地址在建立连接前即被拒绝（不触网、不查 DNS）', async () => {
    for (const u of ['http://169.254.169.254/', 'http://[fe80::1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://0.0.0.0/']) {
      await expect(safeUpstreamFetch(u), u).rejects.toThrow(/always blocked/i)
    }
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('开关关闭时本地地址同样在建立连接前被拒绝', async () => {
    process.env.AI_ALLOW_LOCAL_BASE_URL = 'false'
    await expect(safeUpstreamFetch('http://127.0.0.1:3800/v1')).rejects.toThrow(/AI_ALLOW_LOCAL_BASE_URL=true/)
  })

  it('主机名在 DNS 阶段解析到元数据 → 拒绝且不发起连接', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    await expect(safeUpstreamFetch('https://rebind.example.com/v1')).rejects.toThrow(/always blocked/i)
  })
})
