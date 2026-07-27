<script setup lang="ts">
import AuthPage from '@/components/auth/AuthPage.vue'
import { useConfigStore } from '@/stores/configStore'
import { ensureDeviceId } from '@/composables/clipboardUpload'
import { useRouter } from 'vue-router'
import { watch } from 'vue'

const configStore = useConfigStore()
const router = useRouter()

watch(
  () => configStore.isLoggedIn,
  async (val) => {
    if (val) {
      // 登录成功后立即准备 deviceId，避免断网时上传因缺少 deviceId 而无法入队。
      await ensureDeviceId().catch(() => null)
      router.push('/app/clipboard')
    }
  },
)
</script>

<template>
  <AuthPage />
</template>
