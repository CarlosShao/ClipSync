<script setup lang="ts">
/**
 * 收藏**网格卡片**的内容区 + 底部信息行（这一块是"排版不整齐"与"受保护卡片太丑"的落点）。
 *
 * 设计要点（用户反馈驱动）：
 *  ① 底栏贴底：`.fav-card-meta` 用 `margin-top: auto` 顶到卡片底部 ⇒ 同排卡片的时间行**严格对齐**；
 *  ② 预览统一行数：正文/掩码都走 `.fav-card-text`（clamp 3 行）⇒ 长短内容占位一致；
 *  ③ 受保护内容 = **密码掩码黑点**（`•`，2~3 行、与普通预览同字号/行高），**不再**用通栏灰块 + 锁图标；
 *     真实内容**绝不进 DOM**（受保护时父组件传空串，这里也只渲染固定掩码）；
 *  ④ 状态小字「已保护」与纯文字「解锁」按钮都在**底栏**里：解锁按钮默认 `opacity:0`（不占常驻视觉），
 *     卡片 hover 或键盘 focus-within 时出现（≤150ms，尊重减少动效）。
 *
 * 业务不动：解锁仍由父组件的事件（`openProtectionDialog`）处理，本组件只 `emit('unlock')`。
 */
import { Image as ImageIcon, FileText } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'

const props = defineProps<{
  type: string
  /** 受保护且未解锁：只渲染掩码，不渲染任何真实内容 */
  locked: boolean
  /** 可见正文（受保护时父组件传空串） */
  contentText: string
  /** 图片预览 URL（type=image） */
  preview?: string
  /** 是否按链接排版（type=link 或内容像 URL） */
  isLink?: boolean
  /** 链接域名 */
  domain?: string
  /** 是否按文件排版（type=file） */
  isFile?: boolean
  source: string
  timeText: string
  /** 解锁按钮的 tooltip（沿用父组件的 getProtectionTitle ⇒ 文案仍走 i18n） */
  unlockTitle?: string
}>()

const emit = defineEmits<{ unlock: [] }>()
const { t } = useI18n()

/** 固定掩码（密码黑点）：不与真实内容长度相关，避免泄漏长度信息 */
const MASK_DOTS = '•'.repeat(48)
</script>

<template>
  <div class="fav-card-body" :class="{ 'fav-card-body--media': props.type === 'image' }">
    <template v-if="props.locked">
      <!-- 受保护：密码掩码黑点（同字号/行高 ⇒ 高度与普通卡接近；不含任何真实内容） -->
      <div class="fav-card-text fav-card-mask" data-protected-mask aria-hidden="true">{{ MASK_DOTS }}</div>
    </template>
    <template v-else-if="props.type === 'image'">
      <img v-if="props.preview && props.preview !== 'loading'" :src="props.preview" alt="" class="fav-card-media-img" />
      <div v-else class="fav-card-placeholder"><ImageIcon :size="22" /></div>
    </template>
    <div v-else-if="props.isLink" class="fav-card-text fav-card-link">
      <span class="fav-card-link-url">{{ props.contentText }}</span>
      <span class="fav-card-link-domain">{{ props.domain }}</span>
    </div>
    <div v-else-if="props.isFile || props.type === 'file'" class="fav-card-text fav-card-file">
      <FileText :size="16" /><span>{{ props.contentText }}</span>
    </div>
    <div v-else class="fav-card-text">{{ props.contentText }}</div>
  </div>

  <!-- 底部信息行：来源 / 状态小字 / 解锁（hover·focus 才出现）/ 时间（贴底对齐） -->
  <div class="fav-card-meta">
    <span class="fav-card-source">{{ props.source }}</span>
    <template v-if="props.locked">
      <span class="fav-card-protected-note" data-protected-note>{{ t('fav_protected_note', '已保护') }}</span>
      <button type="button" class="fav-card-unlock" data-unlock :title="props.unlockTitle" @click.stop="emit('unlock')">
        {{ t('item_unlock', '解锁') }}
      </button>
    </template>
    <span class="fav-card-time">{{ props.timeText }}</span>
  </div>
</template>
