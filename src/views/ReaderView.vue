<script setup>
import { ref, watch, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { marked } from 'marked'
import { useNovelStore } from '../stores/novel'
import { useSettingsStore } from '../stores/settings'
import { useI18n } from '../i18n'
import { getChapterDisplay } from '../utils/numbering'
import ReadingSettings from '../components/ReadingSettings.vue'
import ImmersiveReader from '../components/ImmersiveReader.vue'

const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const settings = useSettingsStore()
const { t } = useI18n()

const readingStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: String(settings.lineHeight),
}))

const content = ref('')
const editContent = ref('')
const chapterTitle = ref('')
const mode = ref('read') // 'read', 'edit', 'split'
const saving = ref(false)
const message = ref('')
const splitPoint = ref(-1)
const newChapterTitle = ref('')
const paragraphs = ref([])
const immersive = ref(false)
const PW_KEY = 'novelweb-preview-width'
const previewWidth = ref(+(localStorage.getItem(PW_KEY) || 100))
watch(previewWidth, v => localStorage.setItem(PW_KEY, String(v)))

function findChapterTitle(chId) {
  if (!store.meta) return ''
  for (const vol of store.meta.volumes) {
    const ch = vol.chapters.find(c => c.id === chId)
    if (ch) return ch.title
  }
  return ''
}

const chapterDisplay = computed(() => getChapterDisplay(store.meta, route.params.chapterId))
const renderedHtml = computed(() => marked(content.value || ''))

function buildParagraphs() {
  const text = content.value || ''
  const parts = text.split('\n')
  let result = []
  let charOffset = 0
  for (let i = 0; i < parts.length; i++) {
    result.push({ text: parts[i], offset: charOffset })
    charOffset += parts[i].length + 1
  }
  paragraphs.value = result
}

async function loadContent() {
  const chId = route.params.chapterId
  content.value = await store.getChapterContent(chId)
  editContent.value = content.value
  chapterTitle.value = findChapterTitle(chId)
  mode.value = 'read'
  splitPoint.value = -1
  message.value = ''
}

async function saveContent() {
  saving.value = true
  message.value = ''
  try {
    await store.saveChapterContent(route.params.chapterId, editContent.value)
    content.value = editContent.value
    mode.value = 'read'
    message.value = t('reader.saveSuccess')
    setTimeout(() => message.value = '', 2000)
  } catch (e) {
    message.value = t('reader.saveFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

function enterSplitMode() {
  mode.value = 'split'
  splitPoint.value = -1
  newChapterTitle.value = ''
  buildParagraphs()
}

function selectSplitPoint(offset) {
  splitPoint.value = offset
}

async function confirmSplit() {
  if (splitPoint.value < 0) return
  saving.value = true
  message.value = ''
  try {
    const newChId = await store.splitChapter(
      route.params.chapterId,
      splitPoint.value,
      newChapterTitle.value || t('reader.newChapterFallback')
    )
    message.value = t('reader.splitSuccess')
    await loadContent()
    router.push(`/read/${newChId}`)
  } catch (e) {
    message.value = t('reader.splitFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

function enterEditMode() {
  editContent.value = content.value
  mode.value = 'edit'
}

function canMerge() {
  if (!store.meta) return false
  for (const vol of store.meta.volumes) {
    const idx = vol.chapters.findIndex(c => c.id === route.params.chapterId)
    if (idx !== -1) return idx < vol.chapters.length - 1
  }
  return false
}

function getNextChapterTitle() {
  if (!store.meta) return ''
  for (const vol of store.meta.volumes) {
    const idx = vol.chapters.findIndex(c => c.id === route.params.chapterId)
    if (idx !== -1 && idx < vol.chapters.length - 1) {
      return vol.chapters[idx + 1].title
    }
  }
  return ''
}

async function handleMerge() {
  const next = getNextChapterTitle()
  if (!confirm(t('reader.confirmMerge', { title: next }))) return
  saving.value = true
  message.value = ''
  try {
    await store.mergeChapter(route.params.chapterId)
    message.value = t('reader.mergeSuccess')
    await loadContent()
    setTimeout(() => message.value = '', 2000)
  } catch (e) {
    message.value = t('reader.mergeFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

watch(() => route.params.chapterId, loadContent, { immediate: true })
</script>

<template>
  <div>
    <!-- Tab navigation -->
    <div class="tabs">
      <div class="tab active">{{ t('reader.tabBody') }}</div>
      <div class="tab" @click="router.push(`/conversation/${route.params.chapterId}`)">{{ t('reader.tabConv') }}</div>
      <div class="tab" @click="router.push(`/edit/${route.params.chapterId}`)">{{ t('reader.tabEntry') }}</div>
      <div class="tab" @click="router.push(`/import/${route.params.chapterId}`)">{{ t('reader.tabImport') }}</div>
    </div>

    <!-- Toolbar -->
    <div style="display: flex; gap: 8px; margin-bottom: 20px; align-items: center;">
      <template v-if="mode === 'read'">
        <button class="btn btn-primary" @click="immersive = true">{{ t('reader.immersive') }}</button>
        <button class="btn" @click="enterEditMode">{{ t('reader.editBody') }}</button>
        <button class="btn" @click="enterSplitMode">{{ t('reader.split') }}</button>
        <button class="btn" @click="handleMerge" v-if="canMerge()" :disabled="saving">{{ t('reader.merge') }}</button>
      </template>
      <template v-if="mode === 'edit'">
        <button class="btn btn-primary" @click="saveContent" :disabled="saving">
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
        <button class="btn" @click="mode = 'read'">{{ t('common.cancel') }}</button>
      </template>
      <template v-if="mode === 'split'">
        <button class="btn btn-primary" @click="confirmSplit" :disabled="saving || splitPoint < 0">
          {{ saving ? t('reader.splitting') : t('reader.confirmSplit') }}
        </button>
        <button class="btn" @click="mode = 'read'">{{ t('common.cancel') }}</button>
        <input
          v-model="newChapterTitle"
          type="text"
          :placeholder="t('reader.newChapterTitlePh')"
          style="width: 200px; padding: 5px 10px; font-size: 13px;"
        />
      </template>
      <span v-if="message" style="font-size: 13px; color: var(--accent);">{{ message }}</span>
      <span style="flex: 1;"></span>
      <div v-if="mode === 'read'" class="preview-width-control">
        <span class="pw-label">{{ t('immersive.width') }}</span>
        <input type="range" class="pw-slider" min="50" max="100" step="5" v-model.number="previewWidth" />
        <span class="pw-val">{{ previewWidth }}%</span>
      </div>
      <ReadingSettings v-if="mode === 'read'" />
    </div>

    <!-- Read mode: theme-aware paper -->
    <div v-if="mode === 'read'" class="reader-paper" :style="{ ...settings.themeVars, maxWidth: previewWidth + '%' }">
      <h1 v-if="chapterDisplay.fullTitle" class="reading-content paper-title" :style="readingStyle">
        {{ chapterDisplay.fullTitle }}
      </h1>
      <div class="reading-content paper-body" :style="readingStyle" v-html="renderedHtml"></div>
    </div>

    <!-- Non-read modes: chapter title above -->
    <h1 v-if="mode !== 'read' && chapterDisplay.fullTitle" class="reading-content" :style="readingStyle" style="margin-bottom: 24px;">
      {{ chapterDisplay.fullTitle }}
    </h1>

    <!-- Edit mode -->
    <div v-if="mode === 'edit'">
      <textarea
        v-model="editContent"
        rows="30"
        :style="{ fontFamily: settings.currentFont().family, fontSize: settings.fontSize + 'px', lineHeight: String(settings.lineHeight), minHeight: '500px' }"
      ></textarea>
    </div>

    <!-- Split mode -->
    <div v-if="mode === 'split'">
      <p class="text-muted mb-4" style="font-size: 13px;">
        {{ t('reader.splitHint') }}
      </p>
      <div class="split-view">
        <template v-for="(para, i) in paragraphs" :key="i">
          <div
            v-if="i > 0 && para.text.trim() !== ''"
            class="split-divider"
            :class="{ selected: splitPoint === para.offset }"
            @click="selectSplitPoint(para.offset)"
          >
            <span v-if="splitPoint === para.offset" class="split-label">{{ t('reader.splitHere') }}</span>
            <span v-else class="split-hint">{{ t('reader.clickToSplit') }}</span>
          </div>
          <div
            v-if="para.text.trim() !== ''"
            class="split-para"
            :class="{
              'before-split': splitPoint >= 0 && para.offset < splitPoint,
              'after-split': splitPoint >= 0 && para.offset >= splitPoint
            }"
          >{{ para.text }}</div>
        </template>
      </div>
    </div>

    <div v-if="!content && mode === 'read'" class="text-muted text-center mt-4">
      <p>{{ t('reader.noContent') }}</p>
    </div>

    <!-- Immersive mode -->
    <ImmersiveReader
      v-if="immersive"
      :chapterId="route.params.chapterId"
      @close="immersive = false"
    />
  </div>
</template>

<style scoped>
.reader-paper {
  background: var(--rc-paper, transparent);
  background-image: var(--rc-paper-image, none);
  color: var(--rc-text, inherit);
  padding: 48px 60px;
  border-radius: 6px;
  box-shadow: var(--rc-shadow, none);
  transition: background 0.3s ease, color 0.3s ease, box-shadow 0.3s ease;
  margin: 0 auto 24px;
}

.paper-title {
  color: var(--rc-accent, var(--text));
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--rc-divider, var(--border));
  text-align: center;
}

.paper-body,
.paper-body :deep(*) {
  color: var(--rc-text, inherit);
}

.paper-body :deep(h1),
.paper-body :deep(h2),
.paper-body :deep(h3) {
  color: var(--rc-accent, var(--text));
}

.split-view {
  font-family: var(--font-reading);
  font-size: 16px;
  line-height: 1.8;
}

.split-para {
  padding: 4px 12px;
  border-radius: 4px;
  transition: background 0.15s;
}

.split-para.before-split {
  background: #f0f7f0;
}

.split-para.after-split {
  background: #fff3e8;
}

.split-divider {
  padding: 6px 0;
  margin: 2px 0;
  text-align: center;
  cursor: pointer;
  border: 1px dashed transparent;
  border-radius: 4px;
  transition: all 0.15s;
}

.split-divider .split-hint {
  font-size: 12px;
  color: transparent;
  font-family: var(--font-ui);
}

.split-divider:hover {
  border-color: var(--accent);
  background: #fdf6ee;
}

.split-divider:hover .split-hint {
  color: var(--text-muted);
}

.split-divider.selected {
  border-color: var(--accent);
  background: var(--accent);
}

.split-label {
  font-size: 13px;
  color: white;
  font-weight: 600;
  font-family: var(--font-ui);
}

.preview-width-control {
  display: flex; align-items: center; gap: 6px; margin-right: 8px;
}
.pw-label { font-size: 11px; color: var(--text-muted); }
.pw-val { font-size: 11px; color: var(--text-muted); min-width: 32px; }
.pw-slider {
  width: 80px; height: 3px;
  -webkit-appearance: none; appearance: none;
  background: var(--border); border-radius: 2px;
  outline: none; cursor: pointer;
}
.pw-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px;
  border-radius: 50%; background: var(--accent); cursor: pointer;
}
</style>
