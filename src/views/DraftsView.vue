<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import PromptLab from '../components/PromptLab.vue'
import { useI18n } from '../i18n'
import { useSettingsStore } from '../stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()
const showSettings = ref(false)

const editorStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: String(settings.lineHeight),
}))

const viewMode = ref('drafts')
const showDraftList = ref(false)
const drafts = ref([])
const currentId = ref('')
const title = ref('')
const content = ref('')
const message = ref('')
const saving = ref(false)
const dirty = ref(false)
const loading = ref(false)
const autosaveStatus = ref('')  // '', 'saving', 'saved', 'error'
const lastSavedAt = ref(0)

const AUTOSAVE_DELAY = 2000
const LS_PREFIX = 'novelweb:draft-backup:'

function lsKey(id) { return LS_PREFIX + id }

function backupToLocal(id, t, c) {
  if (!id) return
  try {
    localStorage.setItem(lsKey(id), JSON.stringify({ title: t, content: c, savedAt: Date.now() }))
  } catch (e) { /* quota exceeded — ignore */ }
}

function clearLocalBackup(id) {
  if (!id) return
  try { localStorage.removeItem(lsKey(id)) } catch (e) {}
}

function readLocalBackup(id) {
  if (!id) return null
  try {
    const raw = localStorage.getItem(lsKey(id))
    return raw ? JSON.parse(raw) : null
  } catch (e) { return null }
}

// --- autosave timers (per-context) ---
let mainTimer = null
let compareTimerA = null
let compareTimerB = null

// --- textarea refs (for programmatic undo/redo) ---
const mainEditorRef = ref(null)
const compareEditorRefA = ref(null)
const compareEditorRefB = ref(null)

function execEdit(textareaRef, cmd) {
  const el = textareaRef?.value
  if (!el) return
  el.focus()
  // execCommand is deprecated but is the only way to drive a textarea's native
  // undo stack — exactly what Ctrl+Z does. Falls back silently if unsupported.
  try { document.execCommand(cmd) } catch (e) {}
}

// Compare mode
const compareMode = ref(false)
const compareIdA = ref('')
const compareIdB = ref('')
const compareContentA = ref('')
const compareContentB = ref('')
const compareTitleA = ref('')
const compareTitleB = ref('')
const compareDirtyA = ref(false)
const compareDirtyB = ref(false)
const compareLoadingA = ref(false)
const compareLoadingB = ref(false)

async function fetchDrafts() {
  const res = await fetch('/api/drafts')
  drafts.value = await res.json()
}

async function loadDraft(id) {
  if (!id) {
    currentId.value = ''
    title.value = ''
    content.value = ''
    dirty.value = false
    return
  }
  // Flush any pending autosave on the previous draft before switching
  if (mainTimer) { clearTimeout(mainTimer); mainTimer = null; await saveCurrent({ silent: true }) }
  loading.value = true
  try {
    const res = await fetch(`/api/drafts/${id}`)
    const data = await res.json()
    currentId.value = data.id
    title.value = data.title
    content.value = data.content
    dirty.value = false
    autosaveStatus.value = ''

    // Check for newer local backup (unsaved on previous session, e.g. tab closed)
    const backup = readLocalBackup(id)
    if (backup) {
      const serverTime = data.updatedAt ? new Date(data.updatedAt).getTime() : 0
      const differs = backup.title !== data.title || backup.content !== data.content
      if (differs && backup.savedAt > serverTime) {
        const when = fmtTime(new Date(backup.savedAt).toISOString())
        if (confirm(t('drafts.restorePrompt', { time: when }))) {
          title.value = backup.title
          content.value = backup.content
          dirty.value = true
        } else {
          clearLocalBackup(id)
        }
      } else {
        // Local backup is stale or identical — discard
        clearLocalBackup(id)
      }
    }
  } finally {
    loading.value = false
  }
}

async function newDraft() {
  if (dirty.value && !confirm(t('drafts.confirmNew'))) return
  saving.value = true
  message.value = ''
  try {
    const res = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', content: '' })  // title 空 → 后端自动分配 "草稿N"
    })
    const data = await res.json()
    await fetchDrafts()
    await loadDraft(data.id)
    message.value = t('drafts.draftCreated')
    setTimeout(() => message.value = '', 2000)
  } catch (e) {
    message.value = t('drafts.draftCreateFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

async function saveCurrent({ silent = false } = {}) {
  if (!currentId.value || !dirty.value) return
  const id = currentId.value
  const t = title.value
  const c = content.value
  if (silent) {
    autosaveStatus.value = 'saving'
  } else {
    saving.value = true
    message.value = ''
  }
  try {
    await fetch(`/api/drafts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t, content: c })
    })
    // Only clear dirty if user hasn't typed more since save started
    if (title.value === t && content.value === c && currentId.value === id) {
      dirty.value = false
      clearLocalBackup(id)
    }
    lastSavedAt.value = Date.now()
    autosaveStatus.value = 'saved'
    await fetchDrafts()
    if (!silent) {
      message.value = t('drafts.saved')
      setTimeout(() => message.value = '', 2000)
    }
  } catch (e) {
    autosaveStatus.value = 'error'
    if (!silent) message.value = t('drafts.saveFailed', { error: e.message })
  } finally {
    if (!silent) saving.value = false
  }
}

function scheduleAutosave() {
  if (mainTimer) clearTimeout(mainTimer)
  mainTimer = setTimeout(() => {
    mainTimer = null
    saveCurrent({ silent: true })
  }, AUTOSAVE_DELAY)
}

async function duplicateCurrent() {
  if (!currentId.value) return
  saving.value = true
  try {
    const res = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.value + t('drafts.copySuffix'),
        content: content.value,
        sourceId: currentId.value
      })
    })
    const data = await res.json()
    await fetchDrafts()
    await loadDraft(data.id)
    message.value = t('drafts.duplicated')
    setTimeout(() => message.value = '', 2000)
  } finally {
    saving.value = false
  }
}

async function deleteDraft(id) {
  const d = drafts.value.find(x => x.id === id)
  if (!confirm(t('drafts.confirmDelete', { title: d?.title || id }))) return
  await fetch(`/api/drafts/${id}`, { method: 'DELETE' })
  await fetchDrafts()
  if (currentId.value === id) {
    await loadDraft('')
  }
}

watch([title, content], () => {
  if (currentId.value && !loading.value) {
    dirty.value = true
    autosaveStatus.value = ''
    backupToLocal(currentId.value, title.value, content.value)
    scheduleAutosave()
  }
})

// Compare
async function startCompare() {
  if (drafts.value.length < 2) {
    message.value = t('drafts.needTwoForCompare')
    setTimeout(() => message.value = '', 2000)
    return
  }
  compareMode.value = true
  compareIdA.value = currentId.value || drafts.value[0].id
  compareIdB.value = drafts.value.find(d => d.id !== compareIdA.value)?.id || ''
  await loadCompareSide('A')
  await loadCompareSide('B')
}

async function loadCompareSide(side) {
  const id = side === 'A' ? compareIdA.value : compareIdB.value
  if (!id) return
  if (side === 'A') compareLoadingA.value = true
  else compareLoadingB.value = true
  try {
    const res = await fetch(`/api/drafts/${id}`)
    const data = await res.json()
    let useTitle = data.title
    let useContent = data.content
    let dirtyAfter = false

    const backup = readLocalBackup(id)
    if (backup) {
      const serverTime = data.updatedAt ? new Date(data.updatedAt).getTime() : 0
      const differs = backup.title !== data.title || backup.content !== data.content
      if (differs && backup.savedAt > serverTime) {
        const when = fmtTime(new Date(backup.savedAt).toISOString())
        if (confirm(t('drafts.restorePromptCompare', { side, time: when }))) {
          useTitle = backup.title
          useContent = backup.content
          dirtyAfter = true
        } else {
          clearLocalBackup(id)
        }
      } else {
        clearLocalBackup(id)
      }
    }

    if (side === 'A') {
      compareContentA.value = useContent
      compareTitleA.value = useTitle
      compareDirtyA.value = dirtyAfter
    } else {
      compareContentB.value = useContent
      compareTitleB.value = useTitle
      compareDirtyB.value = dirtyAfter
    }
  } finally {
    if (side === 'A') compareLoadingA.value = false
    else compareLoadingB.value = false
  }
}

async function saveCompareSide(side, { silent = false } = {}) {
  const id = side === 'A' ? compareIdA.value : compareIdB.value
  const isDirty = side === 'A' ? compareDirtyA.value : compareDirtyB.value
  if (!id || !isDirty) return
  const t = side === 'A' ? compareTitleA.value : compareTitleB.value
  const c = side === 'A' ? compareContentA.value : compareContentB.value
  if (!silent) {
    saving.value = true
    message.value = ''
  }
  try {
    await fetch(`/api/drafts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t, content: c })
    })
    const curT = side === 'A' ? compareTitleA.value : compareTitleB.value
    const curC = side === 'A' ? compareContentA.value : compareContentB.value
    if (curT === t && curC === c) {
      if (side === 'A') compareDirtyA.value = false
      else compareDirtyB.value = false
      clearLocalBackup(id)
    }
    await fetchDrafts()
    // 若主编辑器里打开的是同一个草稿，同步状态
    if (currentId.value === id) {
      title.value = t
      content.value = c
      dirty.value = false
    }
    if (!silent) {
      message.value = t('drafts.sideSaved', { side })
      setTimeout(() => message.value = '', 2000)
    }
  } catch (e) {
    if (!silent) message.value = t('drafts.sideSaveFailed', { side, error: e.message })
  } finally {
    if (!silent) saving.value = false
  }
}

function scheduleCompareAutosave(side) {
  if (side === 'A') {
    if (compareTimerA) clearTimeout(compareTimerA)
    compareTimerA = setTimeout(() => { compareTimerA = null; saveCompareSide('A', { silent: true }) }, AUTOSAVE_DELAY)
  } else {
    if (compareTimerB) clearTimeout(compareTimerB)
    compareTimerB = setTimeout(() => { compareTimerB = null; saveCompareSide('B', { silent: true }) }, AUTOSAVE_DELAY)
  }
}

watch(compareIdA, () => loadCompareSide('A'))
watch(compareIdB, () => loadCompareSide('B'))

watch([compareTitleA, compareContentA], () => {
  if (compareIdA.value && !compareLoadingA.value) {
    compareDirtyA.value = true
    backupToLocal(compareIdA.value, compareTitleA.value, compareContentA.value)
    scheduleCompareAutosave('A')
  }
})
watch([compareTitleB, compareContentB], () => {
  if (compareIdB.value && !compareLoadingB.value) {
    compareDirtyB.value = true
    backupToLocal(compareIdB.value, compareTitleB.value, compareContentB.value)
    scheduleCompareAutosave('B')
  }
})

function exitCompare() {
  if ((compareDirtyA.value || compareDirtyB.value) &&
      !confirm(t('drafts.confirmExitCompare'))) return
  compareMode.value = false
}

const wordCount = computed(() => {
  return (content.value || '').replace(/\s/g, '').length
})

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const min = d.getMinutes().toString().padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day} ${h}:${min}`
}

function beforeUnloadHandler(e) {
  if (dirty.value || compareDirtyA.value || compareDirtyB.value) {
    // 本地暂存已写入 localStorage，理论上不会丢；但仍提示一下用户确认
    e.preventDefault()
    e.returnValue = ''
  }
}

const autosaveLabel = computed(() => {
  if (autosaveStatus.value === 'saving') return t('drafts.autosaving')
  if (autosaveStatus.value === 'error') return t('drafts.autosaveError')
  if (autosaveStatus.value === 'saved' && lastSavedAt.value) {
    return t('drafts.autosaved', { time: fmtTime(new Date(lastSavedAt.value).toISOString()) })
  }
  return ''
})

onMounted(() => {
  fetchDrafts()
  window.addEventListener('beforeunload', beforeUnloadHandler)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnloadHandler)
  if (mainTimer) { clearTimeout(mainTimer); saveCurrent({ silent: true }) }
  if (compareTimerA) { clearTimeout(compareTimerA); saveCompareSide('A', { silent: true }) }
  if (compareTimerB) { clearTimeout(compareTimerB); saveCompareSide('B', { silent: true }) }
})
</script>

<template>
  <div class="drafts-root">
    <!-- ====== Top bar ====== -->
    <div class="d-topbar">
      <div class="d-topbar-left">
        <button class="d-icon-btn" @click="showDraftList = !showDraftList" :title="t('drafts.title')">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><path d="M3 4h14v1.5H3V4zm0 5h14v1.5H3V9zm0 5h10v1.5H3v-1.5z"/></svg>
        </button>
        <input
          v-if="currentId && viewMode === 'drafts' && !compareMode"
          v-model="title"
          class="d-title-input"
          :placeholder="t('drafts.titlePlaceholder')"
        />
        <span v-else class="d-topbar-label">{{ t('drafts.title') }}</span>
      </div>

      <div class="d-topbar-center">
        <span v-if="message" class="d-message">{{ message }}</span>
        <template v-else-if="currentId && viewMode === 'drafts' && !compareMode">
          <span class="d-meta">{{ t('drafts.wordCount', { count: wordCount.toLocaleString() }) }}</span>
          <span v-if="dirty && autosaveStatus !== 'saving'" class="d-meta d-meta-accent">{{ t('drafts.pendingAutosave') }}</span>
          <span v-else-if="autosaveStatus === 'saving'" class="d-meta d-meta-accent">{{ t('drafts.autosaving') }}</span>
          <span v-else-if="autosaveStatus === 'saved'" class="d-meta">{{ autosaveLabel }}</span>
          <span v-else-if="autosaveStatus === 'error'" class="d-meta d-meta-error">{{ t('drafts.autosaveError') }}</span>
        </template>
      </div>

      <div class="d-topbar-right">
        <!-- Reading settings toggle -->
        <div class="d-settings-wrap">
          <button class="d-icon-btn" @click.stop="showSettings = !showSettings" :title="t('common.settings')">
            <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor">
              <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
            </svg>
          </button>
          <div v-if="showSettings" class="d-settings-panel" @click.stop>
            <!-- Font size -->
            <div class="ds-row">
              <span class="ds-label">{{ t('immersive.fontSize') }}</span>
              <button class="ds-btn" @click="settings.fontSize = Math.max(12, settings.fontSize - 1)">−</button>
              <span class="ds-val">{{ settings.fontSize }}</span>
              <button class="ds-btn" @click="settings.fontSize = Math.min(28, settings.fontSize + 1)">+</button>
            </div>
            <!-- Line height -->
            <div class="ds-row">
              <span class="ds-label">{{ t('immersive.lineHeight') }}</span>
              <button class="ds-btn" @click="settings.lineHeight = Math.max(1.2, +(settings.lineHeight - 0.2).toFixed(1))">−</button>
              <span class="ds-val">{{ settings.lineHeight }}</span>
              <button class="ds-btn" @click="settings.lineHeight = Math.min(3.0, +(settings.lineHeight + 0.2).toFixed(1))">+</button>
            </div>
            <!-- Font -->
            <div class="ds-row">
              <span class="ds-label">{{ t('immersive.font') }}</span>
              <select class="ds-select" :value="settings.fontId" @change="settings.fontId = $event.target.value">
                <option v-for="f in settings.fonts" :key="f.id" :value="f.id">{{ f.name }}</option>
              </select>
            </div>
            <!-- Theme swatches -->
            <div class="ds-row">
              <span class="ds-label">{{ t('immersive.paper') }}</span>
              <div class="ds-themes">
                <div v-for="th in settings.themes" :key="th.id"
                  class="ds-swatch" :class="{ active: settings.themeId === th.id }"
                  :style="{ background: th.paper }" :title="th.name"
                  @click="settings.themeId = th.id"></div>
              </div>
              <button class="ds-btn" @click="settings.darkMode = !settings.darkMode" style="margin-left:4px">{{ settings.darkMode ? '☀️' : '🌙' }}</button>
            </div>
          </div>
        </div>
        <div v-if="showSettings" class="d-settings-backdrop" @click="showSettings = false"></div>
        <!-- Mode toggle -->
        <div class="d-mode-toggle">
          <button class="d-mode-btn" :class="{ active: viewMode === 'drafts' }" @click="viewMode = 'drafts'">{{ t('drafts.modeNormal') }}</button>
          <button class="d-mode-btn" :class="{ active: viewMode === 'promptlab' }" @click="viewMode = 'promptlab'">{{ t('drafts.modePromptLab') }}</button>
        </div>
        <template v-if="viewMode === 'drafts'">
          <button v-if="!compareMode && currentId" class="d-icon-btn" @click="execEdit(mainEditorRef, 'undo')" :title="t('drafts.undoTitle')">↶</button>
          <button v-if="!compareMode && currentId" class="d-icon-btn" @click="execEdit(mainEditorRef, 'redo')" :title="t('drafts.redoTitle')">↷</button>
          <button class="d-icon-btn" @click="compareMode ? exitCompare() : startCompare()" :title="compareMode ? t('drafts.exitCompare') : t('drafts.compareMode')">⇄</button>
          <button v-if="!compareMode && currentId" class="d-icon-btn" @click="duplicateCurrent" :disabled="saving" :title="t('drafts.duplicate')">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M7 2a2 2 0 00-2 2v1H4a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-1h1a2 2 0 002-2V4a2 2 0 00-2-2H7zm0 2h9v9h-1V7a2 2 0 00-2-2H7V4zM4 7h9v9H4V7z"/></svg>
          </button>
          <button v-if="!compareMode" class="d-text-btn d-btn-primary" @click="newDraft" :disabled="saving">{{ t('drafts.newDraft') }}</button>
          <button v-if="!compareMode && currentId" class="d-text-btn d-btn-save" @click="saveCurrent()" :disabled="saving || !dirty">
            {{ saving ? t('common.saving') : t('drafts.save') }}
          </button>
        </template>
      </div>
    </div>

    <!-- ====== Drafts mode ====== -->
    <template v-if="viewMode === 'drafts'">

      <!-- Normal edit -->
      <div v-if="!compareMode" class="d-editor-wrap">
        <div v-if="!currentId" class="d-placeholder">{{ t('drafts.placeholderEmpty') }}</div>
        <textarea
          v-else
          ref="mainEditorRef"
          v-model="content"
          class="d-editor"
          :style="editorStyle"
          :placeholder="t('drafts.bodyPlaceholder')"
        ></textarea>
      </div>

      <!-- Compare mode -->
      <div v-else class="d-compare-wrap">
        <div class="d-compare-side" v-for="side in ['A','B']" :key="side">
          <div class="d-compare-header">
            <select class="d-compare-select" :value="side === 'A' ? compareIdA : compareIdB"
              @change="side === 'A' ? (compareIdA = $event.target.value) : (compareIdB = $event.target.value)">
              <option v-for="d in drafts" :key="d.id" :value="d.id">{{ d.title }}</option>
            </select>
            <button class="d-text-btn d-btn-save" @click="saveCompareSide(side)"
              :disabled="saving || !(side === 'A' ? compareDirtyA : compareDirtyB)">
              {{ t('drafts.saveSide', { side }) }}
            </button>
          </div>
          <input class="d-compare-title" :value="side === 'A' ? compareTitleA : compareTitleB"
            @input="side === 'A' ? (compareTitleA = $event.target.value) : (compareTitleB = $event.target.value)"
            :placeholder="t('drafts.titlePlaceholder')" />
          <textarea class="d-compare-editor"
            :ref="el => { if (side === 'A') compareEditorRefA = el; else compareEditorRefB = el }"
            :value="side === 'A' ? compareContentA : compareContentB"
            @input="side === 'A' ? (compareContentA = $event.target.value) : (compareContentB = $event.target.value)"
            :style="editorStyle"
          ></textarea>
          <div class="d-compare-footer">
            <span class="d-meta">{{ t('drafts.wordCount', { count: ((side === 'A' ? compareContentA : compareContentB) || '').replace(/\s/g, '').length.toLocaleString() }) }}</span>
            <span v-if="side === 'A' ? compareDirtyA : compareDirtyB" class="d-meta d-meta-accent">{{ t('plab.unsaved') }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ====== PromptLab mode ====== -->
    <PromptLab v-if="viewMode === 'promptlab'" />

    <!-- ====== Draft list panel (slide-out) ====== -->
    <div v-if="showDraftList" class="d-backdrop" @click="showDraftList = false"></div>
    <Transition name="d-panel">
      <aside v-if="showDraftList" class="d-panel" @click.stop>
        <div class="d-panel-header">
          <span>{{ t('drafts.title') }}</span>
          <button class="d-icon-btn" @click="showDraftList = false">✕</button>
        </div>
        <div class="d-panel-list">
          <div v-if="drafts.length === 0" class="d-panel-empty">{{ t('drafts.empty') }}</div>
          <div
            v-for="d in drafts" :key="d.id"
            class="d-panel-item" :class="{ active: currentId === d.id }"
            @click="loadDraft(d.id); showDraftList = false"
          >
            <div class="d-panel-item-body">
              <div class="d-panel-item-title">{{ d.title }}</div>
              <div class="d-panel-item-time">{{ fmtTime(d.updatedAt) }}</div>
            </div>
            <button class="d-panel-item-del" @click.stop="deleteDraft(d.id)" :title="t('common.delete')">×</button>
          </div>
        </div>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.drafts-root {
  display: flex; flex-direction: column;
  height: calc(100vh - 0px);
  margin: -40px -60px;
  overflow: hidden;
}

/* ── Top bar ── */
.d-topbar {
  display: flex; align-items: center;
  padding: 8px 16px; gap: 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  flex-shrink: 0; min-height: 44px;
}
.d-topbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.d-topbar-center { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.d-topbar-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.d-topbar-label { font-family: var(--font-reading); font-size: 15px; font-weight: 500; }

.d-title-input {
  flex: 1; min-width: 0;
  font-size: 15px; font-weight: 500;
  padding: 4px 8px;
  border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--text);
  outline: none; transition: all 0.15s;
}
.d-title-input:focus {
  border-color: var(--accent);
  background: var(--bg-card);
}

.d-meta { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.d-meta-accent { color: var(--accent); }
.d-meta-error { color: #c04040; }
.d-message { font-size: 12px; color: var(--accent); }

.d-icon-btn {
  background: none; border: none;
  padding: 5px 7px; border-radius: 6px;
  font-size: 16px; color: var(--text); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.d-icon-btn:hover { background: rgba(0,0,0,0.06); }
.d-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.d-icon-btn svg { display: block; }

.d-text-btn {
  padding: 4px 12px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 6px;
  background: none; color: var(--text); cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.d-text-btn:hover { border-color: var(--accent); color: var(--accent); }
.d-text-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.d-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.d-btn-primary:hover { opacity: 0.85; color: #fff; }
.d-btn-save { background: var(--accent); color: #fff; border-color: var(--accent); }
.d-btn-save:hover { opacity: 0.85; color: #fff; }

.d-mode-toggle {
  display: flex; gap: 1px; background: var(--border);
  border-radius: 6px; overflow: hidden; margin-right: 4px;
}
.d-mode-btn {
  padding: 4px 10px; font-size: 11px; border: none;
  background: var(--bg-card); color: var(--text-muted);
  cursor: pointer; transition: all 0.15s;
}
.d-mode-btn.active { color: var(--accent); font-weight: 600; }
.d-mode-btn:hover { color: var(--text); }

/* ── Editor area (full-screen) ── */
.d-editor-wrap { flex: 1; display: flex; overflow: hidden; }
.d-editor {
  flex: 1; width: 100%;
  padding: 40px 60px;
  border: none; outline: none; resize: none;
  background: var(--bg); color: var(--text);
}
.d-placeholder {
  flex: 1; display: flex;
  align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 14px;
}

/* ── Compare mode ── */
.d-compare-wrap {
  flex: 1; display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0; overflow: hidden;
}
.d-compare-side {
  display: flex; flex-direction: column;
  border-right: 1px solid var(--border);
  overflow: hidden;
}
.d-compare-side:last-child { border-right: none; }
.d-compare-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-bottom: 1px solid var(--border);
}
.d-compare-select {
  flex: 1; font-size: 12px; padding: 4px 6px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-card); color: var(--text); outline: none;
}
.d-compare-title {
  width: 100%; padding: 6px 12px;
  font-size: 13px; border: none; border-bottom: 1px solid var(--border);
  background: transparent; color: var(--text); outline: none;
}
.d-compare-editor {
  flex: 1; width: 100%; padding: 16px;
  font-family: var(--font-reading); font-size: 14px; line-height: 1.8;
  border: none; outline: none; resize: none;
  background: var(--bg); color: var(--text);
  box-sizing: border-box;
}
.d-compare-footer {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border-top: 1px solid var(--border);
}

/* ── Slide-out draft list panel ── */
.d-backdrop {
  position: fixed; inset: 0; z-index: 50;
}
.d-panel {
  position: fixed; left: 0; top: 0; bottom: 0;
  width: 300px; z-index: 51;
  background: var(--bg-card);
  border-right: 1px solid var(--border);
  box-shadow: 4px 0 24px rgba(0,0,0,0.1);
  display: flex; flex-direction: column;
}
.d-panel-enter-active { animation: panelIn 0.2s ease-out; }
.d-panel-leave-active { animation: panelOut 0.15s ease-in; }
@keyframes panelIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes panelOut { from { transform: translateX(0); } to { transform: translateX(-100%); } }

.d-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  font-weight: 600; font-size: 14px;
}
.d-panel-list {
  flex: 1; overflow-y: auto; padding: 8px;
}
.d-panel-empty {
  padding: 24px; text-align: center;
  color: var(--text-muted); font-size: 13px;
}
.d-panel-item {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 10px 12px; margin-bottom: 2px;
  border-radius: 6px; cursor: pointer;
  border-left: 3px solid transparent;
  transition: all 0.12s;
}
.d-panel-item:hover { background: rgba(0,0,0,0.04); }
.d-panel-item.active {
  background: rgba(0,0,0,0.06);
  border-left-color: var(--accent);
}
.d-panel-item-body { flex: 1; min-width: 0; }
.d-panel-item-title {
  font-size: 13px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.d-panel-item-time { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.d-panel-item-del {
  background: none; border: none; font-size: 14px;
  color: var(--text-muted); cursor: pointer; padding: 0 4px;
  opacity: 0; transition: opacity 0.15s;
}
.d-panel-item:hover .d-panel-item-del { opacity: 0.6; }
.d-panel-item-del:hover { opacity: 1 !important; color: #c44; }

/* ── Settings popover ── */
.d-settings-wrap { position: relative; }
.d-settings-backdrop { position: fixed; inset: 0; z-index: 49; }
.d-settings-panel {
  position: absolute; top: calc(100% + 6px); right: 0;
  z-index: 50;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.12);
  min-width: 260px;
  display: flex; flex-direction: column; gap: 8px;
}
.ds-row { display: flex; align-items: center; gap: 6px; }
.ds-label { font-size: 11px; color: var(--text-muted); min-width: 28px; }
.ds-btn {
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: 1px solid var(--border); border-radius: 6px;
  font-size: 14px; color: var(--text); cursor: pointer;
  transition: all 0.12s;
}
.ds-btn:hover { border-color: var(--accent); color: var(--accent); }
.ds-val { font-size: 12px; min-width: 26px; text-align: center; color: var(--text); font-variant-numeric: tabular-nums; }
.ds-select {
  flex: 1; padding: 3px 6px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg-card); color: var(--text);
  outline: none; cursor: pointer;
}
.ds-select:focus { border-color: var(--accent); }
.ds-themes { display: flex; gap: 4px; }
.ds-swatch {
  width: 22px; height: 22px; border-radius: 5px;
  border: 2px solid transparent; cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08);
  transition: all 0.12s;
}
.ds-swatch:hover { transform: scale(1.15); }
.ds-swatch.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(192,146,110,0.3); }
</style>
