<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useSettingsStore } from '../stores/settings'

const router = useRouter()
const store = useNovelStore()
const settings = useSettingsStore()

// ── Aphorisms — picked from the pool that matches the current locale ─────
const APHORISMS_ZH = [
  { text: '文章千古事，得失寸心知。', source: '杜甫' },
  { text: '笔下有山河，心中有日月。' },
  { text: '故事在被讲述之前，并不存在。' },
  { text: '小说是一面在路上行走的镜子。', source: '司汤达' },
  { text: '说出真相，但请斜着说。', source: 'Emily Dickinson' },
]
const APHORISMS_EN = [
  { text: 'Tell the truth, but tell it slant.',                    source: 'Emily Dickinson' },
  { text: 'A novel is a mirror walking down a road.',              source: 'Stendhal' },
  { text: 'All the Stories Fit to Tell.' },
  { text: 'Fiction is the lie through which we tell the truth.',   source: 'Albert Camus' },
  { text: 'The story does not exist before it is told.' },
]
function pickAphorism() {
  const pool = settings.locale === 'en' ? APHORISMS_EN : APHORISMS_ZH
  return pool[Math.floor(Math.random() * pool.length)]
}
const aphorism = ref(pickAphorism())
watch(() => settings.locale, () => { aphorism.value = pickAphorism() })

// ── Live clock ───────────────────────────────────────────────────────────
const now = ref(new Date())
let clockTimer = null
onMounted(() => { clockTimer = setInterval(() => { now.value = new Date() }, 1000) })
onUnmounted(() => { if (clockTimer) clearInterval(clockTimer) })

const dateEn = computed(() => now.value.toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
}))
const dateZh = computed(() => {
  const d = now.value
  const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 星期${wk}`
})
const timeStr = computed(() => now.value.toLocaleTimeString('en-GB', { hour12: false }))

// ── Vol / No derived from real data ──────────────────────────────────────
function toRoman(n) {
  const vals = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],
                ['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]]
  let r = ''
  for (const [s, v] of vals) { while (n >= v) { r += s; n -= v } }
  return r || 'I'
}
const volNo = computed(() => {
  if (!store.meta) return { vol: '—', no: '—' }
  const bookIdx = store.books.findIndex(b => b.id === store.currentBookId)
  const chCount = (store.meta.volumes || []).reduce((s, v) => s + (v.chapters?.length || 0), 0)
  return { vol: toRoman(bookIdx + 1), no: chCount }
})

// ── Lead story: last chapter of last volume ──────────────────────────────
const leadStory = computed(() => {
  const vols = store.meta?.volumes || []
  if (!vols.length) return null
  const lastVol = vols[vols.length - 1]
  if (!lastVol.chapters?.length) return null
  const lastCh = lastVol.chapters[lastVol.chapters.length - 1]
  let n = 0
  for (const v of vols) for (const c of v.chapters) {
    n++
    if (c.id === lastCh.id) return { id: c.id, title: c.title, volTitle: lastVol.title, chNum: n }
  }
  return null
})

// ── Editorial: drafts in progress ────────────────────────────────────────
const drafts = ref([])
async function loadDrafts() {
  try {
    const res = await fetch('/api/drafts')
    const all = await res.json()
    drafts.value = (Array.isArray(all) ? all : []).slice(0, 4)
  } catch {}
}

// ── Archive: most recent events for current book ─────────────────────────
const events = ref([])
async function loadArchive() {
  if (!store.currentBookId) { events.value = []; return }
  try {
    const res = await fetch(`/api/books/${store.currentBookId}/archive/overview`)
    const data = await res.json()
    events.value = (data.events || []).slice(0, 3)
  } catch {}
}

onMounted(() => { loadDrafts(); loadArchive() })

function go(path) { router.push(path) }
</script>

<template>
  <div class="nyt-home">
    <!-- ── Motto bar ─────────────────────────────────────────── -->
    <div class="nyt-motto">
      <span class="motto-text">"{{ aphorism.text }}"</span>
      <span v-if="aphorism.source" class="motto-source">— {{ aphorism.source }}</span>
    </div>

    <hr class="rule-thin" />

    <!-- ── Header: Vol/No left · Date right ──────────────────── -->
    <div class="nyt-meta">
      <div class="meta-left">
        <div class="meta-line">Late Edition</div>
        <div class="meta-line">Vol. {{ volNo.vol }} &middot; No. {{ volNo.no }}</div>
      </div>
      <div class="meta-right">
        <div class="meta-line">{{ dateEn }} <span v-if="settings.locale === 'en'">&middot; {{ timeStr }}</span></div>
        <div v-if="settings.locale !== 'en'" class="meta-line">{{ dateZh }} &middot; {{ timeStr }}</div>
      </div>
    </div>

    <hr class="rule-thin" />

    <!-- ── Wordmark ──────────────────────────────────────────── -->
    <header class="nyt-wordmark">
      <h1 class="wm-en">NovelWeb</h1>
      <div v-if="settings.locale !== 'en'" class="wm-zh">小说编年制</div>
      <div v-else class="wm-en-sub">A Chronicle of Fiction</div>
    </header>

    <hr class="rule-double" />

    <!-- ── Three-column main ─────────────────────────────────── -->
    <main class="nyt-grid">
      <!-- LEAD STORY -->
      <section class="col col-lead">
        <div class="kicker">Lead Story · 头版</div>
        <template v-if="leadStory">
          <h2 class="headline headline-lead" @click="go(`/read/${leadStory.id}`)">
            {{ leadStory.title }}
          </h2>
          <div class="dateline">{{ leadStory.volTitle }} &middot; 第 {{ leadStory.chNum }} 章</div>
          <p class="dek">
            最近一次落笔停在这里。点击标题继续往下写，或回头读一遍。
          </p>
          <p class="continue" @click="go(`/read/${leadStory.id}`)">
            Continue Reading →
          </p>
        </template>
        <p v-else class="empty">No chapters yet. Begin with the first stroke.</p>
      </section>

      <!-- EDITORIAL: drafts -->
      <section class="col col-mid">
        <div class="kicker">Editorial Desk · 草稿台</div>
        <template v-if="drafts.length">
          <article v-for="d in drafts" :key="d.id" class="card" @click="go('/drafts')">
            <h3 class="headline-sm">{{ d.title || '(无题)' }}</h3>
            <div v-if="d.updatedAt || d.savedAt" class="dateline-sm">
              {{ new Date(d.updatedAt || d.savedAt).toLocaleDateString('zh-CN') }}
            </div>
          </article>
        </template>
        <p v-else class="empty">No drafts in the queue.</p>
        <p class="continue" @click="go('/drafts')">All Drafts →</p>
      </section>

      <!-- ARCHIVE: events -->
      <section class="col col-right">
        <div class="kicker">Archive · 编年志</div>
        <template v-if="events.length">
          <article v-for="e in events" :key="e.id" class="card" @click="go(`/archive/event/${e.id}`)">
            <h3 class="headline-sm">{{ e.display_name || e.id }}</h3>
            <div class="dateline-sm">
              {{ e.world_date || '—' }}
              <span v-if="e.pieceCount" class="piece-count">&middot; {{ e.pieceCount }} pieces</span>
            </div>
          </article>
        </template>
        <p v-else class="empty">The archive is silent.</p>
        <p class="continue" @click="go('/archive')">Full Archive →</p>
      </section>
    </main>

    <hr class="rule-thin" />

    <!-- ── Colophon ──────────────────────────────────────────── -->
    <footer class="nyt-colophon">
      <span>Published from the Editor's Desk</span>
      <span class="dot">·</span>
      <span>{{ store.currentBook?.title || 'Untitled' }}</span>
      <span class="dot">·</span>
      <span>Printed Sundown to Sunup</span>
    </footer>
  </div>
</template>

<style scoped>
/* ════════════════════════════════════════════════════════════
   The Home is its own object — a newspaper. It does NOT inherit
   the reading-content theme variables. Always cream + ink.
   ════════════════════════════════════════════════════════════ */
.nyt-home {
  /* Lock to newspaper colors regardless of app theme/dark mode */
  --ink:       #1a1a1a;
  --ink-soft:  #4a4a4a;
  --ink-muted: #888;
  --paper:     #faf7ef;
  --paper-edge:#e8e1d0;
  --rule:      #1a1a1a;
  --hot:       #8b0000;

  background: var(--paper);
  color: var(--ink);
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Georgia', 'Songti SC', 'SimSun', serif;

  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 36px 60px;
  /* subtle paper edge */
  box-shadow:
    0 2px 24px rgba(60, 40, 20, 0.08),
    0 0 0 1px var(--paper-edge) inset;
}

/* ── Motto ──────────────────────────────────────────────── */
.nyt-motto {
  text-align: center;
  font-style: italic;
  font-size: 13px;
  color: var(--ink-soft);
  padding: 4px 0 6px;
  letter-spacing: 0.02em;
}
.motto-source {
  font-style: normal;
  font-variant: small-caps;
  margin-left: 8px;
  color: var(--ink-muted);
}

/* ── Rules ──────────────────────────────────────────────── */
.rule-thin {
  border: none;
  border-top: 1px solid var(--rule);
  margin: 0;
}
.rule-double {
  border: none;
  border-top: 3px double var(--rule);
  margin: 18px 0 22px;
}

/* ── Header meta line (Vol/Date) ─────────────────────────── */
.nyt-meta {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 8px 4px 10px;
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-soft);
  font-family: 'Georgia', 'Noto Serif SC', serif;
  font-variant-numeric: tabular-nums;
}
.meta-right { text-align: right; }
.meta-line { line-height: 1.7; }

/* ── Wordmark ───────────────────────────────────────────── */
.nyt-wordmark {
  text-align: center;
  padding: 16px 0 8px;
}
.wm-en {
  font-family: 'UnifrakturMaguntia', 'Georgia', serif;
  font-weight: 400;
  font-size: clamp(72px, 11vw, 132px);
  line-height: 1;
  letter-spacing: 0.01em;
  color: var(--ink);
  margin: 0;
}
.wm-zh {
  margin-top: 14px;
  font-family: 'Ma Shan Zheng', 'KaiTi', 'STKaiti', serif;
  font-size: clamp(20px, 2.6vw, 32px);
  color: var(--ink-soft);
  letter-spacing: 0.18em;
}
.wm-en-sub {
  margin-top: 14px;
  font-family: 'Georgia', 'Source Serif Pro', 'Noto Serif SC', serif;
  font-style: italic;
  font-size: clamp(16px, 2vw, 24px);
  color: var(--ink-soft);
  letter-spacing: 0.06em;
}

/* ── Three-column main ──────────────────────────────────── */
.nyt-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 0 24px;
  padding: 6px 0 24px;
}
/* Hairline vertical rules drawn as left-borders on mid/right cols */
.col-mid, .col-right { position: relative; }
.col-mid::before,
.col-right::before {
  content: '';
  position: absolute;
  left: -12px; top: 0; bottom: 0;
  width: 1px;
  background: var(--rule);
  opacity: 0.18;
}

/* ── Column content ─────────────────────────────────────── */
.col {
  padding: 4px 8px 0;
}
.kicker {
  font-family: 'Georgia', 'Noto Serif SC', serif;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--rule);
  padding-bottom: 6px;
  margin-bottom: 14px;
}

.headline {
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Georgia', serif;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.2;
  cursor: pointer;
  margin: 0;
  transition: color 0.15s;
}
.headline:hover { color: var(--hot); }

.headline-lead {
  font-size: 34px;
  letter-spacing: -0.005em;
}

.dateline {
  margin-top: 8px;
  font-family: 'Georgia', serif;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ink-muted);
}

.dek {
  margin-top: 14px;
  font-size: 15px;
  line-height: 1.65;
  color: var(--ink-soft);
}

.continue {
  margin-top: 14px;
  font-family: 'Georgia', serif;
  font-size: 13px;
  font-style: italic;
  color: var(--hot);
  cursor: pointer;
  transition: opacity 0.15s;
}
.continue:hover { opacity: 0.7; }

/* Smaller cards in side columns */
.card {
  padding: 10px 0 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--rule) 18%, transparent);
  cursor: pointer;
  transition: opacity 0.15s;
}
.card:last-of-type { border-bottom: none; }
.card:hover .headline-sm { color: var(--hot); }

.headline-sm {
  margin: 0;
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Georgia', serif;
  font-weight: 600;
  font-size: 16px;
  line-height: 1.3;
  color: var(--ink);
  transition: color 0.15s;
}
.dateline-sm {
  margin-top: 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.piece-count { font-variant: small-caps; }

.empty {
  font-style: italic;
  color: var(--ink-muted);
  font-size: 14px;
  padding: 8px 0;
}

/* ── Colophon ───────────────────────────────────────────── */
.nyt-colophon {
  text-align: center;
  padding: 18px 0 4px;
  font-family: 'Georgia', serif;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.nyt-colophon .dot { margin: 0 10px; opacity: 0.5; }

/* ── Responsive ─────────────────────────────────────────── */
@media (max-width: 880px) {
  .nyt-home { padding: 20px 18px 40px; }
  .nyt-grid { grid-template-columns: 1fr; gap: 16px; }
  .nyt-grid > .col-mid::before,
  .nyt-grid > .col-right::before {
    left: 0; right: 0; top: 0; bottom: auto;
    width: auto; height: 1px;
  }
  .col { padding: 16px 4px 0; border-top: 1px solid color-mix(in srgb, var(--rule) 18%, transparent); }
  .col-lead { border-top: none; padding-top: 4px; }
  .nyt-meta {
    flex-direction: column;
    gap: 4px;
  }
  .meta-right { text-align: left; }
}
</style>
