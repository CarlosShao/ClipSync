<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useTheme, currentMode } from '@/composables/useTheme'
import { useConfigStore } from '@/stores/configStore'

const { t, currentLang, setLang } = useI18n()
const { setMode } = useTheme()
const configStore = useConfigStore()
const emit = defineEmits<{ 'open-modal': [type: string] }>()
const langModel = ref(currentLang.value)
const syncIntervalModel = ref(String(configStore.syncInterval))
const maxHistoryModel = ref(String(configStore.maxHistory))
</script>

<template>
  <div class="settings-view">
    <div class="settings-content">
    <h2 class="sv-title">{{ t('settings_t') }}</h2>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_gen') }}</div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_autosync') }}</div><div class="sg-hint">{{ t('sg_autosync_h') }}</div></div>
        <button class="toggle on" @click="(e: any) => e.currentTarget.classList.toggle('on')" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_imgcomp') }}</div><div class="sg-hint">{{ t('sg_imgcomp_h') }}</div></div>
        <button class="toggle" @click="(e: any) => e.currentTarget.classList.toggle('on')" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_startup') }}</div><div class="sg-hint">{{ t('sg_startup_h') }}</div></div>
        <button :class="['toggle', { on: configStore.autostart }]" @click="configStore.toggleAutostart()" />
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_lang') }}</div><div class="sg-hint">{{ t('sg_lang_h') }}</div></div>
        <select v-model="langModel" class="styled-select" @change="setLang(langModel)"><option value="zh">{{ t('lang_zh') }}</option><option value="en">{{ t('lang_en') }}</option></select>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_interval') }}</div><div class="sg-hint">{{ t('sg_interval_h') }}</div></div>
        <select class="styled-select" v-model="syncIntervalModel" @change="configStore.syncInterval = Number(syncIntervalModel)"><option value="0">{{ t('int_rt') }}</option><option value="5">{{ t('int_5m') }}</option><option value="15">{{ t('int_15m') }}</option></select>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_maxhist') }}</div><div class="sg-hint">{{ t('sg_maxhist_h') }}</div></div>
        <select class="styled-select" v-model="maxHistoryModel" @change="configStore.maxHistory = Number(maxHistoryModel)"><option value="100">{{ t('hist_100') }}</option><option value="500">{{ t('hist_500') }}</option><option value="1000">{{ t('hist_1k') }}</option><option value="999999">{{ t('hist_unl') }}</option></select>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_appear') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'themes')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_theme') }}</div><div class="sg-hint">{{ t('sg_theme_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_mode') }}</div><div class="sg-hint">{{ t('sg_mode_h') }}</div></div>
        <div class="mode-seg">
          <button :class="['mode-btn', { active: currentMode === 'light' }]" @click="setMode('light')">{{ t('mode_light') }}</button>
          <button :class="['mode-btn', { active: currentMode === 'dark' }]" @click="setMode('dark')">{{ t('mode_dark') }}</button>
        </div>
      </div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name" style="font-size:12px;">{{ t('sg_theme_hint') }}</div></div>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_shortcuts') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'shortcuts')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_kb_shortcuts') }}</div><div class="sg-hint">{{ t('sg_kb_shortcuts_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_privacy') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'security')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_2fa') }}</div><div class="sg-hint">{{ t('sg_2fa_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'sessions')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_sessions') }}</div><div class="sg-hint">{{ t('sg_sessions_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'notifications')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_notifp') }}</div><div class="sg-hint">{{ t('sg_notifp_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_data') }}</div>
      <div class="sg-row">
        <div class="sg-label"><div class="sg-name">{{ t('sg_motion') }}</div><div class="sg-hint">{{ t('sg_motion_h') }}</div></div>
        <button class="toggle" @click="(e: any) => e.currentTarget.classList.toggle('on')" />
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'export')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_export') }}</div><div class="sg-hint">{{ t('sg_export_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'updates')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_update') }}</div><div class="sg-hint">{{ t('sg_update_h') }}</div></div>
        <button class="btn btn-sm btn-outline" @click.stop="emit('open-modal', 'updates')">{{ t('btn_check') }}</button>
      </div>
    </div>

    <div class="settings-group">
      <div class="sg-header">{{ t('sg_sub_bill') }}</div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'pricing')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_current_plan') }}</div><div class="sg-hint">{{ t('sg_current_plan_h_free') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="sg-row" style="cursor:pointer;" @click="emit('open-modal', 'billing')">
        <div class="sg-label"><div class="sg-name">{{ t('sg_billing') }}</div><div class="sg-hint">{{ t('sg_billing_h') }}</div></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sg-arrow"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { overflow-y: auto; flex: 1; max-width: 100%; }
.settings-content { padding: 24px; max-width: 720px; }
.sv-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.settings-group { margin-bottom: 24px; }
.sg-header { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-tertiary); margin-bottom: 8px; }
.sg-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: var(--radius-md); gap: 16px; }
.sg-row:hover { background: var(--bg-hover); }
.sg-label { flex: 1; min-width: 0; }
.sg-name { font-size: 14px; font-weight: 500; }
.sg-hint { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
.sg-arrow { color: var(--text-tertiary); opacity: .5; flex-shrink: 0; }
.toggle { position: relative; display: inline-block; width: 40px; height: 22px; cursor: pointer; border-radius: 11px; background: var(--border-default); border: none; padding: 0; flex-shrink: 0; transition: background 0.2s; }
.toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
.toggle.on { background: var(--accent); }
.toggle.on::after { left: 20px; }
.styled-select { padding: 5px 28px 5px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); font-size: 13px; background: var(--bg-surface); color: var(--text-primary); cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23999' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
.mode-seg { display: inline-flex; background: var(--bg-hover); border-radius: 8px; padding: 2px; border: 1px solid var(--border-default); }
.mode-btn { border: none; background: transparent; padding: 3px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--text-secondary); }
.mode-btn.active { background: var(--bg-surface); color: var(--text-primary); font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; white-space: nowrap; }
.btn-outline { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
.btn-outline:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }
</style>
