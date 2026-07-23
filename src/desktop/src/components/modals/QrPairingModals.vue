<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSonner } from '@/composables/useSonner'
import { useConfigStore } from '@/stores/configStore'
import { useDevice } from '@/composables/useDevice'
import { initPairing, redeemPairing } from '@/api/device'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import './modal-shared.css'

const props = defineProps<{ showModalType: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const toast = useSonner()
const configStore = useConfigStore()
const device = useDevice()

// --- 生成配对码（本机已登录设备）---
const pairingToken = ref('')
const pairingQr = ref('')
const pairingRemaining = ref(0)
let expireTimer: number | undefined

function detectPlatform(): string {
  if (/Mac/i.test(navigator.userAgent)) return 'macos'
  if (/Linux/i.test(navigator.userAgent)) return 'linux'
  return 'windows'
}

async function generatePairing() {
  try {
    const res = await initPairing()
    if (res.ok && res.data) {
      pairingToken.value = res.data.token
      pairingRemaining.value = Math.max(0, Math.ceil((res.data.expiresAt - Date.now()) / 1000))
      pairingQr.value = await (QRCode as any).toDataURL(`clipsync://pair?token=${res.data.token}`, {
        width: 220,
        margin: 1,
      })
      if (expireTimer) clearInterval(expireTimer)
      expireTimer = window.setInterval(() => {
        pairingRemaining.value -= 1
        if (pairingRemaining.value <= 0 && expireTimer) {
          clearInterval(expireTimer)
          expireTimer = undefined
          pairingQr.value = ''
        }
      }, 1000)
    } else {
      toast.show(res.error || t('pair_generate_fail'), 'error')
    }
  } catch (e: any) {
    toast.show(t('pair_generate_fail') + String(e), 'error')
  }
}

function copyPairingToken() {
  if (!pairingToken.value) return
  navigator.clipboard
    .writeText(pairingToken.value)
    .then(() => toast.show(t('pair_copy_done'), 'success'))
    .catch(() => toast.show(t('pair_copy_fail'), 'error'))
}

// --- 扫描/兑换配对码（扫码设备）---
const videoEl = ref<HTMLVideoElement | null>(null)
const scanning = ref(false)
const manualToken = ref('')
const redeemSending = ref(false)
let mediaStream: MediaStream | null = null
let rafId = 0

function stopScan() {
  scanning.value = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  if (mediaStream) {
    mediaStream.getTracks().forEach((tr) => tr.stop())
    mediaStream = null
  }
  if (videoEl.value) videoEl.value.srcObject = null
}

async function startScan() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream
      await videoEl.value.play()
    }
    scanning.value = true
    scanLoop()
  } catch (e: any) {
    // 摄像头不可用（无摄像头/未授权/WebView 限制）时优雅降级到手动输入
    toast.show(t('pair_camera_fail') + (e?.message ? `: ${e.message}` : ''), 'error')
  }
}

function scanLoop() {
  if (!scanning.value || !videoEl.value) return
  const video = videoEl.value
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const result = (jsQR as any)(img.data, img.width, img.height)
      if (result?.data) {
        stopScan()
        handlePairingToken(result.data)
        return
      }
    }
  }
  rafId = requestAnimationFrame(scanLoop)
}

function parseToken(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.includes('token=')) {
    return trimmed.split('token=')[1].split(/[&\s]/)[0]
  }
  return trimmed
}

async function handlePairingToken(raw: string) {
  const token = parseToken(raw)
  if (!token) {
    toast.show(t('pair_token_required'), 'error')
    return
  }
  redeemSending.value = true
  try {
    const res = await redeemPairing({
      token,
      deviceName: 'Desktop',
      deviceType: 'desktop',
      platform: detectPlatform(),
    })
    if (res.ok && res.data?.token) {
      await configStore.completeLogin(res.data.token, res.data.user.id)
      await device.loadDevices()
      toast.show(t('pair_redeem_success'), 'success')
      stopScan()
      emit('close')
    } else {
      toast.show(t('pair_redeem_fail') + (res.error || ''), 'error')
    }
  } catch (e: any) {
    toast.show(t('pair_redeem_fail') + String(e), 'error')
  } finally {
    redeemSending.value = false
  }
}

function closePairModals() {
  if (expireTimer) {
    clearInterval(expireTimer)
    expireTimer = undefined
  }
  stopScan()
  emit('close')
}

// 打开「生成配对码」弹窗时自动创建二维码；离开配对类弹窗时清理计时器与摄像头
function handleTypeChange(type: string) {
  if (type === 'pair-generate') {
    generatePairing()
  } else if (type !== 'pair-scan') {
    if (expireTimer) {
      clearInterval(expireTimer)
      expireTimer = undefined
    }
    stopScan()
  }
}
watch(() => props.showModalType, handleTypeChange, { immediate: true })

// 组件卸载（门控关闭）时兜底清理定时器与摄像头，避免泄漏
onUnmounted(() => {
  if (expireTimer) {
    clearInterval(expireTimer)
    expireTimer = undefined
  }
  stopScan()
})
</script>

<template>
  <!-- QR Pairing: Generate (本机已登录设备) -->
  <ModalDialog
    :open="showModalType === 'pair-generate'"
    :title="t('pair_generate')"
    max-width="420px"
    @close="closePairModals"
  >
    <div class="pair-gen-box">
      <div v-if="pairingQr" class="pair-qr-box">
        <img :src="pairingQr" class="pair-qr-img" alt="pairing qr" />
      </div>
      <div v-else class="pair-generating">{{ t('pair_generating') }}</div>

      <p class="pair-token-box">{{ pairingToken }}</p>

      <div class="pair-btn-row">
        <Button
          variant="outline"
          size="sm"
          :disabled="!pairingToken"
          class="modal-action-btn"
          @click="copyPairingToken"
          >{{ t('pair_copy') }}</Button
        >
        <Button variant="outline" size="sm" class="modal-action-btn" @click="generatePairing">{{
          t('pair_regenerate')
        }}</Button>
      </div>

      <p class="pair-expire-text">
        <template v-if="pairingRemaining > 0">{{ t('pair_expire', { s: pairingRemaining }) }}</template>
        <template v-else>{{ t('pair_expired') }}</template>
      </p>
      <p class="pair-gen-desc">{{ t('pair_generate_desc') }}</p>
    </div>
  </ModalDialog>

  <!-- QR Pairing: Scan (扫码设备) -->
  <ModalDialog :open="showModalType === 'pair-scan'" :title="t('pair_scan')" max-width="460px" @close="closePairModals">
    <div class="pair-scan-box">
      <p class="pair-scan-desc">{{ t('pair_scan_desc') }}</p>

      <div class="pair-video-box">
        <video ref="videoEl" playsinline class="pair-video" :style="{ display: scanning ? 'block' : 'none' }"></video>
        <div v-if="!scanning" class="pair-camera-hint">{{ t('pair_camera_hint') }}</div>
      </div>

      <div class="pair-scan-btn-row">
        <Button v-if="!scanning" size="sm" class="modal-action-btn" @click="startScan">{{
          t('pair_scan_start')
        }}</Button>
        <Button v-else variant="ghost" size="sm" class="modal-action-btn" @click="stopScan">{{
          t('pair_scan_stop')
        }}</Button>
      </div>

      <div class="pair-manual-sec">
        <p class="pair-manual-label">{{ t('pair_enter_code') }}</p>
        <div class="pair-manual-row">
          <Input v-model="manualToken" class="manual-token-input" :placeholder="t('pair_token_placeholder')" />
          <Button
            size="sm"
            :disabled="redeemSending"
            class="modal-action-btn"
            @click="handlePairingToken(manualToken)"
            >{{ t('pair_pair_btn') }}</Button
          >
        </div>
        <p class="pair-scan-hint">{{ t('pair_scan_hint') }}</p>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
/* Pairing: generate */
.pair-gen-box {
  text-align: center;
  padding: 12px 0;
}
.pair-qr-box {
  width: 220px;
  height: 220px;
  margin: 0 auto 16px;
  background: #fff;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
}
.pair-qr-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.pair-generating {
  color: var(--text-tertiary);
  padding: 48px 0;
}
.pair-token-box {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  background: var(--bg-hover);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  min-height: 32px;
}
.pair-btn-row {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 16px;
}
.pair-expire-text {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 10px;
}
.pair-gen-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
}

/* Pairing: scan */
.pair-scan-box {
  padding: 8px 0;
}
.pair-scan-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.pair-video-box {
  position: relative;
  width: 100%;
  max-width: 300px;
  margin: 0 auto;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #000;
  aspect-ratio: 1/1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pair-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pair-camera-hint {
  color: #888;
  font-size: 13px;
  text-align: center;
  padding: 20px;
}
.pair-scan-btn-row {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 14px;
}
.pair-manual-sec {
  margin-top: 20px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 14px;
}
.pair-manual-label {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}
.pair-manual-row {
  display: flex;
  gap: 10px;
}
.pair-scan-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 10px;
}
.manual-token-input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
</style>
