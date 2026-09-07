import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createHash } from 'node:crypto';

import { registerAutomationRoutes } from '../server/automation-routes.js';
import { canonicalizeNativePasteText } from '../server/native-gemini-paste.js';

async function jsonRequest(baseUrl, pathname, {
  method = 'GET',
  origin = 'http://127.0.0.1:5173',
  token,
  body,
  extraHeaders = {},
} = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (origin !== null) headers.Origin = origin;
  if (token) headers['X-NovelWeb-Worker-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null,
  };
}

test('automation routes restrict management origins and require a paired worker', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelweb-automation-routes-'));
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  await registerAutomationRoutes(app, {
    rootDir,
    apiPort: 3001,
    storeOptions: {
      leaseMs: 30_000,
      idFactory: () => 'route-test',
    },
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const forbidden = await jsonRequest(baseUrl, '/api/automation/status', {
    origin: 'https://example.com',
  });
  assert.equal(forbidden.status, 403);

  const forwardedLanClient = await jsonRequest(baseUrl, '/api/automation/status', {
    origin: null,
    extraHeaders: { 'X-Forwarded-For': '192.168.1.50' },
  });
  assert.equal(forwardedLanClient.status, 403);

  const status = await jsonRequest(baseUrl, '/api/automation/status');
  assert.equal(status.status, 200);
  assert.match(status.data.pairing.token, /^[A-Za-z0-9_-]{32,}$/);
  const token = status.data.pairing.token;

  const idleHeartbeat = await jsonRequest(baseUrl, '/api/automation/worker/heartbeat', {
    method: 'POST',
    origin: null,
    token,
    body: {
      workerId: 'route-worker',
      taskId: null,
      pageUrl: 'https://gemini.google.com/app',
      modelLabel: 'Deep Think',
    },
  });
  assert.equal(idleHeartbeat.status, 200);
  assert.equal(idleHeartbeat.data.idle, true);

  const created = await jsonRequest(baseUrl, '/api/automation/runs', {
    method: 'POST',
    body: {
      title: 'Route integration',
      mode: 'new_thread_each',
      prompts: ['Write one safe line.'],
      variants: 1,
      requiredModel: 'Deep Think',
      minDelayMs: 5_000,
      maxRetries: 0,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'draft');

  const started = await jsonRequest(
    baseUrl,
    `/api/automation/runs/${encodeURIComponent(created.data.id)}/actions`,
    { method: 'POST', body: { action: 'start' } },
  );
  assert.equal(started.status, 200);

  const unpaired = await jsonRequest(
    baseUrl,
    '/api/automation/worker/next?workerId=route-worker',
    { origin: null },
  );
  assert.equal(unpaired.status, 401);

  const claim = await jsonRequest(
    baseUrl,
    '/api/automation/worker/next?workerId=route-worker&modelLabel=Deep%20Think',
    { origin: null, token },
  );
  assert.equal(claim.status, 200);
  assert.equal(claim.data.prompt, 'Write one safe line.');
  assert.equal(claim.data.id, claim.data.taskId);

  const heartbeat = await jsonRequest(baseUrl, '/api/automation/worker/heartbeat', {
    method: 'POST',
    origin: null,
    token,
    body: {
      workerId: 'route-worker',
      taskId: claim.data.taskId,
      leaseId: claim.data.leaseId,
      pageUrl: 'https://gemini.google.com/app',
      modelLabel: 'Deep Think',
    },
  });
  assert.equal(heartbeat.status, 200);

  const taskPath = `/api/automation/worker/tasks/${encodeURIComponent(claim.data.taskId)}/events`;
  const dispatching = await jsonRequest(baseUrl, taskPath, {
    method: 'POST',
    origin: null,
    token,
    body: {
      workerId: 'route-worker',
      leaseId: claim.data.leaseId,
      eventId: 'route-dispatching',
      type: 'dispatching',
    },
  });
  assert.equal(dispatching.status, 200);
  assert.equal(dispatching.data.task.status, 'submitted');

  const completed = await jsonRequest(baseUrl, taskPath, {
    method: 'POST',
    origin: null,
    token,
    body: {
      workerId: 'route-worker',
      leaseId: claim.data.leaseId,
      eventId: 'route-completed',
      type: 'completed',
      response: 'Saved locally.',
      responseHtml: '<p>Saved locally.</p>',
      conversationUrl: 'https://gemini.google.com/app/route-test',
      modelLabel: 'Deep Think',
    },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.run.status, 'completed');
  assert.equal(completed.data.task.model, 'Deep Think');

  const responsePath = path.join(
    rootDir,
    'runs',
    created.data.id,
    ...completed.data.task.responsePath.split('/'),
  );
  assert.equal(await fs.readFile(responsePath, 'utf8'), 'Saved locally.');
});

test('automation routes expose redo runs as prompt-free bound worker tasks', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelweb-automation-redo-routes-'));
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  await registerAutomationRoutes(app, {
    rootDir,
    apiPort: 3001,
    storeOptions: {
      leaseMs: 30_000,
      idFactory: () => 'redo-route-test',
    },
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const status = await jsonRequest(baseUrl, '/api/automation/status');
  const token = status.data.pairing.token;
  const conversationUrl = 'https://gemini.google.com/app/route-redo-thread';

  const invalid = await jsonRequest(baseUrl, '/api/automation/runs', {
    method: 'POST',
    body: {
      runKind: 'redo',
      title: 'Invalid base chat URL',
      conversationUrl: 'https://gemini.google.com/app',
      repeatCount: 2,
      requiredModel: 'Pro Extended',
    },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'invalid_conversation_url');

  const created = await jsonRequest(baseUrl, '/api/automation/runs', {
    method: 'POST',
    body: {
      runKind: 'redo',
      title: 'Route redo integration',
      conversationUrl,
      repeatCount: 2,
      requiredModel: 'Pro Extended',
      minDelayMs: 5_000,
      maxRetries: 0,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.runKind, 'redo');
  assert.equal(created.data.tasks.length, 1);
  assert.equal(created.data.plannedTaskTotal, 2);
  assert.equal(created.data.tasks[0].conversationAction, 'redo');

  await jsonRequest(
    baseUrl,
    `/api/automation/runs/${encodeURIComponent(created.data.id)}/actions`,
    { method: 'POST', body: { action: 'start' } },
  );
  const claim = await jsonRequest(
    baseUrl,
    '/api/automation/worker/next?workerId=redo-route-worker&modelLabel=Pro%20Extended',
    { origin: null, token },
  );
  assert.equal(claim.status, 200);
  assert.equal(claim.data.runKind, 'redo');
  assert.equal(claim.data.conversationAction, 'redo');
  assert.equal(claim.data.conversationUrl, conversationUrl);
  assert.equal(claim.data.prompt, null);
  assert.equal(claim.data.repeatIndex, 1);
  assert.equal(claim.data.redoIndex, 1);
  assert.equal(claim.data.repeatCount, 2);
});

test('native paste route uses the active lease, keeps prompts server-side, and stops after the dispatch fence', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelweb-native-paste-routes-'));
  const prompt = '私有第一段。\n\n\n私有第二段。';
  const promptCanonical = canonicalizeNativePasteText(prompt);
  const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const conversationUrl = 'https://gemini.google.com/gem/custom-gem-1/thread_abc';
  const calls = [];
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  await registerAutomationRoutes(app, {
    rootDir,
    apiPort: 3001,
    storeOptions: {
      leaseMs: 30_000,
      idFactory: () => 'native-route-test',
    },
    nativePasteExecutor: async payload => {
      calls.push(payload);
      return {
        ok: true,
        telemetry: {
          schemaVersion: 1,
          transport: 'windows-native-clipboard',
          pasteMode: 'fill-empty',
          sourceVerified: false,
          sourceCanonicalSha256: null,
          targetUrl: conversationUrl,
          chromeProcessId: 4321,
          promptCharacters: prompt.length,
          promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
          findWindowMs: 10,
          focusMs: 5,
          pasteMs: 3,
          clipboardHeldMs: 1,
          readbackMs: 7,
          totalMs: 25,
          idempotent: false,
          clipboardTouched: true,
          clipboardRestored: true,
          blankLinesCollapsed: true,
          normalizationApplied: true,
          promptSha256: sha256(prompt),
          promptCanonicalSha256: sha256(promptCanonical),
          readbackSha256: sha256(promptCanonical),
          readbackCanonicalSha256: sha256(promptCanonical),
          verifiedAt: '2026-08-21T12:00:00.000Z',
        },
      };
    },
  });

  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const status = await jsonRequest(baseUrl, '/api/automation/status');
  const token = status.data.pairing.token;

  const created = await jsonRequest(baseUrl, '/api/automation/runs', {
    method: 'POST',
    body: {
      title: 'Native paste integration',
      mode: 'same_thread',
      prompts: [prompt],
      variants: 1,
      conversationUrl,
      requiredModel: 'Pro Extended',
      minDelayMs: 5_000,
      maxRetries: 0,
    },
  });
  await jsonRequest(baseUrl, `/api/automation/runs/${created.data.id}/actions`, {
    method: 'POST',
    body: { action: 'start' },
  });
  const claim = await jsonRequest(
    baseUrl,
    '/api/automation/worker/next?workerId=native-route-worker&modelLabel=Pro%20Extended',
    { origin: null, token },
  );
  const nativePath = `/api/automation/worker/tasks/${claim.data.taskId}/native-paste`;

  const unpaired = await jsonRequest(baseUrl, nativePath, {
    method: 'POST',
    origin: null,
    body: { workerId: 'native-route-worker', leaseId: claim.data.leaseId },
  });
  assert.equal(unpaired.status, 401);

  const wrongLease = await jsonRequest(baseUrl, nativePath, {
    method: 'POST',
    origin: null,
    token,
    body: { workerId: 'native-route-worker', leaseId: 'wrong-lease-id' },
  });
  assert.equal(wrongLease.status, 409);
  assert.equal(calls.length, 0);

  const pasted = await jsonRequest(baseUrl, nativePath, {
    method: 'POST',
    origin: null,
    token,
    body: { workerId: 'native-route-worker', leaseId: claim.data.leaseId },
  });
  assert.equal(pasted.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    prompt,
    targetUrl: conversationUrl,
    pasteMode: 'fill-empty',
  });
  assert.equal(pasted.data.telemetry.transport, 'windows-native-clipboard');
  assert.equal(pasted.data.telemetry.blankLinesCollapsed, true);
  assert.equal(JSON.stringify(pasted.data).includes(prompt), false);

  await jsonRequest(baseUrl, `/api/automation/worker/tasks/${claim.data.taskId}/events`, {
    method: 'POST',
    origin: null,
    token,
    body: {
      workerId: 'native-route-worker',
      leaseId: claim.data.leaseId,
      eventId: 'native-route-dispatching',
      type: 'dispatching',
    },
  });
  const afterFence = await jsonRequest(baseUrl, nativePath, {
    method: 'POST',
    origin: null,
    token,
    body: { workerId: 'native-route-worker', leaseId: claim.data.leaseId },
  });
  assert.equal(afterFence.status, 409);
  assert.equal(calls.length, 1);
});

test('routes expose snapshot inspection, fenced workflow results, clean PromptLab export, and VPN aggregation', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelweb-workflow-routes-'));
  let id = 0;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  await registerAutomationRoutes(app, {
    rootDir,
    apiPort: 3001,
    storeOptions: { leaseMs: 30_000, idFactory: () => `workflow-route-${++id}` },
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const status = await jsonRequest(baseUrl, '/api/automation/status');
  const token = status.data.pairing.token;
  const conversationUrl = 'https://gemini.google.com/gem/gem-route/conversation-route';
  const prompt = 'Snapshot source\n\nfor Redo';
  const canonical = canonicalizeNativePasteText(prompt);
  const sourceSha = createHash('sha256').update(canonical, 'utf8').digest('hex');

  const inspection = await jsonRequest(baseUrl, '/api/automation/conversation-snapshots', {
    method: 'POST', body: { conversationUrl },
  });
  assert.equal(inspection.status, 201);
  const inspectionClaim = await jsonRequest(
    baseUrl,
    '/api/automation/worker/next?workerId=workflow-route-worker',
    { origin: null, token },
  );
  assert.equal(inspectionClaim.data.jobType, 'conversation_snapshot');
  const inspectionResult = await jsonRequest(
    baseUrl,
    `/api/automation/worker/conversation-snapshots/${inspection.data.id}/events`,
    {
      method: 'POST', origin: null, token,
      body: {
        workerId: 'workflow-route-worker',
        eventId: 'snapshot-result',
        type: 'completed',
        leaseId: inspectionClaim.data.leaseId,
        conversationUrl,
        documentInstanceId: 'document-route',
        turns: [{
          turnKey: 'user:0:route', ordinal: 0, role: 'user', text: prompt,
          textSha256: sourceSha, textLength: canonical.length, editable: true,
        }],
      },
    },
  );
  assert.equal(inspectionResult.status, 200);
  const snapshotGet = await jsonRequest(
    baseUrl,
    `/api/automation/conversation-snapshots/${inspection.data.id}`,
  );
  assert.equal(snapshotGet.data.snapshot.turns[0].text, prompt);

  const sourceTurn = {
    turnKey: 'user:0:route', ordinal: 0, sourceTextSha256: sourceSha,
    sourceTextLength: canonical.length,
  };
  const created = await jsonRequest(baseUrl, '/api/automation/runs', {
    method: 'POST',
    body: {
      runKind: 'workflow', title: 'Route workflow', conversationUrl,
      actionBranch: 'redo_only', redoCount: 1, prompt, sourceTurn,
      requiredModel: 'Pro Extended', minDelayMs: 5_000, maxRetries: 0,
    },
  });
  assert.equal(created.status, 201);
  await jsonRequest(baseUrl, `/api/automation/runs/${created.data.id}/actions`, {
    method: 'POST', body: { action: 'start' },
  });
  const claim = await jsonRequest(
    baseUrl,
    '/api/automation/worker/next?workerId=workflow-route-worker',
    { origin: null, token },
  );
  assert.equal(claim.data.conversationAction, 'redo');
  const evidence = { expected: sourceTurn, observed: sourceTurn, documentInstanceId: 'document-route' };
  const eventPath = `/api/automation/worker/tasks/${claim.data.taskId}/events`;
  await jsonRequest(baseUrl, eventPath, {
    method: 'POST', origin: null, token,
    body: {
      workerId: 'workflow-route-worker', eventId: 'workflow-fence', type: 'dispatching',
      leaseId: claim.data.leaseId, conversationUrl, sourceTurnEvidence: evidence,
    },
  });
  const submittedAt = Date.now();
  const completed = await jsonRequest(baseUrl, eventPath, {
    method: 'POST', origin: null, token,
    body: {
      workerId: 'workflow-route-worker', eventId: 'workflow-result', type: 'completed',
      leaseId: claim.data.leaseId, conversationUrl, sourceTurnEvidence: evidence,
      response: 'A regenerated response',
      timing: {
        clientSubmittedAt: new Date(submittedAt).toISOString(),
        firstResponseVisibleAt: new Date(submittedAt + 100).toISOString(),
        completedAt: new Date(submittedAt + 500).toISOString(),
        clickToFirstResponseMs: 100,
      },
      telemetry: { prewarm: { durationMs: 50 } },
    },
  });
  assert.equal(completed.status, 200);
  const detail = await jsonRequest(baseUrl, `/api/automation/runs/${created.data.id}`);
  assert.equal(detail.data.resultGroup.results[0].response, 'A regenerated response');
  assert.equal(detail.data.resultGroup.results[0].responseSha256.length, 64);
  const promptLab = await jsonRequest(
    baseUrl,
    `/api/automation/runs/${created.data.id}/promptlab-export`,
  );
  assert.deepEqual(promptLab.data.groups[0], {
    sourcePrompt: prompt,
    responses: [{ ordinal: 1, role: 'redo', text: 'A regenerated response' }],
  });
  assert.equal(JSON.stringify(promptLab.data).includes('telemetry'), false);

  const experiment = await jsonRequest(baseUrl, '/api/automation/vpn-experiments', {
    method: 'POST', body: { title: 'Route VPN experiment', conversationUrl },
  });
  const trial = await jsonRequest(
    baseUrl,
    `/api/automation/vpn-experiments/${experiment.data.id}/trials`,
    { method: 'POST', body: { nodeLabel: 'US node', runId: created.data.id } },
  );
  assert.equal(trial.data.aggregates[0].completed, 1);
  assert.equal(trial.data.aggregates[0].medianClickToFirstResponseMs, 100);
  assert.equal(trial.data.aggregates[0].medianPrewarmMs, 50);
});
