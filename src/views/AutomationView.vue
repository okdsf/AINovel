<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useAutomationStore } from '../stores/automation'

const automation = useAutomationStore()

const form = reactive({
  title: '',
  runKind: 'workflow',
  actionBranch: 'redo_only',
  workflowInput: '',
  targetTurnKey: '',
  redoCount: 3,
  mode: 'same_thread',
  promptText: '',
  variants: 1,
  conversationUrl: '',
  repeatCount: 3,
  redoOption: 'try_again',
  requiredModel: 'Pro Extended',
  minDelaySeconds: 10,
  maxRetries: 1,
})

const formError = ref('')
const toast = ref('')
const showToken = ref(false)
const refreshing = ref(false)
const historyOpen = ref(false)
let pollTimer = null
let toastTimer = null

const parsedPrompts = computed(() => form.promptText
  .split(/^\s*---\s*$/m)
  .map(prompt => prompt.trim())
  .filter(Boolean))

const normalizedConversationUrl = computed(() => specificConversationUrl(form.conversationUrl))
const workflowSnapshot = computed(() => automation.snapshot || null)
const snapshotTurns = computed(() => snapshotTurnList(workflowSnapshot.value))
const editableTurns = computed(() => snapshotTurns.value.filter(turn => turnEditable(turn)))
const sourceUserTurn = computed(() => (
  snapshotTurns.value
    .filter(turn => ['user', 'human', 'prompt'].includes(turnRole(turn)) && turnHasProof(turn))
    .at(-1) || null
))
const selectedTargetTurn = computed(() => (
  editableTurns.value.find(turn => turnIdentity(turn) === form.targetTurnKey) || null
))
const snapshotMatchesUrl = computed(() => {
  if (!workflowSnapshot.value || !normalizedConversationUrl.value) return false
  const capturedUrl = specificConversationUrl(
    workflowSnapshot.value.conversationUrl
    || workflowSnapshot.value.url
    || workflowSnapshot.value.targetUrl
    || normalizedConversationUrl.value,
  )
  return capturedUrl === normalizedConversationUrl.value
})
const selectedProjection = computed(() => (
  automation.selectedRunId ? automation.projections[automation.selectedRunId] || null : null
))
const projectionResults = computed(() => projectionResultList(selectedProjection.value))

const draftTaskCount = computed(() => (
  form.runKind === 'workflow'
    ? (form.actionBranch === 'redo_only' ? 0 : 1) + Math.min(100, Math.max(0, Number(form.redoCount) || 0))
    : form.runKind === 'redo'
    ? Math.min(100, Math.max(1, Number(form.repeatCount) || 1))
    : parsedPrompts.value.length * Math.max(1, Number(form.variants) || 1)
))

const canSubmitDraft = computed(() => (
  form.runKind === 'workflow'
      ? Boolean(
        normalizedConversationUrl.value
        && form.requiredModel.trim()
        && (form.actionBranch === 'redo_only'
          ? Number(form.redoCount) >= 1
          : form.workflowInput.trim()
            ),
      )
    : form.runKind === 'redo'
    ? Boolean(normalizedConversationUrl.value)
    : parsedPrompts.value.length > 0
))

const worker = computed(() => automation.status?.worker || {})
const pairing = computed(() => automation.status?.pairing || {})
const storageDir = computed(() => automation.status?.storageDir || '')

const workerConnected = computed(() => {
  if (typeof worker.value.connected === 'boolean') return worker.value.connected
  const lastSeen = Date.parse(worker.value.lastSeenAt || worker.value.updatedAt || 0)
  return Number.isFinite(lastSeen) && Date.now() - lastSeen < 45_000
})

const workerPage = computed(() => (
  worker.value.pageUrl
  || worker.value.currentUrl
  || worker.value.lastPage
  || '尚未报告'
))

const workerModel = computed(() => (
  worker.value.currentModel
  || worker.value.model
  || worker.value.mode
  || '尚未识别'
))

const workerConversationUrl = computed(() => {
  return specificConversationUrl(workerPage.value)
})

const selectedTasks = computed(() => automation.selectedRun?.tasks || [])

const STATUS_META = {
  draft: { label: '草稿', tone: 'muted' },
  pending: { label: '待执行', tone: 'muted' },
  queued: { label: '等待执行', tone: 'queued' },
  leased: { label: '准备发送', tone: 'queued' },
  submitted: { label: '生成中', tone: 'running' },
  running: { label: '执行中', tone: 'running' },
  retry_wait: { label: '等待重试', tone: 'queued' },
  paused: { label: '已暂停', tone: 'paused' },
  blocked: { label: '被阻止', tone: 'danger' },
  cancelling: { label: '正在取消', tone: 'muted' },
  completed: { label: '已完成', tone: 'complete' },
  cancelled: { label: '已取消', tone: 'muted' },
  canceled: { label: '已取消', tone: 'muted' },
  failed: { label: '失败', tone: 'danger' },
  needs_attention: { label: '等待处理', tone: 'danger' },
  uncertain: { label: '状态待确认', tone: 'danger' },
}

function statusKey(runOrTask) {
  return String(runOrTask?.status || runOrTask?.state || 'draft')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function statusMeta(runOrTask) {
  const key = statusKey(runOrTask)
  return STATUS_META[key] || { label: key, tone: 'muted' }
}

function taskCounts(run) {
  const tasks = run?.tasks || []
  const total = Number(
    run?.progress?.total
    ?? run?.stats?.total
    ?? run?.totalTasks
    ?? run?.taskCount
    ?? tasks.length
    ?? 0,
  )
  const completed = Number(
    run?.progress?.completed
    ?? run?.stats?.completed
    ?? run?.completedTasks
    ?? run?.counts?.completed
    ?? tasks.filter(task => statusKey(task) === 'completed').length,
  )
  return {
    total: Number.isFinite(total) ? total : 0,
    completed: Number.isFinite(completed) ? completed : 0,
  }
}

function progressPercent(run) {
  const counts = taskCounts(run)
  if (!counts.total) return 0
  return Math.min(100, Math.round((counts.completed / counts.total) * 100))
}

function currentTask(run) {
  if (run?.currentTask) return run.currentTask
  return (run?.tasks || []).find(task => ['leased', 'submitted', 'running'].includes(statusKey(task))) || null
}

function taskPrompt(task) {
  return task?.prompt || task?.input || task?.promptText || ''
}

function isRedoRun(run) {
  return String(run?.runKind || run?.kind || '').toLowerCase() === 'redo'
}

function isWorkflowRun(run) {
  return String(run?.runKind || run?.kind || '').toLowerCase() === 'workflow'
}

function redoOptionLabel(value) {
  return {
    try_again: 'Try again',
    longer: 'Longer',
    shorter: 'Shorter',
  }[value] || 'Try again'
}

function runKindLabel(run) {
  if (isWorkflowRun(run)) {
    const labels = {
      redo_only: '只重复生成',
      send_then_redo: '发送后重复生成',
      edit_then_redo: '编辑历史轮次后重复生成',
    }
    return `${labels[run?.actionBranch] || '对话工作流'} · ${Number(run?.redoCount || 0)} 次 Redo · ${redoOptionLabel(run?.redoOption)}`
  }
  if (isRedoRun(run)) return `重复生成已有回答 · ${Number(run?.repeatCount || taskCounts(run).total || 1)} 次 · ${redoOptionLabel(run?.redoOption)}`
  return run?.mode === 'new_thread_each' ? '每条新聊天' : '同一聊天多轮'
}

function cleanModelLabel(value) {
  return String(value || '')
    .replace(/^open mode picker,\s*currently\s*/i, '')
    .replace(/^打开模式选择器[，,]?\s*当前模式为?[“"]?/i, '')
    .replace(/[”"]$/, '')
    .trim()
}

function runTaskPrompt(run, task) {
  const direct = taskPrompt(task)
  if (direct) return direct
  const promptIndex = Number(task?.promptIndex)
  if (Number.isInteger(promptIndex) && promptIndex > 0) return run?.prompts?.[promptIndex - 1] || ''
  return ''
}

function runFailure(run) {
  const failedTask = (run?.tasks || []).find(task => ['failed', 'needs_attention', 'uncertain'].includes(statusKey(task)))
  return run?.failureReason
    || run?.lastError?.message
    || run?.lastError
    || run?.error?.message
    || run?.error
    || failedTask?.error?.message
    || failedTask?.error
    || ''
}

function friendlyRunFailure(run) {
  const failure = String(runFailure(run) || '')
  if (/已打开的编辑框无法安全恢复|找不到唯一的取消按钮/.test(failure)) {
    return 'Gemini 页面还停在上一次编辑界面；这次没有发送或修改内容。请先在 Gemini 页面点“取消编辑”，再重新开始。'
  }
  const mismatch = failure.match(/当前模式[“"](.+?)[”"]不符合任务要求[“"](.+?)[”"]/) 
  if (!mismatch) return failure

  const actual = cleanModelLabel(mismatch[1])
  const required = cleanModelLabel(mismatch[2])
  return `Gemini 当前使用“${actual}”，但这份任务要求“${required}”。这是任务设置不一致，不是扩展掉线。请先把 Gemini 切换到“${required}”再点“重试”；如果任务要求填错了，请取消旧任务，并在上方选择正确模式后新建。扩展不会自动切换模型，以免误用额度。`
}

function safeConversationUrl(value) {
  try {
    const url = new URL(String(value || ''))
    const validPath = /^\/app\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      || /^\/gem\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    return url.protocol === 'https:' && url.hostname === 'gemini.google.com' && validPath
      ? url.href
      : ''
  } catch {
    return ''
  }
}

function specificConversationUrl(value) {
  const safeUrl = safeConversationUrl(value)
  if (!safeUrl) return ''
  try {
    const url = new URL(safeUrl)
    if (!(/^\/app\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      || /^\/gem\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))) return ''
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return ''
  }
}

function snapshotTurnList(snapshot) {
  const turns = snapshot?.turns || snapshot?.messages || snapshot?.conversation?.turns || []
  return Array.isArray(turns) ? turns : []
}

function turnText(turn) {
  return String(turn?.text ?? turn?.content ?? turn?.input ?? turn?.response ?? '')
}

function turnRole(turn) {
  return String(turn?.role ?? turn?.author ?? turn?.speaker ?? '').toLowerCase()
}

function turnIdentity(turn) {
  return String(turn?.turnKey ?? turn?.key ?? turn?.id ?? '')
}

function turnOrdinal(turn, fallback = 0) {
  const value = Number(turn?.ordinal ?? turn?.index ?? fallback)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function turnSha(turn) {
  return String(turn?.sourceTextSha256 ?? turn?.textSha256 ?? turn?.sha256 ?? '')
}

function turnTextLength(turn) {
  const value = Number(turn?.sourceTextLength ?? turn?.textLength ?? turnText(turn).length)
  return Number.isInteger(value) && value >= 0 ? value : turnText(turn).length
}

function turnEditable(turn) {
  const role = turnRole(turn)
  return Boolean(
    turn?.editable !== false
    && ['user', 'human', 'prompt'].includes(role)
    && turnHasProof(turn),
  )
}

function turnHasProof(turn) {
  return Boolean(
    turnIdentity(turn)
    && Number.isInteger(turnOrdinal(turn, -1))
    && turnOrdinal(turn, -1) >= 0
    && /^[a-f0-9]{64}$/.test(turnSha(turn))
    && Number.isInteger(turnTextLength(turn)),
  )
}

function sourceTurnPayload(turn) {
  if (!turn || !turnHasProof(turn)) return null
  return {
    turnKey: turnIdentity(turn),
    ordinal: turnOrdinal(turn),
    sourceTextSha256: turnSha(turn),
    sourceTextLength: turnTextLength(turn),
  }
}

function targetTurnPayload(turn) {
  if (!turn || !turnEditable(turn)) return null
  return sourceTurnPayload(turn)
}

function turnPreview(turn, limit = 90) {
  const text = turnText(turn).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : (text || '（空文本）')
}

function shortSha(value) {
  const sha = String(value || '')
  return sha ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : '—'
}

function projectionResultList(projection) {
  const source = projection?.results ?? projection?.responses ?? projection?.slots ?? []
  const values = Array.isArray(source)
    ? source
    : Object.entries(source || {})
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([slot, value]) => (typeof value === 'string' ? { slot: Number(slot), response: value } : value))
  return values.map((item, index) => (
    typeof item === 'string'
      ? { resultOrdinal: index, response: item }
      : { ...item, resultOrdinal: item?.resultOrdinal ?? item?.ordinal ?? index }
  ))
}

function resultText(result) {
  return String(result?.response ?? result?.content ?? result?.text ?? '')
}

function resultSha(result) {
  return String(result?.responseSha256 ?? result?.sha256 ?? result?.textSha256 ?? '')
}

function resultThinking(result) {
  const value = result?.visibleThinkingLog
    ?? result?.visibleThinking
    ?? result?.thinkingLog
    ?? result?.thoughts
    ?? result?.visibleThinkingSummary
    ?? []
  if (Array.isArray(value)) {
    return value.map(item => typeof item === 'string' ? item : String(item?.text ?? item?.content ?? '')).filter(Boolean)
  }
  if (value && typeof value === 'object') {
    const text = String(value.text ?? value.content ?? '')
    return text.trim() ? [text] : []
  }
  return String(value || '').trim() ? [String(value)] : []
}

function finiteMilliseconds(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function formatMilliseconds(value) {
  const milliseconds = finiteMilliseconds(value)
  if (milliseconds == null) return '—'
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
}

function resultTelemetry(result) {
  return result?.telemetry && typeof result.telemetry === 'object' ? result.telemetry : {}
}

function resultTiming(result) {
  return result?.timing && typeof result.timing === 'object' ? result.timing : {}
}

function prewarmHandshakeMs(prewarm) {
  // Resource Timing's connect duration already includes TLS, so do not add
  // tlsMs again. This is only the measurable connection work moved before the
  // send click—not a claim about Google's internal receive timestamp.
  const dns = finiteMilliseconds(prewarm?.dnsMs)
  const connect = finiteMilliseconds(prewarm?.connectMs)
  if (dns == null && connect == null) return null
  return (dns || 0) + (connect || 0)
}

function executionMetrics(result) {
  const telemetry = resultTelemetry(result)
  const timing = resultTiming(result)
  const prewarm = telemetry.prewarm && typeof telemetry.prewarm === 'object'
    ? telemetry.prewarm
    : null
  const acceptance = telemetry.submissionAcceptance && typeof telemetry.submissionAcceptance === 'object'
    ? telemetry.submissionAcceptance
    : null
  const legacyAcceptance = telemetry.submissionEvidence && typeof telemetry.submissionEvidence === 'object'
    ? telemetry.submissionEvidence
    : null
  const rows = []

  if (prewarm?.attempted === true) {
    rows.push({ label: '预热请求', value: formatMilliseconds(prewarm.durationMs), detail: prewarm.ok === false ? '未成功' : '完成' })
    const handshake = prewarmHandshakeMs(prewarm)
    if (handshake != null) {
      rows.push({ label: '可测连接工作前移', value: `≤ ${formatMilliseconds(handshake)}`, detail: 'DNS + 建连（TLS 已含于建连）' })
    }
  } else if (prewarm?.reason === 'recent-same-origin-traffic') {
    rows.push({ label: '预热状态', value: '复用近期同源连接', detail: '没有独立预热请求可计时' })
  } else if (prewarm?.reason === 'disabled-by-setting') {
    rows.push({ label: '预热状态', value: '已关闭', detail: '' })
  }

  const handoffMs = finiteMilliseconds(acceptance?.afterClickMs ?? legacyAcceptance?.afterClickMs)
  if (handoffMs != null) {
    rows.push({ label: '发送 → 网页确认', value: formatMilliseconds(handoffMs), detail: 'Gemini 页面首个可见接收信号' })
  }

  const firstResponseMs = finiteMilliseconds(timing.clickToFirstResponseMs)
  if (firstResponseMs != null) {
    rows.push({ label: '发送 → 首字可见', value: formatMilliseconds(firstResponseMs), detail: '回答正文首次变化' })
  } else if (timing.firstResponseTimingQuality === 'unobserved') {
    rows.push({ label: '发送 → 首字可见', value: '未观测', detail: '本轮页面不能安全归因首字' })
  }

  const totalMs = finiteMilliseconds(timing.totalMs ?? telemetry.clickToCompletionMs)
  if (totalMs != null) rows.push({ label: '发送 → 完成', value: formatMilliseconds(totalMs), detail: '' })

  return rows.length ? rows : null
}

function resultLabel(result, index) {
  if (result?.resultRole === 'initial' || Number(result?.resultOrdinal) === 0) return 'Initial · 首次回答'
  const ordinal = Number(result?.resultOrdinal ?? result?.redoIndex ?? index)
  return `R${Number.isFinite(ordinal) ? ordinal : index + 1} · Redo`
}

async function readConversationSnapshot() {
  formError.value = ''
  const conversationUrl = normalizedConversationUrl.value
  if (!conversationUrl) {
    formError.value = '请粘贴带对话 ID 的精确 Gemini 链接，再读取快照。'
    return
  }
  try {
    const snapshot = await automation.fetchSnapshot(conversationUrl)
    const turns = snapshotTurnList(snapshot)
    const candidates = turns.filter(turnEditable)
    form.targetTurnKey = candidates.length ? turnIdentity(candidates.at(-1)) : ''
    if (!snapshotMatchesUrl.value) {
      automation.clearSnapshot()
      throw new Error('服务端返回的快照不属于当前精确链接；未允许创建任务。')
    }
    showToast(`已读取 ${turns.length} 个可见轮次；现在可以选择动作。`)
  } catch (cause) {
    formError.value = cause.message
  }
}

function displayTitle(run) {
  return run?.title || `未命名任务 · ${String(run?.id || '').slice(0, 8)}`
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function taskPosition(task, index) {
  if (task?.workflowStep === 'initial') return 'Initial · 首次回答'
  if (task?.workflowStep === 'redo' || task?.resultRole === 'redo') {
    return `R${Number(task?.resultOrdinal ?? task?.redoIndex ?? task?.repeatIndex ?? index + 1)} · Redo`
  }
  if (String(task?.runKind || task?.kind || task?.action || task?.conversationAction || '').toLowerCase() === 'redo' || task?.redoIndex != null || task?.repeatIndex != null) {
    return `第 ${Number(task?.redoIndex ?? task?.repeatIndex ?? task?.sequence ?? index + 1)} 次重新生成`
  }
  if (task?.variant != null || task?.promptIndex != null) {
    return `第 ${Number(task.variant ?? 1)} 组 · 第 ${Number(task.promptIndex ?? index + 1)} 轮`
  }
  const variant = task?.variant ?? task?.variantIndex
  const step = task?.step ?? task?.stepIndex
  if (variant != null || step != null) {
    return `第 ${Number(variant ?? 0) + 1} 组 · 第 ${Number(step ?? index) + 1} 轮`
  }
  return `第 ${index + 1} 轮`
}

function canStart(run) {
  return ['draft', 'pending'].includes(statusKey(run))
}

function canPause(run) {
  return ['queued', 'running'].includes(statusKey(run))
}

function pauseLabel(run) {
  return statusKey(currentTask(run)) === 'submitted' ? '本轮完成后暂停' : '暂停'
}

function canResume(run) {
  return statusKey(run) === 'paused'
}

function canRetry(run) {
  return ['failed', 'needs_attention', 'uncertain', 'blocked'].includes(statusKey(run))
}

function canCancel(run) {
  return !['completed', 'cancelled', 'canceled'].includes(statusKey(run))
}

function showToast(message) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 3000)
}

function useWorkerConversation() {
  if (!workerConversationUrl.value) return
  form.conversationUrl = workerConversationUrl.value
  formError.value = ''
  showToast('已填入专用浏览器当前打开的 Gemini 对话。')
}

watch(normalizedConversationUrl, (next, previous) => {
  if (next === previous) return
  const capturedUrl = specificConversationUrl(
    automation.snapshot?.conversationUrl
    || automation.snapshot?.url
    || automation.snapshot?.targetUrl
    || '',
  )
  if (!next || (capturedUrl && capturedUrl !== next)) automation.clearSnapshot()
  form.targetTurnKey = ''
})

watch(() => form.actionBranch, branch => {
  if (branch === 'redo_only' && Number(form.redoCount) < 1) form.redoCount = 1
  if (branch === 'edit_then_redo' && !form.targetTurnKey && editableTurns.value.length) {
    form.targetTurnKey = turnIdentity(editableTurns.value.at(-1))
  }
})

async function refresh({ silent = true } = {}) {
  if (refreshing.value) return
  refreshing.value = true
  automation.clearError()

  try {
    const selectedId = automation.selectedRunId
    const jobs = [
      automation.fetchRuns({ silent }),
      automation.fetchStatus({ silent }),
    ]
    if (selectedId) jobs.push(automation.fetchRun(selectedId, { silent: true }))
    if (selectedId && isWorkflowRun(automation.selectedRun)) {
      jobs.push(automation.fetchProjection(selectedId, { silent: true }).catch(() => null))
    }
    await Promise.allSettled(jobs)
  } finally {
    refreshing.value = false
  }
}

async function createDraft() {
  formError.value = ''
  const minDelaySeconds = Math.min(3600, Math.max(5, Number(form.minDelaySeconds) || 5))
  const maxRetries = Math.min(3, Math.max(0, Number(form.maxRetries) || 0))

  const payload = {
    runKind: form.runKind,
    title: form.title.trim() || `${form.runKind === 'workflow' ? 'Gemini 对话工作流' : (form.runKind === 'redo' ? 'Gemini 重复生成任务' : 'Gemini 写作任务')} ${new Date().toLocaleString('zh-CN')}`,
    requiredModel: form.requiredModel.trim(),
    minDelayMs: Math.round(minDelaySeconds * 1000),
    maxRetries,
  }

  if (form.runKind === 'workflow') {
    if (!normalizedConversationUrl.value) {
      formError.value = '请先粘贴带具体对话 ID 的 Gemini 链接。'
      return
    }
    const redoCount = Math.min(100, Math.max(form.actionBranch === 'redo_only' ? 1 : 0, Number(form.redoCount) || 0))
    // Pure Redo is the simple path: Gemini already has the last answer, so
    // do not read history or move the user's visible tab before clicking it.
    if (form.actionBranch === 'redo_only') {
      payload.runKind = 'redo'
      payload.conversationUrl = normalizedConversationUrl.value
      payload.repeatCount = redoCount
      payload.redoOption = form.redoOption
      delete payload.minDelayMs
      payload.minDelayMs = Math.round(minDelaySeconds * 1000)
    } else {
    // Only operations that touch an existing message need a conversation read.
    // A blank/new Gemini conversation can immediately receive a new prompt.
    if (!snapshotMatchesUrl.value) {
      const snapshot = await automation.fetchSnapshot(normalizedConversationUrl.value)
      const candidates = snapshotTurnList(snapshot).filter(turnEditable)
      form.targetTurnKey = candidates.length ? turnIdentity(candidates.at(-1)) : ''
    }
    payload.actionBranch = form.actionBranch
    payload.conversationUrl = normalizedConversationUrl.value
    payload.redoCount = redoCount
    payload.redoOption = form.redoOption
      if (!form.workflowInput.trim()) {
        formError.value = '发送或编辑工作流需要填写输入内容。'
        return
      }
      payload.prompt = form.workflowInput
    if (form.actionBranch === 'edit_then_redo') {
      const targetTurn = targetTurnPayload(selectedTargetTurn.value)
      if (!targetTurn) {
        formError.value = '请选择要改写的那条旧提问。'
        return
      }
      payload.targetTurn = targetTurn
    }
    }
  } else if (form.runKind === 'redo') {
    if (!normalizedConversationUrl.value) {
      formError.value = '请粘贴有效的 Gemini 对话链接，例如 https://gemini.google.com/app/abc123。'
      return
    }
    payload.conversationUrl = normalizedConversationUrl.value
    payload.repeatCount = Math.min(100, Math.max(1, Number(form.repeatCount) || 1))
    payload.redoOption = form.redoOption
  } else {
    const prompts = parsedPrompts.value
    if (!prompts.length) {
      formError.value = '请至少填写一条提示词。'
      return
    }
    if (form.conversationUrl && !normalizedConversationUrl.value) {
      formError.value = '请粘贴有效的 Gemini 对话链接，例如 /app/对话ID 或 /gem/GemID/对话ID。'
      return
    }
    if (form.conversationUrl && form.mode !== 'same_thread') {
      formError.value = '指定已有对话时，请选择“同一聊天，多轮推进”。'
      return
    }
    payload.mode = form.mode
    payload.prompts = prompts
    payload.variants = Math.min(20, Math.max(1, Number(form.variants) || 1))
    if (normalizedConversationUrl.value) payload.conversationUrl = normalizedConversationUrl.value
  }

  try {
    const run = await automation.createRun(payload)
    if (!run?.id) throw new Error('任务没有创建成功。')
    await automation.runAction(run.id, 'start')
    await automation.fetchRun(run.id, { silent: true }).catch(() => {})
    showToast('任务已保存并开始执行。')
  } catch (cause) {
    formError.value = cause.message
  }
}

async function act(run, action) {
  if (!run?.id) return
  if (action === 'cancel' && !window.confirm(`确定取消“${displayTitle(run)}”吗？已落盘的结果会保留；已经提交给 Gemini 的本轮仍可能完成并被保存。`)) return
  if (action === 'retry') {
    const uncertainTask = (run.tasks || []).find(task => ['uncertain', 'failed'].includes(statusKey(task)))
    const conversationUrl = safeConversationUrl(uncertainTask?.conversationUrl)
    const conversationHint = conversationUrl
      ? `\n\n请先打开这段 Gemini 对话检查：\n${conversationUrl}`
      : ''
    const warning = isRedoRun(run)
      ? '这一次可能已经点击过 Gemini 的“重复生成”。重试可能再生成一个版本并消耗额度。'
      : '这一步可能已经发送给 Gemini。直接重试可能重复消耗额度或生成重复内容。'
    const confirmed = window.confirm(`${warning}${conversationHint}\n\n只有在你确认需要重试时，才点击“确定”。`)
    if (!confirmed) return
  }
  try {
    await automation.runAction(run.id, action)
    await refresh({ silent: true })
    const labels = { start: '任务已开始', pause: '任务已暂停', resume: '任务已继续', cancel: '任务已取消', retry: '任务已重新排队' }
    showToast(labels[action] || '操作完成')
  } catch {
    // The store exposes the server error in the page-level error region.
  }
}

async function importSelectedRun() {
  const run = automation.selectedRun
  if (!run?.id) return
  formError.value = ''
  try {
    const imported = await automation.importRunToPromptLab(run)
    showToast(`已完整导入 ${imported.responseCount} 个回答到 PromptLab。`)
  } catch (cause) {
    formError.value = cause.message
  }
}

async function copyValue(value, label) {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    showToast(`${label}已复制`)
  } catch {
    showToast('复制失败，请手动选择文本。')
  }
}

function onVisibilityChange() {
  if (!document.hidden) refresh({ silent: true })
}

onMounted(async () => {
  await refresh({ silent: false })
  pollTimer = window.setInterval(() => refresh({ silent: true }), 2000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  window.clearInterval(pollTimer)
  clearTimeout(toastTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="automation-page">
    <header class="page-header">
      <div>
        <p class="kicker">LOCAL GEMINI RUNNER</p>
        <h1>Gemini 网页自动化</h1>
        <p class="page-intro">先用精确链接读取会话快照，再选择只 Redo、发送后 Redo，或编辑指定历史轮次后 Redo；每个结果连同 SHA 与页面可见思考记录都会落到本地。</p>
      </div>
      <div class="page-header-actions">
        <div class="worker-chip" :class="{ connected: workerConnected }" role="status">
          <span class="worker-dot" aria-hidden="true"></span>
          {{ workerConnected ? '扩展已连接' : '扩展未连接' }}
        </div>
        <button type="button" class="btn btn-sm" @click="historyOpen = true">任务历史</button>
      </div>
    </header>

    <div v-if="automation.error" class="notice notice-error" role="alert">
      <span>{{ automation.error }}</span>
      <button type="button" class="text-button" @click="automation.clearError">关闭</button>
    </div>

    <section class="safety-note" aria-labelledby="safety-title">
      <h2 id="safety-title">运行状态</h2>
      <p>专用 Gemini 浏览器已连接后，任务会按你选定的对话、操作和次数执行；每次结果自动保存到本地。</p>
    </section>

    <div class="top-grid">
      <section class="panel create-panel" aria-labelledby="create-title">
        <div class="section-heading">
          <div>
            <p class="section-number">01 / QUEUE</p>
            <h2 id="create-title">新建执行草稿</h2>
          </div>
          <span class="prompt-count">{{ form.runKind === 'workflow' ? `${draftTaskCount} 个结果` : (form.runKind === 'redo' ? `${draftTaskCount} 次重复` : `${parsedPrompts.length} 条提示`) }}</span>
        </div>

        <form @submit.prevent="createDraft">
          <label class="field">
            <span>任务标题</span>
            <input
              v-model="form.title"
              type="text"
              maxlength="160"
              :placeholder="form.runKind === 'redo' ? '例如：第三章结尾重复生成 10 版' : '例如：第三章多方案续写'"
            />
          </label>

          <fieldset class="mode-fieldset kind-fieldset">
            <legend>要让 Gemini 做什么</legend>
            <label class="mode-option" :class="{ selected: form.runKind === 'workflow' }">
              <input v-model="form.runKind" type="radio" value="workflow" />
              <span>
                <strong>精确对话工作流</strong>
                <small>读取目标会话快照，锁定轮次和 SHA，再选择发送、编辑或 Redo；这是推荐入口。</small>
              </span>
            </label>
            <label class="mode-option" :class="{ selected: form.runKind === 'redo' }">
              <input v-model="form.runKind" type="radio" value="redo" />
              <span>
                <strong>重复生成已有回答</strong>
                <small>打开指定对话，点击 Gemini 回答下方的“重复生成 / Redo”，逐个保存新版本；不会重复发送提示词。</small>
              </span>
            </label>
            <label class="mode-option" :class="{ selected: form.runKind === 'prompt' }">
              <input v-model="form.runKind" type="radio" value="prompt" />
              <span>
                <strong>发送新的提示词队列</strong>
                <small>按顺序把下方提示词发给 Gemini，适合自动推进多轮写作。</small>
              </span>
            </label>
          </fieldset>

          <template v-if="form.runKind === 'workflow'">
            <div class="field">
              <label class="field-label" for="workflow-conversation-url">Gemini 精确对话链接</label>
              <div class="url-entry-row snapshot-url-row">
                <input
                  id="workflow-conversation-url"
                  v-model.trim="form.conversationUrl"
                  type="url"
                  inputmode="url"
                  spellcheck="false"
                  placeholder="https://gemini.google.com/app/…… 或 /gem/……/……"
                />
                <button type="button" class="btn btn-use-current" :disabled="!workerConversationUrl" @click="useWorkerConversation">使用当前对话</button>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="automation.snapshotLoading || !normalizedConversationUrl"
                  @click="readConversationSnapshot"
                >{{ automation.snapshotLoading ? '读取中…' : '读取快照' }}</button>
              </div>
              <small>只接受带具体对话 ID 的规范 URL。链接发生变化后，旧快照立即失效，必须重新读取。</small>
              <small v-if="automation.snapshotLoading && automation.snapshotInspection" class="snapshot-progress" role="status">
                快照任务 {{ automation.snapshotInspection.id }} · {{ automation.snapshotInspection.status === 'leased' ? '扩展正在读取页面' : '等待扩展领取' }}
              </small>
              <small v-if="automation.snapshotError" class="inline-warning">{{ automation.snapshotError }}</small>
            </div>

            <section v-if="snapshotMatchesUrl" class="snapshot-card" aria-label="Gemini 会话快照">
              <header class="snapshot-head">
                <div>
                  <span class="detail-label">Snapshot / 只读证明</span>
                  <strong>{{ workflowSnapshot.title || '未命名 Gemini 对话' }}</strong>
                </div>
                <span class="snapshot-count">{{ snapshotTurns.length }} turns</span>
              </header>
              <dl class="snapshot-facts">
                <div><dt>捕获时间</dt><dd>{{ formatDate(workflowSnapshot.capturedAt || workflowSnapshot.createdAt) }}</dd></div>
                <div><dt>页面模式</dt><dd>{{ workflowSnapshot.modelLabel || workflowSnapshot.model || cleanModelLabel(workerModel) }}</dd></div>
                <div><dt>快照 SHA</dt><dd><code>{{ shortSha(workflowSnapshot.sha256 || workflowSnapshot.snapshotSha256) }}</code></dd></div>
              </dl>
              <ol class="snapshot-turns">
                <li v-for="(turn, index) in snapshotTurns" :key="turnIdentity(turn) || index" :class="{ editable: turnEditable(turn) }">
                  <span class="turn-index">{{ turnRole(turn) || 'turn' }} · {{ turnOrdinal(turn, index) }}</span>
                  <p>{{ turnPreview(turn, 150) }}</p>
                  <code>{{ shortSha(turnSha(turn)) }}</code>
                </li>
              </ol>
            </section>
            <div v-else class="snapshot-required">
              <strong>尚未读取已有内容</strong>
              <p>发送新内容可以直接开始；只有编辑旧提问或只 Redo 才需要读取这里的历史消息。</p>
            </div>

            <fieldset class="mode-fieldset branch-fieldset">
              <legend>动作分支</legend>
              <label class="mode-option" :class="{ selected: form.actionBranch === 'redo_only' }">
                <input v-model="form.actionBranch" type="radio" value="redo_only" />
                <span><strong>只 Redo</strong><small>不发送新文字；对当前最后一个可 Redo 的回答生成指定数量版本。</small></span>
              </label>
              <label class="mode-option" :class="{ selected: form.actionBranch === 'send_then_redo' }">
                <input v-model="form.actionBranch" type="radio" value="send_then_redo" />
                <span><strong>发送 → Redo</strong><small>先把下方输入发送到当前对话，保存首次回答，再对它逐次 Redo。</small></span>
              </label>
              <label class="mode-option" :class="{ selected: form.actionBranch === 'edit_then_redo' }">
                <input v-model="form.actionBranch" type="radio" value="edit_then_redo" />
                <span><strong>编辑历史轮次 → Redo</strong><small>用快照中的 turnKey 与 SHA 锁定某条用户输入，替换后保存首次回答，再逐次 Redo。</small></span>
              </label>
            </fieldset>

            <div v-if="form.actionBranch === 'redo_only'" class="source-turn-proof">
              <span class="detail-label">REDO</span>
              <p>直接对指定对话最后一条 Gemini 回答点击“重新生成”。不读取历史、不发送提示词、不切换当前页面。</p>
            </div>

            <label v-if="form.actionBranch === 'edit_then_redo'" class="field">
              <span>目标用户轮次</span>
              <select v-model="form.targetTurnKey" :disabled="!editableTurns.length">
                <option value="" disabled>{{ editableTurns.length ? '请选择要编辑的轮次' : '快照没有可安全编辑的用户轮次' }}</option>
                <option v-for="(turn, index) in editableTurns" :key="turnIdentity(turn)" :value="turnIdentity(turn)">
                  Turn {{ turnOrdinal(turn, index) }} · {{ turnPreview(turn) }} · {{ shortSha(turnSha(turn)) }}
                </option>
              </select>
              <small v-if="selectedTargetTurn">目标证明：<code>{{ turnIdentity(selectedTargetTurn) }}</code> · SHA <code>{{ shortSha(turnSha(selectedTargetTurn)) }}</code> · {{ turnTextLength(selectedTargetTurn) }} 字符</small>
            </label>

            <label v-if="form.actionBranch !== 'redo_only'" class="field prompt-field">
              <span>{{ form.actionBranch === 'edit_then_redo' ? '替换后的输入内容' : '要发送的输入内容' }}</span>
              <textarea
                v-model="form.workflowInput"
                rows="11"
                spellcheck="false"
                placeholder="完整粘贴小说输入；内容将先持久化，再由扩展发送。"
              ></textarea>
              <small>不会按 <code>---</code> 拆分；这里的全部文字是一次原子输入。</small>
            </label>
          </template>

          <template v-else-if="form.runKind === 'redo'">
            <div class="redo-explainer">
              <strong>它会点击按钮，不会再发送“你好”等提示。</strong>
              <p>每次等待新回答完整生成后就保存，再进行下一次。目标是这段对话中最末一个可以重复生成的 Gemini 回答。</p>
            </div>

            <div class="field">
              <label class="field-label" for="redo-conversation-url">Gemini 对话链接</label>
              <div class="url-entry-row">
                <input
                  id="redo-conversation-url"
                  v-model.trim="form.conversationUrl"
                  type="url"
                  inputmode="url"
                  spellcheck="false"
                  placeholder="https://gemini.google.com/app/…… 或 /gem/……/……"
                />
                <button
                  type="button"
                  class="btn btn-use-current"
                  :disabled="!workerConversationUrl"
                  @click="useWorkerConversation"
                >使用当前 Gemini 对话</button>
              </div>
              <small>在专用 Google Chrome for Testing 中打开目标对话，复制地址栏的完整链接并粘贴到这里。</small>
              <small v-if="!workerConversationUrl" class="inline-warning">专用浏览器目前没有报告具体对话链接；请先打开目标对话，或手动粘贴地址。</small>
            </div>
          </template>

          <template v-else>
            <fieldset class="mode-fieldset conversation-fieldset">
              <legend>对话方式</legend>
              <label class="mode-option" :class="{ selected: form.mode === 'same_thread' }">
                <input v-model="form.mode" type="radio" value="same_thread" />
                <span>
                  <strong>同一聊天，多轮推进</strong>
                  <small>每一组提示在同一 Gemini 对话中依次发送；下一组重新开聊。</small>
                </span>
              </label>
              <label class="mode-option" :class="{ selected: form.mode === 'new_thread_each' }">
                <input v-model="form.mode" type="radio" value="new_thread_each" />
                <span>
                  <strong>每条提示，新建聊天</strong>
                  <small>每一次请求彼此独立，适合并列生成多个版本。</small>
                </span>
              </label>
            </fieldset>

            <div v-if="form.mode === 'same_thread'" class="field">
              <label class="field-label" for="prompt-conversation-url">从已有 Gemini 对话继续（可选）</label>
              <div class="url-entry-row">
                <input
                  id="prompt-conversation-url"
                  v-model.trim="form.conversationUrl"
                  type="url"
                  inputmode="url"
                  spellcheck="false"
                  placeholder="https://gemini.google.com/app/…… 或 /gem/……/……"
                />
                <button
                  type="button"
                  class="btn btn-use-current"
                  :disabled="!workerConversationUrl"
                  @click="useWorkerConversation"
                >使用当前 Gemini 对话</button>
              </div>
              <small>留空会新建聊天；填写后，第一轮也会直接发送到这条已有对话。支持普通对话和自定义 Gem 对话。</small>
            </div>

            <label class="field prompt-field">
              <span>提示词序列</span>
              <textarea
                v-model="form.promptText"
                rows="11"
                spellcheck="false"
                placeholder="先阅读下方设定，列出三个续写方向……&#10;---&#10;选择最符合人物动机的方向，写出完整场景……"
              ></textarea>
              <small>用仅包含 <code>---</code> 的一行分隔各轮提示。提示词会在发送前先写入本地队列。</small>
            </label>
          </template>

          <div class="compact-grid">
            <label class="field">
              <span>{{ form.runKind === 'workflow' ? 'Redo 次数' : (form.runKind === 'redo' ? '重复生成次数' : '重复组数') }}</span>
              <input
                v-if="form.runKind === 'workflow'"
                v-model.number="form.redoCount"
                type="number"
                :min="form.actionBranch === 'redo_only' ? 1 : 0"
                max="100"
                inputmode="numeric"
              />
              <input
                v-else-if="form.runKind === 'redo'"
                v-model.number="form.repeatCount"
                type="number"
                min="1"
                max="100"
                inputmode="numeric"
              />
              <input v-else v-model.number="form.variants" type="number" min="1" max="20" inputmode="numeric" />
            </label>
            <label v-if="form.runKind === 'redo' || (form.runKind === 'workflow' && Number(form.redoCount) > 0)" class="field">
              <span>Redo 方式</span>
              <select id="redo-option" v-model="form.redoOption">
                <option value="try_again">Try again · 再生成一次</option>
                <option value="longer">Longer · 更长版本</option>
                <option value="shorter">Shorter · 更短版本</option>
              </select>
              <small>扩展只会在真实 Redo 菜单内点击这个精确选项。若该回答首次点击 Redo 后直接开始生成，Gemini 不会提供菜单；所选方式从菜单实际出现的轮次起生效。</small>
            </label>
            <label class="field">
              <span>每轮最小间隔（秒）</span>
              <input v-model.number="form.minDelaySeconds" type="number" min="5" max="3600" step="1" inputmode="numeric" />
            </label>
            <label class="field">
              <span>失败重试</span>
              <select v-model.number="form.maxRetries">
                <option :value="0">不自动重试</option>
                <option :value="1">最多 1 次</option>
                <option :value="2">最多 2 次</option>
                <option :value="3">最多 3 次</option>
              </select>
            </label>
          </div>

          <label class="field">
            <span>必需模型 / 模式文字</span>
            <input v-model="form.requiredModel" list="gemini-mode-suggestions" type="text" maxlength="120" placeholder="例如：Pro Extended" />
            <datalist id="gemini-mode-suggestions">
              <option value="Pro Extended"></option>
              <option value="Deep Think"></option>
            </datalist>
            <small>本任务将要求“{{ form.requiredModel || '不校验' }}”。专用浏览器当前报告“{{ cleanModelLabel(workerModel) }}”；两者不一致时任务会暂停，不会自动切换。</small>
          </label>

          <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
          <div class="form-actions">
            <p>预计{{ form.runKind === 'workflow' ? '结果' : (form.runKind === 'redo' ? '保存版本' : '任务') }}数：<strong>{{ draftTaskCount }}</strong></p>
            <button class="btn btn-primary" type="submit" :disabled="automation.submitting">
              {{ automation.submitting ? '正在开始…' : '保存并开始' }}
            </button>
          </div>
        </form>
      </section>

      <aside class="panel connection-panel" aria-labelledby="connection-title">
        <div class="section-heading">
          <div>
            <p class="section-number">02 / BRIDGE</p>
            <h2 id="connection-title">浏览器扩展</h2>
          </div>
        </div>

        <dl class="worker-facts">
          <div>
            <dt>连接</dt>
            <dd :class="workerConnected ? 'ok-text' : 'muted-text'">{{ workerConnected ? '在线' : '离线' }}</dd>
          </div>
          <div>
            <dt>最近心跳</dt>
            <dd>{{ formatDate(worker.lastSeenAt || worker.updatedAt) }}</dd>
          </div>
          <div>
            <dt>当前模式</dt>
            <dd>{{ workerModel }}</dd>
          </div>
          <div>
            <dt>最近页面</dt>
            <dd class="break-value">{{ workerPage }}</dd>
          </div>
        </dl>

        <div class="pair-block">
          <h3>扩展配对信息</h3>
          <label class="copy-field">
            <span>服务器地址</span>
            <span class="copy-row">
              <input :value="pairing.serverUrl || ''" readonly aria-label="扩展服务器地址" />
              <button type="button" class="btn btn-sm" :disabled="!pairing.serverUrl" @click="copyValue(pairing.serverUrl, '服务器地址')">复制</button>
            </span>
          </label>
          <label class="copy-field">
            <span>配对令牌</span>
            <span class="copy-row">
              <input :type="showToken ? 'text' : 'password'" :value="pairing.token || ''" readonly aria-label="扩展配对令牌" />
              <button type="button" class="btn btn-sm" :disabled="!pairing.token" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
              <button type="button" class="btn btn-sm" :disabled="!pairing.token" @click="copyValue(pairing.token, '配对令牌')">复制</button>
            </span>
          </label>
          <p class="pair-hint">令牌仅供本机扩展使用，请勿发送给他人。</p>
        </div>

        <div v-if="storageDir" class="storage-block">
          <span>本地保存目录</span>
          <code>{{ storageDir }}</code>
        </div>
      </aside>
    </div>

    <section v-if="automation.selectedRun" class="current-run-banner" role="status">
      <div>
        <span class="detail-label">当前任务</span>
        <strong>{{ displayTitle(automation.selectedRun) }}</strong>
        <p>
          {{ statusMeta(automation.selectedRun).label }} ·
          {{ taskCounts(automation.selectedRun).completed }} / {{ taskCounts(automation.selectedRun).total }} 已完成
          <template v-if="currentTask(automation.selectedRun)"> · 正在处理 {{ taskPosition(currentTask(automation.selectedRun), 0) }}</template>
        </p>
        <p v-if="runFailure(automation.selectedRun)" class="task-error">{{ friendlyRunFailure(automation.selectedRun) }}</p>
      </div>
      <button type="button" class="btn btn-sm" @click="historyOpen = true">查看详情</button>
    </section>

    <section class="runs-section" :class="{ open: historyOpen }" aria-labelledby="runs-title">
      <div class="runs-heading">
        <div>
          <p class="section-number">TASK HISTORY</p>
          <h2 id="runs-title">任务历史</h2>
        </div>
        <button type="button" class="btn btn-sm" :disabled="refreshing" @click="refresh({ silent: false })">
          {{ refreshing ? '刷新中…' : '立即刷新' }}
        </button>
        <button type="button" class="btn btn-sm" @click="historyOpen = false">关闭</button>
      </div>

      <div class="runs-layout">
        <nav class="run-list" aria-label="自动化任务列表">
          <p v-if="automation.loadingRuns && !automation.runs.length" class="empty-state">正在读取本地队列…</p>
          <p v-else-if="!automation.runs.length" class="empty-state">还没有任务。先在上方保存一份草稿。</p>
          <button
            v-for="run in automation.runs"
            v-else
            :key="run.id"
            type="button"
            class="run-item"
            :class="{ selected: automation.selectedRunId === run.id }"
            @click="automation.selectRun(run.id).catch(() => {})"
          >
            <span class="run-item-top">
              <strong>{{ displayTitle(run) }}</strong>
              <span class="status-label" :class="`tone-${statusMeta(run).tone}`">{{ statusMeta(run).label }}</span>
            </span>
            <span class="run-item-meta">
              {{ runKindLabel(run) }}
              · {{ formatDate(run.updatedAt || run.createdAt) }}
            </span>
            <span class="mini-progress" aria-hidden="true">
              <span :style="{ width: `${progressPercent(run)}%` }"></span>
            </span>
            <span class="run-count">{{ taskCounts(run).completed }} / {{ taskCounts(run).total }} 已完成</span>
          </button>
        </nav>

        <article v-if="automation.selectedRun" class="run-detail" aria-labelledby="detail-title">
          <header class="detail-header">
            <div>
              <span class="status-label" :class="`tone-${statusMeta(automation.selectedRun).tone}`">{{ statusMeta(automation.selectedRun).label }}</span>
              <h3 id="detail-title">{{ displayTitle(automation.selectedRun) }}</h3>
              <p v-if="isWorkflowRun(automation.selectedRun)">
                {{ runKindLabel(automation.selectedRun) }}
                <template v-if="automation.selectedRun.requiredModel"> · 校验“{{ automation.selectedRun.requiredModel }}”</template>
              </p>
              <p v-else-if="isRedoRun(automation.selectedRun)">
                对指定对话的现有回答点击“重新生成” · {{ automation.selectedRun.repeatCount || taskCounts(automation.selectedRun).total }} 次
                · 方式“{{ redoOptionLabel(automation.selectedRun.redoOption) }}”
                <template v-if="automation.selectedRun.requiredModel"> · 校验“{{ automation.selectedRun.requiredModel }}”</template>
              </p>
              <p v-else>
                {{ automation.selectedRun.mode === 'new_thread_each' ? '每条提示新建聊天' : '每组提示在同一聊天多轮推进' }}
                · {{ automation.selectedRun.variants || 1 }} 组
                <template v-if="automation.selectedRun.requiredModel"> · 校验“{{ automation.selectedRun.requiredModel }}”</template>
              </p>
              <a
                v-if="(isWorkflowRun(automation.selectedRun) || isRedoRun(automation.selectedRun)) && safeConversationUrl(automation.selectedRun.conversationUrl)"
                class="detail-conversation-link"
                :href="safeConversationUrl(automation.selectedRun.conversationUrl)"
                target="_blank"
                rel="noopener noreferrer"
              >打开目标 Gemini 对话</a>
            </div>
            <div class="detail-actions" aria-label="任务操作">
              <button v-if="canStart(automation.selectedRun)" type="button" class="btn btn-primary" :disabled="automation.actingId === automation.selectedRun.id" @click="act(automation.selectedRun, 'start')">开始</button>
              <button v-if="canPause(automation.selectedRun)" type="button" class="btn" :disabled="automation.actingId === automation.selectedRun.id" @click="act(automation.selectedRun, 'pause')">{{ pauseLabel(automation.selectedRun) }}</button>
              <button v-if="canResume(automation.selectedRun)" type="button" class="btn btn-primary" :disabled="automation.actingId === automation.selectedRun.id" @click="act(automation.selectedRun, 'resume')">继续</button>
              <button v-if="canRetry(automation.selectedRun)" type="button" class="btn" :disabled="automation.actingId === automation.selectedRun.id" @click="act(automation.selectedRun, 'retry')">重试</button>
              <button v-if="canCancel(automation.selectedRun)" type="button" class="btn btn-danger" :disabled="automation.actingId === automation.selectedRun.id" @click="act(automation.selectedRun, 'cancel')">取消</button>
              <button
                v-if="isWorkflowRun(automation.selectedRun) && projectionResults.length"
                type="button"
                class="btn"
                :disabled="automation.importingRunId === automation.selectedRun.id"
                @click="importSelectedRun"
              >{{ automation.importingRunId === automation.selectedRun.id ? `导入中 ${automation.importProgress?.done || 0}/${automation.importProgress?.total || 0}` : '完整导入 PromptLab' }}</button>
              <RouterLink
                v-if="automation.importedPromptGroups[automation.selectedRun.id]"
                class="btn"
                :to="{ path: '/drafts', query: { mode: 'promptlab', group: automation.importedPromptGroups[automation.selectedRun.id].id } }"
              >打开 PromptLab</RouterLink>
            </div>
          </header>

          <div class="large-progress">
            <div class="progress-copy">
              <span>整体进度</span>
              <strong>{{ taskCounts(automation.selectedRun).completed }} / {{ taskCounts(automation.selectedRun).total }}</strong>
            </div>
            <div
              class="progress-track"
              role="progressbar"
              aria-label="任务完成进度"
              :aria-valuenow="progressPercent(automation.selectedRun)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: `${progressPercent(automation.selectedRun)}%` }"></span>
            </div>
          </div>

          <div v-if="currentTask(automation.selectedRun)" class="current-task">
            <span class="detail-label">当前任务</span>
            <strong>{{ taskPosition(currentTask(automation.selectedRun), 0) }}</strong>
            <p v-if="isRedoRun(automation.selectedRun) || currentTask(automation.selectedRun)?.workflowStep === 'redo'">扩展正在点击“重新生成”<template v-if="currentTask(automation.selectedRun)?.redoOption || automation.selectedRun.redoOption"> → “{{ redoOptionLabel(currentTask(automation.selectedRun)?.redoOption || automation.selectedRun.redoOption) }}”</template>，并等待新回答完成后保存。</p>
            <p v-else>{{ runTaskPrompt(automation.selectedRun, currentTask(automation.selectedRun)) || '扩展正在处理当前步骤。' }}</p>
          </div>

          <div v-if="runFailure(automation.selectedRun)" class="failure-box" role="alert">
            <span class="detail-label">失败 / 暂停原因</span>
            <p>{{ friendlyRunFailure(automation.selectedRun) }}</p>
          </div>

          <section v-if="isWorkflowRun(automation.selectedRun)" class="result-group" aria-labelledby="result-group-title">
            <header class="result-group-head">
              <div>
                <span class="detail-label">RESULT GROUP / 本地投影</span>
                <h4 id="result-group-title">结果组与完整性证明</h4>
              </div>
              <button
                type="button"
                class="btn btn-sm"
                :disabled="automation.projectionLoadingId === automation.selectedRun.id"
                @click="automation.fetchProjection(automation.selectedRun.id).catch(() => {})"
              >{{ automation.projectionLoadingId === automation.selectedRun.id ? '读取中…' : '刷新结果组' }}</button>
            </header>
            <p v-if="automation.projectionError && !selectedProjection" class="task-error">{{ automation.projectionError }}</p>
            <p v-else-if="!projectionResults.length" class="empty-state compact">尚无已完成结果；首次回答和每次 Redo 完成后会按顺序出现在这里。</p>
            <ol v-else class="result-list">
              <li v-for="(result, index) in projectionResults" :key="result.id || result.taskId || `${index}-${resultSha(result)}`">
                <header>
                  <strong>{{ resultLabel(result, index) }}</strong>
                  <span>{{ resultText(result).length.toLocaleString() }} 字符</span>
                </header>
                <div class="sha-row">
                  <span>SHA-256</span>
                  <code :title="resultSha(result)">{{ shortSha(resultSha(result)) }}</code>
                  <button v-if="resultSha(result)" type="button" class="text-button" @click="copyValue(resultSha(result), 'SHA')">复制</button>
                </div>
                <section v-if="executionMetrics(result)" class="execution-metrics" aria-label="本轮连接与生成时序">
                  <header>
                    <span>CONNECTION TIMING / 浏览器可观测</span>
                    <span>非 Google 服务端内部计时</span>
                  </header>
                  <dl>
                    <div v-for="metric in executionMetrics(result)" :key="metric.label">
                      <dt>{{ metric.label }}</dt>
                      <dd>{{ metric.value }}</dd>
                      <small v-if="metric.detail">{{ metric.detail }}</small>
                    </div>
                  </dl>
                  <p>“连接工作前移”是预热前完成的可测 DNS/建连时间上限；Gemini 不向网页提供服务器实际收包时间。</p>
                </section>
                <details v-if="resultText(result)" class="result-content">
                  <summary>查看保存的回答</summary>
                  <pre>{{ resultText(result) }}</pre>
                </details>
                <details v-if="resultThinking(result).length" class="thinking-log">
                  <summary>页面可见思考日志 · {{ resultThinking(result).length }} 段</summary>
                  <ol>
                    <li v-for="(entry, thoughtIndex) in resultThinking(result)" :key="thoughtIndex">{{ entry }}</li>
                  </ol>
                  <p>这里只展示 Gemini 网页主动显示并被保存的文字，不声称包含隐藏推理。</p>
                </details>
              </li>
            </ol>
          </section>

          <div class="task-list-wrap">
            <h4>逐轮记录</h4>
            <p v-if="automation.loadingDetail && !selectedTasks.length" class="empty-state compact">正在载入详情…</p>
            <p v-else-if="!selectedTasks.length" class="empty-state compact">服务端尚未返回逐轮详情。</p>
            <ol v-else class="task-list">
              <li v-for="(task, index) in selectedTasks" :key="task.id || index">
                <div class="task-head">
                  <strong>{{ taskPosition(task, index) }}</strong>
                  <span class="status-label" :class="`tone-${statusMeta(task).tone}`">{{ statusMeta(task).label }}</span>
                </div>
                <p class="task-meta">
                  尝试 {{ task.attempt || 0 }} 次
                  <template v-if="task.dispatchingAt"> · 发送栅栏 {{ formatDate(task.dispatchingAt) }}</template>
                  <template v-if="task.submittedAt"> · 已提交 {{ formatDate(task.submittedAt) }}</template>
                  <template v-if="task.completedAt"> · 已保存 {{ formatDate(task.completedAt) }}</template>
                </p>
                <p v-if="isRedoRun(automation.selectedRun) || task.workflowStep === 'redo'" class="task-prompt">点击 Gemini 的“重新生成”<template v-if="task.redoOption || automation.selectedRun.redoOption"> → “{{ redoOptionLabel(task.redoOption || automation.selectedRun.redoOption) }}”</template>，并把这个版本单独保存到本地。</p>
                <p v-else class="task-prompt">{{ runTaskPrompt(automation.selectedRun, task) || '（提示词已安全落盘）' }}</p>
                <p v-if="task.responseSha256" class="task-meta">回答 SHA · <code>{{ shortSha(task.responseSha256) }}</code></p>
                <p v-if="task.error" class="task-error">{{ task.error.message || task.error }}</p>
                <p
                  v-if="task.recovery && statusKey(task) !== 'completed'"
                  class="task-recovery"
                >
                  已保留未确认回答快照 · {{ formatDate(task.recovery.capturedAt) }}
                  <code>{{ task.recovery.recoveryPath }}</code>
                </p>
                <a
                  v-if="safeConversationUrl(task.conversationUrl)"
                  class="task-link"
                  :href="safeConversationUrl(task.conversationUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                >打开 Gemini 对话检查</a>
              </li>
            </ol>
          </div>
        </article>

        <div v-else class="run-detail empty-detail">
          <p>从左侧选择一项任务，查看逐轮状态和操作。</p>
        </div>
      </div>
    </section>

    <p class="sr-only" aria-live="polite">{{ toast }}</p>
    <transition name="toast">
      <div v-if="toast" class="toast" role="status">{{ toast }}</div>
    </transition>
  </div>
</template>

<style scoped>
.automation-page {
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 4px 0 56px;
  color: var(--text);
}

.page-header,
.section-heading,
.runs-heading,
.detail-header,
.run-item-top,
.progress-copy,
.task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.page-header-actions { display: flex; align-items: center; gap: 8px; }

.page-header {
  align-items: flex-end;
  padding-bottom: 20px;
  border-bottom: 3px double var(--rule);
  margin-bottom: 18px;
}

.page-header h1 {
  margin: 2px 0 4px;
  font-family: var(--font-reading);
  font-size: clamp(25px, 4vw, 36px);
  font-weight: 700;
  line-height: 1.25;
}

.page-intro {
  max-width: 680px;
  color: var(--text-soft);
  font-size: 13px;
}

.kicker,
.section-number {
  color: var(--hot);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.worker-chip {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.06em;
}

.worker-dot {
  width: 7px;
  height: 7px;
  background: var(--text-muted);
}

.worker-chip.connected {
  border-color: var(--accent);
  color: var(--accent);
}

.worker-chip.connected .worker-dot { background: var(--accent); }

.notice,
.safety-note {
  border: 1px solid var(--rule);
  padding: 11px 14px;
  margin-bottom: 16px;
  font-size: 12px;
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.notice-error,
.failure-box {
  border-color: var(--hot);
  color: var(--hot);
  background: color-mix(in srgb, var(--hot) 5%, transparent);
}

.text-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.safety-note {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 18px;
  border-color: var(--border);
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}

.safety-note h2 {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.safety-note p { color: var(--text-soft); line-height: 1.65; }

.top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(270px, 0.8fr);
  gap: 28px;
  margin-top: 26px;
}

.panel {
  min-width: 0;
  border-top: 3px double var(--rule);
  padding-top: 14px;
}

.current-run-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-top: 22px;
  padding: 15px 16px;
  border: 1px solid var(--rule);
  border-left: 3px solid var(--hot);
  background: var(--bg-card);
}
.current-run-banner strong { display: block; margin-top: 4px; font-family: var(--font-reading); font-size: 17px; }
.current-run-banner p { margin: 5px 0 0; color: var(--text-muted); font-size: 11px; }
.current-run-banner .task-error { color: var(--hot); }

.section-heading { align-items: flex-start; margin-bottom: 18px; }
.section-heading h2,
.runs-heading h2 {
  margin-top: 2px;
  font-family: var(--font-reading);
  font-size: 20px;
  line-height: 1.35;
}

.prompt-count {
  padding: 3px 7px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 10px;
}

.field { display: block; margin-bottom: 15px; }
.field > span,
.field-label,
.copy-field > span:first-child,
.detail-label,
.storage-block > span {
  display: block;
  margin-bottom: 5px;
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.field-label { display: block; }

.field input,
.field select,
.field textarea,
.copy-row input {
  width: 100%;
  border: 1px solid var(--rule);
  border-radius: 0;
  background: var(--bg-card);
  color: var(--text);
  font: 13px/1.5 var(--font-ui);
  outline: none;
}

.field input,
.field select,
.copy-row input { min-height: 36px; padding: 7px 9px; }
.field textarea { min-height: 220px; padding: 10px 11px; resize: vertical; }
.field input:focus,
.field select:focus,
.field textarea:focus,
.copy-row input:focus { border-color: var(--hot); box-shadow: inset 3px 0 0 var(--hot); }
.field small,
.pair-hint {
  display: block;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.55;
}

.field code { color: var(--hot); font-family: ui-monospace, monospace; }

.url-entry-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px;
}

.url-entry-row input { min-width: 0; }
.btn-use-current { white-space: nowrap; }
.field small.inline-warning { color: var(--hot); }

.redo-explainer {
  margin: 0 0 15px;
  padding: 10px 12px;
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.redo-explainer strong { display: block; color: var(--text); font-size: 12px; }
.redo-explainer p { margin-top: 3px; color: var(--text-soft); font-size: 10px; line-height: 1.6; }

.snapshot-url-row { grid-template-columns: minmax(0, 1fr) auto auto; }
.snapshot-card,
.snapshot-required {
  margin: 0 0 15px;
  border: 1px solid var(--rule);
  background: color-mix(in srgb, var(--accent) 4%, var(--bg-card));
}
.snapshot-card { padding: 12px; }
.snapshot-required { padding: 11px 12px; border-style: dashed; }
.snapshot-required strong { font-size: 11px; }
.snapshot-required p { margin-top: 3px; color: var(--text-muted); font-size: 10px; line-height: 1.55; }
.snapshot-head,
.result-group-head,
.result-list > li > header,
.sha-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.snapshot-head strong { display: block; font-family: var(--font-reading); font-size: 14px; }
.snapshot-count { color: var(--accent); font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
.snapshot-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 10px; border: 1px solid var(--border); }
.snapshot-facts > div { min-width: 0; padding: 7px 8px; border-right: 1px solid var(--border); }
.snapshot-facts > div:last-child { border-right: 0; }
.snapshot-facts dt { color: var(--text-muted); font-size: 9px; }
.snapshot-facts dd { margin-top: 2px; overflow-wrap: anywhere; font-size: 10px; }
.snapshot-facts code,
.snapshot-turns code,
.sha-row code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.snapshot-turns { max-height: 250px; margin-top: 10px; overflow-y: auto; list-style: none; border-top: 1px solid var(--border); }
.snapshot-turns li { display: grid; grid-template-columns: 100px minmax(0, 1fr) auto; gap: 9px; padding: 7px 4px; border-bottom: 1px solid var(--border); }
.snapshot-turns li.editable { box-shadow: inset 2px 0 0 var(--accent); }
.snapshot-turns .turn-index { color: var(--text-muted); font-size: 9px; text-transform: uppercase; }
.snapshot-turns p { min-width: 0; color: var(--text-soft); font-size: 10px; line-height: 1.5; }
.snapshot-turns code { color: var(--text-muted); font-size: 8px; }
.source-turn-proof {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 3%, transparent);
}
.source-turn-proof.invalid { border-left-color: var(--danger); }
.source-turn-proof p { margin-top: 5px; color: var(--text-soft); font-size: 10px; line-height: 1.55; white-space: pre-wrap; }
.source-turn-proof small { display: block; margin-top: 6px; color: var(--text-muted); font-size: 9px; line-height: 1.45; overflow-wrap: anywhere; }
.branch-fieldset:disabled { opacity: .58; }

.mode-fieldset {
  border: 0;
  margin: 0 0 15px;
  padding: 0;
}

.mode-fieldset legend {
  margin-bottom: 5px;
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.mode-option {
  display: flex;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  cursor: pointer;
}

.mode-option + .mode-option { border-top: 0; }
.mode-option.selected { border-color: var(--rule); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.mode-option input { margin-top: 4px; accent-color: var(--hot); }
.mode-option strong { display: block; font-size: 12px; font-weight: 600; }
.mode-option small { display: block; margin-top: 1px; color: var(--text-muted); font-size: 10px; line-height: 1.5; }

.compact-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.field-error { margin: -2px 0 12px; color: var(--hot); font-size: 12px; }

.form-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.form-actions p { color: var(--text-muted); font-size: 11px; }
.form-actions strong { color: var(--text); }

.connection-panel { align-self: start; }
.worker-facts { border: 1px solid var(--border); }
.worker-facts > div {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.worker-facts > div:last-child { border-bottom: 0; }
.worker-facts dt { color: var(--text-muted); font-size: 10px; }
.worker-facts dd { min-width: 0; font-size: 11px; text-align: right; }
.ok-text { color: var(--accent); font-weight: 600; }
.muted-text { color: var(--text-muted); }
.break-value { overflow-wrap: anywhere; }

.pair-block,
.storage-block {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--rule);
}

.pair-block h3 { margin-bottom: 11px; font-size: 12px; }
.copy-field { display: block; margin-bottom: 11px; }
.copy-row { display: flex; align-items: stretch; gap: 5px; }
.copy-row input { min-width: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
.copy-row .btn { flex-shrink: 0; }
.storage-block code { display: block; overflow-wrap: anywhere; color: var(--text-muted); font-size: 10px; line-height: 1.55; }

.runs-section {
  position: fixed;
  z-index: 30;
  top: 0;
  right: 0;
  width: min(980px, 94vw);
  height: 100dvh;
  padding: 22px;
  overflow: auto;
  border-left: 1px solid var(--rule);
  background: var(--bg);
  box-shadow: -18px 0 38px color-mix(in srgb, var(--text) 14%, transparent);
  transform: translateX(105%);
  transition: transform var(--t-med) var(--ease);
}

.runs-section.open { transform: translateX(0); }

.runs-heading { align-items: flex-end; margin-bottom: 14px; }
.runs-heading > .btn:last-child { margin-left: -8px; }

.runs-layout {
  display: grid;
  grid-template-columns: minmax(245px, 0.65fr) minmax(0, 1.55fr);
  min-height: 430px;
  border: 1px solid var(--rule);
}

.run-list {
  min-width: 0;
  border-right: 1px solid var(--rule);
  background: var(--bg-sidebar);
}

.run-item {
  display: block;
  width: 100%;
  padding: 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
}

.run-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.run-item.selected { background: var(--bg-card); box-shadow: inset 3px 0 0 var(--hot); }
.run-item:focus-visible { outline: 2px solid var(--hot); outline-offset: -2px; }
.run-item-top { align-items: flex-start; }
.run-item-top strong { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.run-item-meta,
.run-count { display: block; margin-top: 4px; color: var(--text-muted); font-size: 9px; }

.status-label {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  min-height: 19px;
  padding: 1px 6px;
  border: 1px solid currentColor;
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.tone-queued { color: var(--accent); }
.tone-running { color: var(--hot); }
.tone-paused { color: var(--text-soft); }
.tone-complete { color: var(--accent); }
.tone-danger { color: var(--hot); }

.mini-progress {
  display: block;
  height: 2px;
  margin-top: 9px;
  background: var(--border);
}
.mini-progress > span,
.progress-track > span { display: block; height: 100%; background: var(--hot); transition: width var(--t-med) var(--ease); }

.run-detail { min-width: 0; padding: 20px; background: var(--bg); }
.empty-detail { display: grid; place-items: center; color: var(--text-muted); font-size: 12px; }
.detail-header { align-items: flex-start; padding-bottom: 16px; border-bottom: 1px solid var(--rule); }
.detail-header h3 { margin-top: 5px; font-family: var(--font-reading); font-size: 20px; line-height: 1.35; }
.detail-header p { margin-top: 4px; color: var(--text-muted); font-size: 10px; }
.detail-conversation-link { display: inline-block; margin-top: 6px; color: var(--accent); font-size: 10px; }
.detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }

.large-progress { padding: 16px 0; border-bottom: 1px solid var(--border); }
.progress-copy { margin-bottom: 7px; font-size: 11px; }
.progress-copy span { color: var(--text-muted); }
.progress-track { height: 5px; background: var(--border); }

.current-task,
.failure-box { margin-top: 15px; padding: 12px; border: 1px solid var(--rule); }
.current-task strong { font-size: 12px; }
.current-task p,
.failure-box p { margin-top: 5px; font-size: 11px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.failure-box { border-color: var(--hot); }

.result-group { margin-top: 20px; padding-top: 14px; border-top: 3px double var(--rule); }
.result-group-head { align-items: flex-start; }
.result-group-head h4 { margin-top: 2px; font-family: var(--font-reading); font-size: 15px; }
.result-list { margin-top: 10px; list-style: none; border: 1px solid var(--rule); }
.result-list > li { padding: 11px 12px; border-bottom: 1px solid var(--border); }
.result-list > li:last-child { border-bottom: 0; }
.result-list > li > header strong { font-size: 11px; }
.result-list > li > header span { color: var(--text-muted); font-size: 9px; }
.sha-row { justify-content: flex-start; margin-top: 6px; color: var(--text-muted); font-size: 9px; }
.sha-row code { color: var(--text-soft); }
.execution-metrics { margin-top: 9px; border: 1px solid var(--border); background: color-mix(in srgb, var(--accent) 3%, transparent); }
.execution-metrics > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 8px; letter-spacing: .06em; }
.execution-metrics > header span:last-child { letter-spacing: 0; text-align: right; }
.execution-metrics dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; }
.execution-metrics dl > div { min-width: 0; padding: 7px 8px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.execution-metrics dl > div:nth-child(2n) { border-right: 0; }
.execution-metrics dl > div:nth-last-child(-n + 2):nth-child(odd),
.execution-metrics dl > div:last-child:nth-child(odd) { border-bottom: 0; }
.execution-metrics dt { color: var(--text-muted); font-size: 8px; }
.execution-metrics dd { margin-top: 2px; color: var(--text); font: 600 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.execution-metrics small { display: block; margin-top: 2px; color: var(--text-muted); font-size: 8px; line-height: 1.35; }
.execution-metrics p { margin: 0; padding: 6px 8px; color: var(--text-muted); font-size: 8px; line-height: 1.45; }
.result-content,
.thinking-log { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 7px; }
.result-content summary,
.thinking-log summary { color: var(--accent); font-size: 10px; cursor: pointer; }
.result-content pre { max-height: 360px; margin-top: 8px; padding: 10px; overflow: auto; background: var(--bg-card); color: var(--text); font: 11px/1.7 var(--font-reading); white-space: pre-wrap; overflow-wrap: anywhere; }
.thinking-log ol { margin: 8px 0 0 18px; }
.thinking-log li { margin-bottom: 6px; color: var(--text-soft); font-size: 10px; line-height: 1.6; white-space: pre-wrap; }
.thinking-log p { color: var(--text-muted); font-size: 9px; }

.task-list-wrap { margin-top: 20px; }
.task-list-wrap h4 { margin-bottom: 9px; font-size: 12px; letter-spacing: 0.08em; }
.task-list { list-style: none; border-top: 1px solid var(--rule); }
.task-list li { padding: 11px 0; border-bottom: 1px solid var(--border); }
.task-head strong { font-size: 11px; }
.task-prompt { margin-top: 5px; color: var(--text-soft); font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-meta { margin-top: 4px; color: var(--text-muted); font-size: 9px; }
.task-error { margin-top: 5px; color: var(--hot); font-size: 10px; }
.task-recovery {
  margin-top: 6px;
  padding: 7px 8px;
  border-left: 2px solid var(--hot);
  background: color-mix(in srgb, var(--hot) 5%, transparent);
  color: var(--text-soft);
  font-size: 10px;
  line-height: 1.55;
}
.task-recovery code { display: block; margin-top: 2px; overflow-wrap: anywhere; color: var(--text); }
.task-link { display: inline-block; margin-top: 6px; color: var(--accent); font-size: 10px; }

.empty-state { padding: 32px 16px; color: var(--text-muted); font-size: 11px; line-height: 1.6; text-align: center; }
.empty-state.compact { padding: 18px 0; text-align: left; }

.toast {
  position: fixed;
  z-index: 300;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  padding: 8px 16px;
  border: 1px solid var(--rule);
  background: var(--text);
  color: var(--bg);
  font-size: 11px;
  box-shadow: 6px 6px 0 color-mix(in srgb, var(--rule) 18%, transparent);
}

.toast-enter-active,
.toast-leave-active { transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translate(-50%, 6px); }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 900px) {
  .top-grid { grid-template-columns: 1fr; }
  .connection-panel { width: 100%; }
  .runs-layout { grid-template-columns: 220px minmax(0, 1fr); }
  .detail-header { flex-direction: column; }
  .detail-actions { justify-content: flex-start; }
}

@media (max-width: 680px) {
  :global(.ed-main.main-content:has(.automation-page)) { padding: 22px 16px; }
  .automation-page { padding-bottom: 32px; }
  .page-header { align-items: flex-start; flex-direction: column; }
  .safety-note { grid-template-columns: 1fr; gap: 4px; }
  .compact-grid { grid-template-columns: 1fr; gap: 0; }
  .runs-section { width: 100vw; padding: 18px 14px; }
  .runs-layout { display: block; }
  .run-list { max-height: 310px; overflow-y: auto; border-right: 0; border-bottom: 1px solid var(--rule); }
  .run-detail { padding: 15px; }
  .form-actions { align-items: flex-start; flex-direction: column; }
  .form-actions .btn { width: 100%; }
  .copy-row { flex-wrap: wrap; }
  .copy-row input { flex-basis: 100%; }
  .url-entry-row { grid-template-columns: 1fr; }
  .snapshot-url-row { grid-template-columns: 1fr; }
  .btn-use-current { width: 100%; }
  .snapshot-facts { grid-template-columns: 1fr; }
  .snapshot-facts > div { border-right: 0; border-bottom: 1px solid var(--border); }
  .snapshot-facts > div:last-child { border-bottom: 0; }
  .snapshot-turns li { grid-template-columns: 1fr; }
}
</style>
