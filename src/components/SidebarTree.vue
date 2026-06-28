<script setup>
import { ref, computed, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'
import { getVolumeLabel, getChapterLabel } from '../utils/numbering'

const store = useNovelStore()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()

const showAddVol = ref(false)
const newVolTitle = ref('')
const addChapterFor = ref(null)
const newChTitle = ref('')

const editingChId = ref(null)
const editingVolId = ref(null)
const editTitle = ref('')

const movingChId = ref(null)

const hasPath = computed(() => store.pathView.length > 0)

function toChineseNum(n) {
  const NUMS = ['零','一','二','三','四','五','六','七','八','九','十',
    '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
    '二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十',
    '三十一','三十二','三十三','三十四','三十五','三十六','三十七','三十八','三十九','四十',
    '四十一','四十二','四十三','四十四','四十五','四十六','四十七','四十八','四十九','五十']
  return n < NUMS.length ? NUMS[n] : String(n)
}

async function handleAddVolume() {
  if (!newVolTitle.value.trim()) return
  await store.addVolume(newVolTitle.value.trim())
  newVolTitle.value = ''
  showAddVol.value = false
}

async function handleAddChapter(volId) {
  if (!newChTitle.value.trim()) return
  const chId = await store.addChapter(volId, newChTitle.value.trim())
  newChTitle.value = ''
  addChapterFor.value = null
  router.push(`/read/${chId}`)
}

function isActive(chId) {
  return route.params.chapterId === chId
}

function startRenameChapter(ch) {
  editingChId.value = ch.id
  editingVolId.value = null
  editTitle.value = ch.title
  nextTick(() => {
    const input = document.querySelector('.rename-input')
    if (input) { input.focus(); input.select() }
  })
}

async function confirmRenameChapter() {
  if (!editTitle.value.trim() || !editingChId.value) return
  await store.renameChapter(editingChId.value, editTitle.value.trim())
  editingChId.value = null
}

function startRenameVolume(vol) {
  editingVolId.value = vol.id
  editingChId.value = null
  editTitle.value = vol.title
  nextTick(() => {
    const input = document.querySelector('.rename-input')
    if (input) { input.focus(); input.select() }
  })
}

async function confirmRenameVolume() {
  if (!editTitle.value.trim() || !editingVolId.value) return
  await store.renameVolume(editingVolId.value, editTitle.value.trim())
  editingVolId.value = null
}

function cancelRename() {
  editingChId.value = null
  editingVolId.value = null
}

function startMove(chId) { movingChId.value = chId }
function cancelMove() { movingChId.value = null }

async function moveUp(vol, chIndex) {
  if (chIndex === 0) return
  await store.moveChapter(vol.chapters[chIndex].id, vol.id, chIndex - 1)
}

async function moveDown(vol, chIndex) {
  if (chIndex >= vol.chapters.length - 1) return
  await store.moveChapter(vol.chapters[chIndex].id, vol.id, chIndex + 1)
}

async function moveToVolume(chId, targetVolId) {
  const targetVol = store.meta.volumes.find(v => v.id === targetVolId)
  if (!targetVol) return
  await store.moveChapter(chId, targetVolId, targetVol.chapters.length)
  movingChId.value = null
}

async function handleDeleteVolume(vol) {
  if (vol.chapters.length === 0) {
    if (!confirm(t('tree.confirmDeleteVolEmpty', { title: vol.title }))) return
    await store.deleteVolume(vol.id)
    return
  }
  if (store.meta.volumes.length <= 1) {
    if (!confirm(t('tree.confirmDeleteVolPurge', { title: vol.title, count: vol.chapters.length }))) return
    const openChIds = vol.chapters.map(c => c.id)
    await store.deleteVolume(vol.id)
    if (openChIds.includes(route.params.chapterId)) router.push('/')
    return
  }
  const choice = prompt(t('tree.confirmDeleteVolChoice', { title: vol.title, count: vol.chapters.length }))
  if (choice === null) return
  const c = choice.trim()
  if (c === '1') {
    const openChIds = vol.chapters.map(ch => ch.id)
    await store.deleteVolume(vol.id)
    if (openChIds.includes(route.params.chapterId)) router.push('/')
  } else if (c === '2') {
    await store.deleteVolume(vol.id, 'dissolve')
  }
}

async function handleDeleteChapter(volId, ch) {
  if (!confirm(t('tree.confirmDeleteChDetail', { title: ch.title }))) return
  await store.deleteChapter(volId, ch.id)
  if (route.params.chapterId === ch.id) router.push('/')
}

// --- Tree path mode operations ---
function startRenameTreeNode(ch) {
  editingChId.value = ch.id
  editTitle.value = ch.title
  nextTick(() => {
    const input = document.querySelector('.rename-input')
    if (input) { input.focus(); input.select() }
  })
}

async function confirmRenameTreeNode() {
  if (!editTitle.value.trim() || !editingChId.value) return
  await store.renameTreeNode(editingChId.value, editTitle.value.trim())
  editingChId.value = null
}

async function handleDeleteTreeNode(ch) {
  if (!confirm(t('tree.confirmDeleteChDetail', { title: ch.title }))) return
  await store.deleteTreeNode(ch.id)
  if (route.params.chapterId === ch.id) router.push('/')
}

async function moveTreeNodeUp(ch) {
  const idx = store.treePath.indexOf(ch.id)
  if (idx > 0) await store.swapTreeNodes(idx - 1, idx)
}

async function moveTreeNodeDown(ch) {
  const idx = store.treePath.indexOf(ch.id)
  if (idx >= 0 && idx < store.treePath.length - 1) await store.swapTreeNodes(idx, idx + 1)
}

function startRenameTreeVolume(volName) {
  editingVolId.value = volName
  editTitle.value = volName
  nextTick(() => {
    const input = document.querySelector('.rename-input')
    if (input) { input.focus(); input.select() }
  })
}

async function confirmRenameTreeVolume() {
  if (!editTitle.value.trim() || !editingVolId.value) return
  await store.renameTreeVolume(editingVolId.value, editTitle.value.trim())
  editingVolId.value = null
}
</script>

<template>
  <div v-if="store.meta">
    <!-- ═══ PATH MODE: tree path defines sidebar content ═══ -->
    <template v-if="hasPath">
      <div v-for="vol in store.pathView" :key="vol.name" class="vol-item">
        <div class="vol-title">
          <template v-if="editingVolId === vol.name">
            <input
              v-model="editTitle"
              class="rename-input"
              type="text"
              @keyup.enter="confirmRenameTreeVolume"
              @keyup.escape="cancelRename"
              @blur="confirmRenameTreeVolume"
              style="font-size: 13px; padding: 2px 6px; flex: 1;"
            />
          </template>
          <template v-else>
            <span @dblclick.stop="startRenameTreeVolume(vol.name)" :title="t('tree.dblToRename')">第{{ toChineseNum(vol.volNum) }}卷 {{ vol.name }}</span>
          </template>
        </div>
        <div class="ch-list">
          <div
            v-for="ch in vol.chapters"
            :key="ch.id"
            class="ch-item"
            :class="{ active: isActive(ch.id) }"
            @click="router.push(`/read/${ch.id}`)"
          >
            <template v-if="editingChId === ch.id">
              <input
                v-model="editTitle"
                class="rename-input"
                type="text"
                @keyup.enter="confirmRenameTreeNode"
                @keyup.escape="cancelRename"
                @blur="confirmRenameTreeNode"
                @click.stop
                style="font-size: 12px; padding: 2px 6px; flex: 1;"
              />
            </template>
            <template v-else>
              <span
                @dblclick.stop="startRenameTreeNode(ch)"
                :title="t('tree.dblToRename')"
                style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
              >第{{ toChineseNum(ch.chNum) }}章 {{ ch.title }}</span>
              <span class="ch-actions" @click.stop>
                <button class="move-btn" @click="moveTreeNodeUp(ch)" :disabled="store.treePath.indexOf(ch.id) === 0" :title="t('tree.moveUp')">&#9650;</button>
                <button class="move-btn" @click="moveTreeNodeDown(ch)" :disabled="store.treePath.indexOf(ch.id) >= store.treePath.length - 1" :title="t('tree.moveDown')">&#9660;</button>
                <button class="move-btn delete" @click="handleDeleteTreeNode(ch)" :title="t('tree.deleteChapter')">&times;</button>
              </span>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ FALLBACK: no tree path → original meta.json view ═══ -->
    <template v-else>
      <div v-for="vol in store.meta.volumes" :key="vol.id" class="vol-item">
        <div class="vol-title">
          <template v-if="editingVolId === vol.id">
            <input
              v-model="editTitle"
              class="rename-input"
              type="text"
              @keyup.enter="confirmRenameVolume"
              @keyup.escape="cancelRename"
              @blur="confirmRenameVolume"
              style="font-size: 13px; padding: 2px 6px; flex: 1;"
            />
          </template>
          <template v-else>
            <span @dblclick.stop="startRenameVolume(vol)" :title="t('tree.dblToRename')">{{ getVolumeLabel(store.meta, vol.id) }} {{ vol.title }}</span>
          </template>
          <button class="btn btn-sm" @click="addChapterFor = vol.id" :title="t('tree.addChapterTitle')">+</button>
          <button class="vol-del-btn" @click.stop="handleDeleteVolume(vol)" :title="t('tree.deleteVolume')">&times;</button>
        </div>

        <div v-if="addChapterFor === vol.id" style="margin: 6px 0 6px 16px;">
          <input v-model="newChTitle" type="text" :placeholder="t('tree.chapterTitlePh')" @keyup.enter="handleAddChapter(vol.id)" style="font-size: 12px; padding: 4px 8px;" />
          <div style="display:flex; gap:4px; margin-top:4px;">
            <button class="btn btn-sm btn-primary" @click="handleAddChapter(vol.id)">{{ t('tree.confirmBtn') }}</button>
            <button class="btn btn-sm" @click="addChapterFor = null">{{ t('tree.cancelBtn') }}</button>
          </div>
        </div>

        <div class="ch-list">
          <div
            v-for="(ch, ci) in vol.chapters"
            :key="ch.id"
            class="ch-item"
            :class="{ active: isActive(ch.id), moving: movingChId === ch.id }"
            @click="router.push(`/read/${ch.id}`)"
          >
            <template v-if="editingChId === ch.id">
              <input v-model="editTitle" class="rename-input" type="text" @keyup.enter="confirmRenameChapter" @keyup.escape="cancelRename" @blur="confirmRenameChapter" @click.stop style="font-size: 12px; padding: 2px 6px; flex: 1;" />
            </template>
            <template v-else>
              <span @dblclick.stop="startRenameChapter(ch)" :title="t('tree.dblToRename')" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ getChapterLabel(store.meta, ch.id) }} {{ ch.title }}</span>
              <span class="ch-actions" @click.stop>
                <button v-if="movingChId !== ch.id" class="move-btn" @click="startMove(ch.id)" :title="t('tree.moveChapter')">&#8691;</button>
                <button v-if="movingChId !== ch.id" class="move-btn delete" @click="handleDeleteChapter(vol.id, ch)" :title="t('tree.deleteChapter')">&times;</button>
                <template v-if="movingChId === ch.id">
                  <button class="move-btn" @click="moveUp(vol, ci)" :disabled="ci === 0" :title="t('tree.moveUp')">&#9650;</button>
                  <button class="move-btn" @click="moveDown(vol, ci)" :disabled="ci >= vol.chapters.length - 1" :title="t('tree.moveDown')">&#9660;</button>
                  <button class="move-btn cancel" @click="cancelMove" :title="t('tree.moveDone')">&#10003;</button>
                </template>
              </span>
            </template>
          </div>
        </div>

        <div v-if="movingChId && !vol.chapters.find(c => c.id === movingChId)" class="move-to-vol" @click.stop="moveToVolume(movingChId, vol.id)">
          {{ t('tree.moveTo', { name: `${getVolumeLabel(store.meta, vol.id)} ${vol.title}` }) }}
        </div>
      </div>

      <div v-if="!showAddVol" style="margin-top: 12px;">
        <button class="btn btn-sm" @click="showAddVol = true" style="width:100%; justify-content:center;">{{ t('tree.addVolumeBtn') }}</button>
      </div>
      <div v-else style="margin-top: 8px;">
        <input v-model="newVolTitle" type="text" :placeholder="t('tree.volumeTitlePh')" @keyup.enter="handleAddVolume" style="font-size: 12px; padding: 4px 8px;" />
        <div style="display:flex; gap:4px; margin-top:4px;">
          <button class="btn btn-sm btn-primary" @click="handleAddVolume">{{ t('tree.confirmBtn') }}</button>
          <button class="btn btn-sm" @click="showAddVol = false">{{ t('tree.cancelBtn') }}</button>
        </div>
      </div>
    </template>
  </div>
  <div v-else class="text-muted text-center" style="padding: 20px;">
    {{ t('tree.loading') }}
  </div>
</template>

<style scoped>
.ch-actions { display: none; gap: 2px; margin-left: 4px; flex-shrink: 0; }
.ch-item:hover .ch-actions, .ch-item.moving .ch-actions { display: inline-flex; }
.move-btn { background: none; border: none; cursor: pointer; font-size: 12px; padding: 0 3px; color: var(--text-muted); line-height: 1; }
.move-btn:hover { color: var(--accent); }
.move-btn:disabled { opacity: 0.3; cursor: default; }
.move-btn.cancel { color: var(--accent); font-weight: bold; }
.move-btn.delete:hover { color: #c04040; }
.ch-item.moving { background: #fdf6ee; outline: 1px dashed var(--accent); }
.move-to-vol { margin: 4px 0 4px 16px; padding: 6px 10px; font-size: 12px; color: var(--accent); border: 1px dashed var(--accent); border-radius: var(--radius); text-align: center; cursor: pointer; transition: all 0.15s; }
.move-to-vol:hover { background: var(--accent); color: white; }
.vol-del-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 3px; line-height: 1; color: var(--text-muted); opacity: 0; transition: opacity 0.15s; }
.vol-title:hover .vol-del-btn { opacity: 0.5; }
.vol-del-btn:hover { opacity: 1 !important; color: #c04040; }
</style>
