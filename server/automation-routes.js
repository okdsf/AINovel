import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import { AutomationStore } from './automation-store.js';
import { canonicalizeNativePasteText, runNativeGeminiPaste } from './native-gemini-paste.js';

const TOKEN_FILE = 'worker-token';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address === '::1'
    || address === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(address)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(address);
}

function lastForwardedAddress(req) {
  const forwarded = req.get('x-forwarded-for');
  if (!forwarded) return null;
  const addresses = forwarded.split(',').map(value => value.trim()).filter(Boolean);
  return addresses.at(-1) || null;
}

async function ensureWorkerToken(rootDir) {
  await fs.mkdir(rootDir, { recursive: true });
  const tokenPath = path.join(rootDir, TOKEN_FILE);

  try {
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(token)) return token;
    throw new Error('worker token file is malformed');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const temporaryPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, tokenPath);
  return token;
}

function isLocalUiRequest(req) {
  // The API can be reached directly or through Vite's local proxy. Reject a
  // LAN client even when it spoofs Host/Origin; `xfwd` appends the proxy's
  // actual client address as the final X-Forwarded-For entry.
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const forwardedAddress = lastForwardedAddress(req);
  if (forwardedAddress && !isLoopbackAddress(forwardedAddress)) return false;

  const host = String(req.hostname || '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return false;

  const origin = req.get('origin');
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function tokensMatch(expected, supplied) {
  if (typeof supplied !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function httpStatus(error) {
  const candidate = Number(error?.statusCode || error?.status);
  return candidate >= 400 && candidate <= 599 ? candidate : 500;
}

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(error => {
    const status = httpStatus(error);
    if (status >= 500) console.error('[automation]', error);
    if (!res.headersSent) {
      res.status(status).json({
        error: error.message || 'Automation request failed',
        code: error.code || 'automation_error',
      });
    }
  });
}

function sanitizeNativePasteTelemetry(value, {
  targetUrl,
  prompt,
  pasteMode,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Native paste helper returned invalid telemetry'), {
      status: 502,
      code: 'native_paste_invalid_telemetry',
    });
  }
  const numeric = name => {
    const candidate = Number(value[name]);
    if (!Number.isFinite(candidate) || candidate < 0 || candidate > 120_000) {
      throw Object.assign(new Error('Native paste helper returned invalid telemetry'), {
        status: 502,
        code: 'native_paste_invalid_telemetry',
      });
    }
    return candidate;
  };
  const verifiedAtMs = Date.parse(value.verifiedAt);
  const hash = name => typeof value[name] === 'string' && /^[a-f0-9]{64}$/.test(value[name])
    ? value[name]
    : null;
  const promptSha256 = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  const promptCanonicalSha256 = crypto.createHash('sha256')
    .update(canonicalizeNativePasteText(prompt), 'utf8')
    .digest('hex');
  if (
    value.schemaVersion !== 1
    || !['windows-native-clipboard', 'windows-native-uia-value'].includes(value.transport)
    || value.targetUrl !== targetUrl
    || value.pasteMode !== pasteMode
    || (['fill-empty', 'replace-open-edit'].includes(pasteMode)
      && (value.sourceVerified !== false || value.sourceCanonicalSha256 !== null))
    || !Number.isInteger(value.chromeProcessId)
    || value.chromeProcessId < 1
    || value.promptCharacters !== prompt.length
    || value.promptUtf8Bytes !== Buffer.byteLength(prompt, 'utf8')
    || typeof value.blankLinesCollapsed !== 'boolean'
    || typeof value.normalizationApplied !== 'boolean'
    || typeof value.idempotent !== 'boolean'
    || typeof value.clipboardTouched !== 'boolean'
    || (value.transport === 'windows-native-clipboard'
      ? value.clipboardTouched === value.idempotent
      : value.clipboardTouched !== false)
    || value.clipboardRestored !== true
    || hash('promptSha256') !== promptSha256
    || hash('promptCanonicalSha256') !== promptCanonicalSha256
    || !hash('readbackSha256')
    || hash('readbackCanonicalSha256') !== promptCanonicalSha256
    || !Number.isFinite(verifiedAtMs)
  ) {
    throw Object.assign(new Error('Native paste helper returned invalid telemetry'), {
      status: 502,
      code: 'native_paste_invalid_telemetry',
    });
  }
  return {
    schemaVersion: 1,
    transport: value.transport,
    targetUrl,
    chromeProcessId: value.chromeProcessId,
    promptCharacters: value.promptCharacters,
    promptUtf8Bytes: value.promptUtf8Bytes,
    findWindowMs: numeric('findWindowMs'),
    focusMs: numeric('focusMs'),
    pasteMs: numeric('pasteMs'),
    clipboardHeldMs: numeric('clipboardHeldMs'),
    readbackMs: numeric('readbackMs'),
    totalMs: numeric('totalMs'),
    idempotent: value.idempotent,
    clipboardTouched: value.clipboardTouched,
    clipboardRestored: value.clipboardRestored,
    blankLinesCollapsed: value.blankLinesCollapsed,
    normalizationApplied: value.normalizationApplied,
    promptSha256,
    promptCanonicalSha256,
    readbackSha256: value.readbackSha256,
    readbackCanonicalSha256: value.readbackCanonicalSha256,
    pasteMode,
    sourceVerified: value.sourceVerified,
    sourceCanonicalSha256: value.sourceCanonicalSha256,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
  };
}

/**
 * Mount the durable Gemini-web automation API.
 *
 * Management routes are restricted to a local UI origin. Worker routes use a
 * random token stored beside the run manifests; the token never enters the
 * extension until the user explicitly pairs it in the options page.
 */
export async function registerAutomationRoutes(app, {
  rootDir,
  apiPort,
  storeOptions = {},
  nativePasteExecutor = runNativeGeminiPaste,
} = {}) {
  if (!rootDir) throw new Error('Automation rootDir is required');

  const store = new AutomationStore(rootDir, storeOptions);
  await store.init();
  const workerToken = await ensureWorkerToken(rootDir);
  const router = express.Router();
  let workerPresence = null;
  let nativePasteTail = Promise.resolve();
  const withNativePasteLock = operation => {
    const result = nativePasteTail.then(operation, operation);
    nativePasteTail = result.catch(() => {});
    return result;
  };

  const noteWorker = ({ workerId, pageUrl, modelLabel, taskId } = {}) => {
    const next = {
      ...(workerPresence || {}),
      id: String(workerId || workerPresence?.id || '').slice(0, 160),
      lastSeenAt: new Date().toISOString(),
    };
    if (typeof pageUrl === 'string' && pageUrl.length <= 2_000) next.pageUrl = pageUrl;
    if (typeof modelLabel === 'string' && modelLabel.length <= 160) next.currentModel = modelLabel;
    if (typeof taskId === 'string' && taskId.length <= 200) next.taskId = taskId;
    workerPresence = next;
  };

  const requireLocalUi = (req, res, next) => {
    if (!isLocalUiRequest(req)) {
      return res.status(403).json({ error: 'Automation management is only available from NovelWeb on this machine' });
    }
    next();
  };

  const requireWorkerToken = (req, res, next) => {
    if (!tokensMatch(workerToken, req.get('x-novelweb-worker-token'))) {
      return res.status(401).json({ error: 'Gemini worker is not paired with this NovelWeb instance' });
    }
    next();
  };

  router.get('/status', requireLocalUi, asyncRoute(async (_req, res) => {
    const aggregate = await store.getWorkerStatus();
    const worker = { ...aggregate, ...(workerPresence || {}) };
    const lastSeenAt = worker?.lastSeenAt || null;
    // Disabled/idle runners intentionally heartbeat every ~30 seconds. Keep a
    // little scheduling headroom so the UI does not flicker offline between
    // healthy heartbeats.
    const connected = Boolean(lastSeenAt && Date.now() - Date.parse(lastSeenAt) < 45_000);
    res.set('Cache-Control', 'no-store');
    res.json({
      worker: { ...worker, connected },
      pairing: {
        serverUrl: `http://127.0.0.1:${apiPort || 3001}`,
        token: workerToken,
      },
      storageDir: rootDir,
    });
  }));

  router.get('/runs', requireLocalUi, asyncRoute(async (_req, res) => {
    res.json(await store.listRuns());
  }));

  router.get('/conversation-snapshots', requireLocalUi, asyncRoute(async (_req, res) => {
    res.json(await store.listConversationSnapshots());
  }));

  router.get('/conversation-snapshots/:snapshotId', requireLocalUi, asyncRoute(async (req, res) => {
    res.json(await store.getConversationSnapshot(req.params.snapshotId));
  }));

  router.post('/conversation-snapshots', requireLocalUi, asyncRoute(async (req, res) => {
    res.status(201).json(await store.createConversationSnapshot(req.body || {}));
  }));

  router.get('/vpn-experiments', requireLocalUi, asyncRoute(async (_req, res) => {
    res.json(await store.listVpnExperiments());
  }));

  router.get('/vpn-experiments/:experimentId', requireLocalUi, asyncRoute(async (req, res) => {
    res.json(await store.getVpnExperiment(req.params.experimentId));
  }));

  router.post('/vpn-experiments', requireLocalUi, asyncRoute(async (req, res) => {
    res.status(201).json(await store.createVpnExperiment(req.body || {}));
  }));

  router.post('/vpn-experiments/:experimentId/trials', requireLocalUi, asyncRoute(async (req, res) => {
    res.status(201).json(await store.addVpnExperimentTrial(req.params.experimentId, req.body || {}));
  }));

  router.get('/runs/:runId', requireLocalUi, asyncRoute(async (req, res) => {
    res.json(await store.getRun(req.params.runId));
  }));

  router.get('/runs/:runId/results', requireLocalUi, asyncRoute(async (req, res) => {
    res.json(await store.getRunResults(req.params.runId));
  }));

  router.get('/runs/:runId/promptlab-export', requireLocalUi, asyncRoute(async (req, res) => {
    res.json(await store.getRunResults(req.params.runId, { promptLab: true }));
  }));

  router.post('/runs', requireLocalUi, asyncRoute(async (req, res) => {
    const run = await store.createRun(req.body || {});
    res.status(201).json(run);
  }));

  router.post('/runs/:runId/actions', requireLocalUi, asyncRoute(async (req, res) => {
    const action = req.body?.action;
    if (typeof action !== 'string') {
      return res.status(400).json({ error: 'action is required' });
    }
    res.json(await store.runAction(req.params.runId, action));
  }));

  router.get('/worker/ping', requireWorkerToken, (_req, res) => {
    res.json({ ok: true, service: 'novelweb-gemini-worker', now: new Date().toISOString() });
  });

  router.get('/worker/next', requireWorkerToken, asyncRoute(async (req, res) => {
    const workerId = String(req.query.workerId || '').trim();
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    noteWorker({
      workerId,
      pageUrl: req.query.pageUrl ? String(req.query.pageUrl) : undefined,
      modelLabel: req.query.modelLabel ? String(req.query.modelLabel) : undefined,
    });
    const task = await store.claimNext({
      workerId,
      pageUrl: req.query.pageUrl ? String(req.query.pageUrl) : undefined,
      modelLabel: req.query.modelLabel ? String(req.query.modelLabel) : undefined,
    });
    if (!task) return res.status(204).end();
    res.json({ ...task, id: task.id || task.taskId });
  }));

  router.post('/worker/heartbeat', requireWorkerToken, asyncRoute(async (req, res) => {
    const workerId = String(req.body?.workerId || '').trim();
    const taskId = String(req.body?.taskId || '').trim();
    if (!workerId) {
      return res.status(400).json({ error: 'workerId is required' });
    }
    noteWorker({
      workerId,
      taskId,
      pageUrl: req.body?.pageUrl,
      modelLabel: req.body?.modelLabel,
    });
    if (!taskId) return res.json({ ok: true, idle: true });
    res.json(await store.heartbeat(taskId, {
      workerId,
      leaseId: req.body?.leaseId,
      pageUrl: req.body?.pageUrl,
      modelLabel: req.body?.modelLabel,
    }));
  }));

  router.post('/worker/conversation-snapshots/:snapshotId/heartbeat', requireWorkerToken, asyncRoute(async (req, res) => {
    const workerId = String(req.body?.workerId || '').trim();
    const leaseId = String(req.body?.leaseId || '').trim();
    if (!workerId || !leaseId) {
      return res.status(400).json({ error: 'workerId and leaseId are required' });
    }
    noteWorker({ workerId });
    res.json(await store.heartbeatConversationSnapshot(req.params.snapshotId, { workerId, leaseId }));
  }));

  router.post('/worker/conversation-snapshots/:snapshotId/events', requireWorkerToken, asyncRoute(async (req, res) => {
    const workerId = String(req.body?.workerId || '').trim();
    if (!workerId) return res.status(400).json({ error: 'workerId is required' });
    noteWorker({ workerId, pageUrl: req.body?.conversationUrl });
    const { workerId: _ignored, ...event } = req.body;
    res.json(await store.recordConversationSnapshotEvent(
      req.params.snapshotId,
      event,
      { workerId },
    ));
  }));

  router.post('/worker/tasks/:taskId/native-paste', requireWorkerToken, asyncRoute(async (req, res) => {
    const workerId = String(req.body?.workerId || '').trim();
    const leaseId = String(req.body?.leaseId || '').trim();
    if (!workerId || !leaseId) {
      return res.status(400).json({ error: 'workerId and leaseId are required' });
    }
    noteWorker({ workerId, taskId: req.params.taskId });
    const payload = await store.prepareNativePaste(req.params.taskId, { workerId, leaseId });
    const result = await withNativePasteLock(() => nativePasteExecutor({
      prompt: payload.prompt,
      targetUrl: payload.targetUrl,
      pasteMode: payload.pasteMode,
    }));
    const telemetry = sanitizeNativePasteTelemetry(result?.telemetry, payload);
    res.json({ ok: true, telemetry });
  }));

  router.post('/worker/tasks/:taskId/events', requireWorkerToken, asyncRoute(async (req, res) => {
    const workerId = String(req.body?.workerId || '').trim();
    const type = String(req.body?.type || '').trim();
    if (!workerId || !type) {
      return res.status(400).json({ error: 'workerId and event type are required' });
    }
    noteWorker({
      workerId,
      taskId: req.params.taskId,
      pageUrl: req.body?.conversationUrl || req.body?.pageUrl,
      modelLabel: req.body?.modelLabel,
    });
    const { workerId: _ignored, ...event } = req.body;
    if (!event.model && typeof event.modelLabel === 'string') event.model = event.modelLabel;
    if (!event.error && typeof event.message === 'string') event.error = event.message;
    res.json(await store.recordTaskEvent(req.params.taskId, event, { workerId }));
  }));

  app.use('/api/automation', router);
  return { store, workerToken };
}
