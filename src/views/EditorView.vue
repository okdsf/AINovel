<script setup>
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useSettingsStore } from '../stores/settings'
import { useI18n } from '../i18n'

const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const settings = useSettingsStore()
const { t } = useI18n()

const mode = ref('conversation')
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

const editorStyle = {
  fontFamily: 'var(--font-reading)',
  fontSize: '15px',
  lineHeight: '1.8',
}

const EV_THEME_KEY = 'novelweb-editor-theme'
const evTheme = ref(localStorage.getItem(EV_THEME_KEY) || 'editorial')
function toggleEvTheme() {
  evTheme.value = evTheme.value === 'editorial' ? 'tabloid' : 'editorial'
  localStorage.setItem(EV_THEME_KEY, evTheme.value)
}
</script>

<template>
  <div class="ev-root" :class="evTheme">
    <!-- Tabs -->
    <div class="tabs">
      <div class="tab" @click="router.push(`/read/${route.params.chapterId}`)">{{ t('reader.tabBody') }}</div>
      <div class="tab" @click="router.push(`/conversation/${route.params.chapterId}`)">{{ t('reader.tabConv') }}</div>
      <div class="tab active">{{ t('reader.tabEntry') }}</div>
      <div class="tab" @click="router.push(`/import/${route.params.chapterId}`)">{{ t('reader.tabImport') }}</div>
    </div>

    <!-- Masthead -->
    <div class="ev-masthead">
      <div class="ev-rule"></div>
      <div class="ev-masthead-row">
        <h2 class="ev-headline">{{ t('reader.tabEntry') }}</h2>
        <button class="ev-theme-toggle" @click="toggleEvTheme" :title="evTheme === 'editorial' ? 'Tabloid mode' : 'Editorial mode'">
          {{ evTheme === 'editorial' ? '📰' : '📋' }}
        </button>
      </div>
      <p class="ev-subhead">{{ mode === 'conversation' ? t('editor.entryTip') : t('editor.novelTip') }}</p>
      <div class="ev-rule"></div>
    </div>

    <!-- Mode toggle -->
    <div class="ev-mode-bar">
      <button class="ev-mode-btn" :class="{ active: mode === 'conversation' }" @click="mode = 'conversation'">
        {{ t('editor.modeConversation') }}
      </button>
      <span class="ev-mode-dot">·</span>
      <button class="ev-mode-btn" :class="{ active: mode === 'novel' }" @click="mode = 'novel'">
        {{ t('editor.modeNovel') }}
      </button>
    </div>

    <!-- Toast -->
    <div v-if="message" class="ev-toast">{{ message }}</div>

    <!-- Conversation mode -->
    <div v-if="mode === 'conversation'" class="ev-columns">
      <div class="ev-col">
        <div class="ev-col-head">{{ t('editor.myPromptLabel') }}</div>
        <textarea v-model="userPrompt" class="ev-textarea" rows="10" :placeholder="t('editor.myPromptPh')"></textarea>
      </div>
      <div class="ev-col">
        <div class="ev-col-head">{{ t('editor.aiReplyLabel') }}</div>
        <textarea v-model="aiResponse" class="ev-textarea ev-textarea-main" rows="10" :placeholder="t('editor.aiReplyPh')"></textarea>
      </div>
    </div>

    <!-- Novel mode -->
    <div v-if="mode === 'novel'" class="ev-novel-wrap">
      <div class="ev-col-head">{{ t('editor.novelLabel') }}</div>
      <textarea v-model="novelContent" class="ev-textarea ev-textarea-main ev-textarea-tall" :placeholder="t('editor.novelPh')" :style="editorStyle"></textarea>
    </div>

    <!-- Action bar -->
    <div class="ev-action-bar">
      <button v-if="mode === 'conversation'" class="ev-submit" @click="submitConversationTurn" :disabled="saving">
        {{ saving ? t('common.saving') : t('editor.submitTurn') }}
      </button>
      <button v-else class="ev-submit" @click="saveNovelContent" :disabled="saving">
        {{ saving ? t('common.saving') : t('editor.saveNovel') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ev-root { max-width: 100%; }

.ev-masthead {
  text-align: center;
  margin-bottom: 24px;
}
.ev-rule {
  height: 2px;
  background: var(--rule, var(--text));
  margin: 8px 0;
}
.ev-headline {
  font-family: var(--font-reading);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin: 12px 0 4px;
  color: var(--text);
}
.ev-subhead {
  font-size: 13px;
  color: var(--text-muted);
  font-style: italic;
  margin: 0;
}

.ev-mode-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 24px;
}
.ev-mode-btn {
  background: none;
  border: none;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 12px;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.ev-mode-btn.active {
  color: var(--text);
  border-bottom-color: var(--text);
}
.ev-mode-btn:hover { color: var(--text); }
.ev-mode-dot { color: var(--text-muted); font-size: 18px; }

.ev-toast {
  text-align: center;
  padding: 10px 16px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--accent);
  border: 1px solid var(--border);
  border-radius: 0;
}

/* Two-column newspaper layout for conversation */
.ev-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}
.ev-col {
  padding: 0 20px;
  border-right: 1px solid var(--rule, var(--border));
}
.ev-col:last-child { border-right: none; }

.ev-col-head {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding-bottom: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.ev-textarea {
  width: 100%;
  padding: 12px 0;
  border: none;
  border-bottom: 1px solid var(--border);
  outline: none;
  resize: vertical;
  font-family: var(--font-reading);
  font-size: 14px;
  line-height: 1.7;
  background: transparent;
  color: var(--text);
  min-height: 180px;
}
.ev-textarea:focus { border-bottom-color: var(--text); }
.ev-textarea-main { min-height: 280px; }
.ev-textarea-tall { min-height: 400px; }

.ev-novel-wrap { padding: 0 20px; }

.ev-action-bar {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 2px solid var(--rule, var(--text));
  text-align: center;
}
.ev-submit {
  background: var(--text);
  color: var(--bg);
  border: none;
  padding: 8px 32px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: opacity 0.15s;
}
.ev-submit:hover { opacity: 0.8; }
.ev-submit:disabled { opacity: 0.4; cursor: not-allowed; }

.ev-masthead-row {
  display: flex; align-items: center; justify-content: center; gap: 12px;
}
.ev-theme-toggle {
  background: none; border: 1px solid var(--border);
  border-radius: 4px; padding: 2px 8px; font-size: 16px;
  cursor: pointer; transition: all 0.15s;
}
.ev-theme-toggle:hover { border-color: var(--text); }

/* ═══════════════════════════════════════════════════════════
   TABLOID MODE — red ink, bold headlines, dramatic flair
   ═══════════════════════════════════════════════════════════ */
.ev-root.tabloid { --tab-red: #b30000; --tab-black: #1a1a1a; --tab-gold: #f5c518; }

.ev-root.tabloid .ev-rule {
  height: 4px;
  background: var(--tab-red);
}
.ev-root.tabloid .ev-headline {
  font-size: 36px;
  color: var(--tab-red);
  text-shadow: 1px 1px 0 rgba(0,0,0,0.1);
  letter-spacing: 0.08em;
}
.ev-root.tabloid .ev-subhead {
  font-size: 14px;
  font-weight: 600;
  font-style: normal;
  color: var(--tab-black);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.ev-root.tabloid .ev-mode-btn {
  font-size: 14px;
  font-weight: 800;
  border-bottom-width: 3px;
}
.ev-root.tabloid .ev-mode-btn.active {
  color: var(--tab-red);
  border-bottom-color: var(--tab-red);
}
.ev-root.tabloid .ev-col {
  border-right: 3px double var(--tab-black);
}
.ev-root.tabloid .ev-col:last-child { border-right: none; }
.ev-root.tabloid .ev-col-head {
  font-size: 13px;
  font-weight: 800;
  color: #fff;
  background: var(--tab-red);
  padding: 6px 12px;
  margin: 0 -20px 12px;
  border-bottom: none;
  letter-spacing: 0.1em;
}
.ev-root.tabloid .ev-textarea {
  border-bottom: 2px solid var(--tab-black);
  font-size: 15px;
}
.ev-root.tabloid .ev-textarea:focus {
  border-bottom-color: var(--tab-red);
}
.ev-root.tabloid .ev-action-bar {
  border-top: 4px solid var(--tab-red);
  padding-top: 20px;
}
.ev-root.tabloid .ev-submit {
  background: var(--tab-red);
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  padding: 10px 40px;
  letter-spacing: 0.1em;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.ev-root.tabloid .ev-toast {
  background: var(--tab-gold);
  color: var(--tab-black);
  border: 2px solid var(--tab-black);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
