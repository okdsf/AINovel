<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNovelStore } from '../stores/novel'
import { useI18n } from '../i18n'

const router = useRouter()
const store = useNovelStore()
const { t } = useI18n()

const tree = ref({ root: null, nodes: {}, edges: {}, selectedPath: [] })
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const loadError = ref('')

// Branch creation
const showBranchDialog = ref(false)
const branchParentId = ref('')
const branchTitle = ref('')
const creatingBranch = ref(false)

async function loadTree() {
  if (!store.currentBookId) {
    loadError.value = 'No book selected'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetch(`/api/books/${store.currentBookId}/tree`)
    if (!res.ok) {
      loadError.value = `API ${res.status}: ${await res.text()}`
      return
    }
    tree.value = await res.json()
  } catch (e) {
    loadError.value = e.message
  } finally {
    loading.value = false
  }
}

function nodeTitle(id) {
  return tree.value.nodes?.[id]?.title || id
}

// Build layers for rendering
const layers = computed(() => {
  const { root, edges } = tree.value
  if (!root || !edges) return []
  const result = []
  let currentLevel = [{ id: root, parent: null }]
  while (currentLevel.length > 0) {
    result.push(currentLevel)
    const nextLevel = []
    for (const node of currentLevel) {
      for (const childId of (edges[node.id] || [])) {
        nextLevel.push({ id: childId, parent: node.id })
      }
    }
    currentLevel = nextLevel
  }
  return result
})

function isSelected(id) { return tree.value.selectedPath?.includes(id) }
function isBranchPoint(id) { return (tree.value.edges?.[id]?.length || 0) > 1 }
function isLeaf(id) { return (tree.value.edges?.[id]?.length || 0) === 0 }

function selectNode(nodeId) {
  const { root, edges } = tree.value
  if (!root) return
  const parentMap = {}
  for (const [p, children] of Object.entries(edges)) {
    for (const c of children) parentMap[c] = p
  }
  const path = []
  let cur = nodeId
  while (cur) { path.unshift(cur); cur = parentMap[cur] || null }
  cur = nodeId
  while (edges[cur]?.length) { cur = edges[cur][0]; path.push(cur) }
  tree.value.selectedPath = path
}

async function savePath() {
  saving.value = true
  message.value = ''
  try {
    await store.saveTree({
      selectedPath: tree.value.selectedPath,
    })
    message.value = t('ntree.saved')
    setTimeout(() => message.value = '', 2000)
  } catch (e) {
    message.value = t('ntree.saveFailed', { error: e.message })
  } finally {
    saving.value = false
  }
}

// Create branch
function openBranchDialog(parentId) {
  branchParentId.value = parentId
  branchTitle.value = ''
  showBranchDialog.value = true
}

async function createBranch() {
  if (!branchTitle.value.trim()) return
  creatingBranch.value = true
  try {
    const res = await fetch(`/api/books/${store.currentBookId}/tree/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: branchParentId.value, title: branchTitle.value.trim() }),
    })
    if (!res.ok) throw new Error(await res.text())
    showBranchDialog.value = false
    await loadTree()
    message.value = t('ntree.branchCreated')
    setTimeout(() => message.value = '', 2000)
  } catch (e) {
    message.value = e.message
  } finally {
    creatingBranch.value = false
  }
}

watch(() => store.currentBookId, async (id) => {
  if (id) {
    if (!store.meta) await store.fetchMeta()
    loadTree()
  }
}, { immediate: true })

watch(() => store.meta, () => {
  if (store.currentBookId) loadTree()
})

onMounted(() => {
  if (!store.books.length) store.fetchBooks()
})
</script>

<template>
  <div class="ntree-page">
    <div class="ntree-header">
      <h2>{{ t('ntree.title') }}</h2>
      <p class="ntree-subtitle">{{ t('ntree.subtitle') }}</p>
    </div>

    <div v-if="loading" class="ntree-loading">{{ t('common.loading') }}</div>

    <div v-else-if="loadError" class="ntree-empty">
      <p style="color:#c44;">{{ loadError }}</p>
      <button class="btn" @click="loadTree" style="margin-top:8px;">Retry</button>
    </div>

    <div v-else-if="!tree.root" class="ntree-empty">
      <p>{{ t('ntree.empty') }}</p>
    </div>

    <template v-else>
      <div class="ntree-canvas">
        <div v-for="(layer, depth) in layers" :key="depth" class="ntree-layer">
          <div v-if="depth > 0" class="ntree-connectors"></div>
          <div class="ntree-nodes">
            <div
              v-for="node in layer"
              :key="node.id"
              class="ntree-node"
              :class="{
                selected: isSelected(node.id),
                'branch-point': isBranchPoint(node.id),
                leaf: isLeaf(node.id),
              }"
            >
              <div class="node-title" @click="selectNode(node.id)">{{ nodeTitle(node.id) }}</div>
              <div class="node-actions">
                <button class="node-act" @click="selectNode(node.id)" :title="t('ntree.selectThis')">☑</button>
                <button class="node-act" @click="openBranchDialog(node.id)" :title="t('ntree.createBranch')">⑂+</button>
                <button class="node-act" @click="router.push(`/read/${node.id}`)" :title="t('ntree.clickToRead')">→</button>
              </div>
              <div v-if="isBranchPoint(node.id)" class="node-branch-badge">
                ⑂ {{ tree.edges[node.id].length }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Selected path -->
      <div class="ntree-path-section">
        <h3>{{ t('ntree.selectedPath') }}</h3>
        <div class="ntree-chain">
          <template v-for="(chId, i) in tree.selectedPath" :key="chId">
            <div class="chain-node" @click="router.push(`/read/${chId}`)">
              <span class="chain-title">{{ nodeTitle(chId) }}</span>
            </div>
            <span v-if="i < tree.selectedPath.length - 1" class="chain-arrow">→</span>
          </template>
        </div>
        <div class="ntree-path-actions">
          <button class="btn btn-primary" @click="savePath" :disabled="saving">
            {{ saving ? t('common.saving') : t('ntree.savePath') }}
          </button>
          <span v-if="message" class="ntree-msg">{{ message }}</span>
        </div>
      </div>

      <div class="ntree-legend">
        <span class="legend-item"><span class="legend-dot selected"></span> {{ t('ntree.legendSelected') }}</span>
        <span class="legend-item"><span class="legend-dot branch"></span> {{ t('ntree.legendBranch') }}</span>
        <span class="legend-item"><span class="legend-dot unselected"></span> {{ t('ntree.legendUnselected') }}</span>
      </div>
    </template>

    <!-- Branch creation dialog -->
    <Transition name="fade">
      <div v-if="showBranchDialog" class="modal-backdrop" @click="showBranchDialog = false">
        <div class="modal-box" @click.stop>
          <h4>{{ t('ntree.createBranch') }}</h4>
          <p class="modal-hint">{{ t('ntree.branchFrom', { title: nodeTitle(branchParentId) }) }}</p>
          <input
            v-model="branchTitle"
            type="text"
            :placeholder="t('ntree.branchTitlePh')"
            @keydown.enter="createBranch"
            autofocus
          />
          <div class="modal-actions">
            <button class="btn" @click="showBranchDialog = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" @click="createBranch" :disabled="creatingBranch || !branchTitle.trim()">
              {{ creatingBranch ? t('common.saving') : t('common.create') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ntree-page { padding: 32px; max-width: 1100px; margin: 0 auto; }
.ntree-header { margin-bottom: 28px; }
.ntree-header h2 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
.ntree-subtitle { font-size: 13px; color: var(--text-muted); margin: 0; }
.ntree-loading, .ntree-empty { text-align: center; color: var(--text-muted); padding: 60px 0; font-size: 14px; }

.ntree-canvas { display: flex; flex-direction: column; margin-bottom: 32px; }
.ntree-layer { position: relative; }
.ntree-connectors { height: 20px; display: flex; justify-content: center; }
.ntree-connectors::before { content: ''; display: block; width: 2px; height: 100%; background: var(--rule); margin: 0 auto; }
.ntree-nodes { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }

.ntree-node {
  position: relative; width: 200px; padding: 10px 12px;
  border: 2px solid var(--rule); background: var(--bg-card, var(--bg));
  transition: all var(--t-fast) var(--ease);
}
.ntree-node:hover { border-color: var(--text-soft); }
.ntree-node.selected { border-color: var(--hot, #c44); background: color-mix(in srgb, var(--hot, #c44) 6%, var(--bg-card, var(--bg))); }
.ntree-node.selected::before { content: ''; position: absolute; left: -2px; top: -2px; bottom: -2px; width: 4px; background: var(--hot, #c44); }
.ntree-node.branch-point { border-style: dashed; }

.node-title {
  font-size: 13px; font-weight: 600; line-height: 1.3;
  cursor: pointer; margin-bottom: 6px;
}
.node-actions { display: flex; gap: 4px; }
.node-act {
  background: none; border: 1px solid var(--rule); cursor: pointer;
  color: var(--text-muted); font-size: 11px; padding: 2px 6px;
  transition: all var(--t-fast) var(--ease);
}
.node-act:hover { color: var(--text); border-color: var(--text-soft); }
.node-branch-badge {
  position: absolute; top: 6px; right: 6px; font-size: 11px;
  color: var(--text-muted); background: color-mix(in srgb, var(--text) 6%, transparent); padding: 1px 6px;
}

.ntree-path-section { border-top: 1px solid var(--rule); padding-top: 24px; margin-bottom: 24px; }
.ntree-path-section h3 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
.ntree-chain { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 16px; }
.chain-node {
  padding: 6px 10px; border: 1px solid var(--hot, #c44);
  background: color-mix(in srgb, var(--hot, #c44) 6%, transparent);
  cursor: pointer; transition: background var(--t-fast) var(--ease);
}
.chain-node:hover { background: color-mix(in srgb, var(--hot, #c44) 14%, transparent); }
.chain-title { font-size: 12px; font-weight: 500; }
.chain-arrow { color: var(--hot, #c44); font-size: 14px; font-weight: 700; }
.ntree-path-actions { display: flex; align-items: center; gap: 12px; }
.ntree-msg { font-size: 13px; color: var(--hot, var(--accent)); }

.ntree-legend { display: flex; gap: 20px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--rule) 40%, transparent); }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
.legend-dot { width: 12px; height: 12px; border: 2px solid var(--rule); }
.legend-dot.selected { border-color: var(--hot, #c44); background: color-mix(in srgb, var(--hot, #c44) 15%, transparent); }
.legend-dot.branch { border-style: dashed; border-color: var(--text-soft); }
.legend-dot.unselected { border-color: var(--rule); }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-box { background: var(--bg-card); border: 1px solid var(--rule); padding: 24px; min-width: 380px; }
.modal-box h4 { font-size: 15px; margin: 0 0 8px; }
.modal-hint { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; }
.modal-box input { width: 100%; font-size: 14px; padding: 8px 10px; border: 1px solid var(--rule); background: var(--bg); color: var(--text); box-sizing: border-box; }
.modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
