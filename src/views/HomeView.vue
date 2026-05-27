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

// ── Tabloid front-page copy (locale-aware) ───────────────────────────────
// The loud alternate masthead reuses the same data; only the voice changes.
const tb = computed(() => settings.locale === 'en' ? {
  free:        'FREE',
  tagline:     'ALL THE STORIES FIT TO SHOUT',
  flashL:      'WORLD\nFIRST',
  flashR:      'INSIDE\nSCOOP',
  splashKicker:'★ WORLD EXCLUSIVE ★',
  sticker:     'READ\nON →',
  leadDek:     'The latest chapter stops dead right HERE — tap in and keep the story spilling!',
  leadEmpty:   'NO CHAPTERS YET — your very first line is tomorrow’s front-page splash!',
  comingUp:    'SPILLING SOON',
  draftsEmpty: 'Nothing in the drafts pile. Quiet… too quiet.',
  allDrafts:   'SEE EVERY DRAFT →',
  bigGossip:   'THIS WEEK’S BOMBSHELLS',
  archiveEmpty:'The archive’s keeping its mouth shut.',
  fullArchive: 'OPEN THE FILES →',
  footer:      'PRINTED HOT OFF THE PRESS',
} : {
  free:        '免费',
  tagline:     '你想知道的，这一页全给你抖出来！',
  flashL:      '全球\n首发',
  flashR:      '独家\n内幕',
  splashKicker:'★ 头版独家爆料 ★',
  sticker:     '读\n下去 →',
  leadDek:     '最新一章刚写到这儿就猛地停住——点开继续，别让故事憋着！',
  leadEmpty:   '还没有章节！你落下的第一笔，就是明天的头版头条。',
  comingUp:    '即将爆料',
  draftsEmpty: '草稿堆里空空如也，安静得反常。',
  allDrafts:   '抖出全部草稿 →',
  bigGossip:   '本周大瓜',
  archiveEmpty:'编年志暂时守口如瓶。',
  fullArchive: '翻开全部卷宗 →',
  footer:      '趁热印好 · 刚下印机',
})

// Event-category flags — colors per the project taxonomy, loud-printed.
const CAT_COLORS = {
  geopolitics: '#d11d1d', personal: '#1656c0', military: '#8a5a2b',
  cultural: '#2f9e44', other: '#777',
}
const CAT_LABELS = {
  zh: { geopolitics: '地缘', personal: '私事', military: '军事', cultural: '文化', other: '其他' },
  en: { geopolitics: 'WORLD', personal: 'PERSONAL', military: 'MILITARY', cultural: 'CULTURE', other: 'MISC' },
}
function catColor(c) { return CAT_COLORS[c] || CAT_COLORS.other }
function catLabel(c) { return (CAT_LABELS[settings.locale] || CAT_LABELS.zh)[c] || (CAT_LABELS[settings.locale] || CAT_LABELS.zh).other }
</script>

<template>
  <!-- ════════════════════════════════════════════════════════════
       TABLOID front page — loud gossip-rag splash. Opt-in via settings.
       ════════════════════════════════════════════════════════════ -->
  <div v-if="settings.homeStyle === 'tabloid'" class="tabloid-home">
    <!-- ── Flash bar: price · date · issue ───────────────────── -->
    <div class="tb-flashbar">
      <span class="tb-price">{{ tb.free }}</span>
      <span class="tb-flashbar-date">{{ dateEn }} · {{ timeStr }}</span>
      <span class="tb-issue">VOL {{ volNo.vol }} · NO. {{ volNo.no }}</span>
    </div>

    <!-- ── Masthead: blackletter wordmark on red, flanked by bursts ── -->
    <header class="tb-masthead">
      <div class="tb-burst tb-burst-l"><span>{{ tb.flashL }}</span></div>
      <h1 class="tb-wordmark">NovelWeb</h1>
      <div class="tb-burst tb-burst-r"><span>{{ tb.flashR }}</span></div>
    </header>
    <div class="tb-subbar">{{ tb.tagline }}</div>

    <!-- ── Lead splash ───────────────────────────────────────── -->
    <main class="tb-splash" :class="{ 'is-clickable': !!leadStory }" @click="leadStory && go(`/read/${leadStory.id}`)">
      <template v-if="leadStory">
        <div class="tb-splash-kicker">{{ tb.splashKicker }}</div>
        <h2 class="tb-headline">{{ leadStory.title }}</h2>
        <p class="tb-dek">{{ tb.leadDek }}</p>
        <div class="tb-byline">
          {{ leadStory.volTitle }}
          <span class="tb-byline-sep">·</span>
          <span v-if="settings.locale === 'en'">CH. {{ leadStory.chNum }}</span>
          <span v-else>第 {{ leadStory.chNum }} 章</span>
        </div>
        <div class="tb-sticker">{{ tb.sticker }}</div>
      </template>
      <p v-else class="tb-headline tb-headline-empty">{{ tb.leadEmpty }}</p>
    </main>

    <!-- ── Lower deck: drafts (coming up) + archive (bombshells) ── -->
    <div class="tb-lower">
      <section class="tb-col tb-shame">
        <div class="tb-band">{{ tb.comingUp }}</div>
        <template v-if="drafts.length">
          <article v-for="(d, i) in drafts" :key="d.id" class="tb-shame-item" @click="go('/drafts')">
            <span class="tb-num">{{ i + 1 }}</span>
            <div class="tb-shame-body">
              <h3 class="tb-shame-title">{{ d.title || '(无题)' }}</h3>
              <div v-if="d.updatedAt || d.savedAt" class="tb-shame-date">
                {{ new Date(d.updatedAt || d.savedAt).toLocaleDateString('zh-CN') }}
              </div>
            </div>
          </article>
        </template>
        <p v-else class="tb-empty">{{ tb.draftsEmpty }}</p>
        <p class="tb-more" @click="go('/drafts')">{{ tb.allDrafts }}</p>
      </section>

      <section class="tb-col tb-bombs">
        <div class="tb-band tb-band-pink">{{ tb.bigGossip }}</div>
        <template v-if="events.length">
          <article v-for="e in events" :key="e.id" class="tb-bomb" @click="go(`/archive/event/${e.id}`)">
            <span class="tb-flag" :style="{ background: catColor(e.category) }">{{ catLabel(e.category) }}</span>
            <h3 class="tb-bomb-title">{{ e.display_name || e.id }}</h3>
            <div class="tb-bomb-meta">
              {{ e.world_date || '—' }}
              <span v-if="e.pieceCount" class="tb-bomb-pieces">· {{ e.pieceCount }} 篇报道</span>
            </div>
          </article>
        </template>
        <p v-else class="tb-empty">{{ tb.archiveEmpty }}</p>
        <p class="tb-more" @click="go('/archive')">{{ tb.fullArchive }}</p>
      </section>
    </div>

    <!-- ── Footer band ───────────────────────────────────────── -->
    <footer class="tb-footer">
      <span>{{ tb.footer }}</span>
      <span class="tb-footer-dot">●</span>
      <span>{{ store.currentBook?.title || 'Untitled' }}</span>
    </footer>
  </div>

  <!-- ════════════════════════════════════════════════════════════
       BROADSHEET front page (default) — the sober NYT masthead.
       ════════════════════════════════════════════════════════════ -->
  <div v-else class="nyt-home">
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

/* ════════════════════════════════════════════════════════════
   TABLOID — a loud gossip-rag front page. Self-contained palette,
   does NOT inherit any app theme. Red + sun-yellow + hot-pink + black.
   ════════════════════════════════════════════════════════════ */
.tabloid-home {
  --tb-paper:  #fffdf8;
  --tb-ink:    #0d0d0d;
  --tb-red:    #e2000f;
  --tb-red-dk: #b00009;
  --tb-yellow: #ffd400;
  --tb-pink:   #ff1f7a;
  --tb-display: 'Smiley Sans', 'Impact', 'Haettenschweiler', 'Arial Narrow Bold',
                'Microsoft YaHei', sans-serif;
  --tb-body:    'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif;

  max-width: 1080px;
  margin: 20px auto;
  background: var(--tb-paper);
  color: var(--tb-ink);
  border: 3px solid var(--tb-ink);
  box-shadow: 0 8px 44px rgba(0, 0, 0, 0.30);
  overflow: hidden;
  font-family: var(--tb-display);
}

/* ── Flash bar ──────────────────────────────────────────── */
.tb-flashbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--tb-ink);
  color: #fff;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
}
.tb-price {
  background: var(--tb-yellow);
  color: #000;
  padding: 2px 11px;
  transform: skewX(-9deg);
  letter-spacing: 0.12em;
}
.tb-flashbar-date { opacity: 0.85; font-weight: 600; }
.tb-issue { color: var(--tb-yellow); }

/* ── Masthead ───────────────────────────────────────────── */
.tb-masthead {
  position: relative;
  background: linear-gradient(180deg, var(--tb-red) 0%, var(--tb-red-dk) 100%);
  border-top: 3px solid var(--tb-ink);
  border-bottom: 3px solid var(--tb-ink);
  padding: 16px 16px 18px;
  text-align: center;
  overflow: hidden;
}
.tb-wordmark {
  font-family: 'UnifrakturMaguntia', 'Georgia', serif;
  font-weight: 400;
  font-size: clamp(54px, 10vw, 100px);
  line-height: 1;
  margin: 0;
  color: #fff;
  letter-spacing: 0.01em;
  text-shadow: 2px 2px 0 var(--tb-red-dk), 4px 5px 0 rgba(0, 0, 0, 0.22);
}
.tb-burst {
  position: absolute;
  top: 50%;
  width: 94px;
  height: 94px;
  background: var(--tb-yellow);
  clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%,
                     50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
  filter: drop-shadow(2px 3px 0 rgba(0, 0, 0, 0.28));
}
.tb-burst-l { left: 14px; transform: translateY(-50%) rotate(-13deg); }
.tb-burst-r { right: 14px; transform: translateY(-50%) rotate(13deg); }
.tb-burst span {
  color: #000;
  font-weight: 700;
  font-size: 13px;
  line-height: 1.05;
  text-align: center;
  white-space: pre-line;
  letter-spacing: 0.02em;
  transform: rotate(2deg);
}

/* ── Tagline sub-bar ────────────────────────────────────── */
.tb-subbar {
  background: var(--tb-ink);
  color: var(--tb-yellow);
  text-align: center;
  font-size: clamp(13px, 1.6vw, 16px);
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 7px 12px;
  text-transform: uppercase;
}

/* ── Lead splash ────────────────────────────────────────── */
.tb-splash {
  position: relative;
  padding: 30px 28px 36px;
  border-bottom: 3px solid var(--tb-ink);
}
.tb-splash.is-clickable { cursor: pointer; }
.tb-splash-kicker {
  display: inline-block;
  background: var(--tb-ink);
  color: var(--tb-yellow);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.12em;
  padding: 4px 13px;
  transform: skewX(-9deg);
  margin-bottom: 16px;
}
.tb-headline {
  font-family: var(--tb-display);
  font-weight: 800;
  font-size: clamp(38px, 7vw, 84px);
  line-height: 0.96;
  margin: 0;
  max-width: 78%;
  color: var(--tb-ink);
  letter-spacing: -0.01em;
  text-transform: uppercase;
  transition: color 0.15s;
}
.tb-splash.is-clickable:hover .tb-headline { color: var(--tb-red); }
.tb-headline-empty { max-width: 100%; color: var(--tb-red); }
.tb-dek {
  margin: 18px 0 0;
  max-width: 60%;
  font-family: var(--tb-body);
  font-weight: 600;
  font-size: clamp(15px, 1.7vw, 19px);
  line-height: 1.45;
  color: #222;
}
.tb-byline {
  margin-top: 14px;
  font-family: var(--tb-body);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--tb-red);
}
.tb-byline-sep { margin: 0 7px; color: #c8c8c8; }
.tb-sticker {
  position: absolute;
  right: 28px;
  bottom: 28px;
  width: 106px;
  height: 106px;
  border-radius: 50%;
  background: var(--tb-pink);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  white-space: pre-line;
  font-family: var(--tb-display);
  font-weight: 800;
  font-size: 19px;
  line-height: 1.1;
  transform: rotate(-10deg);
  border: 3px solid var(--tb-ink);
  box-shadow: 0 4px 0 var(--tb-ink), 0 7px 16px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.tb-splash.is-clickable:hover .tb-sticker { transform: rotate(0deg) scale(1.07); transition: transform 0.18s; }

/* ── Lower deck ─────────────────────────────────────────── */
.tb-lower {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
}
.tb-shame { border-right: 3px solid var(--tb-ink); }
.tb-band {
  background: var(--tb-ink);
  color: #fff;
  font-family: var(--tb-display);
  font-weight: 800;
  font-size: 16px;
  letter-spacing: 0.08em;
  padding: 8px 16px;
  text-transform: uppercase;
}
.tb-band-pink { background: var(--tb-pink); }

/* Coming-up (drafts) list */
.tb-shame-item {
  display: flex;
  gap: 13px;
  align-items: flex-start;
  padding: 11px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  cursor: pointer;
  transition: background 0.15s;
}
.tb-shame-item:last-of-type { border-bottom: none; }
.tb-shame-item:hover { background: var(--tb-yellow); }
.tb-num {
  font-family: var(--tb-display);
  font-weight: 800;
  font-size: 30px;
  line-height: 0.9;
  color: var(--tb-red);
  min-width: 26px;
  text-align: center;
}
.tb-shame-body { min-width: 0; }
.tb-shame-title {
  margin: 0;
  font-family: var(--tb-body);
  font-weight: 700;
  font-size: 15px;
  line-height: 1.3;
  color: var(--tb-ink);
}
.tb-shame-date {
  margin-top: 3px;
  font-size: 11px;
  color: #9a9a9a;
  letter-spacing: 0.04em;
}

/* Bombshells (archive) list */
.tb-bomb {
  padding: 13px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  cursor: pointer;
  transition: background 0.15s;
}
.tb-bomb:last-of-type { border-bottom: none; }
.tb-bomb:hover { background: #fff3c4; }
.tb-flag {
  display: inline-block;
  color: #fff;
  font-family: var(--tb-body);
  font-weight: 800;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 9px;
  margin-bottom: 7px;
  transform: skewX(-9deg);
}
.tb-bomb-title {
  margin: 0;
  font-family: var(--tb-body);
  font-weight: 700;
  font-size: 16px;
  line-height: 1.3;
  color: var(--tb-ink);
}
.tb-bomb-meta {
  margin-top: 5px;
  font-family: var(--tb-body);
  font-size: 11px;
  color: #8a8a8a;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.tb-bomb-pieces { color: var(--tb-red); }

.tb-more {
  margin: 13px 16px 0;
  font-family: var(--tb-display);
  font-weight: 800;
  font-size: 15px;
  letter-spacing: 0.04em;
  color: var(--tb-red);
  cursor: pointer;
  text-transform: uppercase;
  transition: color 0.15s;
}
.tb-more:hover { color: var(--tb-pink); }
.tb-empty {
  padding: 14px 16px;
  font-family: var(--tb-body);
  font-style: italic;
  color: #9a9a9a;
  font-size: 14px;
}

/* ── Footer band ────────────────────────────────────────── */
.tb-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--tb-ink);
  color: #fff;
  border-top: 3px solid var(--tb-ink);
  padding: 11px 16px;
  font-family: var(--tb-body);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-align: center;
}
.tb-footer-dot { color: var(--tb-red); font-size: 8px; }

/* ── Tabloid responsive ─────────────────────────────────── */
@media (max-width: 760px) {
  .tb-lower { grid-template-columns: 1fr; }
  .tb-shame { border-right: none; border-bottom: 3px solid var(--tb-ink); }
  .tb-headline, .tb-dek { max-width: 100%; }
}
@media (max-width: 620px) {
  .tb-burst { display: none; }
  .tb-sticker {
    position: static;
    margin: 20px 0 0;
    transform: rotate(-5deg);
  }
}
</style>
