import { ref, onUnmounted } from 'vue'
import { useConfigStore } from '@/stores/configStore'

type MessageHandler = (data: any) => void

const handlers: MessageHandler[] = []

// Heartbeat config — must stay below the server's 30s heartbeatInterval
// and above the server's 5s heartbeatTimeout.
const PING_INTERVAL = 25_000 // send ping every 25s
const PONG_TIMEOUT = 35_000 // expect pong within 35s of last ping; force reconnect otherwise

export function useWebSocket() {
  const connected = ref(false)
  const registered = ref(false)
  const lastMessage = ref<any>(null)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0

  // --- Heartbeat state ---
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  let lastPongAt = 0

  // 后端拒绝 register（Device not found，常见于换账号后本地缓存 deviceId 失效）时，
  // 清掉缓存并重新拉取，然后断开触发重连，用新 deviceId 重新注册。
  async function recoverDeviceId(): Promise<string | null> {
    try {
      localStorage.removeItem('clipsync-device-id')
      const { ensureDeviceId } = await import('./clipboardUpload')
      return await ensureDeviceId()
    } catch {
      return null
    }
  }

  // 生产环境后端强制 WS 握手携带一次性 csrf_token（64 hex，Redis 校验后即焚）。
  // 获取失败时静默降级：dev 无需 csrf 可直连；生产下后端会拒绝本次连接，走重连再取。
  async function fetchWsCsrf(): Promise<string> {
    try {
      const config = useConfigStore()
      const res = await fetch(config.serverUrl + '/api/ws/csrf-token', {
        headers: { Authorization: 'Bearer ' + (config.config.token || '') },
      })
      if (res.ok) {
        const data = await res.json()
        return typeof data?.csrfToken === 'string' ? data.csrfToken : ''
      }
    } catch {
      /* 降级继续 */
    }
    return ''
  }

  async function connect() {
    const config = useConfigStore()
    if (!config.config.token) return

    let url = config.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(config.config.token || '')
    const csrf = await fetchWsCsrf()
    if (csrf) url += '&csrf_token=' + encodeURIComponent(csrf)

    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connected.value = true
      registered.value = false
      reconnectAttempts = 0
      // 必须先注册设备：后端仅对已注册连接定向广播（10 秒未注册即被踢 4005）
      const deviceId = localStorage.getItem('clipsync-device-id')
      if (deviceId) {
        try {
          ws?.send(JSON.stringify({ type: 'register', deviceId }))
        } catch {
          /* send failure will trigger onclose */
        }
      } else {
        console.warn('[WS] No cached deviceId; register skipped')
      }
      startHeartbeat()
    }

    ws.onmessage = (event) => {
      let data: any
      try {
        data = JSON.parse(event.data)
      } catch {
        data = event.data
      }

      // Application-level pong — reset the missed-pong watchdog
      if (data?.type === 'pong') {
        lastPongAt = Date.now()
        resetPongWatchdog()
      }

      // Register confirmed by server — connection is now in the broadcast table
      if (data?.type === 'registered') {
        registered.value = true
        console.info('[WS] Device registered:', data.deviceId)
      }

      // Cached deviceId invalid (e.g. account switched) — refresh it and reconnect
      if (data?.type === 'error' && typeof data?.message === 'string' && data.message.includes('Device not found')) {
        console.warn('[WS] Device not found — refreshing deviceId and reconnecting')
        recoverDeviceId().finally(() => {
          ws?.close()
        })
        return
      }

      lastMessage.value = data
      // 通知所有注册的处理器
      handlers.forEach((h) => {
        try {
          h(data)
        } catch (e) {
          console.warn('[WS] Handler error:', e)
        }
      })
    }

    ws.onclose = () => {
      connected.value = false
      ws = null
      stopHeartbeat()
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  // ── Heartbeat: send application-level ping + watchdog for missed pongs ──

  function startHeartbeat() {
    stopHeartbeat()
    lastPongAt = Date.now()
    resetPongWatchdog()

    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }))
        } catch {
          /* send failure will trigger onclose */
        }
      }
    }, PING_INTERVAL)
  }

  function stopHeartbeat() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (pongTimer) {
      clearTimeout(pongTimer)
      pongTimer = null
    }
  }

  /// If no pong arrives within PONG_TIMEOUT of the last ping, the connection
  /// is considered dead (proxy/firewall killed it, sleep/wake, etc.).
  /// Force-close triggers the onclose → reconnect path.
  function resetPongWatchdog() {
    if (pongTimer) clearTimeout(pongTimer)
    pongTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.warn('[WS] Pong timeout — forcing reconnect')
        ws.close()
      }
    }, PONG_TIMEOUT)
  }

  // ── Reconnection with exponential backoff ──

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function onMessage(handler: MessageHandler) {
    handlers.push(handler)
    return () => {
      const idx = handlers.indexOf(handler)
      if (idx >= 0) handlers.splice(idx, 1)
    }
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stopHeartbeat()
    if (ws) {
      ws.close()
      ws = null
    }
    connected.value = false
    registered.value = false
  }

  onUnmounted(disconnect)

  return { connected, registered, lastMessage, connect, disconnect, onMessage }
}
