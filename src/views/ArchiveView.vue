<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from '../i18n'
import { useNovelStore } from '../stores/novel'

const { t } = useI18n()
const store = useNovelStore()
const data = ref(null)
const loading = ref(true)
const error = ref('')
const filterCat = ref('all')

async function loadArchive() {
  if (!store.currentBookId) { data.value = null; loading.value = false; return }
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/books/${store.currentBookId}/archive/overview`)
    data.value = await res.json()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(loadArchive)
watch(() => store.currentBookId, loadArchive)

const categoryMap = computed(() => {
  const m = {}
  for (const c of data.value?.taxonomy?.event_categories || []) m[c.id] = c
  return m
})

function catColor(catId) {
  return categoryMap.value[catId]?.color || '#888'
}

// Localised label for an event category. Falls back to the zh label from the
// taxonomy JSON if no i18n key exists (e.g. a category we don't ship yet).
function catLabel(catId) {
  const key = `tax.cat.${catId}`
  const translated = t(key)
  if (translated !== key) return translated
  return categoryMap.value[catId]?.label || catId || t('archive.uncategorized')
}

const timelineGroups = computed(() => {
  if (!data.value?.events) return []
  let list = data.value.events
  if (filterCat.value !== 'all') {
    list = list.filter(e => e.category === filterCat.value)
  }
  const groups = []
  let currentYear = null
  for (const evt of list) {
    const yearMatch = String(evt.world_date || '').match(/泰元(\d+)/)
    const year = yearMatch ? `泰元${yearMatch[1]}年` : t('archive.unknownYear')
    if (year !== currentYear) {
      currentYear = year
      groups.push({ year, events: [] })
    }
    groups[groups.length - 1].events.push(evt)
  }
  return groups
})

const categories = computed(() => data.value?.taxonomy?.event_categories || [])

async function deleteEvent(evt) {
  const count = evt.pieceCount || 0
  const msg = count > 0
    ? t('archive.deleteEventWithPieces', { name: evt.display_name, count })
    : t('archive.deleteEvent', { name: evt.display_name })
  if (!confirm(msg)) return
  await fetch(`/api/books/${store.currentBookId}/archive/event/${evt.id}`, { method: 'DELETE' })
  data.value.events = data.value.events.filter(e => e.id !== evt.id)
}
</script>

<template>
  <div class="chronicle-page">
    <header class="ch-header">
      <h1>{{ t('archive.h1') }}</h1>
      <p class="text-muted">{{ t('archive.tagline') }}</p>
    </header>

    <div v-if="loading" class="ch-empty">{{ t('archive.loading') }}</div>
    <div v-else-if="error" class="ch-empty">{{ t('archive.error', { error }) }}</div>
    <div v-else-if="data" class="ch-body">
      <!-- Category filter -->
      <div class="ch-filters">
        <button :class="['ch-filter', { ac: filterCat === 'all' }]" @click="filterCat = 'all'">
          {{ t('archive.allFilter') }} <span class="ct">{{ data.events.length }}</span>
        </button>
        <button v-for="cat in categories" :key="cat.id"
                :class="['ch-filter', { ac: filterCat === cat.id }]"
                @click="filterCat = cat.id"
                :style="filterCat === cat.id ? { borderColor: cat.color, color: cat.color } : {}">
          <span class="ch-filter-dot" :style="{ background: cat.color }"></span>
          {{ catLabel(cat.id) }}
          <span class="ct">{{ data.events.filter(e => e.category === cat.id).length }}</span>
        </button>
      </div>

      <!-- Timeline -->
      <div v-if="timelineGroups.length === 0" class="ch-empty">{{ t('archive.emptyTimeline') }}</div>
      <div v-else class="tl">
        <div v-for="group in timelineGroups" :key="group.year" class="tl-year-group">
          <div class="tl-year-label">{{ group.year }}</div>
          <div class="tl-events">
            <router-link v-for="evt in group.events" :key="evt.id"
                         :to="`/archive/event/${evt.id}`"
                         class="tl-event">
              <div class="tl-dot" :style="{ background: catColor(evt.category) }"></div>
              <div class="tl-connector"></div>
              <div class="tl-content">
                <div class="tl-content-header">
                  <span class="tl-cat-badge" :style="{ background: catColor(evt.category) }">
                    {{ catLabel(evt.category) }}
                  </span>
                  <span class="tl-date">{{ evt.world_date }}</span>
                </div>
                <h3>{{ evt.display_name }}</h3>
                <p class="tl-summary">{{ evt.summary }}</p>
                <div class="tl-tags" v-if="evt.tags?.length">
                  <span v-for="t in evt.tags" :key="t" class="tl-tag">{{ t }}</span>
                </div>
                <div class="tl-stats">
                  <span v-if="evt.chapterCount">{{ t('archive.chaptersN', { count: evt.chapterCount }) }}</span>
                  <span v-if="evt.pieceCount">{{ t('archive.piecesN', { count: evt.pieceCount }) }}</span>
                </div>
              </div>
              <button class="tl-delete" @click.prevent.stop="deleteEvent(evt)" :title="t('archive.deleteEventTitle')">&times;</button>
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chronicle-page { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
.ch-header h1 { font-family: var(--font-reading); font-size: 28px; margin: 0 0 6px; }
.ch-header { margin-bottom: 24px; }
.ch-empty { padding: 60px; text-align: center; color: var(--text-muted); }

.ch-filters {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 28px;
  padding-bottom: 16px; border-bottom: 1px solid var(--border);
}
.ch-filter {
  display: inline-flex; align-items: center; gap: 5px;
  background: transparent; border: 1px solid var(--border); padding: 5px 14px;
  cursor: pointer; color: var(--text-muted); font-size: 13px;
  border-radius: 20px; transition: all .15s;
}
.ch-filter:hover { border-color: var(--text-muted); color: var(--text); }
.ch-filter.ac { color: var(--accent); border-color: var(--accent); font-weight: 600; }
.ch-filter .ct {
  display: inline-block; min-width: 18px; padding: 0 5px;
  background: var(--border); color: var(--text-muted); border-radius: 10px;
  font-size: 11px; font-weight: 600; text-align: center;
}
.ch-filter-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}

.tl { position: relative; padding-left: 32px; }
.tl::before {
  content: '';
  position: absolute; left: 15px; top: 0; bottom: 0;
  width: 2px; background: var(--border);
}

.tl-year-group { margin-bottom: 8px; }
.tl-year-label {
  position: relative;
  font-family: var(--font-reading); font-size: 18px; font-weight: 700;
  color: var(--accent); padding: 12px 0 8px;
  margin-left: -32px; padding-left: 40px;
}
.tl-year-label::before {
  content: '';
  position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent); border: 3px solid var(--bg);
}

.tl-events { display: flex; flex-direction: column; gap: 4px; }
.tl-event {
  position: relative;
  display: flex; align-items: flex-start; gap: 0;
  padding: 12px 16px 12px 0;
  text-decoration: none; color: var(--text);
  border-radius: var(--radius);
  transition: all .15s;
}
.tl-event:hover { background: var(--bg-card); }
.tl-event:hover .tl-content h3 { color: var(--accent); }

.tl-dot {
  position: absolute; left: -25px; top: 20px;
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--bg); z-index: 1;
  flex-shrink: 0;
}

.tl-content { flex: 1; min-width: 0; }
.tl-content-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
}
.tl-cat-badge {
  font-size: 11px; padding: 1px 8px; color: #fff;
  border-radius: 3px; font-weight: 600; letter-spacing: .3px;
}
.tl-date { font-size: 12px; color: var(--text-muted); }
.tl-content h3 {
  font-size: 16px; font-weight: 600; margin: 0 0 4px;
  line-height: 1.4; transition: color .15s;
}
.tl-summary {
  font-size: 13px; color: var(--text-muted); line-height: 1.6;
  margin: 0 0 6px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tl-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.tl-tag {
  font-size: 11px; padding: 1px 7px; background: var(--bg-sidebar);
  border-radius: 4px; color: var(--text-muted);
}
.tl-stats {
  display: flex; gap: 12px; font-size: 11px; color: var(--text-muted);
}
.tl-stats span::before { margin-right: 2px; }

.tl-delete {
  position: absolute; right: 8px; top: 10px;
  background: none; border: none; cursor: pointer;
  font-size: 16px; color: var(--text-muted); padding: 2px 6px;
  opacity: 0; transition: opacity .15s, color .15s;
  line-height: 1;
}
.tl-event:hover .tl-delete { opacity: 1; }
.tl-delete:hover { color: #c04040; }
</style>
