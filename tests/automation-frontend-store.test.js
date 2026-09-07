import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useAutomationStore } from '../src/stores/automation.js'
import { useVpnTestStore } from '../src/stores/vpnTest.js'

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload)
    },
  }
}

test('PromptLab import preserves all 101 workflow results and uses the run title', async () => {
  setActivePinia(createPinia())
  const store = useAutomationStore()
  const calls = []
  const responses = Array.from({ length: 101 }, (_, index) => ({
    ordinal: index,
    role: index === 0 ? 'initial' : 'redo',
    text: `answer-${index}`,
  }))
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    }
    calls.push(call)
    if (call.url.endsWith('/api/automation/runs/run-101/promptlab-export')) {
      return jsonResponse({
        schemaVersion: 1,
        runId: 'run-101',
        groups: [{ sourcePrompt: 'source prompt', responses }],
      })
    }
    if (call.url === '/api/prompt-groups' && call.method === 'POST') {
      return jsonResponse({ id: 'group-101' })
    }
    if (call.url.startsWith('/api/prompt-groups/group-101/') && call.method === 'PUT') {
      return jsonResponse({ ok: true })
    }
    return jsonResponse({ error: `Unexpected request: ${call.method} ${call.url}` }, 500)
  }

  try {
    const imported = await store.importRunToPromptLab({ id: 'run-101', title: 'Workflow title' })
    assert.deepEqual(imported, { id: 'group-101', responseCount: 101 })

    const createCall = calls.find(call => call.url === '/api/prompt-groups')
    assert.deepEqual(createCall?.body, { title: 'Workflow title', rCount: 101 })
    assert.deepEqual(
      calls.find(call => call.url.endsWith('/group-101/prompt'))?.body,
      { content: 'source prompt' },
    )
    assert.deepEqual(
      calls.find(call => call.url.endsWith('/group-101/r/1'))?.body,
      { content: 'answer-0' },
    )
    assert.deepEqual(
      calls.find(call => call.url.endsWith('/group-101/r/101'))?.body,
      { content: 'answer-100' },
    )
    assert.equal(calls.filter(call => /\/group-101\/r\/\d+$/.test(call.url)).length, 101)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('conversation snapshot creation polls the inspection job before exposing turns', async () => {
  setActivePinia(createPinia())
  const store = useAutomationStore()
  const originalFetch = globalThis.fetch
  let detailReads = 0

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (target === '/api/automation/conversation-snapshots' && options.method === 'POST') {
      return jsonResponse({
        id: 'snapshot-1',
        status: 'pending',
        conversationUrl: 'https://gemini.google.com/app/conversation-1',
      })
    }
    if (target === '/api/automation/conversation-snapshots/snapshot-1') {
      detailReads += 1
      if (detailReads === 1) return jsonResponse({ id: 'snapshot-1', status: 'leased' })
      return jsonResponse({
        id: 'snapshot-1',
        status: 'completed',
        snapshotSha256: 'a'.repeat(64),
        conversationUrl: 'https://gemini.google.com/app/conversation-1',
        snapshot: {
          conversationUrl: 'https://gemini.google.com/app/conversation-1',
          documentInstanceId: 'document-1',
          turns: [{ turnKey: 'turn-1', ordinal: 0, role: 'user', text: 'hello' }],
        },
      })
    }
    return jsonResponse({ error: `Unexpected request: ${target}` }, 500)
  }

  try {
    const snapshot = await store.fetchSnapshot(
      'https://gemini.google.com/app/conversation-1',
      { timeoutMs: 1_000, pollMs: 0 },
    )
    assert.equal(detailReads, 2)
    assert.equal(snapshot.inspectionId, 'snapshot-1')
    assert.equal(snapshot.snapshotSha256, 'a'.repeat(64))
    assert.equal(snapshot.turns[0].turnKey, 'turn-1')
    assert.equal(store.snapshotInspection.status, 'completed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('VPN node trial is bound before start and globally blocks another experiment until terminal', async () => {
  setActivePinia(createPinia())
  const store = useVpnTestStore()
  const originalFetch = globalThis.fetch
  const calls = []
  const conversationUrl = 'https://gemini.google.com/app/vpn-conversation'
  const experiment = { id: 'vpn-1', title: 'VPN test', conversationUrl, trials: [], aggregates: [] }
  const otherExperiment = {
    id: 'vpn-2', title: 'Other VPN test',
    conversationUrl: 'https://gemini.google.com/app/other-vpn-conversation',
    trials: [], aggregates: [],
  }

  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }
    calls.push(call)
    if (call.url.endsWith('/conversation-snapshots') && call.method === 'POST') {
      return jsonResponse({ id: 'snapshot-vpn', status: 'pending', conversationUrl })
    }
    if (call.url.endsWith('/conversation-snapshots/snapshot-vpn')) {
      return jsonResponse({
        id: 'snapshot-vpn', status: 'completed', snapshot: { turns: [{
          turnKey: 'user:0:abcd', ordinal: 0, role: 'user', text: 'same prompt',
          textSha256: 'a'.repeat(64), textLength: 11,
        }] },
      })
    }
    if (call.url.endsWith('/api/automation/runs') && call.method === 'POST') {
      return jsonResponse({ id: 'run-vpn', status: 'draft', ...call.body }, 201)
    }
    if (call.url.endsWith('/vpn-experiments/vpn-1/trials') && call.method === 'POST') {
      return jsonResponse({ ...experiment, trials: [{ id: 'trial-1', nodeLabel: call.body.nodeLabel, runId: call.body.runId }] }, 201)
    }
    if (call.url.endsWith('/runs/run-vpn/actions') && call.method === 'POST') {
      return jsonResponse({ id: 'run-vpn', status: 'queued', runKind: 'workflow', actionBranch: 'redo_only', conversationUrl })
    }
    return jsonResponse({ error: `Unexpected request: ${call.method} ${call.url}` }, 500)
  }

  try {
    store.experiments = [experiment, otherExperiment]
    store.selectedExperiment = experiment
    await store.recordCurrentNode({
      experiment, nodeLabel: 'Node A', redoCount: 1, requiredModel: 'Pro Extended', minDelayMs: 5_000,
    })
    const attachIndex = calls.findIndex(call => call.url.endsWith('/vpn-experiments/vpn-1/trials'))
    const startIndex = calls.findIndex(call => call.url.endsWith('/runs/run-vpn/actions'))
    assert.ok(attachIndex >= 0 && startIndex > attachIndex, 'trial must be bound before the run starts')
    assert.equal(store.activeTrial?.experiment?.id, experiment.id)
    assert.equal(
      store.boundRunIds.has('run-vpn'),
      true,
      'a run attached in one experiment must be excluded from every experiment picker',
    )
    store.selectedExperiment = otherExperiment
    const callCount = calls.length
    await assert.rejects(
      store.recordCurrentNode({
        experiment: otherExperiment, nodeLabel: 'Node B', redoCount: 1,
        requiredModel: 'Pro Extended', minDelayMs: 5_000,
      }),
      /VPN test.*Node A.*仍在执行/,
    )
    assert.equal(calls.length, callCount, 'blocked second node must not create a snapshot or run')
    store.runs = store.runs.map(run => run.id === 'run-vpn' ? { ...run, status: 'completed' } : run)
    assert.equal(store.activeTrial, null, 'a terminal run must release the global VPN node lock')
  } finally {
    globalThis.fetch = originalFetch
  }
})
