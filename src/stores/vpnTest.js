import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export const VPN_EXPERIMENTS_API = Object.freeze({
  collection: '/api/automation/vpn-experiments',
  detail: id => `/api/automation/vpn-experiments/${encodeURIComponent(id)}`,
  trials: id => `/api/automation/vpn-experiments/${encodeURIComponent(id)}/trials`,
  runs: '/api/automation/runs',
  runActions: id => `/api/automation/runs/${encodeURIComponent(id)}/actions`,
  snapshots: '/api/automation/conversation-snapshots',
  snapshotDetail: id => `/api/automation/conversation-snapshots/${encodeURIComponent(id)}`,
})

class VpnExperimentApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.name = 'VpnExperimentApiError'
    this.status = status
    this.details = details
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const raw = await response.text()
  let data = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = { message: raw }
    }
  }
  if (!response.ok) {
    throw new VpnExperimentApiError(
      data?.error || data?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
      data,
    )
  }
  return data
}

function unwrapExperiment(data) {
  return data?.experiment || data?.vpnExperiment || data
}

function unwrapRun(data) {
  return data?.run || data
}

function unwrapList(data, keys) {
  if (Array.isArray(data)) return data
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key]
  }
  return []
}

function updatedTime(value) {
  return Date.parse(value?.updatedAt || value?.completedAt || value?.createdAt || 0) || 0
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'canceled', 'cancelled', 'needs_attention', 'failed'])

function runStatus(run) {
  return String(run?.status || run?.state || '').replace(/-/g, '_').toLowerCase()
}

function wait(milliseconds) {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds))
}

export const useVpnTestStore = defineStore('vpn-experiments', () => {
  const experiments = ref([])
  const selectedExperiment = ref(null)
  const runs = ref([])
  const loadingExperiments = ref(false)
  const loadingDetail = ref(false)
  const loadingRuns = ref(false)
  const creating = ref(false)
  const attaching = ref(false)
  const recording = ref(false)
  const recordingStage = ref('')
  const recordingSnapshot = ref(null)
  const lastCreatedRunId = ref('')
  const error = ref('')

  const selectedExperimentId = computed(() => selectedExperiment.value?.id || '')
  const boundRunIds = computed(() => new Set(
    experiments.value.flatMap(experiment => (
      Array.isArray(experiment?.trials) ? experiment.trials.map(trial => trial.runId) : []
    )).filter(Boolean),
  ))
  const activeTrial = computed(() => {
    for (const experiment of experiments.value) {
      const trials = Array.isArray(experiment?.trials) ? experiment.trials : []
      for (const trial of trials) {
        const run = runs.value.find(candidate => candidate.id === trial.runId)
        if (run && !TERMINAL_RUN_STATUSES.has(runStatus(run))) {
          return { experiment, trial, run }
        }
      }
    }
    return null
  })

  function setError(value) {
    error.value = value instanceof Error ? value.message : String(value || '')
  }

  function clearError() {
    error.value = ''
  }

  function upsertExperiment(experiment) {
    if (!experiment?.id) return
    const index = experiments.value.findIndex(item => item.id === experiment.id)
    if (index === -1) experiments.value.unshift(experiment)
    else experiments.value[index] = { ...experiments.value[index], ...experiment }
    experiments.value.sort((a, b) => updatedTime(b) - updatedTime(a))
  }

  function upsertRun(run) {
    if (!run?.id) return
    const index = runs.value.findIndex(item => item.id === run.id)
    if (index === -1) runs.value.unshift(run)
    else runs.value[index] = { ...runs.value[index], ...run }
    runs.value.sort((a, b) => updatedTime(b) - updatedTime(a))
  }

  async function fetchExperiments({ silent = false } = {}) {
    if (!silent) loadingExperiments.value = true
    try {
      const list = unwrapList(await request(VPN_EXPERIMENTS_API.collection), ['experiments', 'vpnExperiments'])
      experiments.value = [...list].sort((a, b) => updatedTime(b) - updatedTime(a))
      return experiments.value
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      if (!silent) loadingExperiments.value = false
    }
  }

  async function fetchExperiment(id, { silent = false } = {}) {
    if (!id) return null
    if (!silent) loadingDetail.value = true
    try {
      const experiment = unwrapExperiment(await request(VPN_EXPERIMENTS_API.detail(id)))
      if (experiment?.id) {
        upsertExperiment(experiment)
        if (!selectedExperimentId.value || selectedExperimentId.value === experiment.id) {
          selectedExperiment.value = experiment
        }
      }
      return experiment
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      if (!silent) loadingDetail.value = false
    }
  }

  async function selectExperiment(id) {
    if (!id) {
      selectedExperiment.value = null
      return null
    }
    const summary = experiments.value.find(experiment => experiment.id === id)
    if (summary) selectedExperiment.value = summary
    return fetchExperiment(id)
  }

  async function fetchRuns({ silent = false } = {}) {
    if (!silent) loadingRuns.value = true
    try {
      const list = unwrapList(await request(VPN_EXPERIMENTS_API.runs), ['runs'])
      runs.value = [...list].sort((a, b) => updatedTime(b) - updatedTime(a))
      return runs.value
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      if (!silent) loadingRuns.value = false
    }
  }

  async function createExperiment({ title, conversationUrl }) {
    creating.value = true
    clearError()
    try {
      const experiment = unwrapExperiment(await request(VPN_EXPERIMENTS_API.collection, {
        method: 'POST',
        body: JSON.stringify({ title, conversationUrl }),
      }))
      if (experiment?.id) {
        upsertExperiment(experiment)
        selectedExperiment.value = experiment
      }
      return experiment
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      creating.value = false
    }
  }

  async function addTrial(experimentId, { nodeLabel, runId }) {
    if (!experimentId) throw new Error('请先选择 VPN 实验。')
    attaching.value = true
    clearError()
    try {
      const experiment = unwrapExperiment(await request(VPN_EXPERIMENTS_API.trials(experimentId), {
        method: 'POST',
        body: JSON.stringify({ nodeLabel, runId }),
      }))
      if (experiment?.id) {
        upsertExperiment(experiment)
        if (selectedExperimentId.value === experiment.id) selectedExperiment.value = experiment
      }
      return experiment
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      attaching.value = false
    }
  }

  async function captureConversation(conversationUrl) {
    recordingStage.value = '正在请求浏览器读取当前 Gemini 对话…'
    const created = await request(VPN_EXPERIMENTS_API.snapshots, {
      method: 'POST',
      body: JSON.stringify({ conversationUrl }),
    })
    if (!created?.id) throw new Error('服务端创建了快照任务，但没有返回快照 ID。')
    recordingSnapshot.value = created

    for (let attempt = 0; attempt < 31; attempt += 1) {
      if (attempt > 0) await wait(2_000)
      const inspection = await request(VPN_EXPERIMENTS_API.snapshotDetail(created.id))
      recordingSnapshot.value = inspection
      if (inspection?.status === 'failed') {
        throw new Error(`对话快照失败：${inspection.error || '浏览器没有返回可用的对话结构。'}`)
      }
      if (inspection?.status !== 'completed') {
        recordingStage.value = inspection?.status === 'leased'
          ? '浏览器正在读取对话并校验每一轮文字…'
          : '等待 Gemini Runner 接取对话快照任务…'
        continue
      }
      const turns = Array.isArray(inspection?.snapshot?.turns) ? inspection.snapshot.turns : []
      const source = [...turns]
        .filter(turn => turn?.role === 'user')
        .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
        .at(-1)
      if (!source?.text || !source.turnKey || !Number.isInteger(source.ordinal)
        || !source.textSha256 || !Number.isInteger(source.textLength)) {
        throw new Error('对话快照已完成，但没有找到可用于 Redo 的最后一条用户消息及其完整校验证明。')
      }
      return { inspection, source }
    }
    throw new Error('等待对话快照超过 60 秒。请确认 Gemini Runner 已启用并打开了实验对应的精确对话。')
  }

  async function recordCurrentNode({
    experiment,
    nodeLabel,
    redoCount,
    redoOption,
    requiredModel,
    minDelayMs,
  }) {
    if (recording.value) throw new Error('当前节点正在记录，请等待这一次操作完成。')
    if (activeTrial.value) {
      const owner = activeTrial.value.experiment?.title || activeTrial.value.experiment?.id || '未命名实验'
      throw new Error(`实验“${owner}”的节点“${activeTrial.value.trial.nodeLabel}”运行 ${activeTrial.value.run.id} 仍在执行；请保持当前 VPN 不变，等待它结束后再测试下一个节点。`)
    }
    if (!experiment?.id || !experiment?.conversationUrl) throw new Error('请先选择 VPN 实验。')
    recording.value = true
    recordingSnapshot.value = null
    lastCreatedRunId.value = ''
    clearError()
    try {
      const { source } = await captureConversation(experiment.conversationUrl)
      recordingStage.value = '快照已验证，正在创建 Redo 工作流…'
      const run = unwrapRun(await request(VPN_EXPERIMENTS_API.runs, {
        method: 'POST',
        body: JSON.stringify({
          title: `${experiment.title} · ${nodeLabel}`,
          runKind: 'workflow',
          conversationUrl: experiment.conversationUrl,
          actionBranch: 'redo_only',
          redoCount,
          redoOption,
          prompt: source.text,
          sourceTurn: {
            turnKey: source.turnKey,
            ordinal: source.ordinal,
            sourceTextSha256: source.textSha256,
            sourceTextLength: source.textLength,
          },
          requiredModel,
          minDelayMs,
          maxRetries: 0,
        }),
      }))
      if (!run?.id) throw new Error('工作流创建成功响应缺少 run ID。')
      lastCreatedRunId.value = run.id
      upsertRun(run)

      // Bind the draft before starting it. If another node is still active,
      // the server rejects this step while the new run is harmless and has not
      // consumed any Gemini quota.
      recordingStage.value = '工作流已创建，正在绑定到当前 VPN 节点…'
      const detail = unwrapExperiment(await request(VPN_EXPERIMENTS_API.trials(experiment.id), {
        method: 'POST',
        body: JSON.stringify({ nodeLabel, runId: run.id }),
      }))
      if (!detail?.id) throw new Error(`工作流 ${run.id} 尚未启动，但绑定实验的响应无效；可在“附加已有运行”中手动恢复绑定。`)
      upsertExperiment(detail)
      selectedExperiment.value = detail

      recordingStage.value = '节点已绑定，正在启动 Redo 工作流…'
      const started = unwrapRun(await request(VPN_EXPERIMENTS_API.runActions(run.id), {
        method: 'POST',
        body: JSON.stringify({ action: 'start' }),
      }))
      if (started?.id) upsertRun(started)
      recordingStage.value = '当前节点已记录，Redo 工作流正在后台执行。'
      return { experiment: detail, run: started?.id ? started : run }
    } catch (cause) {
      const suffix = lastCreatedRunId.value
        ? `（已创建的运行：${lastCreatedRunId.value}，请勿再次一键创建；可用高级入口绑定。）`
        : ''
      setError(`${cause instanceof Error ? cause.message : String(cause || '')}${suffix}`)
      throw cause
    } finally {
      recording.value = false
    }
  }

  return {
    experiments,
    selectedExperiment,
    selectedExperimentId,
    runs,
    boundRunIds,
    activeTrial,
    loadingExperiments,
    loadingDetail,
    loadingRuns,
    creating,
    attaching,
    recording,
    recordingStage,
    recordingSnapshot,
    lastCreatedRunId,
    error,
    clearError,
    fetchExperiments,
    fetchExperiment,
    selectExperiment,
    fetchRuns,
    createExperiment,
    addTrial,
    recordCurrentNode,
  }
})
