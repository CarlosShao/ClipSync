<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'secondary' | 'destructive' | 'outline'
    class?: HTMLAttributes['class']
  }>(),
  {
    variant: 'default',
  },
)

const badgeVariants: Record<NonNullable<typeof props.variant>, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
  outline: 'border-border text-foreground',
}
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        badgeVariants[props.variant],
        props.class,
      )
    "
  >
    <slot />
  </span>
</template>
