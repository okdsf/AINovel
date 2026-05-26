<script setup>
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'

const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const { t } = useI18n()

const mode = ref('conversation') // 'conversation' or 'novel'
const userPrompt = ref('')
const aiResponse = ref('')
const novelContent = ref('')
const saving = ref(false)
const message = ref('')

async function loadContent() {
  novelContent.value = await store.getChapterContent(route.params.chapterId)
}

watch(() => route.params.chapterId, loadContent, { immediate: true })

async function submitConversationTurn() {
  if (!aiResponse.value.trim()) {
    message.value = t('editor.aiEmpty')
    return
  }
  saving.value = true
  message.value = ''
  try {
    await store.addConversationTurn(
      route.params.chapterId,
      userPrompt.value.trim(),
      aiResponse.value.trim()
    )
    message.value = t('editor.entrySuccess')
    userPrompt.value = ''
    aiResponse.value = ''
    await loadContent()
  } catch (e) {
    message.value = t('editor.entryFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

async function saveNovelContent() {
  saving.value = true
  message.value = ''
  try {
    await store.saveChapterContent(route.params.chapterId, novelContent.value)
    message.value = t('editor.novelSaved')
  } catch (e) {
    message.value = t('editor.entryFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <div class="tabs">
      <div class="tab" @click="router.push(`/read/${route.params.chapterId}`)">{{ t('reader.tabBody') }}</div>
      <div class="tab" @click="router.push(`/conversation/${route.params.chapterId}`)">{{ t('reader.tabConv') }}</div>
      <div class="tab active">{{ t('reader.tabEntry') }}</div>
      <div class="tab" @click="router.push(`/import/${route.params.chapterId}`)">{{ t('reader.tabImport') }}</div>
    </div>

    <!-- Mode toggle -->
    <div style="display: flex; gap: 8px; margin-bottom: 20px;">
      <button class="btn" :class="{ 'btn-primary': mode === 'conversation' }" @click="mode = 'conversation'">
        {{ t('editor.modeConversation') }}
      </button>
      <button class="btn" :class="{ 'btn-primary': mode === 'novel' }" @click="mode = 'novel'">
        {{ t('editor.modeNovel') }}
      </button>
    </div>

    <!-- Conversation input mode -->
    <div v-if="mode === 'conversation'">
      <div class="form-group">
        <label>{{ t('editor.myPromptLabel') }}</label>
        <textarea v-model="userPrompt" rows="5" :placeholder="t('editor.myPromptPh')"></textarea>
      </div>
      <div class="form-group">
        <label>{{ t('editor.aiReplyLabel') }}</label>
        <textarea v-model="aiResponse" rows="12" :placeholder="t('editor.aiReplyPh')"></textarea>
      </div>
      <button class="btn btn-primary" @click="submitConversationTurn" :disabled="saving">
        {{ saving ? t('common.saving') : t('editor.submitTurn') }}
      </button>
      <p class="text-muted" style="font-size: 12px; margin-top: 8px;">
        {{ t('editor.entryTip') }}
      </p>
    </div>

    <!-- Novel direct edit mode -->
    <div v-if="mode === 'novel'">
      <div class="form-group">
        <label>{{ t('editor.novelLabel') }}</label>
        <textarea v-model="novelContent" rows="20" :placeholder="t('editor.novelPh')" style="font-family: var(--font-reading); font-size: 16px; line-height: 1.8;"></textarea>
      </div>
      <button class="btn btn-primary" @click="saveNovelContent" :disabled="saving">
        {{ saving ? t('common.saving') : t('editor.saveNovel') }}
      </button>
      <p class="text-muted" style="font-size: 12px; margin-top: 8px;">
        {{ t('editor.novelTip') }}
      </p>
    </div>

    <!-- Feedback message -->
    <div v-if="message" style="margin-top: 12px; padding: 10px; background: var(--ai-bg); border-radius: var(--radius); font-size: 14px;">
      {{ message }}
    </div>
  </div>
</template>
