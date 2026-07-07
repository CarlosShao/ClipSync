<script setup lang="ts">
import { computed } from 'vue'
import { Primitive, type PrimitiveProps } from 'reka-ui'
import { cn } from '@/lib/utils'

interface Props extends PrimitiveProps {
  isActive?: boolean
  tooltip?: string
  class?: any
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button',
})

const delegatedProps = computed(() => {
  const { class: _, isActive, tooltip, ...delegated } = props
  return delegated
})
</script>

<template>
  <Primitive
    v-bind="delegatedProps"
    :data-active="isActive ? 'true' : undefined"
    :title="tooltip"
    :class="cn(
      'group/sidebar-menu-button flex w-full items-center gap-2 overflow-hidden rounded-md px-2.5 py-2 text-left text-sm font-medium text-sidebar-foreground outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0',
      isActive && 'bg-sidebar-primary text-sidebar-primary-foreground',
      props.class,
    )"
  >
    <slot />
  </Primitive>
</template>
