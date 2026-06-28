<script setup>
import { ref, watch, computed, nextTick, onMounted } from 'vue'
import { useNovelStore } from '../stores/novel'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useI18n } from '../i18n'

const novel = useNovelStore()
const chat = useChatStore()
const settings = useSettingsStore()
const { t } = useI18n()

const showCreate = ref(false)
const MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5 (Flagship)' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'o4-mini', label: 'o4-mini (Reasoning)' },
  { id: 'o3', label: 'o3 (Reasoning)' },
  { id: 'o3-mini', label: 'o3-mini' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { id: 'gpt-4.1', label: 'GPT-4.1' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
]
const createModel = ref('gpt-4o')
const createTitle = ref('')
const createPrompt = ref('')
const selectedChapters = ref([])
const promptList = ref([])

const EFFORTS = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]

const input = ref('')
const messagesEl = ref(null)
const toast = ref('')

// Live model/effort switching during conversation
const activeModel = ref('gpt-4o')
const activeEffort = ref('')
let toastTimer = null

function showToast(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.value = '', 3000)
}

const aiStyle = computed(() => ({
  fontFamily: settings.currentFont().family,
  fontSize: settings.fontSize + 'px',
  lineHeight: '1.8',
}))

const allChapters = computed(() => {
  if (!novel.meta?.volumes) return []
  const list = []
  for (const vol of novel.meta.volumes) {
    for (const ch of vol.chapters) {
      list.push({ id: ch.id, title: ch.title, volTitle: vol.title })
    }
  }
  return list
})

// Active path messages, excluding system
const visibleMessages = computed(() => {
  return chat.activePath.filter(m => m.role !== 'system')
})

// For branch navigation: for each message, how many siblings and which index
function getBranchInfo(msg) {
  if (!chat.currentConv) return { total: 1, index: 0 }
  const siblings = chat.currentConv.messages.filter(m => m.parent === msg.parent && m.role === msg.role)
  const idx = siblings.findIndex(s => s.id === msg.id)
  return { total: siblings.length, index: idx >= 0 ? idx : 0, siblings }
}

function switchBranch(msg, direction) {
  if (!chat.currentConv) return
  const info = getBranchInfo(msg)
  const newIdx = info.index + direction
  if (newIdx < 0 || newIdx >= info.total) return
  // We need to rebuild the active path by selecting this sibling
  // For now, reorder so the chosen sibling is last among its peers
  const target = info.siblings[newIdx]
  const msgs = chat.currentConv.messages
  const otherSiblings = msgs.filter(m => m.parent === msg.parent && m.role === msg.role && m.id !== target.id)
  const nonSiblings = msgs.filter(m => !(m.parent === msg.parent && m.role === msg.role))
  chat.currentConv.messages = [...nonSiblings, ...otherSiblings, target]
}

async function scrollToBottom() {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

// Watch streaming to auto-scroll
watch(() => chat.streamContent, scrollToBottom)

// Load prompt list for the create dialog
async function loadPrompts() {
  try {
    const res = await fetch('/api/prompts')
    promptList.value = await res.json()
  } catch {}
}

async function loadPromptContent(id) {
  try {
    const res = await fetch(`/api/prompts/${id}`)
    const data = await res.json()
    createPrompt.value = data.content || ''
  } catch {}
}

function openCreate() {
  showCreate.value = true
  createTitle.value = ''
  createPrompt.value = ''
  selectedChapters.value = []
  loadPrompts()
}

async function doCreate() {
  const conv = await chat.createConversation({
    title: createTitle.value || undefined,
    model: createModel.value,
    bookId: novel.currentBookId,
    contextChapters: selectedChapters.value,
    systemPrompt: createPrompt.value,
  })
  activeModel.value = createModel.value
  activeEffort.value = ''
  showCreate.value = false
  await scrollToBottom()
}

function sendOpts() {
  const o = { model: activeModel.value }
  if (activeEffort.value) o.reasoning_effort = activeEffort.value
  return o
}

async function doSend() {
  if (!input.value.trim() || chat.streaming) return
  const msg = input.value
  input.value = ''
  await chat.sendMessage(msg, undefined, sendOpts())
  await scrollToBottom()
}

async function doRegenerate(msgId) {
  await chat.regenerate(msgId, sendOpts())
  await scrollToBottom()
}

async function doCopy(content) {
  try {
    await navigator.clipboard.writeText(content)
    showToast(t('chat.copied'))
  } catch {}
}

// Edit prompt (creates a branch)
const editingMsgId = ref('')
const editingContent = ref('')

function startEditPrompt(msg) {
  editingMsgId.value = msg.id
  editingContent.value = msg.content
}

function cancelEditPrompt() {
  editingMsgId.value = ''
  editingContent.value = ''
}

async function submitEditPrompt(msg) {
  if (!editingContent.value.trim() || chat.streaming) return
  const newContent = editingContent.value.trim()
  editingMsgId.value = ''
  editingContent.value = ''
  await chat.sendMessage(newContent, msg.parent, sendOpts())
  await scrollToBottom()
}

// Conversation tree viewer
const showTreeViewer = ref(false)

const convTreeLayers = computed(() => {
  if (!chat.currentConv?.messages?.length) return []
  const msgs = chat.currentConv.messages
  const childMap = {}
  for (const m of msgs) {
    if (m.parent) {
      if (!childMap[m.parent]) childMap[m.parent] = []
      childMap[m.parent].push(m)
    }
  }
  const root = msgs.find(m => !m.parent)
  if (!root) return []

  const layers = []
  let level = [root]
  while (level.length) {
    layers.push(level)
    const next = []
    for (const m of level) {
      for (const c of (childMap[m.id] || [])) next.push(c)
    }
    level = next
  }
  return layers
})

const activePathIds = computed(() => new Set(chat.activePath.map(m => m.id)))

function selectConvTreeNode(msg) {
  if (!chat.currentConv) return
  const allMsgs = chat.currentConv.messages
  const byId = Object.fromEntries(allMsgs.map(m => [m.id, m]))

  // Walk up to root
  const path = []
  let cur = msg
  while (cur) {
    path.unshift(cur)
    cur = cur.parent ? byId[cur.parent] : null
  }

  // Walk down following last child
  cur = msg
  const childMap = {}
  for (const m of allMsgs) {
    if (m.parent) {
      if (!childMap[m.parent]) childMap[m.parent] = []
      childMap[m.parent].push(m)
    }
  }
  while (childMap[cur.id]?.length) {
    cur = childMap[cur.id][childMap[cur.id].length - 1]
    path.push(cur)
  }

  // Reorder: for each node on the path, make it the last sibling so activePath picks it
  for (const node of path) {
    if (!node.parent) continue
    const current = chat.currentConv.messages
    const siblings = current.filter(m => m.parent === node.parent && m.role === node.role && m.id !== node.id)
    const rest = current.filter(m => !(m.parent === node.parent && m.role === node.role))
    chat.currentConv.messages = [...rest, ...siblings, node]
  }

  showTreeViewer.value = false
}

function convMsgPreview(msg) {
  if (msg.role === 'system') return '[System]'
  return (msg.content || '').replace(/\n/g, ' ').slice(0, 50) || '(empty)'
}

// Write to chapter
const writeTarget = ref(null)
const showWriteModal = ref(false)
const writeMsgId = ref('')

function openWriteModal(msgId) {
  writeMsgId.value = msgId
  writeTarget.value = null
  showWriteModal.value = true
}

async function doWrite() {
  if (!writeTarget.value || !writeMsgId.value) return
  try {
    await chat.writeToChapter(novel.currentBookId, writeTarget.value, writeMsgId.value)
    const ch = allChapters.value.find(c => c.id === writeTarget.value)
    showToast(t('chat.writeSuccess', { ch: ch?.title || writeTarget.value }))
    showWriteModal.value = false
  } catch (e) {
    showToast(t('chat.writeFailed', { error: e.message }))
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    doSend()
  }
}

onMounted(() => {
  chat.fetchConversations()
  novel.fetchBooks()
})
</script>

<template>
  <div class="chat-layout">
    <!-- Sidebar: conversation list -->
    <aside class="chat-sidebar">
      <div class="chat-sidebar-head">
        <h2>{{ t('chat.title') }}</h2>
        <button class="btn btn-sm btn-primary" @click="openCreate">{{ t('chat.new') }}</button>
      </div>
      <div class="chat-sidebar-list">
        <div
          v-for="conv in chat.conversations"
          :key="conv.id"
          class="chat-sidebar-item"
          :class="{ active: chat.currentConv?.id === conv.id }"
          @click="chat.loadConversation(conv.id).then(() => { if (chat.currentConv) activeModel = chat.currentConv.model })"
        >
          <div class="item-title">{{ conv.title }}</div>
          <div class="item-meta">{{ conv.model }} · {{ new Date(conv.updatedAt).toLocaleDateString() }}</div>
          <button class="item-delete" @click.stop="chat.deleteConversation(conv.id)" :title="t('common.delete')">×</button>
        </div>
        <div v-if="chat.conversations.length === 0" class="chat-empty-hint">{{ t('chat.empty') }}</div>
      </div>
    </aside>

    <!-- Main: chat area -->
    <div class="chat-main">
      <!-- Create dialog -->
      <div v-if="showCreate" class="chat-create">
        <h3>{{ t('chat.createTitle') }}</h3>

        <label>{{ t('common.title') }}</label>
        <input v-model="createTitle" type="text" :placeholder="t('common.untitled')" />

        <label>{{ t('chat.model') }}</label>
        <select v-model="createModel">
          <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
        <input v-model="createModel" type="text" placeholder="gpt-4o" style="margin-top:4px;" />

        <label>{{ t('chat.context') }}</label>
        <p class="hint">{{ t('chat.contextHint') }}</p>
        <div class="chapter-picker">
          <label v-for="ch in allChapters" :key="ch.id" class="chapter-option">
            <input type="checkbox" :value="ch.id" v-model="selectedChapters" />
            <span>{{ ch.id }} · {{ ch.title }}</span>
          </label>
          <div v-if="allChapters.length === 0" class="hint">{{ t('common.empty') }}</div>
        </div>

        <label>{{ t('chat.systemPrompt') }}</label>
        <div class="prompt-picker" v-if="promptList.length">
          <select @change="loadPromptContent($event.target.value)">
            <option value="">{{ t('chat.selectPrompt') }}</option>
            <option v-for="p in promptList" :key="p.id" :value="p.id">{{ p.title }}</option>
          </select>
        </div>
        <textarea v-model="createPrompt" :placeholder="t('chat.systemPromptPh')" rows="4"></textarea>

        <div class="create-actions">
          <button class="btn" @click="showCreate = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="doCreate">{{ t('chat.startChat') }}</button>
        </div>
      </div>

      <!-- No conversation selected -->
      <div v-else-if="!chat.currentConv" class="chat-placeholder">
        <p>{{ t('chat.noConv') }}</p>
      </div>

      <!-- Active conversation -->
      <template v-else>
        <div class="chat-header">
          <h3>{{ chat.currentConv.title }}</h3>
          <select v-model="activeModel" class="header-select">
            <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
          <select v-model="activeEffort" class="header-select">
            <option v-for="e in EFFORTS" :key="e.id" :value="e.id">{{ e.label }}</option>
          </select>
          <button class="act-btn header-tree-btn" @click="showTreeViewer = true" title="Conversation tree">🌳</button>
        </div>

        <div class="chat-messages" ref="messagesEl">
          <div
            v-for="msg in visibleMessages"
            :key="msg.id"
            class="chat-msg"
            :class="msg.role"
          >
            <div class="msg-role">
              {{ msg.role === 'user' ? t('conv.myPrompt') : t('conv.aiReply') }}
              <span v-if="msg.model && msg.role === 'assistant'" class="msg-model">{{ msg.model }}</span>
            </div>

            <!-- User message: editable -->
            <template v-if="msg.role === 'user'">
              <div v-if="editingMsgId === msg.id" class="msg-edit-area">
                <textarea v-model="editingContent" rows="3" @keydown.enter.ctrl="submitEditPrompt(msg)"></textarea>
                <div class="msg-edit-actions">
                  <button class="btn btn-sm" @click="cancelEditPrompt">{{ t('common.cancel') }}</button>
                  <button class="btn btn-sm btn-primary" @click="submitEditPrompt(msg)" :disabled="chat.streaming">{{ t('chat.send') }}</button>
                </div>
              </div>
              <div v-else class="msg-content">{{ msg.content }}</div>
              <div class="msg-actions">
                <template v-if="getBranchInfo(msg).total > 1">
                  <button class="act-btn" @click="switchBranch(msg, -1)" :disabled="getBranchInfo(msg).index === 0">‹</button>
                  <span class="branch-label">{{ getBranchInfo(msg).index + 1 }}/{{ getBranchInfo(msg).total }}</span>
                  <button class="act-btn" @click="switchBranch(msg, 1)" :disabled="getBranchInfo(msg).index === getBranchInfo(msg).total - 1">›</button>
                  <span class="act-sep"></span>
                </template>
                <button class="act-btn" @click="startEditPrompt(msg)" :disabled="chat.streaming" v-if="editingMsgId !== msg.id">✎</button>
                <button class="act-btn" @click="doCopy(msg.content)">⎘</button>
              </div>
            </template>

            <!-- Assistant message -->
            <template v-else>
              <div class="msg-content" :style="aiStyle">
                <template v-if="chat.streaming && msg.id === chat.activePath[chat.activePath.length - 1]?.id">
                  {{ chat.streamContent || '...' }}
                </template>
                <template v-else>{{ msg.content }}</template>
              </div>
              <div class="msg-actions">
                <template v-if="getBranchInfo(msg).total > 1">
                  <button class="act-btn" @click="switchBranch(msg, -1)" :disabled="getBranchInfo(msg).index === 0">‹</button>
                  <span class="branch-label">{{ getBranchInfo(msg).index + 1 }}/{{ getBranchInfo(msg).total }}</span>
                  <button class="act-btn" @click="switchBranch(msg, 1)" :disabled="getBranchInfo(msg).index === getBranchInfo(msg).total - 1">›</button>
                  <span class="act-sep"></span>
                </template>
                <button class="act-btn" @click="doRegenerate(msg.id)" :disabled="chat.streaming">↻</button>
                <button class="act-btn" @click="doCopy(msg.content)">⎘</button>
                <button class="act-btn" @click="openWriteModal(msg.id)">⬇ {{ t('chat.writeToChapter') }}</button>
              </div>
            </template>
          </div>

          <div v-if="chat.streaming" class="chat-streaming-indicator">{{ t('chat.sending') }}</div>
        </div>

        <!-- Input area -->
        <div class="chat-input-area">
          <textarea
            v-model="input"
            :placeholder="t('chat.inputPh')"
            @keydown="handleKeydown"
            :disabled="chat.streaming"
            rows="3"
          ></textarea>
          <button class="btn btn-primary send-btn" @click="doSend" :disabled="chat.streaming || !input.trim()">
            {{ chat.streaming ? t('chat.sending') : t('chat.send') }}
          </button>
        </div>
      </template>
    </div>

    <!-- Write-to-chapter modal -->
    <Transition name="fade">
      <div v-if="showWriteModal" class="modal-backdrop" @click="showWriteModal = false">
        <div class="modal-box" @click.stop>
          <h4>{{ t('chat.selectChapter') }}</h4>
          <div class="chapter-picker modal-picker">
            <label
              v-for="ch in allChapters"
              :key="ch.id"
              class="chapter-option"
              :class="{ selected: writeTarget === ch.id }"
            >
              <input type="radio" :value="ch.id" v-model="writeTarget" />
              <span>{{ ch.id }} · {{ ch.title }}</span>
            </label>
          </div>
          <div class="modal-actions">
            <button class="btn" @click="showWriteModal = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" @click="doWrite" :disabled="!writeTarget">{{ t('chat.writeToChapter') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Conversation tree viewer -->
    <Transition name="fade">
      <div v-if="showTreeViewer" class="modal-backdrop" @click="showTreeViewer = false">
        <div class="modal-box conv-tree-modal" @click.stop>
          <div class="conv-tree-header">
            <h4>Conversation Tree</h4>
            <button class="act-btn" @click="showTreeViewer = false">✕</button>
          </div>
          <div class="conv-tree-body">
            <div v-for="(layer, depth) in convTreeLayers" :key="depth" class="conv-tree-layer">
              <div v-if="depth > 0" class="conv-tree-connector"></div>
              <div class="conv-tree-nodes">
                <div
                  v-for="msg in layer"
                  :key="msg.id"
                  class="conv-tree-node"
                  :class="{ selected: activePathIds.has(msg.id), user: msg.role === 'user', assistant: msg.role === 'assistant', system: msg.role === 'system' }"
                  @click="selectConvTreeNode(msg)"
                >
                  <div class="ctn-role">{{ msg.role === 'user' ? 'U' : msg.role === 'assistant' ? 'A' : 'S' }}</div>
                  <div class="ctn-preview">{{ convMsgPreview(msg) }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Toast -->
    <Transition name="fade">
      <div v-if="toast" class="chat-toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ── Sidebar ──────────────────────────────────────────────── */
.chat-sidebar {
  width: 260px;
  min-width: 260px;
  border-right: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
}
.chat-sidebar-head {
  padding: 16px;
  border-bottom: 1px solid var(--rule);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.chat-sidebar-head h2 {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  margin: 0;
}
.chat-sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.chat-sidebar-item {
  padding: 10px 12px;
  cursor: pointer;
  border: 1px solid transparent;
  position: relative;
  transition: background var(--t-fast) var(--ease);
}
.chat-sidebar-item:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.chat-sidebar-item.active {
  border-color: var(--rule);
  background: color-mix(in srgb, var(--hot) 8%, transparent);
}
.item-title {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 20px;
}
.item-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.item-delete {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease);
}
.chat-sidebar-item:hover .item-delete { opacity: 1; }
.item-delete:hover { color: #c44; }
.chat-empty-hint {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 32px 16px;
}

/* ── Main area ────────────────────────────────────────────── */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chat-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 14px;
}

/* ── Create dialog ────────────────────────────────────────── */
.chat-create {
  padding: 32px;
  max-width: 640px;
  margin: 0 auto;
  overflow-y: auto;
  flex: 1;
}
.chat-create h3 {
  font-size: 18px;
  margin: 0 0 20px;
}
.chat-create label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  margin: 14px 0 4px;
  color: var(--text-soft);
}
.chat-create input[type="text"],
.chat-create textarea,
.chat-create select {
  width: 100%;
  font-family: var(--font-ui);
  font-size: 13px;
  padding: 8px 10px;
  border: 1px solid var(--rule);
  background: var(--bg-card);
  color: var(--text);
  box-sizing: border-box;
}
.chat-create textarea { resize: vertical; }
.hint {
  font-size: 11px;
  color: var(--text-muted);
  margin: 2px 0 6px;
}
.chapter-picker {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--rule);
  padding: 6px;
}
.chapter-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 12px;
  cursor: pointer;
}
.chapter-option:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.chapter-option.selected {
  background: color-mix(in srgb, var(--hot) 12%, transparent);
}
.prompt-picker {
  margin-bottom: 6px;
}
.prompt-picker select {
  width: 100%;
  font-family: var(--font-ui);
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--rule);
  background: var(--bg-card);
  color: var(--text);
}
.create-actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
  justify-content: flex-end;
}

/* ── Chat header ──────────────────────────────────────────── */
.chat-header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--rule);
  display: flex;
  align-items: center;
  gap: 12px;
}
.chat-header h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.header-select {
  font-size: 12px;
  font-family: var(--font-ui);
  color: var(--text);
  background: var(--bg-card, var(--bg));
  border: 1px solid var(--rule);
  padding: 3px 6px;
  cursor: pointer;
}

/* ── Messages ─────────────────────────────────────────────── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
.chat-msg {
  margin-bottom: 20px;
  max-width: 800px;
}
.chat-msg.user {
  margin-left: auto;
  text-align: right;
}
.msg-role {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 4px;
  text-transform: uppercase;
}
.msg-content {
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-msg.user .msg-content {
  background: color-mix(in srgb, var(--hot) 8%, transparent);
  padding: 10px 14px;
  display: inline-block;
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--hot) 16%, transparent);
}
.chat-msg.assistant .msg-content {
  background: color-mix(in srgb, var(--text) 3%, transparent);
  padding: 12px 16px;
  border: 1px solid var(--rule);
}

/* ── Actions bar ──────────────────────────────────────────── */
.msg-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.act-btn {
  background: none;
  border: 1px solid var(--rule);
  cursor: pointer;
  color: var(--text-soft);
  font-size: 12px;
  padding: 3px 8px;
  font-family: var(--font-ui);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.act-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}
.act-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.branch-label {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 24px;
  text-align: center;
}
.act-sep {
  width: 1px;
  height: 16px;
  background: var(--rule);
  margin: 0 4px;
}

.chat-streaming-indicator {
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px 0;
  animation: pulse 1.5s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── Input area ───────────────────────────────────────────── */
.chat-input-area {
  border-top: 1px solid var(--rule);
  padding: 12px 20px;
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.chat-input-area textarea {
  flex: 1;
  font-family: var(--font-ui);
  font-size: 14px;
  padding: 10px 12px;
  border: 1px solid var(--rule);
  background: var(--bg-card);
  color: var(--text);
  resize: none;
  line-height: 1.5;
}
.send-btn {
  height: fit-content;
  white-space: nowrap;
}

/* ── Modal ────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--rule);
  padding: 24px;
  min-width: 360px;
  max-width: 500px;
  max-height: 70vh;
  overflow-y: auto;
}
.modal-box h4 {
  font-size: 15px;
  margin: 0 0 12px;
}
.modal-picker {
  max-height: 300px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}

/* ── Toast ────────────────────────────────────────────────── */
.chat-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--bg);
  padding: 8px 20px;
  font-size: 13px;
  z-index: 200;
  pointer-events: none;
}

/* ── Transition ───────────────────────────────────────────── */
/* ── Edit prompt area ─────────────────────────────────────── */
.msg-edit-area textarea {
  width: 100%; font-family: var(--font-ui); font-size: 14px;
  padding: 8px 10px; border: 1px solid var(--hot, #c44);
  background: var(--bg-card); color: var(--text); resize: vertical; box-sizing: border-box;
}
.msg-edit-actions { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; }
.msg-model { font-size: 10px; color: var(--text-muted); margin-left: 6px; font-weight: 400; }

/* ── Header tree button ──────────────────────────────────── */
.header-tree-btn { font-size: 16px !important; padding: 2px 8px !important; }

/* ── Conversation tree modal ─────────────────────────────── */
.conv-tree-modal { min-width: 500px; max-width: 80vw; max-height: 80vh; display: flex; flex-direction: column; }
.conv-tree-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.conv-tree-header h4 { margin: 0; font-size: 15px; }
.conv-tree-body { overflow: auto; flex: 1; }
.conv-tree-layer { position: relative; }
.conv-tree-connector { height: 16px; display: flex; justify-content: center; }
.conv-tree-connector::before { content: ''; display: block; width: 2px; height: 100%; background: var(--rule); margin: 0 auto; }
.conv-tree-nodes { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.conv-tree-node {
  width: 160px; padding: 8px 10px; border: 2px solid var(--rule);
  background: var(--bg-card, var(--bg)); cursor: pointer;
  transition: all var(--t-fast) var(--ease); display: flex; gap: 6px; align-items: flex-start;
}
.conv-tree-node:hover { border-color: var(--text-soft); }
.conv-tree-node.selected { border-color: var(--hot, #c44); background: color-mix(in srgb, var(--hot, #c44) 8%, var(--bg-card, var(--bg))); }
.conv-tree-node.system { opacity: 0.5; }
.ctn-role {
  font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
  width: 16px; height: 16px; line-height: 16px; text-align: center; flex-shrink: 0;
}
.conv-tree-node.user .ctn-role { color: var(--hot, #c44); }
.conv-tree-node.assistant .ctn-role { color: #6ab04c; }
.ctn-preview { font-size: 11px; color: var(--text-soft); line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
