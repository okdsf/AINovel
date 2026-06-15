<script setup>
import { ref, computed, onMounted, watch, onBeforeUnmount } from 'vue'
import { useI18n } from '../i18n'
import { useSettingsStore } from '../stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()

const editorStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: String(settings.lineHeight),
}))

const prompts = ref([])
const currentId = ref('')
const title = ref('')
const content = ref('')
const source = ref('')
const tags = ref([])
const summary = ref('')
const tagInput = ref('')

const message = ref('')
const saving = ref(false)
const dirty = ref(false)
const loading = ref(false)
const showList = ref(true)
const searchQuery = ref('')

const AUTOSAVE_DELAY = 2000
let autosaveTimer = null

const filteredPrompts = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return prompts.value
  return prompts.value.filter(p =>
    (p.title || '').toLowerCase().includes(q) ||
    (p.source || '').toLowerCase().includes(q) ||
    (p.summary || '').toLowerCase().includes(q) ||
    (p.tags || []).some(tag => tag.toLowerCase().includes(q))
  )
})

const wordCount = computed(() => (content.value || '').replace(/\s/g, '').length)

const currentPrompt = computed(() => prompts.value.find(p => p.id === currentId.value))

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function fetchPrompts() {
  const res = await fetch('/api/prompts')
  prompts.value = await res.json()
}

async function loadPrompt(id) {
  if (!id) {
    currentId.value = ''
    title.value = ''
    content.value = ''
    source.value = ''
    tags.value = []
    summary.value = ''
    dirty.value = false
    return
  }
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; await saveCurrent(true) }
  loading.value = true
  try {
    const res = await fetch(`/api/prompts/${id}`)
    const data = await res.json()
    currentId.value = data.id
    title.value = data.title || ''
    content.value = data.content || ''
    source.value = data.source || ''
    tags.value = data.tags || []
    summary.value = data.summary || ''
    dirty.value = false
  } finally {
    loading.value = false
  }
}

async function newPrompt() {
  if (dirty.value && !confirm(t('pa.confirmNew'))) return
  saving.value = true
  message.value = ''
  try {
    const res = await fetch('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', content: '' })
    })
    const data = await res.json()
    await fetchPrompts()
    await loadPrompt(data.id)
    message.value = t('pa.created')
    setTimeout(() => message.value = '', 2000)
  } catch (e) {
    message.value = t('pa.createFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

async function saveCurrent(silent = false) {
  if (!currentId.value || !dirty.value) return
  const id = currentId.value
  if (!silent) saving.value = true
  try {
    await fetch(`/api/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.value,
        content: content.value,
        source: source.value,
        tags: tags.value,
        summary: summary.value,
      })
    })
    if (currentId.value === id) {
      dirty.value = false
      const idx = prompts.value.find(p => p.id === id)
      if (idx) {
        idx.title = title.value
        idx.source = source.value
        idx.tags = [...tags.value]
        idx.summary = summary.value
        idx.updatedAt = new Date().toISOString()
      }
    }
    if (!silent) {
      message.value = t('pa.saved')
      setTimeout(() => message.value = '', 2000)
    }
  } catch (e) {
    if (!silent) message.value = t('pa.saveFailed', { error: e.message })
  } finally {
    if (!silent) saving.value = false
  }
}

async function deletePrompt(id) {
  const p = prompts.value.find(x => x.id === id)
  if (!confirm(t('pa.confirmDelete', { title: p?.title || id }))) return
  await fetch(`/api/prompts/${id}`, { method: 'DELETE' })
  await fetchPrompts()
  if (currentId.value === id) loadPrompt('')
}

function addTag() {
  const tag = tagInput.value.trim()
  if (tag && !tags.value.includes(tag)) {
    tags.value.push(tag)
    dirty.value = true
  }
  tagInput.value = ''
}

function removeTag(tag) {
  tags.value = tags.value.filter(t => t !== tag)
  dirty.value = true
}

function scheduleAutosave() {
  dirty.value = true
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => saveCurrent(true), AUTOSAVE_DELAY)
}

watch([title, content, source, summary], () => {
  if (currentId.value && !loading.value) scheduleAutosave()
})

onMounted(fetchPrompts)
onBeforeUnmount(() => { if (autosaveTimer) clearTimeout(autosaveTimer) })
</script>

<template>
  <div class="pa-root">
    <!-- ====== Top bar ====== -->
    <div class="pa-topbar">
      <div class="pa-topbar-left">
        <button class="pa-icon-btn" @click="showList = !showList" :title="t('pa.title')">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><path d="M3 4h14v1.5H3V4zm0 5h14v1.5H3V9zm0 5h10v1.5H3v-1.5z"/></svg>
        </button>
        <input
          v-if="currentId"
          v-model="title"
          class="pa-title-input"
          :placeholder="t('pa.titlePh')"
        />
        <span v-else class="pa-topbar-label">{{ t('pa.title') }}</span>
      </div>

      <div class="pa-topbar-center">
        <span v-if="message" class="pa-message">{{ message }}</span>
        <template v-else-if="currentId">
          <span class="pa-meta">{{ t('pa.wordCount', { count: wordCount.toLocaleString() }) }}</span>
          <span v-if="dirty" class="pa-meta pa-meta-accent">{{ t('pa.unsaved') }}</span>
        </template>
      </div>

      <div class="pa-topbar-right">
        <button class="pa-text-btn pa-btn-primary" @click="newPrompt" :disabled="saving">{{ t('pa.new') }}</button>
        <button v-if="currentId" class="pa-text-btn pa-btn-save" @click="saveCurrent()" :disabled="saving || !dirty">
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>

    <!-- ====== Main area ====== -->
    <div class="pa-body">
      <!-- List panel -->
      <Transition name="pa-panel">
        <aside v-if="showList" class="pa-list-panel">
          <div class="pa-search-wrap">
            <input v-model="searchQuery" class="pa-search" :placeholder="t('pa.searchPh')" />
          </div>
          <div class="pa-list-scroll">
            <div v-if="filteredPrompts.length === 0" class="pa-list-empty">{{ t('pa.empty') }}</div>
            <div
              v-for="p in filteredPrompts" :key="p.id"
              class="pa-list-item" :class="{ active: currentId === p.id }"
              @click="loadPrompt(p.id)"
            >
              <div class="pa-list-item-body">
                <div class="pa-list-item-title">{{ p.title }}</div>
                <div class="pa-list-item-meta">
                  <span v-if="p.source" class="pa-list-source">{{ p.source }}</span>
                  <span class="pa-list-time">{{ fmtTime(p.updatedAt) }}</span>
                </div>
                <div v-if="p.tags && p.tags.length" class="pa-list-tags">
                  <span v-for="tag in p.tags" :key="tag" class="pa-tag-sm">{{ tag }}</span>
                </div>
              </div>
              <button class="pa-list-del" @click.stop="deletePrompt(p.id)" :title="t('common.delete')">×</button>
            </div>
          </div>
        </aside>
      </Transition>

      <!-- Detail / editor -->
      <div class="pa-detail">
        <div v-if="!currentId" class="pa-placeholder">{{ t('pa.placeholder') }}</div>
        <template v-else>
          <!-- Metadata bar -->
          <div class="pa-meta-bar">
            <div class="pa-field">
              <label class="pa-field-label">{{ t('pa.source') }}</label>
              <input v-model="source" class="pa-field-input" :placeholder="t('pa.sourcePh')" />
            </div>
            <div class="pa-field">
              <label class="pa-field-label">{{ t('pa.summary') }}</label>
              <input v-model="summary" class="pa-field-input" :placeholder="t('pa.summaryPh')" />
            </div>
            <div class="pa-field">
              <label class="pa-field-label">{{ t('pa.tags') }}</label>
              <div class="pa-tags-row">
                <span v-for="tag in tags" :key="tag" class="pa-tag" @click="removeTag(tag)">{{ tag }} ×</span>
                <input
                  v-model="tagInput"
                  class="pa-tag-input"
                  :placeholder="t('pa.tagPh')"
                  @keydown.enter.prevent="addTag"
                />
              </div>
            </div>
          </div>

          <!-- Content editor -->
          <textarea
            v-model="content"
            class="pa-editor"
            :style="editorStyle"
            :placeholder="t('pa.contentPh')"
          ></textarea>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pa-root {
  display: flex; flex-direction: column;
  height: calc(100vh - 0px);
  margin: -40px -60px;
  overflow: hidden;
}

/* ── Top bar ── */
.pa-topbar {
  display: flex; align-items: center;
  padding: 8px 16px; gap: 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  flex-shrink: 0; min-height: 44px;
}
.pa-topbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.pa-topbar-center { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.pa-topbar-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.pa-topbar-label { font-family: var(--font-reading); font-size: 15px; font-weight: 500; }

.pa-title-input {
  flex: 1; min-width: 0;
  font-size: 15px; font-weight: 500;
  padding: 4px 8px;
  border: 1px solid transparent; border-radius: 0;
  background: transparent; color: var(--text);
  outline: none; transition: all 0.15s;
  font-family: var(--font-reading);
}
.pa-title-input:focus {
  border-color: var(--border);
  background: var(--bg);
}

.pa-icon-btn {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px;
  border: none; background: transparent; color: var(--text-muted);
  cursor: pointer; transition: color 0.15s;
}
.pa-icon-btn:hover { color: var(--text); }

.pa-text-btn {
  padding: 4px 12px; font-size: 13px; font-weight: 500;
  border: 1px solid var(--border); background: transparent;
  color: var(--text); cursor: pointer; transition: all 0.15s;
  font-family: var(--font-reading);
}
.pa-text-btn:hover { background: var(--bg-hover, rgba(128,128,128,.08)); }
.pa-text-btn:disabled { opacity: 0.4; cursor: default; }
.pa-btn-primary { border-color: var(--accent, #b8860b); color: var(--accent, #b8860b); }
.pa-btn-save { border-color: var(--accent, #b8860b); }

.pa-message { font-size: 13px; color: var(--accent, #b8860b); }
.pa-meta { font-size: 12px; color: var(--text-muted); }
.pa-meta-accent { color: var(--accent, #b8860b); }

/* ── Body: list + detail ── */
.pa-body {
  display: flex; flex: 1; min-height: 0; overflow: hidden;
}

/* ── List panel ── */
.pa-list-panel {
  width: 320px; min-width: 280px; max-width: 380px;
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  background: var(--bg-card);
  flex-shrink: 0;
}

.pa-search-wrap {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.pa-search {
  width: 100%; padding: 6px 10px;
  font-size: 13px;
  border: 1px solid var(--border); border-radius: 0;
  background: var(--bg); color: var(--text);
  outline: none; font-family: var(--font-reading);
}
.pa-search:focus { border-color: var(--accent, #b8860b); }

.pa-list-scroll {
  flex: 1; overflow-y: auto;
}

.pa-list-empty {
  padding: 40px 20px; text-align: center;
  color: var(--text-muted); font-size: 13px;
}

.pa-list-item {
  display: flex; align-items: flex-start; gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer; transition: background 0.12s;
}
.pa-list-item:hover { background: var(--bg-hover, rgba(128,128,128,.06)); }
.pa-list-item.active {
  background: var(--bg-hover, rgba(128,128,128,.1));
  border-left: 3px solid var(--accent, #b8860b);
  padding-left: 9px;
}

.pa-list-item-body { flex: 1; min-width: 0; }
.pa-list-item-title {
  font-size: 14px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: var(--font-reading);
}
.pa-list-item-meta {
  display: flex; gap: 8px; margin-top: 3px;
  font-size: 11px; color: var(--text-muted);
}
.pa-list-source {
  color: var(--accent, #b8860b);
  font-weight: 500;
}
.pa-list-tags {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;
}
.pa-tag-sm {
  font-size: 10px; padding: 1px 5px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: var(--font-reading);
}

.pa-list-del {
  flex-shrink: 0; width: 22px; height: 22px;
  border: none; background: transparent;
  color: var(--text-muted); cursor: pointer;
  font-size: 16px; line-height: 1;
  opacity: 0; transition: opacity 0.15s;
}
.pa-list-item:hover .pa-list-del { opacity: 1; }
.pa-list-del:hover { color: var(--danger, #c33); }

/* ── Detail panel ── */
.pa-detail {
  flex: 1; display: flex; flex-direction: column;
  min-width: 0; overflow: hidden;
}

.pa-placeholder {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--text-muted); font-size: 14px;
  font-family: var(--font-reading);
}

/* ── Metadata bar ── */
.pa-meta-bar {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  display: flex; flex-wrap: wrap; gap: 12px 24px;
  background: var(--bg-card);
}
.pa-field { display: flex; align-items: center; gap: 6px; }
.pa-field-label {
  font-size: 12px; font-weight: 500;
  color: var(--text-muted); white-space: nowrap;
  font-family: var(--font-reading);
}
.pa-field-input {
  padding: 3px 8px; font-size: 13px;
  border: 1px solid var(--border); border-radius: 0;
  background: transparent; color: var(--text);
  outline: none; font-family: var(--font-reading);
  min-width: 140px;
}
.pa-field-input:focus { border-color: var(--accent, #b8860b); }

.pa-tags-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
}
.pa-tag {
  font-size: 12px; padding: 2px 8px;
  border: 1px solid var(--accent, #b8860b);
  color: var(--accent, #b8860b);
  cursor: pointer; transition: all 0.12s;
  font-family: var(--font-reading);
}
.pa-tag:hover { background: var(--accent, #b8860b); color: var(--bg); }
.pa-tag-input {
  padding: 2px 6px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 0;
  background: transparent; color: var(--text);
  outline: none; min-width: 80px;
  font-family: var(--font-reading);
}
.pa-tag-input:focus { border-color: var(--accent, #b8860b); }

/* ── Editor ── */
.pa-editor {
  flex: 1; width: 100%;
  padding: 20px 24px;
  border: none; outline: none; resize: none;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono, 'Consolas', 'Monaco', monospace);
  font-size: 13px; line-height: 1.7;
  tab-size: 2;
}

/* ── Transitions ── */
.pa-panel-enter-active, .pa-panel-leave-active { transition: all 0.2s ease; }
.pa-panel-enter-from, .pa-panel-leave-to { opacity: 0; margin-left: -320px; }
</style>
