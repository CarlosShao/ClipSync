// =============================================
// 启动前清理 dev server 端口残留（黑屏防线）
// 背景：tauri dev 的 beforeDevCommand 会拉起 vite（strictPort:1420）。
// 若上次 dev 进程未干净退出（残留 vite/tauri 子进程占住 1420），
// vite 启动失败 → "Port is already in use" → beforeDevCommand 仍返回非零
// 但 taauri 的 exe 照常启动 → 窗口加载不到页面 → 纯黑屏。
// 本脚本在 dev 前强制释放 1420，从根上消除该黑屏路径。
// 仅杀监听 1420 的进程，避免误杀其它服务。
// =============================================
import { execSync } from 'child_process'
import os from 'os'

const PORT = 1420
const isWin = os.platform() === 'win32'

function listListeningPids() {
  if (isWin) {
    try {
      // 匹配 :1420 的 LISTENING 行，取最后一列 PID
      const out = execSync('netstat -ano | findstr :1420', { encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split(/\r?\n/)) {
        if (/LISTENING/i.test(line) && /:1420\b/.test(line)) {
          const pid = line.trim().split(/\s+/).pop()
          if (pid && /^\d+$/.test(pid)) pids.add(Number(pid))
        }
      }
      return [...pids]
    } catch { return [] }
  }
  // macOS/Linux: lsof -iTCP:1420
  try {
    const out = execSync(`lsof -ti tcp:${PORT} 2>/dev/null`, { encoding: 'utf8' })
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  } catch { return [] }
}

function killPid(pid) {
  try {
    if (isWin) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
  } catch { /* 已退出或权限不足，忽略 */ }
}

function main() {
  const pids = listListeningPids()
  if (pids.length === 0) {
    console.log(`[dev-clean] port ${PORT} free, nothing to clean`)
    return
  }
  for (const pid of pids) {
    console.log(`[dev-clean] releasing port ${PORT} (PID ${pid})`)
    killPid(pid)
  }
  // 等端口真正释放
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (listListeningPids().length === 0) {
      console.log(`[dev-clean] port ${PORT} released`)
      return
    }
    execSync(isWin ? 'ping -n 1 127.0.0.1 >NUL' : 'sleep 0.2', { stdio: 'ignore' })
  }
  console.warn(`[dev-clean] WARN: port ${PORT} still occupied`)
}

// 直接运行本脚本时清理端口（import 时作为模块导出不执行）
const isDirectRun =
  process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('scripts/dev-clean-port.mjs')
if (isDirectRun) main()

export { listListeningPids, killPid }