<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from '../i18n'
import { useSettingsStore } from '../stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()

const editorStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: String(settings.lineHeight),
}))

const groups = ref([])
const currentGroupId = ref('')
const groupTitle = ref('')
const titleDirty = ref(false)
const promptContent = ref('')
const promptDirty = ref(false)
const promptExpanded = ref(true)
const activeSlot = ref(1)
const responses = ref({ 1: '', 2: '', 3: '', 4: '', 5: '', 6: '' })
const responseDirty = ref({ 1: false, 2: false, 3: false, 4: false, 5: false, 6: false })
const message = ref('')
const saving = ref(false)
const loading = ref(false)

const expandedDrawer = ref('prompt')
const fullscreen = ref(null)

function goBackToList() {
  if (hasUnsaved() && !confirm(t('plab.confirmSwitch'))) return
  loadGroup('')
}

function toggleDrawer(key) {
  expandedDrawer.value = expandedDrawer.value === key ? null : key
}

function openFullscreen(key) {
  expandedDrawer.value = key
  fullscreen.value = key
}

function closeFullscreen() {
  fullscreen.value = null
}

function saveFullscreenSlot() {
  if (fullscreen.value === 'prompt') savePrompt()
  else if (typeof fullscreen.value === 'number') saveResponse(fullscreen.value)
}

const fsWordCount = computed(() => {
  if (fullscreen.value === 'prompt') return promptWordCount.value
  if (typeof fullscreen.value === 'number') return (responses.value[fullscreen.value] || '').replace(/\s/g, '').length
  return 0
})

const fsDirty = computed(() => {
  if (fullscreen.value === 'prompt') return promptDirty.value
  if (typeof fullscreen.value === 'number') return responseDirty.value[fullscreen.value]
  return false
})

const compareMode = ref(false)
const compareSlotA = ref(1)
const compareSlotB = ref(2)
const compareContentA = ref('')
const compareContentB = ref('')
const compareDirtyA = ref(false)
const compareDirtyB = ref(false)

async function fetchGroups() {
  const res = await fetch('/api/prompt-groups')
  groups.value = await res.json()
}

function hasUnsaved() {
  if (titleDirty.value || promptDirty.value) return true
  for (let i = 1; i <= 6; i++) if (responseDirty.value[i]) return true
  return false
}

async function selectGroup(id) {
  if (id === currentGroupId.value) return
  if (currentGroupId.value && hasUnsaved() && !confirm(t('plab.confirmSwitch'))) return
  await loadGroup(id)
}

async function loadGroup(id) {
  if (!id) {
    currentGroupId.value = ''
    groupTitle.value = ''
    promptContent.value = ''
    promptDirty.value = false
    titleDirty.value = false
    responses.value = { 1: '', 2: '', 3: '', 4: '', 5: '', 6: '' }
    responseDirty.value = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false }
    return
  }
  loading.value = true
  try {
    const res = await fetch(`/api/prompt-groups/${id}`)
    const data = await res.json()
    currentGroupId.value = data.id
    groupTitle.value = data.title
    promptContent.value = data.prompt || ''
    promptDirty.value = false
    titleDirty.value = false
    const r = {}
    const rd = {}
    for (let i = 1; i <= 6; i++) {
      r[i] = data.responses?.[i] || ''
      rd[i] = false
    }
    responses.value = r
    responseDirty.value = rd
  } finally {
    loading.value = false
  }
}

async function newGroup() {
  if (hasUnsaved() && !confirm(t('plab.confirmNew'))) return
  saving.value = true
  try {
    const res = await fetch('/api/prompt-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' })
    })
    const data = await res.json()
    await fetchGroups()
    await loadGroup(data.id)
    promptExpanded.value = true
    activeSlot.value = 1
    showMsg(t('plab.created'))
  } catch (e) {
    showMsg(t('plab.createFailed', { error: e.message }))
  } finally {
    saving.value = false
  }
}

async function deleteGroup(id) {
  const g = groups.value.find(x => x.id === id)
  if (!confirm(t('plab.confirmDelete', { title: g?.title || id }))) return
  await fetch(`/api/prompt-groups/${id}`, { method: 'DELETE' })
  await fetchGroups()
  if (currentGroupId.value === id) await loadGroup('')
}

async function saveTitle({ silent = false } = {}) {
  if (!currentGroupId.value || !titleDirty.value) return
  saving.value = true
  try {
    await fetch(`/api/prompt-groups/${currentGroupId.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: groupTitle.value })
    })
    titleDirty.value = false
    await fetchGroups()
    if (!silent) showMsg(t('plab.titleSaved'))
  } catch (e) {
    if (!silent) showMsg(t('plab.saveFailed', { error: e.message }))
  } finally {
    saving.value = false
  }
}

async function savePrompt({ silent = false } = {}) {
  if (!currentGroupId.value || !promptDirty.value) return
  saving.value = true
  try {
    await fetch(`/api/prompt-groups/${currentGroupId.value}/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: promptContent.value })
    })
    promptDirty.value = false
    if (!silent) showMsg(t('plab.promptSaved'))
  } catch (e) {
    if (!silent) showMsg(t('plab.saveFailed', { error: e.message }))
  } finally {
    saving.value = false
  }
}

async function saveResponse(slot, { silent = false } = {}) {
  if (!currentGroupId.value || !responseDirty.value[slot]) return
  saving.value = true
  try {
    await fetch(`/api/prompt-groups/${currentGroupId.value}/r/${slot}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: responses.value[slot] })
    })
    responseDirty.value[slot] = false
    if (!silent) showMsg(t('plab.slotSaved', { n: slot }))
  } catch (e) {
    if (!silent) showMsg(t('plab.saveFailed', { error: e.message }))
  } finally {
    saving.value = false
  }
}

function onResponseInput(slot, value) {
  responses.value[slot] = value
  if (!loading.value) {
    responseDirty.value[slot] = true
    scheduleAutoSaveResponse(slot)
  }
}

function startCompare() {
  compareMode.value = true
  compareSlotA.value = activeSlot.value
  compareSlotB.value = activeSlot.value < 6 ? activeSlot.value + 1 : 1
  compareContentA.value = responses.value[compareSlotA.value] || ''
  compareContentB.value = responses.value[compareSlotB.value] || ''
  compareDirtyA.value = false
  compareDirtyB.value = false
}

async function saveCompareSide(side, { silent = false } = {}) {
  const slot = side === 'A' ? compareSlotA.value : compareSlotB.value
  const content = side === 'A' ? compareContentA.value : compareContentB.value
  if (!currentGroupId.value) return
  saving.value = true
  try {
    await fetch(`/api/prompt-groups/${currentGroupId.value}/r/${slot}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })
    responses.value[slot] = content
    responseDirty.value[slot] = false
    if (side === 'A') compareDirtyA.value = false
    else compareDirtyB.value = false
    if (!silent) showMsg(t('plab.slotSaved', { n: slot }))
  } catch (e) {
    if (!silent) showMsg(t('plab.saveFailed', { error: e.message }))
  } finally {
    saving.value = false
  }
}

let compareTimerA = null
let compareTimerB = null
function scheduleAutoSaveCompare(side) {
  if (side === 'A') {
    if (compareTimerA) clearTimeout(compareTimerA)
    compareTimerA = setTimeout(() => { compareTimerA = null; saveCompareSide('A', { silent: true }) }, AUTOSAVE_MS)
  } else {
    if (compareTimerB) clearTimeout(compareTimerB)
    compareTimerB = setTimeout(() => { compareTimerB = null; saveCompareSide('B', { silent: true }) }, AUTOSAVE_MS)
  }
}
function onCompareInput(side, value) {
  if (side === 'A') { compareContentA.value = value; compareDirtyA.value = true }
  else { compareContentB.value = value; compareDirtyB.value = true }
  scheduleAutoSaveCompare(side)
}

function exitCompare() {
  if ((compareDirtyA.value || compareDirtyB.value) &&
      !confirm(t('plab.confirmExitCompare'))) return
  if (compareDirtyA.value) {
    responses.value[compareSlotA.value] = compareContentA.value
    responseDirty.value[compareSlotA.value] = true
  }
  if (compareDirtyB.value) {
    responses.value[compareSlotB.value] = compareContentB.value
    responseDirty.value[compareSlotB.value] = true
  }
  compareMode.value = false
}

watch(compareSlotA, (val) => {
  compareContentA.value = responses.value[val] || ''
  compareDirtyA.value = false
})
watch(compareSlotB, (val) => {
  compareContentB.value = responses.value[val] || ''
  compareDirtyB.value = false
})

const AUTOSAVE_MS = 1000
let titleTimer = null
let promptTimer = null
const responseTimers = {}

function scheduleAutoSaveTitle() {
  if (titleTimer) clearTimeout(titleTimer)
  titleTimer = setTimeout(() => { titleTimer = null; saveTitle({ silent: true }) }, AUTOSAVE_MS)
}
function scheduleAutoSavePrompt() {
  if (promptTimer) clearTimeout(promptTimer)
  promptTimer = setTimeout(() => { promptTimer = null; savePrompt({ silent: true }) }, AUTOSAVE_MS)
}
function scheduleAutoSaveResponse(slot) {
  if (responseTimers[slot]) clearTimeout(responseTimers[slot])
  responseTimers[slot] = setTimeout(() => { responseTimers[slot] = null; saveResponse(slot, { silent: true }) }, AUTOSAVE_MS)
}

watch(groupTitle, () => {
  if (currentGroupId.value && !loading.value) {
    titleDirty.value = true
    scheduleAutoSaveTitle()
  }
})
watch(promptContent, () => {
  if (currentGroupId.value && !loading.value) {
    promptDirty.value = true
    scheduleAutoSavePrompt()
  }
})

const activeWordCount = computed(() => (responses.value[activeSlot.value] || '').replace(/\s/g, '').length)
const promptWordCount = computed(() => (promptContent.value || '').replace(/\s/g, '').length)
const compareWordCountA = computed(() => (compareContentA.value || '').replace(/\s/g, '').length)
const compareWordCountB = computed(() => (compareContentB.value || '').replace(/\s/g, '').length)

function slotHasContent(slot) {
  return (responses.value[slot] || '').trim().length > 0
}

function showMsg(text) {
  message.value = text
  setTimeout(() => message.value = '', 2000)
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const min = d.getMinutes().toString().padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day} ${h}:${min}`
}

onMounted(fetchGroups)
</script>

<template>
  <div class="pl-root">
    <!-- ====== Fullscreen editor overlay ====== -->
    <Teleport to="body">
      <div v-if="fullscreen" class="pl-fs">
        <div class="pl-fs-bar">
          <span class="pl-fs-label">{{ fullscreen === 'prompt' ? 'Prompt' : 'R' + fullscreen }}</span>
          <span class="pl-fs-meta">{{ t('drafts.wordCount', { count: fsWordCount.toLocaleString() }) }}</span>
          <span v-if="fsDirty" class="pl-fs-dirty">{{ t('plab.unsaved') }}</span>
          <div style="flex:1"></div>
          <button class="pl-fs-btn pl-fs-save" @click="saveFullscreenSlot" :disabled="saving || !fsDirty">{{ t('common.save') }}</button>
          <button class="pl-fs-btn" @click="closeFullscreen">✕</button>
        </div>
        <!-- Prompt fullscreen -->
        <textarea v-if="fullscreen === 'prompt'" v-model="promptContent" class="pl-fs-editor" :style="editorStyle" :placeholder="t('plab.promptPh')" spellcheck="false"></textarea>
        <!-- Response fullscreen -->
        <textarea v-else :value="responses[fullscreen]" @input="e => onResponseInput(fullscreen, e.target.value)" class="pl-fs-editor" :style="editorStyle" :placeholder="t('plab.responsePh', { n: fullscreen })" spellcheck="false"></textarea>
      </div>
    </Teleport>

    <p v-if="message" class="pl-message">{{ message }}</p>

    <!-- ====== Group cards grid (no group selected) ====== -->
    <div v-if="!currentGroupId && !compareMode" class="pl-grid-view">
      <div class="pl-grid-bar">
        <span class="pl-grid-title">{{ t('plab.promptLab') || 'Prompt Lab' }}</span>
        <button class="d-text-btn d-btn-primary" @click="newGroup" :disabled="saving">{{ t('plab.newGroup') }}</button>
      </div>
      <div v-if="groups.length === 0" class="pl-grid-empty">{{ t('plab.empty') }}</div>
      <div class="pl-grid">
        <div v-for="g in groups" :key="g.id" class="pl-card" @click="selectGroup(g.id)">
          <div class="pl-card-title">{{ g.title }}</div>
          <div class="pl-card-time">{{ fmtTime(g.updatedAt) }}</div>
          <button class="pl-card-del" @click.stop="deleteGroup(g.id)" :title="t('common.delete')">×</button>
        </div>
      </div>
    </div>

    <!-- ====== Inside a group: drawer view ====== -->
    <div v-else-if="currentGroupId && !compareMode" class="pl-drawer-view">
      <!-- Group header -->
      <div class="pl-group-bar">
        <button class="d-icon-btn" @click="goBackToList" :title="t('common.back')">←</button>
        <input v-model="groupTitle" class="pl-group-title" :placeholder="t('plab.groupTitlePh')" />
        <span v-if="titleDirty" class="pl-fs-dirty">{{ t('plab.unsaved') }}</span>
        <button class="d-text-btn" @click="saveTitle" :disabled="saving || !titleDirty">{{ t('plab.saveTitle') }}</button>
        <div style="flex:1"></div>
        <button class="d-icon-btn" @click="startCompare" :title="t('plab.compareBtn')">⇄</button>
        <button class="d-icon-btn" @click="deleteGroup(currentGroupId)" :title="t('common.delete')">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M6 2a1 1 0 00-1 1v1H3v2h14V4h-2V3a1 1 0 00-1-1H6zm0 2V3h8v1H6zM4 7v9a2 2 0 002 2h8a2 2 0 002-2V7H4zm3 2h2v7H7V9zm4 0h2v7h-2V9z"/></svg>
        </button>
      </div>

      <!-- Drawers -->
      <div class="pl-drawers">
        <!-- Prompt drawer -->
        <div class="pl-drawer" :class="{ open: expandedDrawer === 'prompt' }">
          <div class="pl-drawer-head" @click="toggleDrawer('prompt')">
            <span class="pl-drawer-arrow">{{ expandedDrawer === 'prompt' ? '▼' : '▶' }}</span>
            <span class="pl-drawer-label">Prompt</span>
            <span class="pl-drawer-meta">{{ t('drafts.wordCount', { count: promptWordCount }) }}</span>
            <span v-if="promptDirty" class="pl-drawer-dot"></span>
            <div style="flex:1"></div>
            <button class="pl-drawer-action" @click.stop="savePrompt" :disabled="saving || !promptDirty">{{ t('common.save') }}</button>
            <button class="pl-drawer-action" @click.stop="openFullscreen('prompt')" :title="t('plab.fullscreen')">⤢</button>
          </div>
          <div v-if="expandedDrawer === 'prompt'" class="pl-drawer-body">
            <textarea v-model="promptContent" class="pl-drawer-editor" :style="editorStyle" :placeholder="t('plab.promptPh')"></textarea>
          </div>
        </div>

        <!-- Response drawers R1-R6 -->
        <div v-for="i in 6" :key="i" class="pl-drawer" :class="{ open: expandedDrawer === i }">
          <div class="pl-drawer-head" @click="toggleDrawer(i)">
            <span class="pl-drawer-arrow">{{ expandedDrawer === i ? '▼' : '▶' }}</span>
            <span class="pl-drawer-label">R{{ i }}</span>
            <span class="pl-drawer-meta">{{ t('drafts.wordCount', { count: (responses[i] || '').replace(/\s/g, '').length }) }}</span>
            <span v-if="slotHasContent(i)" class="pl-drawer-dot"></span>
            <span v-if="responseDirty[i]" class="pl-drawer-dot dirty"></span>
            <div style="flex:1"></div>
            <button class="pl-drawer-action" @click.stop="saveResponse(i)" :disabled="saving || !responseDirty[i]">{{ t('common.save') }}</button>
            <button class="pl-drawer-action" @click.stop="openFullscreen(i)" :title="t('plab.fullscreen')">⤢</button>
          </div>
          <div v-if="expandedDrawer === i" class="pl-drawer-body">
            <textarea :value="responses[i]" @input="e => onResponseInput(i, e.target.value)" class="pl-drawer-editor" :style="editorStyle" :placeholder="t('plab.responsePh', { n: i })"></textarea>
          </div>
        </div>
      </div>
    </div>

    <!-- ====== Compare mode (fullscreen split) ====== -->
    <div v-if="compareMode" class="pl-compare-view">
      <div class="pl-group-bar">
        <button class="d-icon-btn" @click="exitCompare">←</button>
        <span class="pl-grid-title">{{ t('plab.compareTitle', { title: groupTitle }) }}</span>
      </div>
      <div class="pl-compare-body">
        <div class="pl-compare-side" v-for="(slot, side) in { A: compareSlotA, B: compareSlotB }" :key="side">
          <div class="pl-compare-head">
            <select class="pl-compare-sel" :value="slot" @change="side === 'A' ? (compareSlotA = +$event.target.value) : (compareSlotB = +$event.target.value)">
              <option v-for="i in 6" :key="i" :value="i">R{{ i }}{{ slotHasContent(i) ? ' ●' : '' }}</option>
            </select>
            <button class="d-text-btn d-btn-save" @click="saveCompareSide(side)" :disabled="saving || !(side === 'A' ? compareDirtyA : compareDirtyB)">
              {{ t('plab.saveSlot', { n: slot }) }}
            </button>
          </div>
          <textarea class="pl-compare-editor" :style="editorStyle"
            :value="side === 'A' ? compareContentA : compareContentB"
            @input="onCompareInput(side, $event.target.value)"
          ></textarea>
          <div class="pl-compare-foot">
            <span class="pl-drawer-meta">{{ t('drafts.wordCount', { count: (side === 'A' ? compareWordCountA : compareWordCountB).toLocaleString() }) }}</span>
            <span v-if="side === 'A' ? compareDirtyA : compareDirtyB" class="pl-fs-dirty">{{ t('plab.unsaved') }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pl-root {
  display: flex; flex-direction: column;
  height: 100%; overflow: hidden;
}
.pl-message { color: var(--accent); font-size: 12px; padding: 0 4px 8px; flex-shrink: 0; }

/* ── Group cards grid ── */
.pl-grid-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.pl-grid-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 4px 16px; flex-shrink: 0;
}
.pl-grid-title { font-family: var(--font-reading); font-size: 16px; font-weight: 600; }
.pl-grid-empty { text-align: center; padding: 40px; color: var(--text-muted); font-size: 13px; }
.pl-grid {
  flex: 1; overflow-y: auto;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px; padding: 4px; align-content: start;
}
.pl-card {
  position: relative;
  padding: 16px; border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  cursor: pointer; transition: all 0.15s;
}
.pl-card:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.pl-card-title { font-size: 14px; font-weight: 500; margin-bottom: 6px; }
.pl-card-time { font-size: 11px; color: var(--text-muted); }
.pl-card-del {
  position: absolute; top: 8px; right: 8px;
  background: none; border: none; font-size: 16px;
  color: var(--text-muted); cursor: pointer;
  opacity: 0; transition: opacity 0.15s;
}
.pl-card:hover .pl-card-del { opacity: 0.5; }
.pl-card-del:hover { opacity: 1 !important; color: #c44; }

/* ── Group header bar ── */
.pl-group-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 0 10px; flex-shrink: 0;
}
.pl-group-title {
  flex: 1; min-width: 0;
  font-size: 15px; font-weight: 500;
  padding: 4px 8px; border: 1px solid transparent;
  border-radius: 4px; background: transparent;
  color: var(--text); outline: none; transition: all 0.15s;
}
.pl-group-title:focus { border-color: var(--accent); background: var(--bg-card); }

/* ── Drawer view ── */
.pl-drawer-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.pl-drawers { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }

.pl-drawer {
  border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; flex-shrink: 0;
  transition: flex 0.2s;
}
.pl-drawer.open { flex: 1; display: flex; flex-direction: column; min-height: 150px; }

.pl-drawer-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: var(--bg-card);
  cursor: pointer; user-select: none;
  transition: background 0.15s;
}
.pl-drawer-head:hover { background: rgba(0,0,0,0.03); }
.pl-drawer-arrow { font-size: 10px; color: var(--text-muted); width: 12px; }
.pl-drawer-label { font-weight: 600; font-size: 13px; }
.pl-drawer-meta { font-size: 11px; color: var(--text-muted); }
.pl-drawer-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); flex-shrink: 0;
}
.pl-drawer-dot.dirty { background: #e8a040; }
.pl-drawer-action {
  padding: 2px 10px; font-size: 11px;
  border: 1px solid var(--border); border-radius: 4px;
  background: none; color: var(--text); cursor: pointer;
  transition: all 0.12s;
}
.pl-drawer-action:hover { border-color: var(--accent); color: var(--accent); }
.pl-drawer-action:disabled { opacity: 0.3; cursor: not-allowed; }

.pl-drawer-body { flex: 1; display: flex; padding: 6px; min-height: 0; }
.pl-drawer-editor {
  flex: 1; width: 100%; padding: 10px;
  font-family: var(--font-reading); font-size: 14px; line-height: 1.8;
  border: none; outline: none; resize: none;
  background: var(--bg); color: var(--text);
  box-sizing: border-box;
}

/* ── Fullscreen overlay ── */
.pl-fs {
  position: fixed; inset: 0; z-index: 9998;
  display: flex; flex-direction: column;
  background: var(--bg);
}
.pl-fs-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px; border-bottom: 1px solid var(--border);
  background: var(--bg-card); flex-shrink: 0;
}
.pl-fs-label { font-weight: 600; font-size: 14px; }
.pl-fs-meta { font-size: 11px; color: var(--text-muted); }
.pl-fs-dirty { font-size: 11px; color: var(--accent); }
.pl-fs-btn {
  padding: 4px 14px; font-size: 13px;
  border: 1px solid var(--border); border-radius: 6px;
  background: none; color: var(--text); cursor: pointer;
  transition: all 0.15s;
}
.pl-fs-btn:hover { border-color: var(--accent); color: var(--accent); }
.pl-fs-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pl-fs-save { background: var(--accent); color: #fff; border-color: var(--accent); }
.pl-fs-save:hover { opacity: 0.85; color: #fff; }
.pl-fs-editor {
  flex: 1; width: 100%;
  padding: 40px 60px;
  font-family: var(--font-reading); font-size: 16px; line-height: 1.9;
  border: none; outline: none; resize: none;
  background: var(--bg); color: var(--text);
}

/* ── Compare mode ── */
.pl-compare-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.pl-compare-body {
  flex: 1; display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0; overflow: hidden;
}
.pl-compare-side {
  display: flex; flex-direction: column;
  border-right: 1px solid var(--border); overflow: hidden;
}
.pl-compare-side:last-child { border-right: none; }
.pl-compare-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.pl-compare-sel {
  flex: 1; font-size: 12px; padding: 4px 6px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-card); color: var(--text); outline: none;
}
.pl-compare-editor {
  flex: 1; width: 100%; padding: 16px;
  font-family: var(--font-reading); font-size: 14px; line-height: 1.8;
  border: none; outline: none; resize: none;
  background: var(--bg); color: var(--text); box-sizing: border-box;
}
.pl-compare-foot {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-top: 1px solid var(--border); flex-shrink: 0;
}
</style>
