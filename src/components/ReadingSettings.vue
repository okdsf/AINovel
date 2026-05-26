<script setup>
import { ref } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useI18n } from '../i18n'

const settings = useSettingsStore()
const { t } = useI18n()
const showThemePanel = ref(false)

function pickTheme(id) {
  settings.themeId = id
  showThemePanel.value = false
}

function toggleLocale() {
  settings.locale = settings.locale === 'zh' ? 'en' : 'zh'
}
</script>

<template>
  <div class="reading-settings">
    <!-- Theme picker -->
    <div class="theme-picker-wrap">
      <button
        class="setting-btn theme-picker-btn"
        @click="showThemePanel = !showThemePanel"
        :title="t('settings.currentTheme', { name: settings.currentTheme().name })"
      >
        <span class="theme-swatch" :style="{ background: settings.currentTheme().paper, borderColor: settings.currentTheme().accent }"></span>
        {{ settings.currentTheme().name }}
        <span class="caret">▾</span>
      </button>
      <div v-if="showThemePanel" class="theme-panel" @click.stop>
        <div
          v-for="t in settings.themes"
          :key="t.id"
          class="theme-option"
          :class="{ active: settings.themeId === t.id }"
          @click="pickTheme(t.id)"
        >
          <div class="theme-preview" :style="{ background: t.paper, color: t.text, borderColor: t.accent }">
            <span class="theme-preview-title" :style="{ color: t.accent }">第一章</span>
            <span class="theme-preview-text">霜降日，长安城……</span>
          </div>
          <div class="theme-meta">
            <div class="theme-name" :style="{ color: settings.themeId === t.id ? t.accent : 'var(--text)' }">{{ t.name }}</div>
            <div class="theme-desc">{{ t.desc }}</div>
          </div>
        </div>
        <div class="theme-footer">
          <button class="setting-btn theme-apply-font" @click="settings.applyRecommendedFont()" :disabled="!settings.currentTheme().recommendedFont">
            {{ t('settings.applyRecommendedFont') }}
          </button>
        </div>
      </div>
    </div>

    <span class="setting-divider"></span>

    <!-- Language toggle -->
    <button class="setting-btn lang-toggle" @click="toggleLocale" :title="t('settings.language')">
      🌐 {{ settings.locale === 'zh' ? '中' : 'EN' }}
    </button>

    <!-- Dark mode toggle -->
    <button
      class="setting-btn theme-toggle"
      @click="settings.darkMode = !settings.darkMode"
      :title="settings.darkMode ? t('settings.switchToDay') : t('settings.switchToNight')"
    >
      {{ settings.darkMode ? '☀️' : '🌙' }}
    </button>

    <!-- Font size -->
    <div class="setting-group">
      <button class="setting-btn" @click="settings.fontSize = Math.max(12, settings.fontSize - 1)" :title="t('settings.fontSizeMinus')">A-</button>
      <span class="setting-label">{{ settings.fontSize }}</span>
      <button class="setting-btn" @click="settings.fontSize = Math.min(28, settings.fontSize + 1)" :title="t('settings.fontSizePlus')">A+</button>
    </div>

    <!-- Line height -->
    <div class="setting-group">
      <button class="setting-btn" @click="settings.lineHeight = Math.max(1.2, +(settings.lineHeight - 0.2).toFixed(1))" :title="t('settings.lineHeightMinus')">{{ settings.locale === 'zh' ? '行-' : 'L-' }}</button>
      <span class="setting-label">{{ settings.lineHeight }}</span>
      <button class="setting-btn" @click="settings.lineHeight = Math.min(3.0, +(settings.lineHeight + 0.2).toFixed(1))" :title="t('settings.lineHeightPlus')">{{ settings.locale === 'zh' ? '行+' : 'L+' }}</button>
    </div>

    <!-- Reading font picker (novel content — Chinese) -->
    <select
      class="font-select"
      :value="settings.fontId"
      @change="settings.fontId = $event.target.value"
      :title="t('settings.readingFont')"
    >
      <option v-for="f in settings.fonts" :key="f.id" :value="f.id" :style="{ fontFamily: f.family }">
        {{ f.name }}
      </option>
    </select>

    <!-- UI font now mirrors the reading font selection above (see settings.applyTheme). -->
  </div>
</template>

<style scoped>
.reading-settings {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  flex-wrap: wrap;
}

.setting-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.setting-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text);
  transition: all 0.15s;
  line-height: 1.4;
}

.setting-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.theme-toggle {
  font-size: 16px;
  padding: 2px 6px;
}

.lang-toggle {
  font-size: 13px;
  padding: 2px 8px;
  font-weight: 600;
}

.setting-label {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 24px;
  text-align: center;
}

.font-select {
  padding: 3px 8px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-card);
  color: var(--text);
  cursor: pointer;
  outline: none;
}

.font-select:focus {
  border-color: var(--accent);
}

/* Theme picker */
.theme-picker-wrap {
  position: relative;
}

.theme-picker-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
}

.theme-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid;
  flex-shrink: 0;
}

.caret {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 2px;
}

.setting-divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
}

.theme-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  width: 320px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  padding: 8px;
  max-height: 70vh;
  overflow-y: auto;
}

.theme-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.theme-option:hover {
  background: rgba(0,0,0,0.04);
}

.theme-option.active {
  background: rgba(192,146,110,0.08);
  outline: 1px solid var(--accent);
}

.theme-preview {
  width: 72px;
  height: 48px;
  border-radius: 4px;
  border: 1px solid;
  flex-shrink: 0;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  overflow: hidden;
  font-family: 'KaiTi', 'STKaiti', serif;
}

.theme-preview-title {
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}

.theme-preview-text {
  font-size: 8px;
  line-height: 1.2;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.theme-meta {
  flex: 1;
  min-width: 0;
}

.theme-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}

.theme-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.theme-footer {
  border-top: 1px solid var(--border);
  margin-top: 6px;
  padding-top: 6px;
  text-align: right;
}

.theme-apply-font {
  font-size: 11px;
  padding: 3px 8px;
}

.theme-apply-font:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
