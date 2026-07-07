<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <aside
    :class="cn(
      'flex h-full w-[220px] flex-col bg-sidebar text-sidebar-foreground',
      props.class,
    )"
  >
    <slot />
  </aside>
</template>
