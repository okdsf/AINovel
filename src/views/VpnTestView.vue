<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useVpnTestStore } from '../stores/vpnTest'

const vpnTests = useVpnTestStore()

const experimentForm = reactive({
  title: '',
  conversationUrl: '',
})
const nodeForm = reactive({
  nodeLabel: '',
  redoCount: 3,
  redoOption: 'try_again',
  requiredModel: 'Pro Extended',
  minDelaySeconds: 10,
})
const attachForm = reactive({
  nodeLabel: '',
  runId: '',
})

const experimentFormError = ref('')
const nodeFormError = ref('')
const attachFormError = ref('')
const refreshing = ref(false)
const toast = ref('')
let pollTimer = null
let toastTimer = null

function normalizeConversationUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    const exactPath = /^\/app\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      || /^\/gem\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'gemini.google.com'
      || url.port
      || url.username
      || url.password
      || !exactPath
    ) return ''
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return ''
  }
}

function trialsOf(experiment) {
  return Array.isArray(experiment?.trials) ? experiment.trials : []
}

function aggregatesOf(experiment) {
  return Array.isArray(experiment?.aggregates) ? experiment.aggregates : []
}

function experimentCounts(experiment) {
  const aggregates = aggregatesOf(experiment)
  const total = aggregates.reduce((sum, item) => sum + (Number(item.total) || 0), 0)
  const completed = aggregates.reduce((sum, item) => sum + (Number(item.completed) || 0), 0)
  return { total: total || trialsOf(experiment).length, completed }
}

function displayTitle(experiment) {
  return experiment?.title || `未命名实验 · ${String(experiment?.id || '').slice(0, 8)}`
}

function formatDate(value, includeSeconds = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
  }).format(date)
}

function formatMs(value) {
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds >= 10_000) return `${(milliseconds / 1000).toFixed(1)} s`
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(2)} s`
  return `${milliseconds.toFixed(milliseconds < 10 ? 1 : 0)} ms`
}

function formatRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%` : '—'
}

function statusKey(run) {
  return String(run?.status || run?.state || 'unknown')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

const RUN_STATUS = {
  draft: { label: '草稿', tone: 'muted' },
  queued: { label: '等待执行', tone: 'queued' },
  leased: { label: '准备执行', tone: 'running' },
  submitted: { label: '生成中', tone: 'running' },
  running: { label: '执行中', tone: 'running' },
  paused: { label: '已暂停', tone: 'paused' },
  completed: { label: '已完成', tone: 'complete' },
  failed: { label: '失败', tone: 'danger' },
  blocked: { label: '被阻止', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'muted' },
  canceled: { label: '已取消', tone: 'muted' },
}

function runStatus(run) {
  const key = statusKey(run)
  return RUN_STATUS[key] || { label: key, tone: 'muted' }
}

function runForTrial(trial) {
  return vpnTests.runs.find(run => run.id === trial?.runId) || null
}

const eligibleRuns = computed(() => {
  const conversationUrl = normalizeConversationUrl(vpnTests.selectedExperiment?.conversationUrl)
  if (!conversationUrl) return []
  return vpnTests.runs.filter(run => (
    run?.runKind === 'workflow'
    && run?.actionBranch === 'redo_only'
    && normalizeConversationUrl(run?.conversationUrl) === conversationUrl
    && !vpnTests.boundRunIds.has(run.id)
  ))
})
const activeNodeTrial = computed(() => vpnTests.activeTrial || null)
const activeNodeLabel = computed(() => {
  const active = activeNodeTrial.value
  if (!active) return ''
  return `实验“${displayTitle(active.experiment)}”的节点“${active.trial.nodeLabel}”`
})

function showToast(message) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 3000)
}

async function refresh({ silent = true } = {}) {
  if (refreshing.value) return
  refreshing.value = true
  const selectedId = vpnTests.selectedExperimentId
  try {
    const jobs = [
      vpnTests.fetchExperiments({ silent }),
      vpnTests.fetchRuns({ silent }),
    ]
    if (selectedId) jobs.push(vpnTests.fetchExperiment(selectedId, { silent: true }))
    await Promise.allSettled(jobs)
  } finally {
    refreshing.value = false
  }
}

async function createExperiment() {
  experimentFormError.value = ''
  const title = experimentForm.title.trim()
  const conversationUrl = normalizeConversationUrl(experimentForm.conversationUrl)
  if (!title) {
    experimentFormError.value = '请填写实验标题。'
    return
  }
  if (!conversationUrl) {
    experimentFormError.value = '请粘贴精确的 Gemini 对话链接，例如 /app/对话ID 或 /gem/GemID/对话ID。'
    return
  }
  try {
    await vpnTests.createExperiment({ title, conversationUrl })
    experimentForm.conversationUrl = conversationUrl
    showToast('VPN 实验已创建。现在可以切换线路并记录节点。')
  } catch (cause) {
    experimentFormError.value = cause.message
  }
}

async function recordNode() {
  if (vpnTests.recording) return
  nodeFormError.value = ''
  if (activeNodeTrial.value) {
    nodeFormError.value = `${activeNodeLabel.value}仍在执行。请保持当前 VPN 不变，等该运行结束后再测试下一个节点。`
    return
  }
  const nodeLabel = nodeForm.nodeLabel.trim()
  const redoCount = Math.min(100, Math.max(1, Number(nodeForm.redoCount) || 1))
  const requiredModel = nodeForm.requiredModel.trim()
  const minDelaySeconds = Math.min(3600, Math.max(5, Number(nodeForm.minDelaySeconds) || 5))
  if (!nodeLabel) {
    nodeFormError.value = '请填写当前 VPN 节点名称。'
    return
  }
  if (!requiredModel) {
    nodeFormError.value = '请填写 Gemini 当前必须使用的模式。'
    return
  }
  try {
    await vpnTests.recordCurrentNode({
      experiment: vpnTests.selectedExperiment,
      nodeLabel,
      redoCount,
      redoOption: nodeForm.redoOption,
      requiredModel,
      minDelayMs: Math.round(minDelaySeconds * 1000),
    })
    nodeForm.nodeLabel = ''
    await refresh({ silent: true })
    showToast('当前节点已绑定，Redo 工作流正在执行。')
  } catch {
    // The store keeps the exact failed stage and any recoverable run ID.
  }
}

async function attachExistingRun() {
  if (vpnTests.attaching) return
  attachFormError.value = ''
  if (activeNodeTrial.value) {
    attachFormError.value = `${activeNodeLabel.value}仍在执行，不能并行绑定另一个节点。`
    return
  }
  const nodeLabel = attachForm.nodeLabel.trim()
  const runId = attachForm.runId.trim()
  if (!nodeLabel) {
    attachFormError.value = '请填写这个运行对应的 VPN 节点名称。'
    return
  }
  const eligible = eligibleRuns.value.find(run => run.id === runId)
  if (!eligible) {
    attachFormError.value = '该 run ID 不是当前对话尚未绑定的 workflow / redo_only 运行。'
    return
  }
  try {
    await vpnTests.addTrial(vpnTests.selectedExperimentId, { nodeLabel, runId })
    attachForm.nodeLabel = ''
    attachForm.runId = ''
    await refresh({ silent: true })
    showToast('已有运行已绑定到实验。')
  } catch (cause) {
    attachFormError.value = cause.message
  }
}

function onVisibilityChange() {
  if (!document.hidden) refresh({ silent: true })
}

onMounted(async () => {
  await refresh({ silent: false })
  pollTimer = window.setInterval(() => {
    if (!document.hidden && !vpnTests.recording) refresh({ silent: true })
  }, 3000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  window.clearInterval(pollTimer)
  window.clearTimeout(toastTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="vpn-page">
    <header class="page-header">
      <div>
        <p class="kicker">VPN COMPARISON DESK</p>
        <h1>Gemini VPN 节点实验</h1>
        <p class="page-intro">固定同一条 Gemini 对话，只比较不同 VPN 出口下的 Redo 工作流。Runner 会保存预热、点击至首个响应和完整生成耗时。</p>
      </div>
      <button type="button" class="btn btn-small" :disabled="refreshing || vpnTests.recording" @click="refresh({ silent: false })">
        {{ refreshing ? '刷新中…' : '立即刷新' }}
      </button>
    </header>

    <div v-if="vpnTests.error" class="notice notice-error" role="alert">
      <span>{{ vpnTests.error }}</span>
      <button type="button" class="text-button" @click="vpnTests.clearError">关闭</button>
    </div>

    <section class="method-note" aria-labelledby="vpn-method-title">
      <h2 id="vpn-method-title">比较边界</h2>
      <p>实验不会直接 ping 一个 URL，也不会把两条不同对话混在一起。每个 trial 都绑定同一精确对话的 <code>workflow / redo_only</code> 运行；请先切好 VPN、确认专用 Gemini 浏览器已打开该对话，再记录当前节点。</p>
    </section>

    <section class="create-section panel" aria-labelledby="create-experiment-title">
      <div class="section-heading">
        <div>
          <p class="section-number">01 / EXPERIMENT</p>
          <h2 id="create-experiment-title">新建实验</h2>
        </div>
      </div>
      <form class="create-form" @submit.prevent="createExperiment">
        <label class="field">
          <span>实验标题</span>
          <input v-model="experimentForm.title" type="text" maxlength="200" placeholder="例如：美国家宽与机房线路 · 长对话 Redo" />
        </label>
        <label class="field">
          <span>精确 Gemini 对话链接</span>
          <input v-model="experimentForm.conversationUrl" type="url" maxlength="4096" spellcheck="false" placeholder="https://gemini.google.com/app/对话ID" />
          <small>只接受 <code>/app/对话ID</code> 或 <code>/gem/GemID/对话ID</code>；查询参数会被移除。</small>
        </label>
        <p v-if="experimentFormError" class="field-error" role="alert">{{ experimentFormError }}</p>
        <div class="form-actions">
          <p>创建实验不会发送内容，也不会启动 Redo。</p>
          <button type="submit" class="btn btn-primary" :disabled="vpnTests.creating || vpnTests.recording">
            {{ vpnTests.creating ? '创建中…' : '创建实验' }}
          </button>
        </div>
      </form>
    </section>

    <section class="records-section" aria-labelledby="experiment-records-title">
      <div class="records-heading">
        <div>
          <p class="section-number">02 / NODES</p>
          <h2 id="experiment-records-title">实验与节点</h2>
        </div>
        <span class="count-badge">{{ vpnTests.experiments.length }} 个实验</span>
      </div>

      <div class="records-layout">
        <nav class="experiment-list" aria-label="VPN 实验列表">
          <p v-if="vpnTests.loadingExperiments && !vpnTests.experiments.length" class="empty-state">正在读取实验…</p>
          <p v-else-if="!vpnTests.experiments.length" class="empty-state">还没有实验。先固定一条 Gemini 对话。</p>
          <button
            v-for="experiment in vpnTests.experiments"
            v-else
            :key="experiment.id"
            type="button"
            class="experiment-item"
            :class="{ selected: vpnTests.selectedExperimentId === experiment.id }"
            @click="vpnTests.selectExperiment(experiment.id).catch(() => {})"
          >
            <strong>{{ displayTitle(experiment) }}</strong>
            <span>{{ formatDate(experiment.updatedAt || experiment.createdAt) }}</span>
            <span>{{ experimentCounts(experiment).completed }} / {{ experimentCounts(experiment).total }} 个运行完成</span>
          </button>
        </nav>

        <article v-if="vpnTests.selectedExperiment" class="experiment-detail" aria-labelledby="experiment-detail-title">
          <header class="detail-header">
            <div>
              <p class="detail-label">固定对话</p>
              <h3 id="experiment-detail-title">{{ displayTitle(vpnTests.selectedExperiment) }}</h3>
              <a :href="vpnTests.selectedExperiment.conversationUrl" target="_blank" rel="noopener noreferrer">{{ vpnTests.selectedExperiment.conversationUrl }}</a>
            </div>
            <span class="trial-badge">{{ trialsOf(vpnTests.selectedExperiment).length }} 个 trial</span>
          </header>

          <section class="record-node" aria-labelledby="record-node-title">
            <div class="record-node-heading">
              <div>
                <p class="section-number">CURRENT EXIT</p>
                <h4 id="record-node-title">记录并测试当前节点</h4>
              </div>
              <strong class="switch-warning">先切好 VPN，再点击</strong>
            </div>
            <p class="record-explainer">点击后，系统会让 Runner 读取当前对话，锁定最后一条用户消息的 turnKey、序号、哈希和长度，然后创建、启动并绑定一个只做 Redo 的工作流。操作进行中按钮会锁定，避免重复创建。</p>

            <div v-if="activeNodeTrial" class="active-node-lock" role="status">
              <strong>全局节点锁：{{ activeNodeLabel }}</strong>
              <p>运行 {{ activeNodeTrial.run.id }} · {{ runStatus(activeNodeTrial.run).label }}。在它完成、取消或进入待处理状态前，请不要切换 VPN；系统也不会接受下一个节点。</p>
            </div>

            <form @submit.prevent="recordNode">
              <div class="node-form-grid">
                <label class="field node-label-field">
                  <span>当前节点名称</span>
                  <input v-model="nodeForm.nodeLabel" type="text" maxlength="200" placeholder="例如：US Chicago Residential 01" />
                </label>
                <label class="field">
                  <span>Redo 次数</span>
                  <input v-model.number="nodeForm.redoCount" type="number" min="1" max="100" step="1" />
                </label>
                <label class="field">
                  <span>Redo 方式</span>
                  <select id="vpn-redo-option" v-model="nodeForm.redoOption">
                    <option value="try_again">Try again</option>
                    <option value="longer">Longer</option>
                    <option value="shorter">Shorter</option>
                  </select>
                </label>
                <label class="field">
                  <span>必需模式</span>
                  <input v-model="nodeForm.requiredModel" type="text" maxlength="120" list="vpn-model-suggestions" />
                  <datalist id="vpn-model-suggestions">
                    <option value="Pro Extended"></option>
                    <option value="Deep Think"></option>
                  </datalist>
                </label>
                <label class="field">
                  <span>轮间最短等待（秒）</span>
                  <input v-model.number="nodeForm.minDelaySeconds" type="number" min="5" max="3600" step="1" />
                </label>
              </div>
              <p v-if="nodeFormError" class="field-error" role="alert">{{ nodeFormError }}</p>
              <div v-if="vpnTests.recordingStage" class="recording-status" :class="{ active: vpnTests.recording }" role="status">
                <span class="status-dot" aria-hidden="true"></span>
                <span>
                  {{ vpnTests.recordingStage }}
                  <small v-if="vpnTests.recordingSnapshot?.id">
                    快照 {{ vpnTests.recordingSnapshot.id }} · {{ vpnTests.recordingSnapshot.status }}
                  </small>
                  <small v-if="vpnTests.lastCreatedRunId">运行 {{ vpnTests.lastCreatedRunId }}</small>
                </span>
              </div>
              <div class="form-actions">
                <p>此入口会自动创建并启动测试运行；无需先去自动化页面。</p>
                <button type="submit" class="btn btn-primary" :disabled="vpnTests.recording || vpnTests.attaching || Boolean(activeNodeTrial)">
                  {{ vpnTests.recording ? '正在读取并创建…' : '记录并测试当前节点' }}
                </button>
              </div>
            </form>
          </section>

          <details class="advanced-attach">
            <summary>高级：附加已有 redo_only 运行</summary>
            <p>仅列出对话链接完全一致、类型为 <code>workflow / redo_only</code> 且尚未绑定到任何 VPN 实验的运行。也可以先到 <a href="/automation">Gemini 网页自动化</a> 创建运行，再回到这里绑定。</p>
            <form @submit.prevent="attachExistingRun">
              <div class="attach-grid">
                <label class="field">
                  <span>节点名称</span>
                  <input v-model="attachForm.nodeLabel" type="text" maxlength="200" placeholder="当前 VPN 出口名称" />
                </label>
                <label class="field">
                  <span>已有 run ID</span>
                  <input v-model="attachForm.runId" type="text" maxlength="240" list="eligible-vpn-runs" placeholder="选择或粘贴 run ID" />
                  <datalist id="eligible-vpn-runs">
                    <option v-for="run in eligibleRuns" :key="run.id" :value="run.id">{{ run.title }} · {{ runStatus(run).label }}</option>
                  </datalist>
                  <small v-if="vpnTests.loadingRuns">正在读取运行列表…</small>
                  <small v-else>{{ eligibleRuns.length }} 个匹配且未绑定的运行</small>
                </label>
              </div>
              <p v-if="attachFormError" class="field-error" role="alert">{{ attachFormError }}</p>
              <div class="attach-actions">
                <a class="text-link" href="/automation">前往自动化页面</a>
                <button type="submit" class="btn" :disabled="vpnTests.attaching || vpnTests.recording || Boolean(activeNodeTrial) || !eligibleRuns.length">
                  {{ vpnTests.attaching ? '绑定中…' : '绑定已有运行' }}
                </button>
              </div>
            </form>
          </details>

          <section class="aggregate-section" aria-labelledby="aggregate-title">
            <div class="subheading">
              <div>
                <p class="section-number">AGGREGATES</p>
                <h4 id="aggregate-title">按 VPN 节点汇总</h4>
              </div>
              <span>中位数降低单次波动影响</span>
            </div>
            <p v-if="!aggregatesOf(vpnTests.selectedExperiment).length" class="empty-state compact">绑定运行后，这里会按节点汇总完成率与 Runner 遥测。</p>
            <div v-else class="table-wrap">
              <table class="metric-table">
                <thead>
                  <tr>
                    <th scope="col">节点</th>
                    <th scope="col">完成</th>
                    <th scope="col">成功率</th>
                    <th scope="col">点击 → 首响应</th>
                    <th scope="col">完整耗时</th>
                    <th scope="col">预热耗时</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="aggregate in aggregatesOf(vpnTests.selectedExperiment)" :key="aggregate.nodeLabel">
                    <th scope="row">{{ aggregate.nodeLabel }}</th>
                    <td>{{ aggregate.completed }} / {{ aggregate.total }}</td>
                    <td>{{ formatRate(aggregate.successRate) }}</td>
                    <td>{{ formatMs(aggregate.medianClickToFirstResponseMs) }}</td>
                    <td>{{ formatMs(aggregate.medianTotalMs) }}</td>
                    <td>{{ formatMs(aggregate.medianPrewarmMs) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="telemetry-note">“预热耗时”来自发送前同源网络预热 telemetry；“点击 → 首响应”和“完整耗时”来自实际 Redo。它们衡量浏览器到服务端的可观察时间，不宣称能读取隐藏 CoT。</p>
          </section>

          <section class="trial-section" aria-labelledby="trials-title">
            <div class="subheading">
              <div>
                <p class="section-number">TRIALS</p>
                <h4 id="trials-title">已绑定运行</h4>
              </div>
              <span>{{ trialsOf(vpnTests.selectedExperiment).length }} 条</span>
            </div>
            <p v-if="vpnTests.loadingDetail && !trialsOf(vpnTests.selectedExperiment).length" class="empty-state compact">正在读取 trial…</p>
            <p v-else-if="!trialsOf(vpnTests.selectedExperiment).length" class="empty-state compact">尚未记录任何 VPN 节点。</p>
            <ol v-else class="trial-list">
              <li v-for="trial in trialsOf(vpnTests.selectedExperiment)" :key="trial.id">
                <div>
                  <strong>{{ trial.nodeLabel }}</strong>
                  <code>{{ trial.runId }}</code>
                  <span>绑定于 {{ formatDate(trial.attachedAt, true) }}</span>
                </div>
                <span class="run-status" :class="`tone-${runStatus(runForTrial(trial)).tone}`">
                  {{ runForTrial(trial) ? runStatus(runForTrial(trial)).label : '读取中' }}
                </span>
              </li>
            </ol>
          </section>
        </article>

        <div v-else class="experiment-detail empty-detail">
          <p>从左侧选择一个实验，切换 VPN 后记录当前节点。</p>
        </div>
      </div>
    </section>

    <p class="sr-only" aria-live="polite">{{ toast }}</p>
    <transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></transition>
  </div>
</template>

<style scoped>
.vpn-page {
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 4px 0 56px;
  color: var(--text);
}

.page-header,
.section-heading,
.records-heading,
.detail-header,
.record-node-heading,
.subheading,
.form-actions,
.attach-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.page-header {
  align-items: flex-end;
  padding-bottom: 20px;
  margin-bottom: 18px;
  border-bottom: 3px double var(--rule);
}

.page-header h1 {
  margin: 2px 0 4px;
  font-family: var(--font-reading);
  font-size: clamp(25px, 4vw, 36px);
  line-height: 1.25;
}

.page-intro { max-width: 760px; color: var(--text-soft); font-size: 13px; line-height: 1.65; }
.kicker,
.section-number { color: var(--hot); font-size: 10px; font-weight: 700; letter-spacing: 0.18em; }
.panel { padding-top: 14px; border-top: 3px double var(--rule); }
.section-heading { align-items: flex-start; margin-bottom: 15px; }
.section-heading h2,
.records-heading h2 { margin-top: 2px; font-family: var(--font-reading); font-size: 20px; }

.notice,
.method-note { padding: 11px 14px; margin-bottom: 16px; border: 1px solid var(--rule); font-size: 12px; }
.notice { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.notice-error { border-color: var(--hot); color: var(--hot); background: color-mix(in srgb, var(--hot) 5%, transparent); }
.text-button { border: 0; padding: 0; background: transparent; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
.method-note { display: grid; grid-template-columns: 120px 1fr; gap: 18px; border-color: var(--border); background: color-mix(in srgb, var(--accent) 4%, transparent); }
.method-note h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
.method-note p { color: var(--text-soft); line-height: 1.65; }
.method-note code,
.advanced-attach code { color: var(--hot); font-family: ui-monospace, monospace; }

.create-section { margin-top: 26px; }
.create-form { display: grid; grid-template-columns: minmax(220px, .7fr) minmax(0, 1.5fr); gap: 0 14px; }
.create-form .form-actions,
.create-form .field-error { grid-column: 1 / -1; }
.field { display: block; margin-bottom: 15px; }
.field > span { display: block; margin-bottom: 5px; color: var(--text-soft); font-size: 11px; font-weight: 600; letter-spacing: .06em; }
.field input { width: 100%; min-height: 36px; padding: 7px 9px; border: 1px solid var(--rule); border-radius: 0; background: var(--bg-card); color: var(--text); font: 13px/1.5 var(--font-ui); outline: none; }
.field input:focus { border-color: var(--hot); box-shadow: inset 3px 0 0 var(--hot); }
.field small { display: block; margin-top: 5px; color: var(--text-muted); font-size: 10px; line-height: 1.55; }
.field small code { color: var(--hot); }
.field-error { margin: 0 0 12px; color: var(--hot); font-size: 11px; }
.form-actions { padding-top: 12px; border-top: 1px solid var(--border); }
.form-actions p { color: var(--text-muted); font-size: 10px; }

.btn { min-height: 33px; padding: 6px 11px; border: 1px solid var(--rule); border-radius: 0; background: transparent; color: var(--text); font: 11px/1.2 var(--font-ui); cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--text); background: color-mix(in srgb, var(--text) 5%, transparent); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-primary { border-color: var(--hot); background: var(--hot); color: var(--bg); }
.btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--hot) 88%, var(--text)); }
.btn-small { min-height: 29px; padding: 5px 9px; }

.records-section { margin-top: 42px; padding-top: 14px; border-top: 3px double var(--rule); }
.records-heading { align-items: flex-end; margin-bottom: 14px; }
.count-badge,
.trial-badge { padding: 3px 7px; border: 1px solid var(--border); color: var(--text-muted); font-size: 10px; }
.records-layout { display: grid; grid-template-columns: minmax(245px, .62fr) minmax(0, 1.6fr); min-height: 520px; border: 1px solid var(--rule); }
.experiment-list { min-width: 0; border-right: 1px solid var(--rule); background: var(--bg-sidebar); }
.experiment-item { display: block; width: 100%; padding: 12px; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--text); font-family: var(--font-ui); text-align: left; cursor: pointer; }
.experiment-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.experiment-item.selected { background: var(--bg-card); box-shadow: inset 3px 0 0 var(--hot); }
.experiment-item:focus-visible { outline: 2px solid var(--hot); outline-offset: -2px; }
.experiment-item strong { display: block; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.experiment-item span { display: block; margin-top: 4px; color: var(--text-muted); font-size: 9px; }

.experiment-detail { min-width: 0; padding: 20px; background: var(--bg); }
.empty-detail { display: grid; place-items: center; color: var(--text-muted); font-size: 12px; }
.detail-header { align-items: flex-start; padding-bottom: 16px; border-bottom: 1px solid var(--rule); }
.detail-label { color: var(--text-muted); font-size: 9px; letter-spacing: .08em; }
.detail-header h3 { margin-top: 4px; font-family: var(--font-reading); font-size: 20px; }
.detail-header a { display: block; max-width: 700px; margin-top: 5px; overflow-wrap: anywhere; color: var(--accent); font-size: 10px; }

.record-node { margin-top: 20px; padding: 14px; border: 1px solid var(--rule); background: var(--bg-card); }
.record-node-heading { align-items: flex-end; padding-bottom: 9px; border-bottom: 1px solid var(--border); }
.record-node-heading h4,
.subheading h4 { margin-top: 2px; font-size: 13px; letter-spacing: .03em; }
.switch-warning { color: var(--hot); font-size: 11px; }
.record-explainer { margin: 10px 0 13px; color: var(--text-soft); font-size: 10px; line-height: 1.65; }
.active-node-lock { margin: 0 0 13px; padding: 10px 11px; border: 1px solid color-mix(in srgb, var(--hot) 52%, var(--border)); background: color-mix(in srgb, var(--hot) 7%, transparent); }
.active-node-lock strong { color: var(--hot); font-size: 11px; }
.active-node-lock p { margin-top: 4px; color: var(--text-soft); font-size: 10px; line-height: 1.55; overflow-wrap: anywhere; }
.node-form-grid { display: grid; grid-template-columns: minmax(170px, 1.4fr) repeat(3, minmax(105px, .7fr)); gap: 10px; }
.node-form-grid .field { margin-bottom: 11px; }
.recording-status { display: flex; align-items: flex-start; gap: 8px; margin: 2px 0 12px; padding: 9px 10px; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 5%, transparent); color: var(--text-soft); font-size: 11px; }
.recording-status.active { border-left-color: var(--hot); }
.status-dot { flex: 0 0 auto; width: 7px; height: 7px; margin-top: 4px; background: var(--accent); }
.recording-status.active .status-dot { background: var(--hot); animation: pulse 1.2s ease-in-out infinite; }
.recording-status small { display: block; margin-top: 2px; color: var(--text-muted); font-size: 9px; overflow-wrap: anywhere; }
@keyframes pulse { 50% { opacity: .3; } }

.advanced-attach { margin-top: 15px; padding: 12px; border: 1px solid var(--border); }
.advanced-attach summary { font-size: 11px; font-weight: 600; cursor: pointer; }
.advanced-attach > p { margin: 9px 0 12px; color: var(--text-muted); font-size: 10px; line-height: 1.6; }
.advanced-attach a,
.text-link { color: var(--accent); }
.attach-grid { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(0, 1.3fr); gap: 12px; }
.attach-grid .field { margin-bottom: 8px; }
.attach-actions { justify-content: flex-end; padding-top: 9px; border-top: 1px solid var(--border); font-size: 10px; }

.aggregate-section,
.trial-section { margin-top: 24px; }
.subheading { align-items: flex-end; margin-bottom: 9px; }
.subheading > span { color: var(--text-muted); font-size: 9px; }
.table-wrap { max-width: 100%; overflow-x: auto; border-top: 1px solid var(--rule); }
.metric-table { width: 100%; min-width: 660px; border-collapse: collapse; font-size: 10px; font-variant-numeric: tabular-nums; }
.metric-table th,
.metric-table td { padding: 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.metric-table thead th { color: var(--text-muted); font-size: 9px; font-weight: 600; }
.metric-table tbody th { font-weight: 600; }
.telemetry-note { margin-top: 9px; padding-left: 10px; border-left: 2px solid var(--accent); color: var(--text-muted); font-size: 9px; line-height: 1.6; }
.trial-list { list-style: none; border-top: 1px solid var(--rule); }
.trial-list li { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.trial-list strong,
.trial-list code,
.trial-list div > span { display: block; }
.trial-list strong { font-size: 11px; }
.trial-list code { margin-top: 3px; overflow-wrap: anywhere; color: var(--text-soft); font-size: 9px; }
.trial-list div > span { margin-top: 3px; color: var(--text-muted); font-size: 9px; }
.run-status { flex: 0 0 auto; padding: 2px 6px; border: 1px solid currentColor; color: var(--text-muted); font-size: 9px; }
.tone-queued,
.tone-complete { color: var(--accent); }
.tone-running,
.tone-danger { color: var(--hot); }
.tone-paused { color: var(--text-soft); }
.empty-state { padding: 32px 16px; color: var(--text-muted); font-size: 11px; line-height: 1.6; text-align: center; }
.empty-state.compact { padding: 18px 0; text-align: left; }

.toast { position: fixed; z-index: 300; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 8px 16px; border: 1px solid var(--rule); background: var(--text); color: var(--bg); font-size: 11px; }
.toast-enter-active,
.toast-leave-active { transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translate(-50%, 6px); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 980px) {
  .node-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .node-label-field { grid-column: 1 / -1; }
}

@media (max-width: 760px) {
  :global(.ed-main.main-content:has(.vpn-page)) { padding: 22px 16px; }
  .vpn-page { padding-bottom: 32px; }
  .page-header { align-items: flex-start; flex-direction: column; }
  .method-note { grid-template-columns: 1fr; gap: 4px; }
  .create-form,
  .attach-grid { grid-template-columns: 1fr; }
  .create-form .form-actions,
  .create-form .field-error { grid-column: auto; }
  .records-layout { display: block; }
  .experiment-list { max-height: 300px; overflow-y: auto; border-right: 0; border-bottom: 1px solid var(--rule); }
  .experiment-detail { padding: 15px; }
  .node-form-grid { grid-template-columns: 1fr; }
  .node-label-field { grid-column: auto; }
  .form-actions { align-items: flex-start; flex-direction: column; }
  .form-actions .btn { width: 100%; }
}
</style>
