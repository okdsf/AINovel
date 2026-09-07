<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useNovelStore } from './stores/novel'
import { useSettingsStore } from './stores/settings'
import { useI18n } from './i18n'
import SidebarTree from './components/SidebarTree.vue'

const route = useRoute()
const store = useNovelStore()
const settings = useSettingsStore()
const { t } = useI18n()

const mainWide = computed(() => true)

// ── Rail interaction state ────────────────────────────────────────────
const drawer  = ref('')   // '' | 'chapters'
const popover = ref('')   // '' | 'settings'

// Restore drawer state across reloads — but only the chapters drawer; popover is transient
const DRAWER_LS_KEY = 'novelweb:rail-drawer'
try {
  const saved = localStorage.getItem(DRAWER_LS_KEY)
  if (saved === 'chapters') drawer.value = 'chapters'
} catch {}
watch(drawer, v => {
  try { localStorage.setItem(DRAWER_LS_KEY, v) } catch {}
})

function toggleDrawer(name) {
  popover.value = ''
  drawer.value = drawer.value === name ? '' : name
}
function togglePopover(name) {
  drawer.value = ''
  popover.value = popover.value === name ? '' : name
}
function closeAll() {
  drawer.value = ''
  popover.value = ''
  exportDialogType.value = ''
}

async function doShutdown() {
  if (!confirm(t('nav.exitConfirm'))) return
  try { await fetch('/api/shutdown', { method: 'POST' }) } catch {}
  window.close()
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-size:18px;color:#888;">已关闭，可以关闭此标签页</div>'
}

// Keyboard: Cmd/Ctrl+B toggles chapter drawer; Esc closes everything
function handleKeydown(e) {
  if (e.key === 'Escape') {
    if (drawer.value || popover.value || exportDialogType.value) {
      e.preventDefault()
      closeAll()
    }
    return
  }
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault()
    toggleDrawer('chapters')
  }
}

// ── Book management (now in settings popover) ─────────────────────────
const bookCreateOpen = ref(false)
const newBookTitle   = ref('')
const newBookDesc    = ref('')

async function onCreateBook() {
  if (!newBookTitle.value.trim()) return
  await store.createBook(newBookTitle.value.trim(), newBookDesc.value.trim())
  newBookTitle.value = ''
  newBookDesc.value  = ''
  bookCreateOpen.value = false
}

// ── Export ────────────────────────────────────────────────────────────
const exporting = ref('')
const exportMsg = ref('')
const exportDialogType = ref('')
const selectedExportChapters = ref([])
const allExportChapterIds = computed(() =>
  (store.meta?.volumes || []).flatMap(vol => vol.chapters.map(ch => ch.id))
)
const selectedExportCount = computed(() => selectedExportChapters.value.length)
const allExportSelected = computed(() =>
  allExportChapterIds.value.length > 0 && selectedExportCount.value === allExportChapterIds.value.length
)
const someExportSelected = computed(() =>
  selectedExportCount.value > 0 && !allExportSelected.value
)

function openExportDialog(type) {
  if (!store.currentBookId) return
  selectedExportChapters.value = [...allExportChapterIds.value]
  exportDialogType.value = type
  popover.value = ''
  exportMsg.value = ''
}

function setAllExportChapters(checked) {
  selectedExportChapters.value = checked ? [...allExportChapterIds.value] : []
}

function isVolumeSelected(volume) {
  return volume.chapters.length > 0 && volume.chapters.every(ch => selectedExportChapters.value.includes(ch.id))
}

function isVolumePartiallySelected(volume) {
  const count = volume.chapters.filter(ch => selectedExportChapters.value.includes(ch.id)).length
  return count > 0 && count < volume.chapters.length
}

function setExportVolume(volume, checked) {
  const ids = new Set(selectedExportChapters.value)
  for (const chapter of volume.chapters) {
    if (checked) ids.add(chapter.id)
    else ids.delete(chapter.id)
  }
  selectedExportChapters.value = [...ids]
}

async function doExport(type) {
  if (!store.currentBookId || selectedExportCount.value === 0) return
  exporting.value = type
  exportMsg.value = ''
  try {
    const res = await fetch(`/api/books/${store.currentBookId}/export/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterIds: selectedExportChapters.value }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || t('nav.exportFailed'))
    exportDialogType.value = ''
    exportMsg.value = t('export.success', { count: selectedExportCount.value })
  } catch {
    exportMsg.value = t('nav.exportFailed')
  } finally {
    exporting.value = ''
    setTimeout(() => exportMsg.value = '', 3000)
  }
}

// ── Active-route helpers for rail highlighting ───────────────────────
const isHome    = computed(() => route.name === 'home')
const isDrafts  = computed(() => route.name === 'drafts')
const isArchive = computed(() => route.name === 'archive' || route.name === 'archive-event')
const isStats   = computed(() => route.name === 'stats')
const isSearch  = computed(() => route.name === 'search-replace')
const isGit     = computed(() => route.name === 'git')
const isPromptArchive = computed(() => route.name === 'prompt-archive')
const isChat = computed(() => route.name === 'chat')
const isAutomation = computed(() => route.name === 'automation')
const isVpnTest = computed(() => route.name === 'vpn-test')
const isNovelTree = computed(() => route.name === 'novel-tree')

onMounted(() => {
  store.fetchBooks()
  window.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="app-shell">
    <!-- ── Editorial rail (always visible, 48px) ──────────────────── -->
    <nav class="ed-rail">
      <RouterLink to="/" class="rail-btn" :class="{ active: isHome }" :title="t('nav.home') || 'Home'" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <path d="M9 22V12h6v10"/>
        </svg>
      </RouterLink>

      <button class="rail-btn" :class="{ active: drawer === 'chapters' }" @click="toggleDrawer('chapters')" title="目录 · Cmd/Ctrl+B">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
      </button>

      <RouterLink to="/drafts" class="rail-btn" :class="{ active: isDrafts }" :title="t('nav.drafts')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
          <path d="m15 5 4 4"/>
        </svg>
      </RouterLink>

      <RouterLink to="/archive" class="rail-btn" :class="{ active: isArchive }" :title="t('nav.archive')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect width="20" height="5" x="2" y="3" rx="1"/>
          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>
          <path d="M10 12h4"/>
        </svg>
      </RouterLink>

      <RouterLink to="/stats" class="rail-btn" :class="{ active: isStats }" :title="t('nav.stats')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v18h18"/>
          <path d="M18 17V9"/>
          <path d="M13 17V5"/>
          <path d="M8 17v-3"/>
        </svg>
      </RouterLink>

      <RouterLink to="/search-replace" class="rail-btn" :class="{ active: isSearch }" :title="t('nav.search')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
      </RouterLink>

      <RouterLink to="/prompt-archive" class="rail-btn" :class="{ active: isPromptArchive }" :title="t('nav.promptArchive')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <line x1="10" y1="9" x2="8" y2="9"/>
        </svg>
      </RouterLink>

      <RouterLink to="/chat" class="rail-btn" :class="{ active: isChat }" :title="t('nav.chat')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </RouterLink>

      <RouterLink to="/novel-tree" class="rail-btn" :class="{ active: isNovelTree }" :title="t('nav.novelTree')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="5" r="2"/>
          <circle cx="6" cy="13" r="2"/>
          <circle cx="18" cy="13" r="2"/>
          <circle cx="4" cy="20" r="1.5"/>
          <circle cx="10" cy="20" r="1.5"/>
          <circle cx="20" cy="20" r="1.5"/>
          <line x1="12" y1="7" x2="6" y2="11"/>
          <line x1="12" y1="7" x2="18" y2="11"/>
          <line x1="6" y1="15" x2="4" y2="18.5"/>
          <line x1="6" y1="15" x2="10" y2="18.5"/>
          <line x1="18" y1="15" x2="20" y2="18.5"/>
        </svg>
      </RouterLink>

      <RouterLink to="/automation" class="rail-btn" :class="{ active: isAutomation }" :title="t('nav.automation')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="7" width="16" height="13"/>
          <path d="M9 3h6M12 3v4"/>
          <circle cx="9" cy="13" r="1"/>
          <circle cx="15" cy="13" r="1"/>
          <path d="M8 17h8"/>
        </svg>
      </RouterLink>

      <RouterLink to="/vpn-test" class="rail-btn" :class="{ active: isVpnTest }" :title="t('nav.vpnTest')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a9 9 0 0 0-9 9"/>
          <path d="M12 7a5 5 0 0 0-5 5"/>
          <path d="M12 11a1 1 0 0 0-1 1"/>
          <path d="M12 3a9 9 0 0 1 9 9"/>
          <path d="M12 7a5 5 0 0 1 5 5"/>
          <path d="M12 11a1 1 0 0 1 1 1"/>
          <path d="M8 17h8M10 21h4"/>
        </svg>
      </RouterLink>

      <a href="/notes/index.html" class="rail-btn" :title="t('nav.notes')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          <path d="M8 7h8"/>
          <path d="M8 11h6"/>
        </svg>
      </a>

      <span class="rail-spacer"></span>

      <RouterLink to="/git" class="rail-btn" :class="{ active: isGit }" :title="t('nav.git')" @click="closeAll">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="6" y1="3" x2="6" y2="15"/>
          <circle cx="18" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
      </RouterLink>

      <button class="rail-btn" :class="{ active: popover === 'settings' }" @click="togglePopover('settings')" title="Settings">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="21" y1="4" x2="14" y2="4"/>
          <line x1="10" y1="4" x2="3" y2="4"/>
          <line x1="21" y1="12" x2="12" y2="12"/>
          <line x1="8" y1="12" x2="3" y2="12"/>
          <line x1="21" y1="20" x2="16" y2="20"/>
          <line x1="12" y1="20" x2="3" y2="20"/>
          <line x1="14" y1="2" x2="14" y2="6"/>
          <line x1="8" y1="10" x2="8" y2="14"/>
          <line x1="16" y1="18" x2="16" y2="22"/>
        </svg>
      </button>

      <button class="rail-btn rail-exit" @click="doShutdown" :title="t('nav.exit')">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </nav>

    <!-- ── Backdrop ───────────────────────────────────────────────── -->
    <Transition name="fade">
      <div v-if="drawer || popover" class="rail-backdrop" @click="closeAll"></div>
    </Transition>

    <!-- ── Chapters drawer (slides in from the rail) ─────────────── -->
    <Transition name="drawer">
      <aside v-if="drawer === 'chapters'" class="ed-drawer" @click.stop>
        <header class="drawer-head">
          <select
            class="drawer-book"
            :value="store.currentBookId"
            @change="store.selectBook($event.target.value)"
          >
            <option value="" disabled>{{ t('app.selectBook') }}</option>
            <option v-for="book in store.books" :key="book.id" :value="book.id">
              {{ book.title }}
            </option>
          </select>
          <button class="drawer-close" @click="closeAll" title="Esc">✕</button>
        </header>
        <p v-if="store.currentBook?.description" class="drawer-tagline">
          {{ store.currentBook.description }}
        </p>
        <div class="drawer-body">
          <SidebarTree v-if="store.currentBookId" />
          <div v-else class="drawer-empty">{{ t('app.bookPlaceholder') }}</div>
        </div>
      </aside>
    </Transition>

    <!-- ── Settings popover (from bottom of the rail) ────────────── -->
    <Transition name="popover">
      <div v-if="popover === 'settings'" class="ed-popover" @click.stop>
        <div class="pop-section">
          <div class="pop-label">Chrome</div>
          <div class="pop-toggle-group">
            <button class="pop-toggle" :class="{ on: settings.chromeTheme === 'writer' }" @click="settings.chromeTheme = 'writer'">✒ Writer</button>
            <button class="pop-toggle" :class="{ on: settings.chromeTheme === 'editorial' }" @click="settings.chromeTheme = 'editorial'">📰 Editorial</button>
          </div>
        </div>

        <div class="pop-section">
          <div class="pop-label">{{ settings.locale === 'en' ? 'Front Page' : '首页头版' }}</div>
          <div class="pop-toggle-group">
            <button class="pop-toggle" :class="{ on: settings.homeStyle === 'broadsheet' }" @click="settings.homeStyle = 'broadsheet'">🗞 {{ settings.locale === 'en' ? 'Broadsheet' : '简报' }}</button>
            <button class="pop-toggle" :class="{ on: settings.homeStyle === 'tabloid' }" @click="settings.homeStyle = 'tabloid'">💋 {{ settings.locale === 'en' ? 'Tabloid' : '小报' }}</button>
          </div>
        </div>

        <div class="pop-section">
          <div class="pop-label">Language</div>
          <div class="pop-toggle-group">
            <button class="pop-toggle" :class="{ on: settings.locale === 'zh' }" @click="settings.locale = 'zh'">中文</button>
            <button class="pop-toggle" :class="{ on: settings.locale === 'en' }" @click="settings.locale = 'en'">English</button>
          </div>
        </div>

        <div class="pop-section">
          <div class="pop-label">Mode</div>
          <div class="pop-toggle-group">
            <button class="pop-toggle" :class="{ on: !settings.darkMode }" @click="settings.darkMode = false">☀ Light</button>
            <button class="pop-toggle" :class="{ on: settings.darkMode }" @click="settings.darkMode = true">☾ Dark</button>
          </div>
        </div>

        <div class="pop-rule"></div>

        <div class="pop-section">
          <div class="pop-label">Books</div>
          <button v-if="!bookCreateOpen" class="btn btn-sm pop-block" @click="bookCreateOpen = true">+ {{ t('app.newBook') }}</button>
          <div v-else class="pop-create-book">
            <input v-model="newBookTitle" type="text" :placeholder="t('app.bookTitle')" />
            <input v-model="newBookDesc" type="text" :placeholder="t('app.bookDesc')" />
            <div class="pop-row">
              <button class="btn btn-sm" @click="bookCreateOpen = false">{{ t('common.cancel') }}</button>
              <button class="btn btn-sm btn-primary" @click="onCreateBook">{{ t('common.create') }}</button>
            </div>
          </div>
        </div>

        <div class="pop-rule"></div>

        <div class="pop-section">
          <div class="pop-label">Export</div>
          <button class="btn btn-sm pop-block" @click="openExportDialog('novel')" :disabled="!!exporting || !store.currentBookId || !store.meta">
            {{ exporting === 'novel' ? t('nav.exporting') : t('nav.exportNovel') }}
          </button>
          <button class="btn btn-sm pop-block" @click="openExportDialog('conversation')" :disabled="!!exporting || !store.currentBookId || !store.meta">
            {{ exporting === 'conversation' ? t('nav.exporting') : t('nav.exportConv') }}
          </button>
          <p v-if="exportMsg" class="pop-msg">{{ exportMsg }}</p>
        </div>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="exportDialogType" class="modal-overlay" @click="exportDialogType = ''">
        <section class="modal export-modal" role="dialog" aria-modal="true" :aria-label="t('export.title')" @click.stop>
          <header class="export-head">
            <div>
              <p class="export-kicker">{{ exportDialogType === 'novel' ? t('nav.exportNovel') : t('nav.exportConv') }}</p>
              <h3>{{ t('export.title') }}</h3>
            </div>
            <button class="export-close" type="button" :aria-label="t('common.close')" @click="exportDialogType = ''">×</button>
          </header>

          <div class="export-summary">
            <label class="export-check export-check-all">
              <input
                type="checkbox"
                :checked="allExportSelected"
                :indeterminate="someExportSelected"
                @change="setAllExportChapters($event.target.checked)"
              />
              <span>{{ t('export.selectAll') }}</span>
            </label>
            <span>{{ t('export.selectedCount', { selected: selectedExportCount, total: allExportChapterIds.length }) }}</span>
          </div>

          <p class="export-hint">{{ t('export.hint') }}</p>

          <div class="export-chapter-list">
            <section v-for="(volume, volumeIndex) in store.meta?.volumes || []" :key="volume.id" class="export-volume">
              <label class="export-check export-volume-check">
                <input
                  type="checkbox"
                  :checked="isVolumeSelected(volume)"
                  :indeterminate="isVolumePartiallySelected(volume)"
                  @change="setExportVolume(volume, $event.target.checked)"
                />
                <span>{{ t('export.volume', { number: volumeIndex + 1, title: volume.title }) }}</span>
              </label>
              <label v-for="chapter in volume.chapters" :key="chapter.id" class="export-check export-chapter-check">
                <input v-model="selectedExportChapters" type="checkbox" :value="chapter.id" />
                <span>{{ chapter.title }}</span>
              </label>
            </section>
          </div>

          <p v-if="selectedExportCount === 0" class="export-empty">{{ t('export.selectOne') }}</p>
          <footer class="modal-actions">
            <button class="btn" type="button" @click="exportDialogType = ''">{{ t('common.cancel') }}</button>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!!exporting || selectedExportCount === 0"
              @click="doExport(exportDialogType)"
            >
              {{ exporting ? t('export.exporting') : t('export.confirm', { count: selectedExportCount }) }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>

    <Transition name="fade">
      <p v-if="exportMsg && !popover" class="export-toast">{{ exportMsg }}</p>
    </Transition>

    <!-- ── Main content ─────────────────────────────────────────── -->
    <main class="ed-main" :class="{ 'main-content': true, wide: mainWide }">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════════
   Shell: thin editorial rail + full-bleed main
   ══════════════════════════════════════════════════════════════════ */
.app-shell {
  position: relative;
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ── Rail ────────────────────────────────────────────────────────── */
.ed-rail {
  width: 48px;
  min-width: 48px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 2px;
  z-index: 20;
}
.rail-btn {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-soft);
  text-decoration: none;
  position: relative;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.rail-btn::before {
  content: '';
  position: absolute;
  left: 0; top: 8px; bottom: 8px;
  width: 2px;
  background: transparent;
  transition: background var(--t-fast) var(--ease);
}
.rail-btn:hover {
  color: var(--text);
}
.rail-btn.active {
  color: var(--hot);
}
.rail-btn.active::before {
  background: var(--hot);
}
.rail-icon {
  width: 19px;
  height: 19px;
  display: block;
  transition: transform var(--t-fast) var(--ease);
}
.rail-btn:hover .rail-icon { transform: scale(1.05); }
.rail-btn.active .rail-icon { transform: scale(1.03); }
.rail-spacer { flex: 1; }
.rail-exit { opacity: 0.4; }
.rail-exit:hover { opacity: 1; color: #c44; }

/* ── Backdrop ────────────────────────────────────────────────────── */
.rail-backdrop {
  position: absolute;
  inset: 0 0 0 48px;
  background: color-mix(in srgb, var(--text) 12%, transparent);
  backdrop-filter: blur(1px);
  z-index: 30;
}

/* ── Drawer ──────────────────────────────────────────────────────── */
.ed-drawer {
  position: absolute;
  left: 48px; top: 0; bottom: 0;
  width: 320px;
  background: var(--bg);
  border-right: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  z-index: 40;
  box-shadow: 12px 0 32px color-mix(in srgb, var(--text) 8%, transparent);
}
.drawer-head {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--rule);
}
.drawer-book {
  flex: 1;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 12px 14px;
  background: var(--bg-sidebar);
  color: var(--text);
  border: none;
  outline: none;
  cursor: pointer;
  appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
    linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-position: calc(100% - 16px) center, calc(100% - 11px) center;
  background-size: 5px 5px;
  background-repeat: no-repeat;
  padding-right: 32px;
}
.drawer-close {
  width: 40px;
  border: none;
  border-left: 1px solid var(--rule);
  background: var(--bg-sidebar);
  color: var(--text-soft);
  cursor: pointer;
  font-size: 14px;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.drawer-close:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.drawer-tagline {
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  padding: 10px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--rule) 30%, transparent);
}
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 14px 18px;
}
.drawer-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-style: italic;
  font-size: 13px;
}

/* ── Settings popover ───────────────────────────────────────────── */
.ed-popover {
  position: absolute;
  left: 60px;
  bottom: 16px;
  width: 280px;
  background: var(--bg-card);
  border: 1px solid var(--rule);
  z-index: 40;
  padding: 16px;
  box-shadow: 0 12px 36px color-mix(in srgb, var(--text) 14%, transparent);
}
.pop-section { margin-bottom: 12px; }
.pop-section:last-child { margin-bottom: 0; }
.pop-label {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-soft);
  margin-bottom: 6px;
}
.pop-toggle-group {
  display: flex;
  gap: 0;
  border: 1px solid var(--rule);
}
.pop-toggle {
  flex: 1;
  padding: 7px 8px;
  background: var(--bg-card);
  border: none;
  border-right: 1px solid var(--rule);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-soft);
  font-family: var(--font-ui);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.pop-toggle:last-child { border-right: none; }
.pop-toggle:hover { color: var(--text); }
.pop-toggle.on {
  background: var(--text);
  color: var(--bg);
}
.pop-rule {
  height: 1px;
  background: var(--rule);
  margin: 14px 0;
  opacity: 0.4;
}
.pop-block {
  display: block;
  width: 100%;
  margin-top: 6px;
}
.pop-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.pop-row > .btn { flex: 1; }
.pop-create-book input {
  font-size: 12px;
  padding: 6px 8px;
  margin-bottom: 6px;
}
.pop-msg {
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--hot);
  text-align: center;
  margin-top: 8px;
}

/* ── Export chapter picker ───────────────────────────────────────── */
.export-modal {
  width: min(620px, calc(100vw - 40px));
  max-height: min(760px, calc(100vh - 40px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.export-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--rule);
}
.export-head h3 {
  margin: 2px 0 0;
  padding: 0;
  border: 0;
  font-size: 20px;
}
.export-kicker {
  margin: 0;
  color: var(--hot);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.export-close {
  border: 0;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
  font-size: 24px;
  line-height: 1;
  padding: 0 2px;
}
.export-close:hover { color: var(--text); }
.export-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  color: var(--text-muted);
  font-size: 12px;
}
.export-hint {
  margin: 8px 0 12px;
  color: var(--text-muted);
  font-size: 12px;
}
.export-chapter-list {
  flex: 1 1 360px;
  min-height: 120px;
  overflow-y: auto;
  border: 1px solid var(--rule);
  background: var(--bg);
}
.export-volume + .export-volume { border-top: 1px solid var(--rule); }
.export-check {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  font-size: 13px;
}
.export-check input {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  accent-color: var(--hot);
}
.export-check-all { color: var(--text); font-weight: 600; }
.export-volume-check {
  padding: 10px 14px;
  background: var(--bg-sidebar);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.export-chapter-check {
  padding: 8px 14px 8px 38px;
  color: var(--text-soft);
  border-top: 1px solid color-mix(in srgb, var(--rule) 35%, transparent);
}
.export-chapter-check:hover { color: var(--text); }
.export-empty {
  margin: 10px 0 0;
  color: var(--hot);
  font-size: 12px;
}
.export-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 120;
  transform: translateX(-50%);
  margin: 0;
  padding: 9px 14px;
  border: 1px solid var(--rule);
  background: var(--bg-card);
  color: var(--hot);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--text) 14%, transparent);
  font-size: 12px;
}

@media (max-width: 640px) {
  .export-modal { padding: 20px; }
  .export-summary { align-items: flex-start; flex-direction: column; gap: 6px; }
  .export-chapter-check { padding-left: 24px; }
}

/* ── Main content ───────────────────────────────────────────────── */
.ed-main {
  flex: 1;
  overflow-y: auto;
}

/* ── Transitions ────────────────────────────────────────────────── */
.fade-enter-active, .fade-leave-active { transition: opacity var(--t-med) var(--ease); }
.fade-enter-from, .fade-leave-to       { opacity: 0; }

.drawer-enter-active, .drawer-leave-active {
  transition: transform var(--t-med) var(--ease), opacity var(--t-med) var(--ease);
}
.drawer-enter-from, .drawer-leave-to {
  transform: translateX(-12px);
  opacity: 0;
}

.popover-enter-active, .popover-leave-active {
  transition: transform var(--t-med) var(--ease), opacity var(--t-med) var(--ease);
}
.popover-enter-from, .popover-leave-to {
  transform: translateY(8px);
  opacity: 0;
}
</style>
