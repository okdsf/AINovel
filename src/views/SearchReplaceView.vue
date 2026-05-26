<script setup>
import { ref } from 'vue'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'

const store = useNovelStore()
const { t } = useI18n()
const searchText = ref('')
const replaceText = ref('')
const results = ref(null)
const totalCount = ref(0)
const searching = ref(false)
const replacing = ref(false)
const message = ref('')

async function doSearch() {
  if (!searchText.value) return
  searching.value = true
  message.value = ''
  try {
    const res = await fetch(`/api/books/${store.currentBookId}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchText.value })
    })
    const data = await res.json()
    results.value = data.results
    totalCount.value = data.totalCount
  } catch (e) {
    message.value = t('sr.searchFailed', { error: e.message })
  } finally {
    searching.value = false
  }
}

async function doReplace(chapterIds) {
  const scope = chapterIds ? t('sr.scopeSelected') : t('sr.scopeAllCh')
  const action = replaceText.value === ''
    ? t('sr.actionDelete')
    : t('sr.actionReplaceWith', { value: replaceText.value })
  if (!confirm(t('sr.confirmReplaceLong', { scope, action, find: searchText.value }))) return

  replacing.value = true
  message.value = ''
  try {
    const body = {
      search: searchText.value,
      replace: replaceText.value,
    }
    if (chapterIds) body.chapterIds = chapterIds

    const res = await fetch(`/api/books/${store.currentBookId}/replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    message.value = t('sr.replaceDone', { total: data.totalReplaced, files: data.filesChanged })
    await doSearch()
  } catch (e) {
    message.value = t('sr.replaceFailed', { error: e.message })
  } finally {
    replacing.value = false
  }
}

function highlightMatch(context, query) {
  const idx = context.indexOf(query)
  if (idx === -1) return context
  const before = context.substring(0, idx)
  const match = context.substring(idx, idx + query.length)
  const after = context.substring(idx + query.length)
  return `${esc(before)}<mark>${esc(match)}</mark>${esc(after)}`
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
</script>

<template>
  <div>
    <h2 style="font-family: var(--font-reading); margin-bottom: 20px;">{{ t('sr.title') }}</h2>

    <div class="form-group">
      <label>{{ t('sr.searchLabel') }}</label>
      <input v-model="searchText" type="text" :placeholder="t('sr.searchPh')" @keyup.enter="doSearch" />
    </div>

    <div class="form-group">
      <label>{{ t('sr.replaceLabel') }}</label>
      <input v-model="replaceText" type="text" :placeholder="t('sr.replacePh')" />
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 20px;">
      <button class="btn btn-primary" @click="doSearch" :disabled="searching || !searchText">
        {{ searching ? t('sr.searching') : t('sr.find') }}
      </button>
      <button
        class="btn btn-danger"
        @click="doReplace(null)"
        :disabled="replacing || !results || totalCount === 0"
      >
        {{ replacing ? t('sr.replacing') : t('sr.replaceAll') }}
      </button>
    </div>

    <div v-if="message" style="padding: 10px; background: var(--ai-bg); border-radius: var(--radius); font-size: 14px; margin-bottom: 16px;">
      {{ message }}
    </div>

    <!-- Results -->
    <div v-if="results !== null">
      <div v-if="totalCount === 0" class="text-muted">{{ t('sr.noMatchMsg') }}</div>

      <div v-else>
        <p style="font-size: 14px; margin-bottom: 16px;" v-html="t('sr.foundN', { total: `<strong>${totalCount}</strong>`, files: `<strong>${results.length}</strong>` })"></p>

        <div v-for="r in results" :key="r.chId" class="stat-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong>{{ t('sr.chapter', { n: r.chNum }) }} {{ r.chTitle }}</strong>
            <div style="display: flex; gap: 6px; align-items: center;">
              <span class="text-muted" style="font-size: 13px;">{{ t('sr.occurrences', { count: r.count }) }}</span>
              <button class="btn btn-sm" @click="doReplace([r.chId])" :disabled="replacing">
                {{ t('sr.replaceThisCh') }}
              </button>
            </div>
          </div>
          <div
            v-for="(m, i) in r.matches"
            :key="i"
            style="font-size: 13px; padding: 3px 0; border-bottom: 1px solid var(--border); font-family: var(--font-reading);"
            v-html="'...' + highlightMatch(m.context, searchText) + '...'"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
mark {
  background: #ffe066;
  color: #333;
  padding: 0 2px;
  border-radius: 2px;
}

[data-theme="dark"] mark {
  background: #665500;
  color: #ffe066;
}
</style>
