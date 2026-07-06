<script setup lang="ts">
import AuthPage from '@/components/auth/AuthPage.vue'
import { useConfigStore } from '@/stores/configStore'
import { useRouter } from 'vue-router'
import { watch } from 'vue'

const configStore = useConfigStore()
const router = useRouter()

watch(() => configStore.isLoggedIn, (val) => {
  if (val) router.push('/app/clipboard')
})
</script>

<template>
  <AuthPage />
</template>
