<script setup>
import { ref, onMounted } from 'vue'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'
import { getVolumeLabel, getChapterLabel } from '../utils/numbering'

const store = useNovelStore()
const { t } = useI18n()
const stats = ref(null)

onMounted(async () => {
  stats.value = await store.getStats()
})
</script>

<template>
  <div>
    <h2 style="margin-bottom: 24px; font-family: var(--font-reading);">{{ t('stats.title') }}</h2>

    <div v-if="!stats" class="text-muted">{{ t('stats.loading') }}</div>

    <div v-else>
      <!-- Total -->
      <div class="stat-card">
        <div class="text-muted" style="font-size: 13px;">{{ t('stats.totalWords') }}</div>
        <div class="stat-number">{{ stats.total.toLocaleString() }}</div>
      </div>

      <!-- Per volume -->
      <div v-for="(vol, vi) in stats.volumes" :key="vol.id" class="stat-card">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong>{{ getVolumeLabel(store.meta, vol.id) }} {{ vol.title }}</strong>
          <span class="stat-number" style="font-size: 20px;">{{ vol.wordCount.toLocaleString() }}</span>
        </div>
        <div style="margin-top: 8px;">
          <div
            v-for="ch in vol.chapters"
            :key="ch.id"
            style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; border-bottom: 1px solid var(--border);"
          >
            <span class="text-muted">{{ getChapterLabel(store.meta, ch.id) }} {{ ch.title }}</span>
            <span>{{ ch.wordCount.toLocaleString() }}{{ t('stats.charsSuffix') }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
