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

const mainWide = computed(() => route.name === 'home')

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
}

// Keyboard: Cmd/Ctrl+B toggles chapter drawer; Esc closes everything
function handleKeydown(e) {
  if (e.key === 'Escape') {
    if (drawer.value || popover.value) {
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
async function doExport(type) {
  if (!store.currentBookId) return
  exporting.value = type
  exportMsg.value = ''
  try {
    const res  = await fetch(`/api/books/${store.currentBookId}/export/${type}`, { method: 'POST' })
    const data = await res.json()
    exportMsg.value = data.ok ? t('nav.exported') : t('nav.exportFailed')
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

      <a href="/notes/index.html" class="rail-btn" :title="t('nav.notes')">
        <svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
          <path d="M8 2v20"/>
          <path d="M12 7h6"/>
          <path d="M12 11h6"/>
          <path d="M12 15h6"/>
        </svg>
      </a>

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
            <button class="pop-toggle" :class="{ on: settings.chromeTheme === 'nyt' }" @click="settings.chromeTheme = 'nyt'">📰 NYT</button>
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
          <button class="btn btn-sm pop-block" @click="doExport('novel')" :disabled="!!exporting || !store.currentBookId">
            {{ exporting === 'novel' ? t('nav.exporting') : t('nav.exportNovel') }}
          </button>
          <button class="btn btn-sm pop-block" @click="doExport('conversation')" :disabled="!!exporting || !store.currentBookId">
            {{ exporting === 'conv' ? t('nav.exporting') : t('nav.exportConv') }}
          </button>
          <p v-if="exportMsg" class="pop-msg">{{ exportMsg }}</p>
        </div>
      </div>
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
