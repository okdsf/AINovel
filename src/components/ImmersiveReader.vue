<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { marked } from 'marked'
import { useNovelStore } from '../stores/novel'
import { useSettingsStore } from '../stores/settings'
import { useI18n } from '../i18n'
import { getChapterDisplay, getChapterLabel, getVolumeLabel } from '../utils/numbering'

const props = defineProps({ chapterId: String })
const emit = defineEmits(['close'])

const store = useNovelStore()
const settings = useSettingsStore()
const { t } = useI18n()

const content = ref('')
const currentChapterId = ref(props.chapterId)
const currentSpread = ref(0)
const totalSpreads = ref(1)

const bookRef = ref(null)
const innerRef = ref(null)
const measureRef = ref(null)
const transitioning = ref(false)

// Floating settings panel
const showSettings = ref(false)
// Floating chapter list panel
const showChapters = ref(false)
const chapterListRef = ref(null)
// Bookmarks
const showBookmarks = ref(false)
const bookmarks = ref([])
const BM_KEY = 'novelweb-bookmarks'

function loadBookmarks() {
  try { bookmarks.value = JSON.parse(localStorage.getItem(BM_KEY) || '[]') } catch { bookmarks.value = [] }
}
function saveBookmarks() {
  localStorage.setItem(BM_KEY, JSON.stringify(bookmarks.value))
}

const isBookmarked = computed(() =>
  bookmarks.value.some(b => b.chapterId === currentChapterId.value && b.spread === currentSpread.value)
)

function toggleBookmark() {
  const idx = bookmarks.value.findIndex(b => b.chapterId === currentChapterId.value && b.spread === currentSpread.value)
  if (idx >= 0) {
    bookmarks.value.splice(idx, 1)
  } else {
    const display = getChapterDisplay(store.meta, currentChapterId.value)
    bookmarks.value.unshift({
      chapterId: currentChapterId.value,
      spread: currentSpread.value,
      label: display.fullTitle || display.chLabel,
      page: currentSpread.value + 1,
      time: Date.now(),
    })
  }
  saveBookmarks()
}

async function jumpToBookmark(bm) {
  showBookmarks.value = false
  if (bm.chapterId !== currentChapterId.value) {
    transitioning.value = true
    await loadChapter(bm.chapterId, false)
    transitioning.value = false
  }
  currentSpread.value = Math.min(bm.spread, Math.max(0, totalSpreads.value - 1))
}

function removeBookmark(idx) {
  bookmarks.value.splice(idx, 1)
  saveBookmarks()
}

function toggleBookmarkPanel() {
  if (showSettings.value) showSettings.value = false
  if (showChapters.value) showChapters.value = false
  showBookmarks.value = !showBookmarks.value
}

// Edit mode — only edits the current visible page's paragraphs
const editMode = ref(false)
const editContent = ref('')
const editSaving = ref(false)
const editRange = ref(null) // { start, end } byte offsets in content


// Page flip animation
const flipActive = ref(false)
const flipDir = ref('next')
const flipOldTranslateX = ref('0px')
// Snapshot of outgoing chapter HTML for cross-chapter flips (empty = use current renderedHtml)
const flipHtml = ref('')

const GAP = 80
const PAD_H = GAP / 2
const PAD_V = 40

const colWidthPx = ref(400)
const pageHeightPx = ref(500)
const spreadWidthPx = ref(1000)

const chapterDisplay = computed(() => getChapterDisplay(store.meta, currentChapterId.value))

const readingStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: String(settings.lineHeight),
}))

const renderedHtml = computed(() => {
  const title = chapterDisplay.value.fullTitle
  const titleHtml = title ? `<h2 style="text-align:center; margin-bottom: 1.2em; font-weight: 600;">${title}</h2>` : ''
  return titleHtml + marked(content.value || '')
})

function measure() {
  const book = bookRef.value
  const meas = measureRef.value
  if (!book || !meas) return

  const bw = book.clientWidth
  const bh = book.clientHeight
  if (bw <= 0 || bh <= 0) return

  spreadWidthPx.value = bw
  const cw = (bw - 2 * GAP) / 2
  colWidthPx.value = cw
  const ph = bh - 2 * PAD_V
  pageHeightPx.value = ph

  meas.style.width = cw + 'px'
  meas.style.padding = PAD_V + 'px ' + PAD_H + 'px'
  meas.style.fontSize = settings.fontSize + 'px'
  meas.style.lineHeight = String(settings.lineHeight)
  meas.style.fontFamily = settings.currentFont().family
  void meas.offsetHeight

  const contentHeight = meas.scrollHeight - 2 * PAD_V
  const columnsNeeded = Math.max(1, Math.ceil(contentHeight / ph))
  totalSpreads.value = Math.max(1, Math.ceil(columnsNeeded / 2))
}

function refineSpreads() {
  const inner = innerRef.value
  if (!inner) return

  let lastEl = inner.lastElementChild
  while (lastEl && lastEl.getBoundingClientRect().width === 0) {
    lastEl = lastEl.previousElementSibling
  }
  if (!lastEl) { totalSpreads.value = 1; return }

  const innerRect = inner.getBoundingClientRect()
  const lastRect = lastEl.getBoundingClientRect()
  const relLeft = lastRect.left - innerRect.left
  const colSpan = colWidthPx.value + GAP
  const lastCol = Math.max(0, Math.floor(relLeft / colSpan))
  totalSpreads.value = Math.max(1, Math.ceil((lastCol + 1) / 2))
}

function getAllChapters() {
  if (!store.meta) return []
  const all = []
  for (const vol of store.meta.volumes) {
    for (const ch of vol.chapters) all.push(ch.id)
  }
  return all
}

const volumeList = computed(() => {
  if (!store.meta) return []
  return store.meta.volumes.map(vol => ({
    id: vol.id,
    title: vol.title,
    volLabel: getVolumeLabel(store.meta, vol.id),
    chapters: vol.chapters.map(ch => ({
      id: ch.id,
      title: ch.title,
      chLabel: getChapterLabel(store.meta, ch.id),
    })),
  }))
})

async function jumpToChapter(chId) {
  showChapters.value = false
  if (chId === currentChapterId.value) return
  transitioning.value = true
  await loadChapter(chId, false)
  setTimeout(() => { transitioning.value = false }, 200)
}

function toggleChapters() {
  if (showSettings.value) showSettings.value = false
  showChapters.value = !showChapters.value
  if (showChapters.value) {
    nextTick(() => {
      const el = chapterListRef.value?.querySelector('.cl-chapter.active')
      if (el) el.scrollIntoView({ block: 'center' })
    })
  }
}

function getAdjacentChapter(delta) {
  const all = getAllChapters()
  const idx = all.indexOf(currentChapterId.value)
  const ni = idx + delta
  if (ni < 0 || ni >= all.length) return null
  return all[ni]
}

async function loadChapter(chId, goToLast = false, keepFlip = false) {
  if (!keepFlip) flipActive.value = false
  currentChapterId.value = chId
  content.value = await store.getChapterContent(chId)
  currentSpread.value = 0
  await nextTick()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      measure()
      nextTick().then(() => {
        refineSpreads()
        if (goToLast) {
          currentSpread.value = Math.max(0, totalSpreads.value - 1)
        }
      })
    })
  })
}

function turnPage(delta) {
  if (transitioning.value || flipActive.value) return
  const target = currentSpread.value + delta

  if (target < 0) {
    const prev = getAdjacentChapter(-1)
    if (prev) {
      flipHtml.value = renderedHtml.value
      flipOldTranslateX.value = `-${currentSpread.value * spreadWidthPx.value}px`
      flipDir.value = 'prev'
      flipActive.value = true
      transitioning.value = true
      loadChapter(prev, true, true).then(() => {
        setTimeout(() => { transitioning.value = false }, 200)
      })
    }
    return
  }

  if (target >= totalSpreads.value) {
    const next = getAdjacentChapter(1)
    if (next) {
      flipHtml.value = renderedHtml.value
      flipOldTranslateX.value = `-${currentSpread.value * spreadWidthPx.value}px`
      flipDir.value = 'next'
      flipActive.value = true
      transitioning.value = true
      loadChapter(next, false, true).then(() => {
        setTimeout(() => { transitioning.value = false }, 200)
      })
    }
    return
  }

  flipOldTranslateX.value = `-${currentSpread.value * spreadWidthPx.value}px`
  flipDir.value = delta > 0 ? 'next' : 'prev'
  flipActive.value = true
  currentSpread.value = target
}

function onFlipEnd() {
  flipActive.value = false
  flipHtml.value = ''
}

function handleClick(e) {
  if (showSettings.value) {
    showSettings.value = false
    return
  }
  if (showChapters.value) {
    showChapters.value = false
    return
  }
  const rect = bookRef.value.getBoundingClientRect()
  const ratio = (e.clientX - rect.left) / rect.width
  if (ratio < 0.35) turnPage(-1)
  else if (ratio > 0.65) turnPage(1)
}

function buildParaMap(text) {
  const map = []
  const regex = /(?:\r?\n|\r){2,}/g
  let lastEnd = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    if (text.slice(lastEnd, match.index).trim()) {
      map.push({ start: lastEnd, end: match.index })
    }
    lastEnd = match.index + match[0].length
  }
  if (text.slice(lastEnd).trim()) {
    map.push({ start: lastEnd, end: text.length })
  }
  return map
}

function getVisibleParaIndices() {
  const inner = innerRef.value
  const book = bookRef.value
  if (!inner || !book) return null

  const bookRect = book.getBoundingClientRect()
  const paragraphs = []
  for (const el of inner.children) {
    if (el.tagName === 'P' && el.offsetWidth > 0) paragraphs.push(el)
  }
  if (paragraphs.length === 0) return null

  let first = -1, last = -1
  paragraphs.forEach((p, idx) => {
    const r = p.getBoundingClientRect()
    if (r.width > 0 && r.right > bookRect.left + 10 && r.left < bookRect.right - 10) {
      if (first === -1) first = idx
      last = idx
    }
  })
  return first >= 0 ? { first, last } : null
}

function enterEdit() {
  showSettings.value = false
  showChapters.value = false

  const vis = getVisibleParaIndices()
  const map = buildParaMap(content.value)

  if (vis && map.length > 0) {
    const fi = Math.min(vis.first, map.length - 1)
    const li = Math.min(vis.last, map.length - 1)
    const range = { start: map[fi].start, end: map[li].end }
    editRange.value = range
    editContent.value = content.value.slice(range.start, range.end)
  } else {
    editRange.value = null
    editContent.value = content.value
  }
  editMode.value = true
}

async function saveEdit() {
  editSaving.value = true
  try {
    let newContent
    if (editRange.value) {
      newContent = content.value.slice(0, editRange.value.start) + editContent.value + content.value.slice(editRange.value.end)
    } else {
      newContent = editContent.value
    }
    await store.saveChapterContent(currentChapterId.value, newContent)
    content.value = newContent
    editRange.value = null
    editMode.value = false
    // Re-measure with new content, keep current spread
    await nextTick()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        measure()
        nextTick().then(() => {
          refineSpreads()
          if (currentSpread.value >= totalSpreads.value) {
            currentSpread.value = Math.max(0, totalSpreads.value - 1)
          }
        })
      })
    })
  } finally {
    editSaving.value = false
  }
}

function cancelEdit() {
  editMode.value = false
  editRange.value = null
}

function handleKeydown(e) {
  if (editMode.value) {
    if (e.key === 'Escape') cancelEdit()
    return
  }
  if (e.key === 'Escape') {
    if (showSettings.value) showSettings.value = false
    else if (showChapters.value) showChapters.value = false
    else emit('close')
  } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
    if (showChapters.value || showSettings.value) return
    e.preventDefault(); turnPage(1)
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    if (showChapters.value || showSettings.value) return
    e.preventDefault(); turnPage(-1)
  }
}

function changeFontSize(delta) {
  settings.fontSize = Math.max(12, Math.min(28, settings.fontSize + delta))
}

function changeLineHeight(delta) {
  settings.lineHeight = Math.max(1.2, Math.min(3.0, +(settings.lineHeight + delta).toFixed(1)))
}

const progress = computed(() => {
  const all = getAllChapters()
  const chIdx = all.indexOf(currentChapterId.value)
  return t('immersive.progress', {
    ch: chIdx + 1,
    page: currentSpread.value + 1,
    total: totalSpreads.value,
  })
})

const progressPercent = computed(() => {
  if (totalSpreads.value <= 1) return 100
  return Math.round((currentSpread.value / (totalSpreads.value - 1)) * 100)
})

const translateX = computed(() => `-${currentSpread.value * spreadWidthPx.value}px`)

const innerDynStyle = computed(() => ({
  ...readingStyle.value,
  width: (spreadWidthPx.value - GAP) + 'px',
  height: pageHeightPx.value + 'px',
  padding: PAD_V + 'px ' + PAD_H + 'px',
  columnWidth: colWidthPx.value + 'px',
  columnGap: GAP + 'px',
  columnFill: 'auto',
  transform: `translateX(${translateX.value})`,
}))

const flipInnerStyle = computed(() => ({
  ...readingStyle.value,
  width: (spreadWidthPx.value - GAP) + 'px',
  height: pageHeightPx.value + 'px',
  padding: PAD_V + 'px ' + PAD_H + 'px',
  columnWidth: colWidthPx.value + 'px',
  columnGap: GAP + 'px',
  columnFill: 'auto',
  transform: `translateX(${flipOldTranslateX.value})`,
}))

watch([() => settings.fontSize, () => settings.lineHeight, () => settings.fontId], () => {
  nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        measure()
        nextTick().then(() => {
          refineSpreads()
          if (currentSpread.value >= totalSpreads.value) {
            currentSpread.value = Math.max(0, totalSpreads.value - 1)
          }
        })
      })
    })
  })
})

let ro = null

onMounted(async () => {
  loadBookmarks()
  await loadChapter(currentChapterId.value)
  document.addEventListener('keydown', handleKeydown)
  if (bookRef.value) {
    ro = new ResizeObserver(() => {
      measure()
      nextTick().then(() => {
        refineSpreads()
        if (currentSpread.value >= totalSpreads.value) {
          currentSpread.value = Math.max(0, totalSpreads.value - 1)
        }
      })
    })
    ro.observe(bookRef.value)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (ro) ro.disconnect()
})
</script>

<template>
  <Teleport to="body">
    <div class="immersive-overlay" :class="{ dark: settings.darkMode }" :style="settings.themeVars">
      <!-- Top bar -->
      <div class="immersive-topbar">
        <span class="immersive-title">{{ chapterDisplay.fullTitle }}</span>
        <span class="immersive-progress">{{ progress }}</span>
        <div class="topbar-actions">
          <button class="topbar-btn" @click.stop="toggleChapters" :title="t('immersive.chapters')">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
              <path d="M3 4h14v2H3V4zm0 5h14v2H3V9zm0 5h14v2H3v-2z"/>
            </svg>
          </button>
          <button class="topbar-btn" @click.stop="toggleBookmarkPanel" :title="t('immersive.bookmarks')">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
              <path d="M5 2a1 1 0 00-1 1v14l6-3.5L16 17V3a1 1 0 00-1-1H5z"/>
            </svg>
          </button>
          <button class="topbar-btn" @click.stop="enterEdit()" :title="t('immersive.edit')">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-8.793 8.793-3.536.707.707-3.536 8.793-8.793z"/>
            </svg>
          </button>
          <button class="topbar-btn" @click.stop="showChapters = false; showSettings = !showSettings" :title="t('immersive.settings')">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
              <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
            </svg>
          </button>
          <button class="topbar-btn" @click="emit('close')">✕</button>
        </div>
      </div>

      <!-- Book viewport (always rendered — never display:none) -->
      <div ref="bookRef" class="immersive-book" @click="handleClick">
        <!-- Book spine (3D fold effect) -->
        <div class="book-spine"></div>

        <!-- Main paginated content -->
        <div
          ref="innerRef"
          class="immersive-inner reading-content"
          :class="{ 'no-transition': flipActive }"
          :style="innerDynStyle"
          v-html="renderedHtml"
        ></div>

        <!-- Page flip overlay -->
        <div v-if="flipActive" class="flip-container">
          <div class="flip-page" :class="flipDir" @animationend="onFlipEnd">
            <div class="flip-content reading-content" :style="flipInnerStyle" v-html="flipHtml || renderedHtml"></div>
          </div>
          <div class="flip-shadow" :class="flipDir"></div>
        </div>

        <!-- Bookmark ribbon -->
        <div class="bm-ribbon" :class="{ active: isBookmarked }" @click.stop="toggleBookmark" :title="isBookmarked ? t('immersive.removeBookmark') : t('immersive.addBookmark')">
          <svg viewBox="0 0 24 40" width="20" height="32"><path d="M2 0h20v36l-10-6-10 6V0z" :fill="isBookmarked ? 'var(--rc-accent, #c0926e)' : 'transparent'" :stroke="isBookmarked ? 'none' : 'var(--rc-text, #999)'" stroke-width="1.5" opacity="0.7"/></svg>
        </div>

        <!-- Progress bar -->
        <div class="book-progress">
          <div class="book-progress-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
      </div>

      <!-- Edit mode overlay (on top of book) -->
      <div v-if="editMode" class="immersive-edit">
        <div class="edit-toolbar">
          <button class="edit-btn edit-btn-save" @click="saveEdit" :disabled="editSaving">
            {{ editSaving ? t('common.saving') : t('common.save') }}
          </button>
          <button class="edit-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
          <span class="edit-hint">{{ t('immersive.editHint') }}</span>
        </div>
        <textarea
          class="edit-area"
          v-model="editContent"
          :style="readingStyle"
          spellcheck="false"
        ></textarea>
      </div>

      <!-- Measurement div -->
      <div ref="measureRef" class="measure-div reading-content" v-html="renderedHtml"></div>

      <!-- Bottom bar -->
      <div v-if="!editMode" class="immersive-bottombar">
        <span>{{ t('immersive.hint') }}</span>
      </div>

      <!-- Edge click zones -->
      <div v-if="!editMode" class="click-zone left" @click.stop="turnPage(-1)"><span class="zone-arrow">‹</span></div>
      <div v-if="!editMode" class="click-zone right" @click.stop="turnPage(1)"><span class="zone-arrow">›</span></div>

      <!-- Chapter list backdrop -->
      <div v-if="showChapters" class="settings-backdrop" @click="showChapters = false"></div>

      <!-- Bookmark list backdrop -->
      <div v-if="showBookmarks" class="settings-backdrop" @click="showBookmarks = false"></div>

      <!-- Bookmark list panel -->
      <Transition name="sp-anim">
        <div v-if="showBookmarks" class="chapter-panel" @click.stop>
          <div class="cl-header">{{ t('immersive.bookmarks') }}</div>
          <div class="cl-body">
            <div v-if="bookmarks.length === 0" class="bm-empty">{{ t('immersive.noBookmarks') }}</div>
            <div v-for="(bm, idx) in bookmarks" :key="idx" class="bm-item" @click="jumpToBookmark(bm)">
              <div class="bm-item-body">
                <div class="bm-item-title">{{ bm.label }}</div>
                <div class="bm-item-page">{{ t('immersive.bookmarkPage', { page: bm.page }) }}</div>
              </div>
              <button class="bm-item-del" @click.stop="removeBookmark(idx)" :title="t('common.delete')">×</button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- Floating chapter list panel -->
      <Transition name="sp-anim">
        <div v-if="showChapters" ref="chapterListRef" class="chapter-panel" @click.stop>
          <div class="cl-header">{{ t('immersive.chapters') }}</div>
          <div class="cl-body">
            <div v-for="vol in volumeList" :key="vol.id" class="cl-volume">
              <div class="cl-vol-title">{{ vol.volLabel }} · {{ vol.title }}</div>
              <div
                v-for="ch in vol.chapters"
                :key="ch.id"
                class="cl-chapter"
                :class="{ active: ch.id === currentChapterId }"
                @click="jumpToChapter(ch.id)"
              >
                <span class="cl-ch-label">{{ ch.chLabel }}</span>
                <span class="cl-ch-title">{{ ch.title }}</span>
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <!-- Settings backdrop -->
      <div v-if="showSettings" class="settings-backdrop" @click="showSettings = false"></div>

      <!-- Floating settings panel -->
      <Transition name="sp-anim">
        <div v-if="showSettings" class="settings-panel" @click.stop>
          <div class="sp-row">
            <div class="sp-group">
              <span class="sp-label">{{ t('immersive.fontSize') }}</span>
              <div class="sp-controls">
                <button class="sp-btn" @click="changeFontSize(-1)">−</button>
                <span class="sp-val">{{ settings.fontSize }}</span>
                <button class="sp-btn" @click="changeFontSize(1)">+</button>
              </div>
            </div>
            <div class="sp-group">
              <span class="sp-label">{{ t('immersive.lineHeight') }}</span>
              <div class="sp-controls">
                <button class="sp-btn" @click="changeLineHeight(-0.2)">−</button>
                <span class="sp-val">{{ settings.lineHeight }}</span>
                <button class="sp-btn" @click="changeLineHeight(0.2)">+</button>
              </div>
            </div>
            <button class="sp-dark" @click="settings.darkMode = !settings.darkMode">
              {{ settings.darkMode ? '☀️' : '🌙' }}
            </button>
          </div>
          <div class="sp-row">
            <div class="sp-group sp-grow">
              <span class="sp-label">{{ t('immersive.paper') }}</span>
              <div class="sp-themes">
                <div
                  v-for="th in settings.themes"
                  :key="th.id"
                  class="sp-swatch"
                  :class="{ active: settings.themeId === th.id }"
                  :style="{ background: th.paper, borderColor: settings.themeId === th.id ? th.accent : 'transparent' }"
                  :title="th.name"
                  @click="settings.themeId = th.id"
                ></div>
              </div>
            </div>
            <div class="sp-group">
              <span class="sp-label">{{ t('immersive.font') }}</span>
              <select class="sp-select" :value="settings.fontId" @change="settings.fontId = $event.target.value">
                <option v-for="f in settings.fonts" :key="f.id" :value="f.id">{{ f.name }}</option>
              </select>
            </div>
          </div>
          <div class="sp-row">
            <div class="sp-group">
              <span class="sp-label">{{ t('immersive.textColor') }}</span>
              <label class="sp-color-wrap">
                <input
                  type="color"
                  class="sp-color"
                  :value="settings.customTextColor || settings.activeTheme.text"
                  @input="settings.customTextColor = $event.target.value"
                />
                <span class="sp-color-preview" :style="{ background: settings.customTextColor || settings.activeTheme.text }"></span>
              </label>
              <button v-if="settings.customTextColor" class="sp-reset" @click="settings.customTextColor = ''">✕</button>
            </div>
            <div class="sp-group">
              <span class="sp-label">{{ t('immersive.bgColor') }}</span>
              <label class="sp-color-wrap">
                <input
                  type="color"
                  class="sp-color"
                  :value="settings.customBgColor || settings.activeTheme.paper"
                  @input="settings.customBgColor = $event.target.value"
                />
                <span class="sp-color-preview" :style="{ background: settings.customBgColor || settings.activeTheme.paper }"></span>
              </label>
              <button v-if="settings.customBgColor" class="sp-reset" @click="settings.customBgColor = ''">✕</button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay ── */
.immersive-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: var(--rc-bg, #f5f0e8);
  color: var(--rc-text, #2a2520);
  display: flex; flex-direction: column;
  overflow: hidden; user-select: none;
  transition: background 0.3s ease, color 0.3s ease;
}

/* ── Top bar ── */
.immersive-topbar {
  display: flex; align-items: center; justify-content: center;
  padding: 10px 60px; font-size: 13px;
  color: var(--rc-text, #888);
  opacity: 0.7;
  gap: 20px; flex-shrink: 0; position: relative;
  transition: opacity 0.25s;
}
.immersive-topbar:hover { opacity: 1; }
.immersive-title { font-weight: 500; }
.immersive-progress { font-size: 12px; opacity: 0.8; }

.topbar-actions {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  display: flex; gap: 4px;
}
.topbar-btn {
  background: none; border: none; font-size: 16px;
  color: var(--rc-text, #999); opacity: 0.6;
  cursor: pointer; padding: 6px 8px; border-radius: 6px;
  transition: opacity 0.15s, background 0.15s;
  display: flex; align-items: center; justify-content: center;
}
.topbar-btn:hover { opacity: 1; background: rgba(127,127,127,0.12); }
.topbar-btn svg { display: block; }

/* ── Book viewport ── */
.immersive-book {
  flex: 1; margin: 0 auto;
  width: calc(100% - 120px); max-width: 1200px;
  overflow: hidden; position: relative;
  background: var(--rc-paper, #fffdf5);
  background-image: var(--rc-paper-image, none);
  border-radius: 3px 6px 6px 3px;
  color: var(--rc-text, #2a2520);
  transition: background 0.3s ease, box-shadow 0.3s ease;
  box-shadow:
    var(--rc-shadow, 0 2px 20px rgba(0,0,0,0.08)),
    1px 2px 0 -1px var(--rc-paper, #fffdf5),
    1px 2px 0 0px color-mix(in srgb, currentColor 6%, transparent),
    2px 4px 0 -1px var(--rc-paper, #fffdf5),
    2px 4px 0 0px color-mix(in srgb, currentColor 5%, transparent),
    3px 6px 0 -1px var(--rc-paper, #fffdf5),
    3px 6px 0 0px color-mix(in srgb, currentColor 4%, transparent);
}

/* ── Book spine (center fold) ── */
.book-spine {
  position: absolute;
  left: 50%; top: 0; bottom: 0;
  width: 30px;
  transform: translateX(-50%);
  background: linear-gradient(to right,
    transparent 0%,
    color-mix(in srgb, currentColor 3%, transparent) 20%,
    color-mix(in srgb, currentColor 8%, transparent) 35%,
    color-mix(in srgb, currentColor 14%, transparent) 46%,
    color-mix(in srgb, currentColor 4%, transparent) 50%,
    color-mix(in srgb, currentColor 14%, transparent) 54%,
    color-mix(in srgb, currentColor 8%, transparent) 65%,
    color-mix(in srgb, currentColor 3%, transparent) 80%,
    transparent 100%
  );
  z-index: 3; pointer-events: none;
}

/* ── Content inner ── */
.immersive-inner {
  box-sizing: content-box;
  overflow: visible;
  transition: transform 0.35s ease;
  color: var(--rc-text, #2a2520);
}
.immersive-inner :deep(*) {
  color: inherit;
}
.immersive-inner.no-transition {
  transition: none !important;
}
.immersive-inner :deep(p) {
  text-indent: 2em;
  margin-top: 0;
  margin-bottom: 1em;
  orphans: 1; widows: 1;
}
.immersive-inner :deep(p:empty) {
  display: none;
}
.immersive-inner :deep(h1),
.immersive-inner :deep(h2),
.immersive-inner :deep(h3) {
  break-after: avoid;
}

/* ── Page flip animation ── */
.flip-container {
  position: absolute; inset: 0;
  perspective: 2000px;
  z-index: 5; pointer-events: none;
}

.flip-page {
  position: absolute; inset: 0;
  overflow: hidden;
  backface-visibility: hidden;
  will-change: transform;
}
.flip-page.next {
  clip-path: inset(0 0 0 50%);
  transform-origin: 50% 50%;
  animation: flipNext 0.5s ease-in-out forwards;
}
.flip-page.prev {
  clip-path: inset(0 50% 0 0);
  transform-origin: 50% 50%;
  animation: flipPrev 0.5s ease-in-out forwards;
}

/* Subtle light reflection on the turning page */
.flip-page::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(105deg,
    transparent 30%,
    rgba(255,255,255,0.08) 45%,
    rgba(255,255,255,0.12) 50%,
    rgba(255,255,255,0.08) 55%,
    transparent 70%
  );
  pointer-events: none; z-index: 1;
}

.flip-content {
  box-sizing: content-box;
  overflow: visible;
  color: var(--rc-text, #2a2520);
}
.flip-content :deep(*) {
  color: inherit;
}
.flip-content :deep(p) {
  text-indent: 2em;
  margin-top: 0;
  margin-bottom: 1em;
  orphans: 1; widows: 1;
}
.flip-content :deep(p:empty) {
  display: none;
}

@keyframes flipNext {
  0%   { transform: rotateY(0deg); }
  100% { transform: rotateY(-90deg); opacity: 0; }
}
@keyframes flipPrev {
  0%   { transform: rotateY(0deg); }
  100% { transform: rotateY(90deg); opacity: 0; }
}

/* Shadow cast by flipping page onto the opposite side */
.flip-shadow {
  position: absolute; top: 0; height: 100%;
  pointer-events: none; z-index: 4;
}
.flip-shadow.next {
  left: 0; width: 50%;
  background: linear-gradient(to left, color-mix(in srgb, currentColor 10%, transparent) 0%, transparent 50%);
  animation: flipShadow 0.5s ease-in-out;
}
.flip-shadow.prev {
  right: 0; width: 50%;
  background: linear-gradient(to right, color-mix(in srgb, currentColor 10%, transparent) 0%, transparent 50%);
  animation: flipShadow 0.5s ease-in-out;
}
@keyframes flipShadow {
  0%   { opacity: 0; }
  35%  { opacity: 1; }
  100% { opacity: 0; }
}

/* ── Progress bar ── */
.book-progress {
  position: absolute;
  bottom: 6px; left: 10%; right: 10%;
  height: 2px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  border-radius: 1px;
  z-index: 4; opacity: 0.5;
  transition: opacity 0.2s;
}
.immersive-book:hover .book-progress { opacity: 0.8; }
.book-progress-fill {
  height: 100%;
  background: var(--rc-accent, rgba(0,0,0,0.15));
  border-radius: 1px;
  transition: width 0.3s ease;
  opacity: 0.7;
}

/* ── Bottom bar ── */
.immersive-bottombar {
  display: flex; justify-content: center;
  padding: 8px; flex-shrink: 0;
  font-size: 11px;
  color: var(--rc-text, #aaa);
  opacity: 0.55;
}

/* ── Click zones ── */
.click-zone {
  position: fixed; top: 50px; bottom: 50px; width: 60px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.2s; z-index: 10000;
}
.click-zone:hover { opacity: 1; }
.click-zone.left { left: 0; }
.click-zone.right { right: 0; }
.zone-arrow {
  font-size: 36px;
  color: var(--rc-text, rgba(0,0,0,0.15));
  opacity: 0.25; font-weight: 300;
}

/* ── Measurement div ── */
.measure-div {
  position: absolute; left: -99999px; top: 0;
  visibility: hidden; pointer-events: none; height: auto;
}
.measure-div :deep(p) { text-indent: 2em; margin-top: 0; margin-bottom: 1em; }
.measure-div :deep(p:empty) { display: none; }

/* ── Settings backdrop ── */
.settings-backdrop {
  position: fixed; inset: 0;
  z-index: 10001;
}

/* ── Settings panel ── */
.settings-panel {
  position: fixed;
  bottom: 50px; left: 0; right: 0;
  width: fit-content; max-width: 90vw;
  margin: 0 auto;
  z-index: 10002;
  background: var(--rc-paper, #fffdf5);
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 16px;
  padding: 14px 20px;
  box-shadow: 0 -4px 40px color-mix(in srgb, currentColor 12%, transparent);
  color: var(--rc-text, #2a2520);
  user-select: none;
}

/* Settings slide-up animation */
.sp-anim-enter-active { animation: spIn 0.25s ease-out; }
.sp-anim-leave-active { animation: spOut 0.2s ease-in; }
@keyframes spIn {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes spOut {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(16px); }
}

.sp-row {
  display: flex; align-items: center; gap: 20px;
  padding: 5px 0;
}
.sp-row + .sp-row {
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  margin-top: 4px; padding-top: 9px;
}

.sp-group {
  display: flex; align-items: center; gap: 8px;
}
.sp-grow { flex: 1; }

.sp-label {
  font-size: 12px;
  color: var(--rc-text, #888);
  opacity: 0.75;
  white-space: nowrap;
}

.sp-controls {
  display: flex; align-items: center; gap: 2px;
}

.sp-btn {
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  background: none;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 8px;
  font-size: 16px;
  color: var(--rc-text, #333);
  cursor: pointer;
  transition: all 0.15s;
}
.sp-btn:hover {
  border-color: var(--rc-accent, #8b6b3d);
  color: var(--rc-accent, #8b6b3d);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.sp-btn:active { transform: scale(0.92); }

.sp-val {
  font-size: 13px;
  min-width: 30px; text-align: center;
  color: var(--rc-text, #555);
  font-variant-numeric: tabular-nums;
}

.sp-dark {
  padding: 5px 12px;
  font-size: 14px;
  background: none;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 8px;
  color: var(--rc-text, #333);
  cursor: pointer;
  transition: all 0.15s;
  margin-left: auto;
}
.sp-dark:hover {
  border-color: var(--rc-accent, #8b6b3d);
  background: color-mix(in srgb, currentColor 6%, transparent);
}

.sp-themes {
  display: flex; gap: 6px;
}
.sp-swatch {
  width: 28px; height: 28px;
  border-radius: 6px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent), 0 1px 3px color-mix(in srgb, currentColor 10%, transparent);
}
.sp-swatch:hover { transform: scale(1.15); }
.sp-swatch.active {
  box-shadow: 0 0 0 2px var(--rc-accent, rgba(139,107,61,0.4));
}

.sp-select {
  padding: 5px 10px;
  font-size: 13px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 8px;
  background: var(--rc-paper, #fff);
  color: var(--rc-text, #333);
  cursor: pointer; outline: none;
  transition: border-color 0.15s;
}
.sp-select option {
  background: var(--rc-paper, #fff);
  color: var(--rc-text, #333);
}
.sp-select:focus { border-color: var(--rc-accent, #8b6b3d); }

/* ── Color picker ── */
.sp-color-wrap {
  position: relative;
  width: 28px; height: 28px;
  cursor: pointer;
}
.sp-color {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  opacity: 0; cursor: pointer;
}
.sp-color-preview {
  display: block;
  width: 28px; height: 28px;
  border-radius: 6px;
  border: 2px solid color-mix(in srgb, currentColor 20%, transparent);
  pointer-events: none;
  transition: background 0.15s;
}
.sp-reset {
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  background: none;
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 50%;
  font-size: 11px;
  color: var(--rc-text, #888);
  opacity: 0.6;
  cursor: pointer;
  transition: all 0.15s;
}
.sp-reset:hover {
  opacity: 1;
  border-color: var(--rc-accent, #8b6b3d);
  color: var(--rc-accent, #8b6b3d);
}

/* ── Chapter list panel ── */
.chapter-panel {
  position: fixed;
  top: 60px; bottom: 60px; right: 24px;
  width: 320px; max-width: 90vw;
  z-index: 10002;
  background: var(--rc-paper, #fffdf5);
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 14px;
  box-shadow: 0 4px 40px color-mix(in srgb, currentColor 16%, transparent);
  color: var(--rc-text, #2a2520);
  display: flex; flex-direction: column;
  overflow: hidden;
  user-select: none;
}

.cl-header {
  padding: 14px 18px 10px;
  font-size: 13px; font-weight: 600;
  color: var(--rc-text, #2a2520);
  opacity: 0.8;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  flex-shrink: 0;
}

.cl-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.cl-body::-webkit-scrollbar { width: 6px; }
.cl-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 3px;
}

.cl-volume + .cl-volume {
  margin-top: 4px;
}

.cl-vol-title {
  padding: 10px 18px 6px;
  font-size: 12px;
  color: var(--rc-text, #888);
  opacity: 0.6;
  letter-spacing: 0.04em;
}

.cl-chapter {
  padding: 8px 18px;
  cursor: pointer;
  display: flex; align-items: baseline; gap: 10px;
  font-size: 13px;
  transition: background 0.12s, color 0.12s;
  border-left: 2px solid transparent;
}
.cl-chapter:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.cl-chapter.active {
  background: color-mix(in srgb, var(--rc-accent, #8b6b3d) 12%, transparent);
  border-left-color: var(--rc-accent, #8b6b3d);
  color: var(--rc-accent, #8b6b3d);
  font-weight: 500;
}

.cl-ch-label {
  font-size: 11px;
  opacity: 0.65;
  flex-shrink: 0;
  min-width: 56px;
  font-variant-numeric: tabular-nums;
}
.cl-ch-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Edit mode ── */
.immersive-edit {
  position: fixed;
  top: 40px; bottom: 40px;
  left: 50%; transform: translateX(-50%);
  width: calc(100% - 120px); max-width: 1200px;
  display: flex; flex-direction: column;
  gap: 0; overflow: hidden;
  z-index: 6;
}
.edit-toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0; flex-shrink: 0;
}
.edit-btn {
  padding: 5px 16px; font-size: 13px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 6px;
  background: none; color: var(--rc-text, #333);
  cursor: pointer; transition: all 0.15s;
}
.edit-btn:hover {
  border-color: var(--rc-accent, #8b6b3d);
  color: var(--rc-accent, #8b6b3d);
}
.edit-btn-save {
  background: var(--rc-accent, #8b6b3d);
  color: var(--rc-paper, #fff);
  border-color: var(--rc-accent, #8b6b3d);
}
.edit-btn-save:hover { opacity: 0.85; }
.edit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.edit-hint {
  font-size: 12px; opacity: 0.5;
  color: var(--rc-text, #888);
}
.edit-area {
  flex: 1;
  width: 100%;
  padding: 40px;
  border: none; outline: none; resize: none;
  background: var(--rc-paper, #fffdf5);
  background-image: var(--rc-paper-image, none);
  color: var(--rc-text, #2a2520);
  border-radius: 4px;
  box-shadow: var(--rc-shadow, 0 2px 20px rgba(0,0,0,0.08));
  text-indent: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}

/* ── Bookmark ribbon ── */
.bm-ribbon {
  position: absolute;
  top: -2px; right: 24px;
  cursor: pointer; z-index: 4;
  opacity: 0.35;
  transition: opacity 0.2s, transform 0.2s;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.15));
}
.bm-ribbon:hover { opacity: 0.8; transform: translateY(2px); }
.bm-ribbon.active { opacity: 1; }

/* ── Bookmark list ── */
.bm-empty {
  padding: 24px; text-align: center;
  color: var(--rc-text, #999); opacity: 0.5; font-size: 13px;
}
.bm-item {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: 6px;
  cursor: pointer; transition: background 0.12s;
}
.bm-item:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
.bm-item-body { flex: 1; min-width: 0; }
.bm-item-title {
  font-size: 13px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bm-item-page { font-size: 11px; opacity: 0.5; margin-top: 2px; }
.bm-item-del {
  background: none; border: none; font-size: 16px;
  color: currentColor; cursor: pointer; padding: 0 4px;
  opacity: 0; transition: opacity 0.15s;
}
.bm-item:hover .bm-item-del { opacity: 0.4; }
.bm-item-del:hover { opacity: 1 !important; }
</style>
