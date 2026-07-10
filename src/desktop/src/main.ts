import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import { initErrorCapture } from './utils/errorReport'
import { initPerfMonitor } from './utils/perfMonitor'
import './styles/globals.css'

// Capture uncaught errors before Vue mounts
initErrorCapture()
initPerfMonitor()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
