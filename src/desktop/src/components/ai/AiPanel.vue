<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useAiChatUi } from '@/composables/useAiChatUi'

/**
 * AI 三栏 Shell 容器（UI-B）：Nav 会话栏 + Canvas 聊天主区 + Detail Inspector。
 * 纯布局组件，不承载业务/协议状态（数据与事件由插槽父级 AISidebar 编排）。
 *
 * 插槽契约：
 *   #nav     → AiNavRail（会话导航，形态由 useAiChatUi 驱动）
 *   #canvas  → 聊天主区（消息流 + Composer，UI-C 交付物挂载点）
 *   #detail  → AiInspector（Inspector 内容，UI-E 后续填充用量/缓存/子代理/记忆）
 *
 * 断点四档（视口媒体查询 + 面板容器查询双驱动，形态由 useAiChatUi.breakpoint 决定）：
 *   xl ≥1440 全三栏；lg 1100–1439 Inspector 浮层；md 820–1099 NavRail icon-rail；sm <820 NavRail 浮层。
 */
const { breakpoint, navOverlayOpen, setNavOverlayOpen, inspectorMode, inspectorOpen, closeInspector } = useAiChatUi()

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (navOverlayOpen.value) {
    setNavOverlayOpen(false)
  } else if (inspectorOpen.value && inspectorMode.value === 'overlay') {
    closeInspector()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="ai-shell" :data-bp="breakpoint">
    <!-- Nav：md 档保留 48px icon-rail 占位（浮层呼出时画布不跳动）；sm 档完全脱流 -->
    <div class="ai-shell-nav" :class="`ai-shell-nav--${breakpoint}`">
      <slot name="nav" />
    </div>

    <!-- Canvas：聊天主区（消息流 + Composer） -->
    <div class="ai-shell-canvas">
      <slot name="canvas" />
    </div>

    <!-- Detail：xl 行内栏；其余档位浮层（由 AiInspector 自行定位） -->
    <div v-if="inspectorOpen" class="ai-shell-detail" :class="`ai-shell-detail--${inspectorMode}`">
      <slot name="detail" />
    </div>

    <!-- 浮层遮罩：NavRail 浮层 / Inspector 浮层 -->
    <div
      v-if="navOverlayOpen || (inspectorOpen && inspectorMode === 'overlay')"
      class="ai-shell-mask"
      @click="
        () => {
          if (navOverlayOpen) setNavOverlayOpen(false)
          else closeInspector()
        }
      "
    />
  </div>
</template>

<style scoped>
/* 面板容器：设为查询容器，子区块（Nav 内容/Inspector）可用 @container 自适应 */
.ai-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  position: relative;
  overflow: hidden;
  container-type: inline-size;
  container-name: ai-shell;
  background: var(--bg-surface);
}

/* ---- Nav 占位 ---- */
.ai-shell-nav {
  flex: 0 0 auto;
  position: relative;
  min-width: 0;
}
.ai-shell-nav--md {
  /* icon-rail 固定占位：浮层呼出期间画布宽度不跳 */
  width: 48px;
}
.ai-shell-nav--sm {
  width: 0;
  overflow: visible;
}

/* ---- Canvas 主区 ---- */
.ai-shell-canvas {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface);
}

/* ---- Detail 占位 ---- */
.ai-shell-detail {
  flex: 0 0 auto;
  position: relative;
  min-width: 0;
}
.ai-shell-detail--overlay {
  width: 0;
  overflow: visible;
}

/* ---- 浮层遮罩 ---- */
.ai-shell-mask {
  position: absolute;
  inset: 0;
  z-index: var(--z-rail);
  background: rgba(0, 0, 0, 0.35);
  animation: ai-shell-mask-in 0.15s ease-out;
}

@keyframes ai-shell-mask-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* ---- 断点降级（媒体查询兜底；主形态由 data-bp + useAiChatUi 驱动） ---- */
@media (max-width: 1099px) {
  /* md 及以下：NavRail 降级 icon-rail（48px），Canvas 紧凑化 */
  .ai-shell-canvas {
    font-size: var(--text-base);
  }
}
@media (max-width: 819px) {
  /* sm：NavRail 脱流为浮层，Canvas 占满面板 */
  .ai-shell-canvas {
    padding-inline: 0;
  }
}

/* 尊重系统「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .ai-shell-mask {
    animation: none;
  }
}
</style>
