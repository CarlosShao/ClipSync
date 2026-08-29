<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from '@/composables/useI18n'
import Button from '@/components/ui/button/Button.vue'
import { FileQuestion, ArrowLeft } from 'lucide-vue-next'

/**
 * NotFoundView — 404 兜底页（C8④）
 *
 * 覆盖两类入口：
 *   1. 未匹配任何路由的 URL（catch-all `/:pathMatch(.*)*`）
 *   2. `/app/<非法 sub>`：由 router 白名单校验重定向到本页，而不是渲染空白主页
 */
const props = withDefaults(defineProps<{ path?: string }>(), { path: '' })
const { tf } = useI18n()
const router = useRouter()

function goHome() {
  router.push('/app/clipboard')
}
</script>

<template>
  <div class="nf-wrap" role="main">
    <div class="nf-card">
      <FileQuestion :size="44" class="nf-icon" />
      <h1 class="nf-code">404</h1>
      <p class="nf-title">{{ tf('nf_title', '页面不存在') }}</p>
      <p class="nf-desc">
        {{ tf('nf_desc', '你访问的地址没有对应的页面，或者该功能已被移除。') }}
      </p>
      <p v-if="props.path" class="nf-path">{{ props.path }}</p>
      <Button class="nf-btn" @click="goHome">
        <ArrowLeft :size="14" />
        {{ tf('nf_back', '返回剪贴板') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.nf-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--bg-base);
  color: var(--text-primary);
}
.nf-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  padding: 32px 28px;
  text-align: center;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.nf-icon {
  color: var(--text-tertiary);
}
.nf-code {
  margin: 4px 0 0;
  font-size: 40px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.nf-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.nf-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.nf-path {
  margin: 0;
  max-width: 100%;
  padding: 4px 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  word-break: break-all;
}
.nf-btn {
  margin-top: 12px;
}
</style>
