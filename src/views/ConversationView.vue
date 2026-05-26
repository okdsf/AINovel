<script setup>
import { ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useSettingsStore } from '../stores/settings'
import { useI18n } from '../i18n'
import ReadingSettings from '../components/ReadingSettings.vue'

const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const settings = useSettingsStore()
const { t } = useI18n()

const turns = ref([])

const aiStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: '1.8',
}))

async function loadConversation() {
  turns.value = await store.getConversation(route.params.chapterId)
}

watch(() => route.params.chapterId, loadConversation, { immediate: true })
</script>

<template>
  <div>
    <div class="tabs">
      <div class="tab" @click="router.push(`/read/${route.params.chapterId}`)">{{ t('reader.tabBody') }}</div>
      <div class="tab active">{{ t('reader.tabConv') }}</div>
      <div class="tab" @click="router.push(`/edit/${route.params.chapterId}`)">{{ t('reader.tabEntry') }}</div>
      <div class="tab" @click="router.push(`/import/${route.params.chapterId}`)">{{ t('reader.tabImport') }}</div>
    </div>

    <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
      <ReadingSettings />
    </div>

    <div v-if="turns.length === 0" class="text-muted text-center mt-4">
      <p>{{ t('conv.empty') }}</p>
    </div>

    <div v-for="(turn, i) in turns" :key="i" class="conv-turn" :class="turn.role">
      <div class="conv-role">{{ turn.role === 'user' ? t('conv.myPrompt') : t('conv.aiReply') }}</div>
      <div :style="turn.role === 'assistant' ? aiStyle : {}">{{ turn.content }}</div>
    </div>
  </div>
</template>
