import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import { initErrorCapture } from './utils/errorReport'
import { initPerfMonitor } from './utils/perfMonitor'
import './styles/globals.css'
import './styles/sonner-theme.css'
import 'vue-sonner/style.css'

// Capture uncaught errors before Vue mounts
initErrorCapture()
initPerfMonitor()

console.log('[BOOT] 0 modules loaded')
const app = createApp(App)
console.log('[BOOT] 1 createApp')
app.use(createPinia())
console.log('[BOOT] 2 pinia')
app.use(router)
console.log('[BOOT] 3 router')
app.mount('#app')
console.log('[BOOT] 4 mounted')
