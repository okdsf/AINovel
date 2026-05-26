<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'

const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const { t } = useI18n()

const rawText = ref('')
const userDelimiter = ref('You said')
const aiDelimiter = ref('Gemini said')
const parsedTurns = ref([])
const saving = ref(false)
const message = ref('')
const step = ref('input') // 'input' or 'preview'

function parseConversation() {
  const text = rawText.value.trim()
  if (!text) return

  const turns = []
  const userDel = userDelimiter.value.trim()
  const aiDel = aiDelimiter.value.trim()

  if (!userDel || !aiDel) {
    message.value = t('import.fillMarkers')
    return
  }

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(${esc(userDel)}|${esc(aiDel)})`, 'g')

  const parts = text.split(pattern).filter(s => s.trim())

  let currentRole = null
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === userDel) {
      currentRole = 'user'
    } else if (trimmed === aiDel) {
      currentRole = 'assistant'
    } else if (currentRole) {
      turns.push({ role: currentRole, content: trimmed })
    }
  }

  parsedTurns.value = turns
  step.value = 'preview'
  message.value = t('import.parseDone', { count: turns.length })
}

function removeTurn(index) {
  parsedTurns.value.splice(index, 1)
}

async function confirmImport() {
  if (parsedTurns.value.length === 0) return
  saving.value = true
  try {
    const existing = await store.getConversation(route.params.chapterId)
    const merged = [...existing, ...parsedTurns.value]
    await store.saveConversation(route.params.chapterId, merged)
    message.value = t('import.importSuccess', { count: parsedTurns.value.length })
    parsedTurns.value = []
    rawText.value = ''
    step.value = 'input'
  } catch (e) {
    message.value = t('import.importFailedDetail', { error: e.message })
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
      <div class="tab" @click="router.push(`/edit/${route.params.chapterId}`)">{{ t('reader.tabEntry') }}</div>
      <div class="tab active">{{ t('reader.tabImport') }}</div>
    </div>

    <!-- Step 1: Input -->
    <div v-if="step === 'input'">
      <p class="mb-4" style="font-size: 14px;">
        {{ t('import.intro') }}
      </p>

      <div style="display: flex; gap: 12px; margin-bottom: 16px;">
        <div class="form-group" style="flex: 1;">
          <label>{{ t('import.userMarker') }}</label>
          <input v-model="userDelimiter" type="text" placeholder="You said" />
        </div>
        <div class="form-group" style="flex: 1;">
          <label>{{ t('import.aiMarker') }}</label>
          <input v-model="aiDelimiter" type="text" placeholder="Gemini said" />
        </div>
      </div>

      <div class="form-group">
        <label>{{ t('import.pasteLabel') }}</label>
        <textarea v-model="rawText" rows="20" :placeholder="t('import.pasteHere')"></textarea>
      </div>

      <button class="btn btn-primary" @click="parseConversation">
        {{ t('import.parseConv') }}
      </button>
    </div>

    <!-- Step 2: Preview -->
    <div v-if="step === 'preview'">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3>{{ t('import.parsePreview', { count: parsedTurns.length }) }}</h3>
        <div style="display: flex; gap: 8px;">
          <button class="btn" @click="step = 'input'">{{ t('import.backToEdit') }}</button>
          <button class="btn btn-primary" @click="confirmImport" :disabled="saving">
            {{ saving ? t('import.importingDots') : t('import.confirmImport') }}
          </button>
        </div>
      </div>

      <div v-for="(turn, i) in parsedTurns" :key="i" class="conv-turn" :class="turn.role" style="position: relative;">
        <div class="conv-role">
          {{ turn.role === 'user' ? t('conv.myPrompt') : t('conv.aiReply') }}
          <button
            class="btn btn-sm btn-danger"
            style="position: absolute; top: 10px; right: 10px;"
            @click="removeTurn(i)"
          >{{ t('common.delete') }}</button>
        </div>
        <div style="white-space: pre-wrap;">{{ turn.content }}</div>
      </div>
    </div>

    <!-- Feedback -->
    <div v-if="message" style="margin-top: 12px; padding: 10px; background: var(--ai-bg); border-radius: var(--radius); font-size: 14px;">
      {{ message }}
    </div>
  </div>
</template>
