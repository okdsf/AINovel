<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '../i18n'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const data = ref(null)
const taxonomy = ref(null)
const loading = ref(true)
const error = ref('')

async function load(id) {
  loading.value = true
  error.value = ''
  try {
    const [r1, r2] = await Promise.all([
      fetch(`/api/archive/event/${id}`),
      fetch('/api/archive/taxonomy')
    ])
    if (!r1.ok) {
      const err = await r1.json()
      throw new Error(err.error || t('event.loading'))
    }
    data.value = await r1.json()
    taxonomy.value = await r2.json()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(() => load(route.params.id))
watch(() => route.params.id, id => { if (id) load(id) })

const outletMap = computed(() => {
  const m = {}
  for (const o of taxonomy.value?.outlets || []) m[o.id] = o
  return m
})
const reliabilityMap = computed(() => {
  const m = {}
  for (const r of taxonomy.value?.reliability || []) m[r.id] = r
  return m
})

const piecesByReliability = computed(() => {
  const groups = {}
  for (const p of data.value?.pieces || []) {
    const k = p.reliability || 'reported'
    if (!groups[k]) groups[k] = []
    groups[k].push(p)
  }
  return groups
})

const reliabilityOrder = ['canon', 'official', 'reported', 'rumor', 'propaganda']

async function deletePiece(pieceId) {
  const p = data.value.pieces.find(x => x.id === pieceId)
  if (!confirm(t('event.deletePieceConfirm', { title: p?.title || pieceId }))) return
  await fetch(`/api/archive/piece/${pieceId}`, { method: 'DELETE' })
  data.value.pieces = data.value.pieces.filter(x => x.id !== pieceId)
}

async function deleteCurrentEvent() {
  const evt = data.value.event
  const count = data.value.pieces.length
  const msg = count > 0
    ? t('archive.deleteEventWithPieces', { name: evt.display_name, count })
    : t('archive.deleteEvent', { name: evt.display_name })
  if (!confirm(msg)) return
  await fetch(`/api/archive/event/${evt.id}`, { method: 'DELETE' })
  router.push('/archive')
}
</script>

<template>
  <div class="event-page">
    <div v-if="loading" class="ar-empty">{{ t('event.loading') }}</div>
    <div v-else-if="error" class="ar-empty">{{ t('event.error', { error }) }}</div>
    <div v-else-if="data">
      <header class="ev-header">
        <div class="ev-crumb">
          <router-link to="/archive">{{ t('event.backCrumb') }}</router-link>
        </div>
        <div class="ev-title-row">
          <h1>{{ data.event.display_name }}</h1>
          <span class="ev-date" v-if="data.event.world_date">{{ data.event.world_date }}</span>
          <button class="ev-delete-btn" @click="deleteCurrentEvent" :title="t('event.deleteEventTitle')">{{ t('event.deleteEventBtn') }}</button>
        </div>
        <div class="ev-tags">
          <span v-for="tag in data.event.tags" :key="tag" class="ar-tag">{{ tag }}</span>
        </div>
        <p class="ev-summary">{{ data.event.summary }}</p>
        <p v-if="data.event.significance" class="ev-significance">
          <strong>{{ t('event.significancePrefix') }}</strong> {{ data.event.significance }}
        </p>
      </header>

      <!-- Pieces grouped by reliability -->
      <section class="ev-section">
        <h2>{{ t('event.piecesHeader') }} <span class="ct">{{ data.pieces.length }}</span></h2>
        <div v-if="!data.pieces.length" class="ev-section-empty">{{ t('event.noPiecesOuter') }}</div>
        <div v-else class="ev-pieces">
          <template v-for="r in reliabilityOrder" :key="r">
            <div v-if="piecesByReliability[r]" class="ev-pieces-group">
              <div class="ev-rel-label" :style="{ borderColor: reliabilityMap[r]?.color || '#666' }">
                <span class="ar-reliability" :style="{ background: reliabilityMap[r]?.color || '#666' }">
                  {{ reliabilityMap[r]?.label || r }}
                </span>
                <span class="ev-rel-desc">{{ reliabilityMap[r]?.desc }}</span>
              </div>
              <div class="ev-pieces-grid">
                <div v-for="p in piecesByReliability[r]" :key="p.id" class="ev-piece-card-wrap">
                  <a :href="`/pieces-render/${p.id}/${p.entry_file}`"
                     target="_blank"
                     class="ev-piece-card">
                    <div class="ev-piece-h">
                      <span class="ar-outlet" :style="{ background: outletMap[p.outlet]?.color || '#666' }">
                        {{ outletMap[p.outlet]?.name || p.outlet }}
                      </span>
                      <span v-if="p.author" class="ev-author">{{ p.author }}</span>
                    </div>
                    <h3>{{ p.title }}</h3>
                    <p>{{ p.summary }}</p>
                  </a>
                  <button class="piece-delete" @click="deletePiece(p.id)" :title="t('event.deletePieceTitle')">&times;</button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- Chapters -->
      <section class="ev-section">
        <h2>{{ t('event.chaptersHeader') }} <span class="ct">{{ data.chapters.length }}</span></h2>
        <div v-if="!data.chapters.length" class="ev-section-empty">{{ t('event.noChapters') }}</div>
        <ul v-else class="ev-list">
          <li v-for="ch in data.chapters" :key="ch.chId">
            <router-link :to="`/read/${ch.chId}`">
              <span class="ev-list-title">{{ ch.chTitle }}</span>
              <span class="ev-list-sub">{{ ch.bookTitle }} · {{ ch.volTitle }}</span>
            </router-link>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.event-page { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
.ar-empty { padding: 60px; text-align: center; color: var(--text-muted); }

.ev-crumb { margin-bottom: 12px; }
.ev-crumb a { color: var(--text-muted); text-decoration: none; font-size: 13px; }
.ev-crumb a:hover { color: var(--accent); }

.ev-title-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.ev-header h1 { font-family: var(--font-reading); font-size: 30px; margin: 0; }
.ev-date { font-size: 14px; color: var(--text-muted); }

.ev-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 10px 0 12px; }
.ar-tag {
  font-size: 11px; padding: 2px 8px; background: var(--bg-sidebar);
  border-radius: 4px; color: var(--text-muted);
}

.ev-summary { font-size: 14px; line-height: 1.8; margin: 0 0 12px; padding: 16px; background: var(--bg-card); border-left: 3px solid var(--accent); border-radius: var(--radius); }
.ev-significance { font-size: 13px; color: var(--text-muted); line-height: 1.7; margin: 0 0 28px; padding: 0 4px; }
.ev-significance strong { color: var(--accent); }

.ev-section h2 {
  font-size: 15px; font-weight: 600; margin: 24px 0 12px;
  padding-bottom: 6px; border-bottom: 1px solid var(--border);
}
.ev-section h2 .ct {
  font-size: 11px; color: var(--text-muted); font-weight: 400; margin-left: 6px;
}
.ev-section-empty { font-size: 13px; color: var(--text-muted); padding: 12px 0; font-style: italic; }

.ev-pieces { display: flex; flex-direction: column; gap: 20px; }
.ev-pieces-group { padding: 12px 0; }
.ev-rel-label {
  display: flex; align-items: center; gap: 10px;
  border-left: 3px solid; padding-left: 10px; margin-bottom: 10px;
}
.ev-rel-desc { font-size: 12px; color: var(--text-muted); }

.ev-pieces-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.ev-piece-card {
  display: block; padding: 14px 16px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: var(--radius);
  text-decoration: none; color: var(--text); transition: all .15s;
}
.ev-piece-card:hover { border-color: var(--accent); transform: translateY(-2px); }
.ev-piece-h { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.ev-author { font-size: 11px; color: var(--text-muted); }
.ev-piece-card h3 { font-size: 14px; font-weight: 600; margin: 0 0 6px; line-height: 1.4; }
.ev-piece-card p { font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

.ev-list { list-style: none; padding: 0; margin: 0; }
.ev-list li { margin-bottom: 4px; }
.ev-list a {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 8px 12px; border-radius: 4px;
  text-decoration: none; color: var(--text); transition: background .15s;
}
.ev-list a:hover { background: var(--bg-card); }
.ev-list-title { font-size: 14px; }
.ev-list-sub { font-size: 11px; color: var(--text-muted); }

.ar-outlet, .ar-reliability {
  font-size: 11px; padding: 3px 10px; color: #fff; border-radius: 3px;
  font-weight: 600; letter-spacing: .5px;
}

.ev-delete-btn {
  background: none; border: 1px solid var(--border); cursor: pointer;
  font-size: 12px; color: var(--text-muted); padding: 4px 12px;
  border-radius: 4px; transition: all .15s; margin-left: auto;
}
.ev-delete-btn:hover { color: #c04040; border-color: #c04040; }

.ev-piece-card-wrap { position: relative; }
.piece-delete {
  position: absolute; right: 6px; top: 6px;
  background: var(--bg-card); border: 1px solid var(--border); cursor: pointer;
  font-size: 14px; color: var(--text-muted); padding: 1px 6px;
  border-radius: 3px; opacity: 0; transition: opacity .15s, color .15s;
  line-height: 1;
}
.ev-piece-card-wrap:hover .piece-delete { opacity: 1; }
.piece-delete:hover { color: #c04040; border-color: #c04040; }
</style>
