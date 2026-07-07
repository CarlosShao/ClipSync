<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { Primitive, type PrimitiveProps } from 'reka-ui'
import { cn } from '@/lib/utils'

interface Props extends PrimitiveProps {
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  as: 'tbody',
})

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <Primitive
    v-bind="delegatedProps"
    :class="cn('[&_tr:last-child]:border-0', props.class)"
  >
    <slot />
  </Primitive>
</template>
