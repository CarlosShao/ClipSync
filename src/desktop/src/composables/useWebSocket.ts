import { ref, onUnmounted } from 'vue'
import { useConfigStore } from '@/stores/configStore'

type MessageHandler = (data: any) => void

const handlers: MessageHandler[] = []

// Heartbeat config — must stay below the server's 30s heartbeatInterval
// and above the server's 5s heartbeatTimeout.
const PING_INTERVAL = 25_000   // send ping every 25s
const PONG_TIMEOUT  = 35_000   // expect pong within 35s of last ping; force reconnect otherwise

export function useWebSocket() {
  const connected = ref(false)
  const lastMessage = ref<any>(null)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0

  // --- Heartbeat state ---
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  let lastPongAt = 0

  function connect() {
    const config = useConfigStore()
    if (!config.config.token) return

    const url = config.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(config.config.token || '')

    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connected.value = true
      reconnectAttempts = 0
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

      lastMessage.value = data
      // 通知所有注册的处理器
      handlers.forEach(h => {
        try { h(data) } catch (e) { console.warn('[WS] Handler error:', e) }
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
        } catch { /* send failure will trigger onclose */ }
      }
    }, PING_INTERVAL)
  }

  function stopHeartbeat() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    stopHeartbeat()
    if (ws) { ws.close(); ws = null }
    connected.value = false
  }

  onUnmounted(disconnect)

  return { connected, lastMessage, connect, disconnect, onMessage }
}
