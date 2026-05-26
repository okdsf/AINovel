<script setup>
import { ref, nextTick } from 'vue'
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

function startMove(chId) {
  movingChId.value = chId
}

function cancelMove() {
  movingChId.value = null
}

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

async function handleDeleteChapter(volId, ch) {
  if (!confirm(t('tree.confirmDeleteChDetail', { title: ch.title }))) return
  await store.deleteChapter(volId, ch.id)
  if (route.params.chapterId === ch.id) {
    router.push('/')
  }
}
</script>

<template>
  <div v-if="store.meta">
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
      </div>

      <!-- Add chapter form -->
      <div v-if="addChapterFor === vol.id" style="margin: 6px 0 6px 16px;">
        <input
          v-model="newChTitle"
          type="text"
          :placeholder="t('tree.chapterTitlePh')"
          @keyup.enter="handleAddChapter(vol.id)"
          style="font-size: 12px; padding: 4px 8px;"
        />
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
            <input
              v-model="editTitle"
              class="rename-input"
              type="text"
              @keyup.enter="confirmRenameChapter"
              @keyup.escape="cancelRename"
              @blur="confirmRenameChapter"
              @click.stop
              style="font-size: 12px; padding: 2px 6px; flex: 1;"
            />
          </template>
          <template v-else>
            <span
              @dblclick.stop="startRenameChapter(ch)"
              :title="t('tree.dblToRename')"
              style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
            >{{ getChapterLabel(store.meta, ch.id) }} {{ ch.title }}</span>

            <span class="ch-actions" @click.stop>
              <button
                v-if="movingChId !== ch.id"
                class="move-btn"
                @click="startMove(ch.id)"
                :title="t('tree.moveChapter')"
              >&#8691;</button>
              <button
                v-if="movingChId !== ch.id"
                class="move-btn delete"
                @click="handleDeleteChapter(vol.id, ch)"
                :title="t('tree.deleteChapter')"
              >&times;</button>

              <template v-if="movingChId === ch.id">
                <button class="move-btn" @click="moveUp(vol, ci)" :disabled="ci === 0" :title="t('tree.moveUp')">&#9650;</button>
                <button class="move-btn" @click="moveDown(vol, ci)" :disabled="ci >= vol.chapters.length - 1" :title="t('tree.moveDown')">&#9660;</button>
                <button class="move-btn cancel" @click="cancelMove" :title="t('tree.moveDone')">&#10003;</button>
              </template>
            </span>
          </template>
        </div>
      </div>

      <div
        v-if="movingChId && !vol.chapters.find(c => c.id === movingChId)"
        class="move-to-vol"
        @click.stop="moveToVolume(movingChId, vol.id)"
      >
        {{ t('tree.moveTo', { name: `${getVolumeLabel(store.meta, vol.id)} ${vol.title}` }) }}
      </div>
    </div>

    <div v-if="!showAddVol" style="margin-top: 12px;">
      <button class="btn btn-sm" @click="showAddVol = true" style="width:100%; justify-content:center;">
        {{ t('tree.addVolumeBtn') }}
      </button>
    </div>
    <div v-else style="margin-top: 8px;">
      <input
        v-model="newVolTitle"
        type="text"
        :placeholder="t('tree.volumeTitlePh')"
        @keyup.enter="handleAddVolume"
        style="font-size: 12px; padding: 4px 8px;"
      />
      <div style="display:flex; gap:4px; margin-top:4px;">
        <button class="btn btn-sm btn-primary" @click="handleAddVolume">{{ t('tree.confirmBtn') }}</button>
        <button class="btn btn-sm" @click="showAddVol = false">{{ t('tree.cancelBtn') }}</button>
      </div>
    </div>
  </div>
  <div v-else class="text-muted text-center" style="padding: 20px;">
    {{ t('tree.loading') }}
  </div>
</template>

<style scoped>
.ch-actions {
  display: none;
  gap: 2px;
  margin-left: 4px;
  flex-shrink: 0;
}

.ch-item:hover .ch-actions,
.ch-item.moving .ch-actions {
  display: inline-flex;
}

.move-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 0 3px;
  color: var(--text-muted);
  line-height: 1;
}

.move-btn:hover {
  color: var(--accent);
}

.move-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.move-btn.cancel {
  color: var(--accent);
  font-weight: bold;
}

.move-btn.delete:hover {
  color: #c04040;
}

.ch-item.moving {
  background: #fdf6ee;
  outline: 1px dashed var(--accent);
}

.move-to-vol {
  margin: 4px 0 4px 16px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--accent);
  border: 1px dashed var(--accent);
  border-radius: var(--radius);
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
}

.move-to-vol:hover {
  background: var(--accent);
  color: white;
}
</style>
