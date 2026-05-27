<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'

const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const { t } = useI18n()

const BI_THEME_KEY = 'novelweb-editor-theme'
const biTheme = ref(localStorage.getItem(BI_THEME_KEY) || 'editorial')
function toggleBiTheme() {
  biTheme.value = biTheme.value === 'editorial' ? 'tabloid' : 'editorial'
  localStorage.setItem(BI_THEME_KEY, biTheme.value)
}

const rawText = ref('')
const userDelimiter = ref('You said')
const aiDelimiter = ref('Gemini said')
const parsedTurns = ref([])
const saving = ref(false)
const message = ref('')
const step = ref('input')

function parseConversation() {
  const text = rawText.value.trim()
  if (!text) return
  const turns = []
  const userDel = userDelimiter.value.trim()
  const aiDel = aiDelimiter.value.trim()
  if (!userDel || !aiDel) { message.value = t('import.fillMarkers'); return }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(${esc(userDel)}|${esc(aiDel)})`, 'g')
  const parts = text.split(pattern).filter(s => s.trim())
  let currentRole = null
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === userDel) currentRole = 'user'
    else if (trimmed === aiDel) currentRole = 'assistant'
    else if (currentRole) turns.push({ role: currentRole, content: trimmed })
  }
  parsedTurns.value = turns
  step.value = 'preview'
  message.value = t('import.parseDone', { count: turns.length })
}

function removeTurn(index) { parsedTurns.value.splice(index, 1) }

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
  <div class="bi-root" :class="biTheme">
    <!-- Tabs -->
    <div class="tabs">
      <div class="tab" @click="router.push(`/read/${route.params.chapterId}`)">{{ t('reader.tabBody') }}</div>
      <div class="tab" @click="router.push(`/conversation/${route.params.chapterId}`)">{{ t('reader.tabConv') }}</div>
      <div class="tab" @click="router.push(`/edit/${route.params.chapterId}`)">{{ t('reader.tabEntry') }}</div>
      <div class="tab active">{{ t('reader.tabImport') }}</div>
    </div>

    <!-- Masthead -->
    <div class="bi-masthead">
      <div class="bi-rule-thick"></div>
      <div class="bi-masthead-row">
        <h2 class="bi-headline">{{ t('reader.tabImport') }}</h2>
        <button class="bi-theme-toggle" @click="toggleBiTheme" :title="biTheme === 'editorial' ? 'Tabloid mode' : 'Editorial mode'">
          {{ biTheme === 'editorial' ? '📰' : '📋' }}
        </button>
      </div>
      <p class="bi-subhead">{{ t('import.intro') }}</p>
      <div class="bi-rule"></div>
    </div>

    <!-- Toast -->
    <div v-if="message" class="bi-toast">{{ message }}</div>

    <!-- Step 1: Input -->
    <div v-if="step === 'input'">
      <!-- Delimiter config — newspaper classified-ad style -->
      <div class="bi-delimiters">
        <div class="bi-del-item">
          <span class="bi-del-label">{{ t('import.userMarker') }}</span>
          <input v-model="userDelimiter" type="text" class="bi-del-input" placeholder="You said" />
        </div>
        <span class="bi-del-sep">|</span>
        <div class="bi-del-item">
          <span class="bi-del-label">{{ t('import.aiMarker') }}</span>
          <input v-model="aiDelimiter" type="text" class="bi-del-input" placeholder="Gemini said" />
        </div>
      </div>

      <div class="bi-paste-section">
        <div class="bi-section-head">{{ t('import.pasteLabel') }}</div>
        <textarea v-model="rawText" class="bi-textarea" rows="20" :placeholder="t('import.pasteHere')"></textarea>
      </div>

      <div class="bi-action-bar">
        <button class="bi-submit" @click="parseConversation">{{ t('import.parseConv') }}</button>
      </div>
    </div>

    <!-- Step 2: Preview -->
    <div v-if="step === 'preview'">
      <div class="bi-preview-header">
        <h3 class="bi-preview-title">{{ t('import.parsePreview', { count: parsedTurns.length }) }}</h3>
        <div class="bi-preview-actions">
          <button class="bi-btn-outline" @click="step = 'input'">{{ t('import.backToEdit') }}</button>
          <button class="bi-submit" @click="confirmImport" :disabled="saving">
            {{ saving ? t('import.importingDots') : t('import.confirmImport') }}
          </button>
        </div>
      </div>

      <div class="bi-turn-list">
        <div v-for="(turn, i) in parsedTurns" :key="i" class="bi-turn" :class="turn.role">
          <div class="bi-turn-head">
            <span class="bi-turn-role">{{ turn.role === 'user' ? t('conv.myPrompt') : t('conv.aiReply') }}</span>
            <span class="bi-turn-num">#{{ i + 1 }}</span>
            <button class="bi-turn-del" @click="removeTurn(i)">{{ t('common.delete') }}</button>
          </div>
          <div class="bi-turn-body">{{ turn.content }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bi-root { max-width: 100%; }

/* Masthead */
.bi-masthead { text-align: center; margin-bottom: 24px; }
.bi-rule-thick { height: 3px; background: var(--rule, var(--text)); margin: 8px 0; }
.bi-rule { height: 1px; background: var(--border); margin: 8px 0; }
.bi-headline {
  font-family: var(--font-reading);
  font-size: 26px; font-weight: 700;
  letter-spacing: 0.05em; text-transform: uppercase;
  margin: 12px 0 4px; color: var(--text);
}
.bi-subhead { font-size: 13px; color: var(--text-muted); font-style: italic; margin: 0; }

/* Toast */
.bi-toast {
  text-align: center; padding: 10px 16px; margin-bottom: 16px;
  font-size: 13px; color: var(--accent);
  border: 1px solid var(--border);
}

/* Delimiter config — classified ad style */
.bi-delimiters {
  display: flex; align-items: center; justify-content: center; gap: 16px;
  padding: 16px; margin-bottom: 20px;
  border: 1px solid var(--rule, var(--border));
  background: var(--bg-card);
}
.bi-del-item { display: flex; align-items: center; gap: 8px; }
.bi-del-label {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-muted); white-space: nowrap;
}
.bi-del-input {
  width: 140px; padding: 4px 8px;
  border: none; border-bottom: 1px solid var(--border);
  background: transparent; color: var(--text);
  font-size: 13px; outline: none;
}
.bi-del-input:focus { border-bottom-color: var(--text); }
.bi-del-sep { font-size: 20px; color: var(--border); font-weight: 300; }

/* Paste section */
.bi-paste-section { margin-bottom: 20px; }
.bi-section-head {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text-muted);
  padding-bottom: 8px; margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.bi-textarea {
  width: 100%; padding: 16px 0;
  border: none; border-bottom: 1px solid var(--border);
  outline: none; resize: vertical;
  font-family: var(--font-reading);
  font-size: 14px; line-height: 1.7;
  background: transparent; color: var(--text);
  min-height: 300px;
}
.bi-textarea:focus { border-bottom-color: var(--text); }

/* Action bar */
.bi-action-bar {
  padding-top: 16px; border-top: 2px solid var(--rule, var(--text));
  text-align: center;
}
.bi-submit {
  background: var(--text); color: var(--bg);
  border: none; padding: 8px 32px;
  font-size: 13px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  cursor: pointer; transition: opacity 0.15s;
}
.bi-submit:hover { opacity: 0.8; }
.bi-submit:disabled { opacity: 0.4; cursor: not-allowed; }
.bi-btn-outline {
  background: none; color: var(--text);
  border: 1px solid var(--text); padding: 7px 20px;
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  cursor: pointer; transition: all 0.15s;
}
.bi-btn-outline:hover { background: var(--text); color: var(--bg); }

/* Preview header */
.bi-preview-header {
  display: flex; justify-content: space-between; align-items: center;
  padding-bottom: 16px; margin-bottom: 16px;
  border-bottom: 2px solid var(--rule, var(--text));
}
.bi-preview-title {
  font-family: var(--font-reading); font-size: 18px;
  font-weight: 700; margin: 0; letter-spacing: 0.03em;
}
.bi-preview-actions { display: flex; gap: 10px; }

/* Turn list — newspaper column style */
.bi-turn-list {
  display: flex; flex-direction: column; gap: 0;
}
.bi-turn {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  position: relative;
}
.bi-turn.user { border-left: 3px solid var(--text); }
.bi-turn.assistant {
  border-left: 3px solid var(--accent, var(--text));
  background: var(--ai-bg, rgba(0,0,0,0.02));
}
.bi-turn-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 8px;
}
.bi-turn-role {
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text-muted);
}
.bi-turn-num { font-size: 10px; color: var(--text-muted); }
.bi-turn-del {
  margin-left: auto;
  background: none; border: 1px solid var(--border);
  padding: 1px 8px; font-size: 11px;
  color: var(--text-muted); cursor: pointer;
  opacity: 0; transition: opacity 0.15s;
}
.bi-turn:hover .bi-turn-del { opacity: 0.6; }
.bi-turn-del:hover { opacity: 1 !important; color: #c44; border-color: #c44; }
.bi-turn-body {
  white-space: pre-wrap;
  font-family: var(--font-reading);
  font-size: 14px; line-height: 1.7;
}

.bi-masthead-row {
  display: flex; align-items: center; justify-content: center; gap: 12px;
}
.bi-theme-toggle {
  background: none; border: 1px solid var(--border);
  border-radius: 4px; padding: 2px 8px; font-size: 16px;
  cursor: pointer; transition: all 0.15s;
}
.bi-theme-toggle:hover { border-color: var(--text); }

/* ═══════════════════════════════════════════════════════════
   TABLOID MODE
   ═══════════════════════════════════════════════════════════ */
.bi-root.tabloid { --tab-red: #b30000; --tab-black: #1a1a1a; --tab-gold: #f5c518; }

.bi-root.tabloid .bi-rule-thick {
  height: 5px; background: var(--tab-red);
}
.bi-root.tabloid .bi-rule {
  height: 2px; background: var(--tab-red);
}
.bi-root.tabloid .bi-headline {
  font-size: 36px; color: var(--tab-red);
  text-shadow: 1px 1px 0 rgba(0,0,0,0.1);
  letter-spacing: 0.08em;
}
.bi-root.tabloid .bi-subhead {
  font-size: 14px; font-weight: 600;
  font-style: normal; color: var(--tab-black);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.bi-root.tabloid .bi-toast {
  background: var(--tab-gold); color: var(--tab-black);
  border: 2px solid var(--tab-black);
  font-weight: 700; text-transform: uppercase;
}
.bi-root.tabloid .bi-delimiters {
  border: 3px solid var(--tab-black);
  background: #fef9e7;
}
.bi-root.tabloid .bi-del-label {
  color: var(--tab-red); font-size: 12px;
}
.bi-root.tabloid .bi-del-sep { color: var(--tab-red); font-weight: 800; }
.bi-root.tabloid .bi-section-head {
  font-size: 13px; font-weight: 800;
  color: #fff; background: var(--tab-red);
  padding: 6px 12px; margin: 0 0 12px;
  border-bottom: none;
}
.bi-root.tabloid .bi-textarea {
  border-bottom: 2px solid var(--tab-black); font-size: 15px;
}
.bi-root.tabloid .bi-textarea:focus { border-bottom-color: var(--tab-red); }
.bi-root.tabloid .bi-action-bar {
  border-top: 4px solid var(--tab-red); padding-top: 20px;
}
.bi-root.tabloid .bi-submit {
  background: var(--tab-red); color: #fff;
  font-size: 15px; font-weight: 800; padding: 10px 40px;
  letter-spacing: 0.1em;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.bi-root.tabloid .bi-btn-outline {
  border: 2px solid var(--tab-black); font-weight: 800;
}
.bi-root.tabloid .bi-btn-outline:hover {
  background: var(--tab-black); color: #fff;
}
.bi-root.tabloid .bi-preview-header {
  border-bottom: 4px double var(--tab-red);
}
.bi-root.tabloid .bi-preview-title {
  color: var(--tab-red); font-size: 22px;
}
.bi-root.tabloid .bi-turn.user {
  border-left: 4px solid var(--tab-black);
}
.bi-root.tabloid .bi-turn.assistant {
  border-left: 4px solid var(--tab-red);
  background: #fff8f0;
}
.bi-root.tabloid .bi-turn-role {
  font-size: 11px; font-weight: 800;
  color: #fff; padding: 1px 8px;
  background: var(--tab-black);
}
.bi-root.tabloid .bi-turn.assistant .bi-turn-role {
  background: var(--tab-red);
}
</style>
