<!-- ClipSync 品牌标识（唯一出处）：直接用应用图标 src/assets/logo.png ——
     与任务栏/窗口图标同源（来自 src-tauri/icons/128x128.png），避免"应用内一个 logo、
     任务栏另一个 logo"。此前应用内有三种不一致的标记：标题栏用 lucide ClipboardList 图标、
     侧边栏另一个标记、登录页用字母「C」方块。 -->
<script setup lang="ts">
import logo from '@/assets/logo.png'

withDefaults(defineProps<{ size?: number }>(), { size: 20 })
</script>

<template>
  <img :src="logo" :width="size" :height="size" class="app-logo" :alt="''" aria-hidden="true" />
</template>

<style scoped>
.app-logo {
  display: block;
  flex: none;
  border-radius: 22%;
  object-fit: contain;
}
</style>
