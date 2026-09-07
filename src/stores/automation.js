import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

const API = '/api/automation'
const PROMPT_GROUPS_API = '/api/prompt-groups'

class AutomationApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.name = 'AutomationApiError'
    this.status = status
    this.details = details
  }
}

async function requestUrl(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
  }

  if (!response.ok) {
    throw new AutomationApiError(
      data?.error || data?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
      data,
    )
  }

  return data
}

function request(path, options = {}) {
  return requestUrl(`${API}${path}`, options)
}

function unwrapRun(data) {
  return data?.run || data
}

function updatedTime(run) {
  return Date.parse(run?.updatedAt || run?.createdAt || 0) || 0
}

function unwrapProjection(data) {
  return data?.projection || data?.resultGroup || data
}

function snapshotFailureMessage(inspection) {
  return inspection?.error?.message
    || inspection?.error
    || inspection?.failureReason
    || 'Gemini 会话快照读取失败。'
}

function completedSnapshot(inspection, fallbackUrl) {
  if (!inspection?.snapshot || typeof inspection.snapshot !== 'object') return null
  return {
    ...inspection.snapshot,
    inspectionId: inspection.id,
    inspectionStatus: inspection.status,
    snapshotSha256: inspection.snapshotSha256 || inspection.snapshot?.snapshotSha256 || null,
    conversationUrl: inspection.snapshot.conversationUrl || inspection.conversationUrl || fallbackUrl,
    inspectionCreatedAt: inspection.createdAt || null,
    inspectionCompletedAt: inspection.completedAt || null,
  }
}

function projectedResponseText(item) {
  if (typeof item === 'string') return item
  return String(item?.response ?? item?.content ?? item?.text ?? '')
}

function projectedResponses(projection) {
  const source = projection?.responses ?? projection?.results ?? projection?.slots ?? []
  const values = Array.isArray(source)
    ? source
    : Object.entries(source || {})
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, value]) => value)
  return values
    .filter(item => typeof item === 'string' || !item?.status || item.status === 'completed')
    .map(projectedResponseText)
}

export const useAutomationStore = defineStore('automation', () => {
  const runs = ref([])
  const selectedRun = ref(null)
  const status = ref(null)
  const loadingRuns = ref(false)
  const loadingDetail = ref(false)
  const loadingStatus = ref(false)
  const submitting = ref(false)
  const actingId = ref('')
  const error = ref('')
  const snapshot = ref(null)
  const snapshotInspection = ref(null)
  const snapshotLoading = ref(false)
  const snapshotError = ref('')
  const projections = ref({})
  const projectionLoadingId = ref('')
  const projectionError = ref('')
  const importingRunId = ref('')
  const importProgress = ref(null)
  const importedPromptGroups = ref({})
  let snapshotRequestSerial = 0

  const selectedRunId = computed(() => selectedRun.value?.id || '')

  function setError(value) {
    error.value = value instanceof Error ? value.message : String(value || '')
  }

  function upsertRun(run) {
    if (!run?.id) return
    const index = runs.value.findIndex(item => item.id === run.id)
    if (index === -1) runs.value.unshift(run)
    else runs.value[index] = { ...runs.value[index], ...run }
    runs.value.sort((a, b) => updatedTime(b) - updatedTime(a))
  }

  async function fetchRuns({ silent = false } = {}) {
    if (!silent) loadingRuns.value = true
    try {
      const data = await request('/runs')
      const list = Array.isArray(data) ? data : (data?.runs || [])
      runs.value = [...list].sort((a, b) => updatedTime(b) - updatedTime(a))
      return runs.value
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      if (!silent) loadingRuns.value = false
    }
  }

  async function fetchRun(id, { silent = false } = {}) {
    if (!id) return null
    if (!silent) loadingDetail.value = true
    try {
      const run = unwrapRun(await request(`/runs/${encodeURIComponent(id)}`))
      if (run?.id) {
        selectedRun.value = run
        upsertRun(run)
      }
      return run
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      if (!silent) loadingDetail.value = false
    }
  }

  async function selectRun(id) {
    if (!id) {
      selectedRun.value = null
      return null
    }

    const summary = runs.value.find(run => run.id === id)
    if (summary) selectedRun.value = summary
    const run = await fetchRun(id)
    if (run?.runKind === 'workflow') {
      await fetchProjection(id, { silent: true }).catch(() => {})
    }
    return run
  }

  async function fetchSnapshot(conversationUrl, { timeoutMs = 60_000, pollMs = 2_000 } = {}) {
    const requestSerial = ++snapshotRequestSerial
    snapshotLoading.value = true
    snapshotError.value = ''
    snapshot.value = null
    snapshotInspection.value = null
    try {
      const pending = await request('/conversation-snapshots', {
        method: 'POST',
        body: JSON.stringify({ conversationUrl }),
      })
      if (!pending?.id) throw new Error('快照服务没有返回 inspection ID。')
      snapshotInspection.value = pending

      const deadline = Date.now() + timeoutMs
      let inspection = pending
      while (Date.now() <= deadline) {
        if (requestSerial !== snapshotRequestSerial) throw new Error('快照读取已被新的链接请求取代。')
        inspection = await request(`/conversation-snapshots/${encodeURIComponent(pending.id)}`)
        snapshotInspection.value = inspection
        if (inspection?.status === 'failed') throw new Error(snapshotFailureMessage(inspection))
        if (inspection?.status === 'completed') {
          const result = completedSnapshot(inspection, conversationUrl)
          if (!result) throw new Error('快照任务已完成，但服务端没有返回可用的 turns 快照。')
          snapshot.value = result
          return result
        }
        await new Promise(resolve => globalThis.setTimeout(resolve, pollMs))
      }
      throw new Error('读取会话快照超过 60 秒。请确认专用浏览器扩展在线并已登录 Gemini，然后重试。')
    } catch (cause) {
      if (requestSerial === snapshotRequestSerial) {
        snapshot.value = null
        snapshotError.value = cause instanceof Error ? cause.message : String(cause || '')
      }
      throw cause
    } finally {
      if (requestSerial === snapshotRequestSerial) snapshotLoading.value = false
    }
  }

  function clearSnapshot() {
    snapshotRequestSerial += 1
    snapshot.value = null
    snapshotInspection.value = null
    snapshotLoading.value = false
    snapshotError.value = ''
  }

  async function fetchProjection(id, { silent = false } = {}) {
    if (!id) return null
    if (!silent) projectionLoadingId.value = id
    projectionError.value = ''
    try {
      const projection = unwrapProjection(await request(`/runs/${encodeURIComponent(id)}/results`))
      projections.value = { ...projections.value, [id]: projection }
      return projection
    } catch (cause) {
      projectionError.value = cause instanceof Error ? cause.message : String(cause || '')
      throw cause
    } finally {
      if (!silent && projectionLoadingId.value === id) projectionLoadingId.value = ''
    }
  }

  async function importRunToPromptLab(run) {
    const runId = typeof run === 'string' ? run : run?.id
    if (!runId) throw new Error('缺少自动化任务 ID。')
    importingRunId.value = runId
    importProgress.value = { phase: 'projection', done: 0, total: 0 }
    let groupId = ''
    try {
      const exported = await request(`/runs/${encodeURIComponent(runId)}/promptlab-export`)
      const groups = Array.isArray(exported?.groups) ? exported.groups : []
      if (groups.length !== 1) {
        throw new Error(`PromptLab 导出应包含 1 个结果组，实际为 ${groups.length} 个；没有导入。`)
      }
      const exportGroup = groups[0]
      const responses = projectedResponses(exportGroup)
      if (!responses.length) throw new Error('结果组里还没有可导入的完整回答。')
      if (responses.length > 101) {
        throw new Error(`结果组包含 ${responses.length} 个回答，超过 PromptLab 的 101 槽容量；没有导入或截断。`)
      }
      const prompt = String(exportGroup?.sourcePrompt ?? '')
      const runTitle = typeof run === 'object' ? run?.title : ''
      const title = String(exported?.title || runTitle || `Gemini 结果组 ${runId.slice(0, 8)}`)
      importProgress.value = { phase: 'create', done: 0, total: responses.length + 1 }
      const created = await requestUrl(PROMPT_GROUPS_API, {
        method: 'POST',
        body: JSON.stringify({ title, rCount: responses.length }),
      })
      groupId = created?.id || created?.group?.id || ''
      if (!groupId) throw new Error('PromptLab 创建成功响应缺少 group ID。')

      await requestUrl(`${PROMPT_GROUPS_API}/${encodeURIComponent(groupId)}/prompt`, {
        method: 'PUT',
        body: JSON.stringify({ content: prompt }),
      })
      importProgress.value = { phase: 'responses', done: 1, total: responses.length + 1 }
      for (let index = 0; index < responses.length; index += 1) {
        await requestUrl(`${PROMPT_GROUPS_API}/${encodeURIComponent(groupId)}/r/${index + 1}`, {
          method: 'PUT',
          body: JSON.stringify({ content: responses[index] }),
        })
        importProgress.value = {
          phase: 'responses',
          done: index + 2,
          total: responses.length + 1,
        }
      }
      importedPromptGroups.value = {
        ...importedPromptGroups.value,
        [runId]: { id: groupId, responseCount: responses.length },
      }
      return importedPromptGroups.value[runId]
    } catch (cause) {
      const suffix = groupId ? ` 已创建的部分 PromptLab 组为 ${groupId}，请检查后再决定是否删除。` : ''
      throw new Error(`${cause instanceof Error ? cause.message : String(cause || '导入失败。')}${suffix}`)
    } finally {
      importingRunId.value = ''
      importProgress.value = null
    }
  }

  async function createRun(payload) {
    submitting.value = true
    error.value = ''
    try {
      const run = unwrapRun(await request('/runs', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))
      if (run?.id) {
        upsertRun(run)
        selectedRun.value = run
      }
      return run
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      submitting.value = false
    }
  }

  async function runAction(id, action) {
    if (!id || !action) return null
    actingId.value = id
    error.value = ''
    try {
      const run = unwrapRun(await request(`/runs/${encodeURIComponent(id)}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      }))
      if (run?.id) {
        upsertRun(run)
        if (selectedRunId.value === run.id) selectedRun.value = run
      }
      return run
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      actingId.value = ''
    }
  }

  async function fetchStatus({ silent = false } = {}) {
    if (!silent) loadingStatus.value = true
    try {
      status.value = await request('/status')
      return status.value
    } catch (cause) {
      setError(cause)
      throw cause
    } finally {
      if (!silent) loadingStatus.value = false
    }
  }

  function clearError() {
    error.value = ''
  }

  return {
    runs,
    selectedRun,
    selectedRunId,
    status,
    loadingRuns,
    loadingDetail,
    loadingStatus,
    submitting,
    actingId,
    error,
    snapshot,
    snapshotInspection,
    snapshotLoading,
    snapshotError,
    projections,
    projectionLoadingId,
    projectionError,
    importingRunId,
    importProgress,
    importedPromptGroups,
    clearError,
    fetchRuns,
    fetchRun,
    selectRun,
    createRun,
    runAction,
    fetchStatus,
    fetchSnapshot,
    clearSnapshot,
    fetchProjection,
    importRunToPromptLab,
  }
})
