import { ref, onUnmounted } from 'vue'
import { useConfigStore } from '@/stores/configStore'

type MessageHandler = (data: any) => void

const handlers: MessageHandler[] = []

export function useWebSocket() {
  const connected = ref(false)
  const lastMessage = ref<any>(null)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0

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
    }

    ws.onmessage = (event) => {
      let data: any
      try {
        data = JSON.parse(event.data)
      } catch {
        data = event.data
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
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

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
    if (ws) { ws.close(); ws = null }
    connected.value = false
  }

  onUnmounted(disconnect)

  return { connected, lastMessage, connect, disconnect, onMessage }
}
