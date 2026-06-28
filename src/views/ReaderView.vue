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

// --- Writes (version library) ---
const showWrites = ref(false)
const writes = ref([])
const writesLoading = ref(false)
const previewWrite = ref(null)

async function loadWrites() {
  writesLoading.value = true
  try {
    writes.value = await store.getWrites(route.params.chapterId)
  } catch {
    writes.value = []
  } finally {
    writesLoading.value = false
  }
}

function toggleWrites() {
  showWrites.value = !showWrites.value
  if (showWrites.value) loadWrites()
}

function provenanceLabel(prov) {
  if (!prov) return t('writes.manual')
  if (prov.type === 'ai') return t('writes.ai')
  if (prov.type === 'imported') return t('writes.imported')
  return t('writes.manual')
}

async function applyWriteVersion(w) {
  saving.value = true
  try {
    await store.applyWrite(route.params.chapterId, w.id)
    content.value = w.content
    editContent.value = w.content
    message.value = t('writes.applied')
    previewWrite.value = null
    setTimeout(() => message.value = '', 2000)
  } finally {
    saving.value = false
  }
}

async function deleteWriteVersion(w) {
  if (!confirm(t('writes.confirmDelete'))) return
  await store.deleteWrite(route.params.chapterId, w.id)
  await loadWrites()
  if (previewWrite.value?.id === w.id) previewWrite.value = null
}

function findChapterTitle(chId) {
  if (!store.meta) return ''
  for (const vol of store.meta.volumes) {
    const ch = vol.chapters.find(c => c.id === chId)
    if (ch) return ch.title
  }
  return ''
}

const chapterDisplay = computed(() => {
  const chId = route.params.chapterId
  const pathIdx = store.treePath.indexOf(chId)
  if (pathIdx >= 0) {
    const node = store.treeNodes[chId]
    const title = node?.title || findChapterTitle(chId) || chId
    return { fullTitle: `第${pathIdx + 1}章 ${title}` }
  }
  return getChapterDisplay(store.meta, chId)
})

const pathNeighbors = computed(() => store.getPathNeighbors(route.params.chapterId))

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
  previewWrite.value = null
  loadWrites()
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
        <span style="width:1px;height:20px;background:var(--rule);margin:0 4px;"></span>
        <button class="btn" :class="{ 'btn-active': showWrites }" @click="toggleWrites">
          {{ t('writes.title') }}
          <span v-if="writes.length" class="writes-badge">{{ writes.length }}</span>
        </button>
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

    <!-- Writes panel (version library) -->
    <Transition name="writes-slide">
      <div v-if="showWrites && mode === 'read'" class="writes-panel">
        <div v-if="writesLoading" class="writes-loading">{{ t('common.loading') }}</div>
        <div v-else-if="writes.length === 0" class="writes-empty">
          {{ t('writes.empty') }}
        </div>
        <div v-else class="writes-list">
          <div
            v-for="w in writes"
            :key="w.id"
            class="writes-item"
            :class="{ previewing: previewWrite?.id === w.id }"
          >
            <div class="writes-item-head">
              <span class="writes-type" :class="w.provenance?.type || 'manual'">{{ provenanceLabel(w.provenance) }}</span>
              <span v-if="w.provenance?.type === 'imported' && w.provenance.source" class="writes-source">{{ w.provenance.source }}</span>
              <span class="writes-date">{{ new Date(w.createdAt).toLocaleString() }}</span>
            </div>
            <div class="writes-snippet">{{ (w.content || '').slice(0, 120) }}{{ (w.content || '').length > 120 ? '…' : '' }}</div>
            <div class="writes-actions">
              <button class="btn btn-sm" @click="previewWrite = previewWrite?.id === w.id ? null : w">
                {{ previewWrite?.id === w.id ? t('common.close') : t('writes.preview') }}
              </button>
              <button class="btn btn-sm btn-primary" @click="applyWriteVersion(w)" :disabled="saving">{{ t('writes.apply') }}</button>
              <button class="btn btn-sm" @click="deleteWriteVersion(w)">{{ t('writes.delete') }}</button>
            </div>
            <div v-if="previewWrite?.id === w.id" class="writes-preview" :style="readingStyle">
              {{ w.content }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

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

/* ── Writes panel ──────────────────────────────────────────── */
.btn-active {
  background: var(--text) !important;
  color: var(--bg) !important;
}
.writes-badge {
  display: inline-block;
  background: var(--hot, #c44);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  margin-left: 4px;
  padding: 0 4px;
}
.writes-panel {
  border: 1px solid var(--rule);
  background: var(--bg-card, var(--bg));
  padding: 16px;
  margin-bottom: 20px;
}
.writes-loading,
.writes-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 12px;
}
.writes-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.writes-item {
  border: 1px solid var(--rule);
  padding: 12px;
  transition: border-color var(--t-fast) var(--ease);
}
.writes-item.previewing {
  border-color: var(--hot, var(--accent));
}
.writes-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.writes-type {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  text-transform: uppercase;
}
.writes-type.manual { background: color-mix(in srgb, #4a90d9 12%, transparent); color: #4a90d9; }
.writes-type.ai { background: color-mix(in srgb, #6ab04c 12%, transparent); color: #6ab04c; }
.writes-type.imported { background: color-mix(in srgb, #e17055 12%, transparent); color: #e17055; }
.writes-source {
  font-size: 11px;
  color: var(--text-muted);
}
.writes-date {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}
.writes-snippet {
  font-size: 13px;
  color: var(--text-soft);
  line-height: 1.5;
  margin-bottom: 8px;
}
.writes-actions {
  display: flex;
  gap: 6px;
}
.writes-preview {
  margin-top: 10px;
  padding: 12px;
  background: color-mix(in srgb, var(--text) 3%, transparent);
  border: 1px solid var(--rule);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Writes slide transition ───────────────────────────────── */
.writes-slide-enter-active, .writes-slide-leave-active {
  transition: all 0.25s ease;
  overflow: hidden;
}
.writes-slide-enter-from, .writes-slide-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-bottom: 0;
}
.writes-slide-enter-to, .writes-slide-leave-from {
  opacity: 1;
  max-height: 800px;
}
</style>
