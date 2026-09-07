"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  prewarmEnabled: true,
  serverUrl: "http://127.0.0.1:3001",
  pairingToken: "",
  workerId: ""
});

const OUTBOX_KEY = "nwGeminiRunnerOutbox";
const RECOVERY_KEY = "nwGeminiRunnerRecoveries";
const ACTIVE_TASK_KEY = "nwGeminiRunnerActiveTask";
const MAX_OUTBOX_ITEMS = 500;
const API_PATH_PREFIX = "/api/automation/";
const RUNNER_LOCK_KEY = "nwGeminiRunnerTabLock";
const RUNNER_LOCK_TTL_MS = 120000;
const BOOTSTRAP_RESOURCE = "bootstrap.local.json";
const BOOTSTRAP_SCHEMA_VERSION = 1;
const LAST_BOOTSTRAP_ID_KEY = "nwGeminiRunnerLastBootstrapId";
const LAST_BOOTSTRAP_AT_KEY = "nwGeminiRunnerLastBootstrapAt";
let flushPromise = null;
let outboxTail = Promise.resolve();
let runnerLockTail = Promise.resolve();
let initializationPromise = null;
const runnerActivationJobs = new Map();

function randomId(prefix = "nw-gemini") {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function normalizedLocalServerUrl(value) {
  const parsed = new URL(String(value || DEFAULT_SETTINGS.serverUrl));
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  if (parsed.protocol !== "http:" || !allowedHosts.has(parsed.hostname)) {
    throw new Error("NovelWeb server URL must be a local http://localhost or http://127.0.0.1 address.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

function canonicalGeminiConversationUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.origin !== "https://gemini.google.com") return "";
    if (/^\/app\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    if (/^\/gem\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
      return `${parsed.origin}${parsed.pathname}`;
    }
  } catch {
    // Invalid URLs fail closed below.
  }
  return "";
}

function validateBootstrapConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bootstrap configuration must be a JSON object.");
  }
  const allowedKeys = new Set(["schemaVersion", "bootstrapId", "serverUrl", "pairingToken"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Bootstrap configuration contains an unsupported field.");
  }
  if (value.schemaVersion !== BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error("Bootstrap configuration has an unsupported schema version.");
  }
  if (typeof value.bootstrapId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/.test(value.bootstrapId)) {
    throw new Error("Bootstrap ID is invalid.");
  }
  if (typeof value.pairingToken !== "string"
      || value.pairingToken.length > 512
      || !/^[A-Za-z0-9_-]{32,}$/.test(value.pairingToken)) {
    throw new Error("Bootstrap pairing token is invalid.");
  }
  if (typeof value.serverUrl !== "string" || value.serverUrl !== value.serverUrl.trim()) {
    throw new Error("Bootstrap server URL is invalid.");
  }
  let parsed;
  try {
    parsed = new URL(value.serverUrl);
  } catch {
    throw new Error("Bootstrap server URL is invalid.");
  }
  if (parsed.protocol !== "http:"
      || !new Set(["127.0.0.1", "localhost"]).has(parsed.hostname)
      || parsed.username
      || parsed.password
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash) {
    throw new Error("Bootstrap server URL must be a clean local HTTP base URL.");
  }
  return Object.freeze({
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    bootstrapId: value.bootstrapId,
    serverUrl: normalizedLocalServerUrl(value.serverUrl),
    pairingToken: value.pairingToken
  });
}

function parseBootstrapText(raw) {
  if (!raw || raw.length > 4096) throw new Error("Bootstrap configuration has an invalid size.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Bootstrap configuration is not valid JSON.");
  }
  return validateBootstrapConfig(parsed);
}

async function readOptionalBootstrap() {
  const resourceUrl = chrome.runtime.getURL(BOOTSTRAP_RESOURCE);
  let response;
  try {
    response = await fetch(resourceUrl, { cache: "no-store", credentials: "omit" });
  } catch {
    // A missing chrome-extension:// resource is surfaced as a rejected fetch in
    // some Chromium builds rather than a 404 Response. The file is optional;
    // the launcher detects non-consumption because no bootstrap heartbeat occurs.
    return null;
  }
  if (!response?.ok) return null;
  return parseBootstrapText(await response.text());
}

function validateApiPath(path) {
  const value = String(path || "");
  if (!value || value.includes("\\") || value.includes("#")) {
    throw new Error("The extension only proxies NovelWeb automation API calls.");
  }
  const base = new URL("http://local.invalid/");
  const parsed = new URL(value, base);
  if (parsed.origin !== base.origin
      || parsed.username
      || parsed.password
      || !parsed.pathname.startsWith(API_PATH_PREFIX)) {
    throw new Error("The extension only proxies NovelWeb automation API calls.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const changes = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof current[key] === "undefined") changes[key] = value;
  }
  if (!current.workerId) changes.workerId = randomId();
  if (Object.keys(changes).length) await chrome.storage.local.set(changes);
  return { ...DEFAULT_SETTINGS, ...current, ...changes };
}

async function readSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!stored.workerId) {
    stored.workerId = randomId();
    await chrome.storage.local.set({ workerId: stored.workerId });
  }
  stored.serverUrl = normalizedLocalServerUrl(stored.serverUrl);
  return stored;
}

async function getSettings() {
  await initializeOnce();
  return readSettings();
}

async function updateBadge() {
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#2e6b45" : "#777777" });
}

async function performApiRequest(settings, { path, method = "GET", body, timeoutMs = 15000, serverUrl }) {
  const baseUrl = normalizedLocalServerUrl(serverUrl || settings.serverUrl);
  const apiPath = validateApiPath(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(Number(timeoutMs) || 15000, 60000)));
  try {
    const headers = {
      Accept: "application/json",
      "X-NovelWeb-Worker-Token": String(settings.pairingToken || "")
    };
    const options = {
      method: String(method || "GET").toUpperCase(),
      headers,
      cache: "no-store",
      signal: controller.signal
    };
    if (typeof body !== "undefined") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${apiPath}`, options);
    const text = response.status === 204 ? "" : await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 1000) };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? null : (data?.error || data?.message || `HTTP ${response.status}`)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error?.name === "AbortError" ? "NovelWeb request timed out." : String(error?.message || error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function initializeBackground() {
  let settings = await ensureDefaults();
  let bootstrap;
  try {
    bootstrap = await readOptionalBootstrap();
  } catch (error) {
    await chrome.storage.local.set({ enabled: false });
    await updateBadge().catch(() => {});
    throw error;
  }

  if (bootstrap) {
    const marker = await chrome.storage.local.get({ [LAST_BOOTSTRAP_ID_KEY]: "" });
    const alreadyConsumed = marker[LAST_BOOTSTRAP_ID_KEY] === bootstrap.bootstrapId;
    if (!alreadyConsumed) {
      const runtime = await chrome.storage.local.get({
        [ACTIVE_TASK_KEY]: null,
        [OUTBOX_KEY]: []
      });
      const outbox = Array.isArray(runtime[OUTBOX_KEY]) ? runtime[OUTBOX_KEY] : [];
      const busy = Boolean(runtime[ACTIVE_TASK_KEY]) || outbox.length > 0;
      const connectionChanged = normalizedLocalServerUrl(settings.serverUrl) !== bootstrap.serverUrl
        || String(settings.pairingToken || "") !== bootstrap.pairingToken;
      if (busy && connectionChanged) {
        await chrome.storage.local.set({ enabled: false });
        await updateBadge().catch(() => {});
        throw new Error("Bootstrap cannot change pairing while an active task or local outbox is present.");
      }

      const bootstrapSettings = {
        serverUrl: bootstrap.serverUrl,
        pairingToken: bootstrap.pairingToken,
        enabled: true
      };
      await chrome.storage.local.set(bootstrapSettings);
      // This is a deliberate launcher restart, not a browser-crash recovery.
      // Drop only the old in-progress marker so a canceled page from a prior
      // run cannot keep a fresh background worker on the wrong conversation.
      await chrome.storage.local.remove(ACTIVE_TASK_KEY);
      // This is a dedicated NovelWeb browser profile. A new local pairing should
      // be ready to work immediately, and must not inherit an old tab lock.
      await chrome.storage.session.remove(RUNNER_LOCK_KEY);
      settings = { ...settings, ...bootstrapSettings };
      await updateBadge();
    } else {
      // Re-launching the dedicated NovelWeb browser is meant to resume work,
      // not to leave its runner silently switched off.
      await chrome.storage.local.set({ enabled: true });
      settings = { ...settings, enabled: true };
      await chrome.storage.session.remove(RUNNER_LOCK_KEY);
      await updateBadge();
    }

    // A launcher may stage the same bootstrap again solely to verify that this
    // profile still holds working credentials. Re-ACK with the stored settings,
    // but never reapply the file or reset the user's enabled choice.
    const heartbeat = await performApiRequest(settings, {
      path: "/api/automation/worker/heartbeat",
      method: "POST",
      timeoutMs: 12000,
      body: {
        workerId: settings.workerId,
        taskId: null,
        modelLabel: `bootstrap:${bootstrap.bootstrapId}`
      }
    });
    if (!heartbeat.ok) {
      throw new Error(`Bootstrap pairing heartbeat failed${heartbeat.status ? ` (HTTP ${heartbeat.status})` : ""}.`);
    }
    if (!alreadyConsumed) {
      await chrome.storage.local.set({
        [LAST_BOOTSTRAP_ID_KEY]: bootstrap.bootstrapId,
        [LAST_BOOTSTRAP_AT_KEY]: new Date().toISOString()
      });
    }
  }

  await updateBadge();
  return readSettings();
}

function initializeOnce() {
  if (!initializationPromise) initializationPromise = initializeBackground();
  return initializationPromise;
}

async function apiRequest(request) {
  const settings = await getSettings();
  const apiPath = validateApiPath(request?.path);
  const pathname = new URL(apiPath, "http://local.invalid/").pathname;
  if (pathname === "/api/automation/worker/next" && !settings.enabled) {
    return {
      ok: false,
      status: 423,
      data: null,
      error: "Gemini runner is disabled; no task was claimed."
    };
  }
  return performApiRequest(settings, { ...request, path: apiPath });
}

async function readOutbox() {
  const stored = await chrome.storage.local.get({ [OUTBOX_KEY]: [] });
  return Array.isArray(stored[OUTBOX_KEY]) ? stored[OUTBOX_KEY] : [];
}

async function writeOutbox(items) {
  if (items.length > MAX_OUTBOX_ITEMS) {
    throw new Error(`Local result outbox is full (${items.length}/${MAX_OUTBOX_ITEMS}).`);
  }
  await chrome.storage.local.set({ [OUTBOX_KEY]: items });
}

async function clearDeliveredRecovery(taskId, leaseId) {
  const stored = await chrome.storage.local.get({ [RECOVERY_KEY]: [] });
  const recoveries = Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY] : [];
  const next = recoveries.filter((item) => item.taskId !== taskId || item.leaseId !== leaseId);
  if (next.length !== recoveries.length) await chrome.storage.local.set({ [RECOVERY_KEY]: next });
}

function withOutboxLock(operation) {
  const result = outboxTail.then(operation, operation);
  outboxTail = result.catch(() => {});
  return result;
}

function withRunnerLock(operation) {
  const result = runnerLockTail.then(operation, operation);
  runnerLockTail = result.catch(() => {});
  return result;
}

async function enqueueOutbox(entry) {
  if (!entry || typeof entry !== "object" || !entry.id || !entry.taskId || !entry.body?.eventId) {
    throw new Error("Invalid outbox event.");
  }
  let outbox = await readOutbox();
  if (outbox.some((item) => item.id === entry.id)) {
    return { ok: true, queued: true, duplicate: true, pending: outbox.length };
  }
  const terminalRank = { completed: 3, blocked: 2, failed: 2 };
  const incomingRank = terminalRank[entry.body.type] || 0;
  const existingTerminalRank = outbox
    .filter((item) => item.taskId === entry.taskId)
    .reduce((rank, item) => Math.max(rank, terminalRank[item.body?.type] || 0), 0);
  if (entry.body.type !== "completed"
      && existingTerminalRank >= incomingRank
      && existingTerminalRank > 0) {
    return { ok: true, queued: false, suppressed: true, pending: outbox.length };
  }
  const isTerminal = ["completed", "blocked", "failed"].includes(entry.body.type);
  if (isTerminal) {
    // Terminal events supersede stale, undelivered progress for the same task.
    // The final answer is irreplaceable and all terminal reports jump the queue.
    outbox = outbox.filter((item) => item.taskId !== entry.taskId);
    outbox.unshift(entry);
  } else {
    outbox.push(entry);
  }
  await writeOutbox(outbox);
  return { ok: true, queued: true, pending: outbox.length };
}

async function doFlushOutbox() {
  let outbox = await readOutbox();
  const deliveredIds = [];
  let lastError = null;

  for (const entry of [...outbox]) {
    const result = await apiRequest({
      path: `/api/automation/worker/tasks/${encodeURIComponent(entry.taskId)}/events`,
      method: "POST",
      body: entry.body,
      timeoutMs: 30000,
      serverUrl: entry.serverUrl
    });
    // The server returns 200 for an idempotent duplicate. A 409 can instead mean
    // lease-owner mismatch or an invalid transition, so retaining the only local
    // copy is essential until the user resolves the conflict.
    if (result.ok) {
      deliveredIds.push(entry.id);
      if (entry.body?.type === "completed") {
        await clearDeliveredRecovery(entry.taskId, entry.body.leaseId).catch(() => {});
      }
      // Re-read after the network wait before deleting. This is defensive even
      // though all normal mutations share the serialized outbox lock.
      outbox = await readOutbox();
      outbox = ["completed", "blocked", "failed"].includes(entry.body?.type)
        ? outbox.filter((item) => item.taskId !== entry.taskId)
        : outbox.filter((item) => item.id !== entry.id);
      await writeOutbox(outbox);
      continue;
    }

    lastError = result.error || `HTTP ${result.status}`;
    outbox = await readOutbox();
    const index = outbox.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      outbox[index] = {
        ...outbox[index],
        attempts: Number(outbox[index].attempts || 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError
      };
      await writeOutbox(outbox);
    }
    // Authentication, connectivity, throttling, and server failures affect the
    // whole queue. A per-event 4xx conflict must not head-of-line block a later
    // completed answer (possibly from a canceled task) or another task.
    if (result.status === 0
        || result.status === 401
        || result.status === 403
        || result.status === 429
        || result.status >= 500) break;
  }

  return {
    ok: outbox.length === 0,
    deliveredIds,
    pending: outbox.length,
    lastError
  };
}

function flushOutbox() {
  if (!flushPromise) {
    flushPromise = withOutboxLock(doFlushOutbox).finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

async function runnerLock(message, sender) {
  const tabId = sender?.tab?.id;
  const senderUrl = String(sender?.tab?.url || sender?.url || "");
  if (!Number.isInteger(tabId) || !senderUrl.startsWith("https://gemini.google.com/")) {
    return { ok: false, acquired: false, error: "Runner lock is only available to a Gemini tab." };
  }
  const ownerKey = `tab:${tabId}`;
  const action = String(message.action || "acquire");
  const stored = await chrome.storage.session.get({ [RUNNER_LOCK_KEY]: null });
  const current = stored[RUNNER_LOCK_KEY];
  const now = Date.now();

  if (action === "release") {
    if (current?.ownerKey === ownerKey) await chrome.storage.session.remove(RUNNER_LOCK_KEY);
    return { ok: true, acquired: false, ownerKey };
  }
  if (action !== "acquire" && action !== "renew") {
    return { ok: false, acquired: false, error: "Unknown runner lock action." };
  }
  if (current && current.ownerKey !== ownerKey && Number(current.expiresAt || 0) > now) {
    return { ok: true, acquired: false, ownerKey, heldBy: current.ownerKey, expiresAt: current.expiresAt };
  }
  const next = { ownerKey, tabId, expiresAt: now + RUNNER_LOCK_TTL_MS, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [RUNNER_LOCK_KEY]: next });
  return { ok: true, acquired: true, ownerKey, expiresAt: next.expiresAt };
}

function canonicalRunnerActivationUrl(value, newChat = false) {
  if (newChat && value === "https://gemini.google.com/app") return value;
  return canonicalGeminiConversationUrl(value);
}

function runnerActivationKey(tabId, expectedUrl, newChat = false) {
  return `${tabId}:${expectedUrl}${newChat ? ":new-chat" : ""}`;
}

async function runnerTabState(tabId, expectedUrl, newChat = false) {
  if (newChat) {
    const stored = await chrome.storage.session.get({ [RUNNER_LOCK_KEY]: null });
    const lock = stored[RUNNER_LOCK_KEY];
    if (lock?.tabId !== tabId || lock.ownerKey !== `tab:${tabId}` || lock.expiresAt <= Date.now()) {
      throw new Error("New-chat activation requires the current runner lock owned by the sender tab.");
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("The Gemini runner tab is no longer available.");
  }
  if (canonicalRunnerActivationUrl(tab?.url, newChat) !== expectedUrl) {
    throw new Error("The Gemini runner tab changed conversations before activation.");
  }
  if (!Number.isInteger(tab.windowId)) {
    throw new Error("The Gemini runner tab has no valid browser window.");
  }
  let windowState;
  try {
    windowState = await chrome.windows.get(tab.windowId);
  } catch {
    throw new Error("The Gemini runner window is no longer available.");
  }
  return {
    tab,
    window: windowState,
    ready: tab.active === true && windowState?.focused === true
  };
}

function scheduleRunnerTabActivation(tabId, expectedUrl, newChat = false) {
  const key = runnerActivationKey(tabId, expectedUrl, newChat);
  const existing = runnerActivationJobs.get(key);
  if (existing?.status === "pending") return;
  const job = { status: "pending", error: "" };
  runnerActivationJobs.set(key, job);

  // The original message must be ACKed before an active-tab change:
  // some Chromium builds tear down that sender port during the UI transition.
  setTimeout(() => {
    (async () => {
      let state = await runnerTabState(tabId, expectedUrl, newChat);
      if (!state.tab.active) await chrome.tabs.update(tabId, { active: true });
      state = await runnerTabState(tabId, expectedUrl, newChat);
      if (!state.window?.focused) await chrome.windows.update(state.tab.windowId, { focused: true });
      state = await runnerTabState(tabId, expectedUrl, newChat);
      if (!state.ready) throw new Error("The expected Gemini runner tab could not be activated safely.");
      job.status = "ready";
    })().catch((error) => {
      job.status = "failed";
      job.error = String(error?.message || error || "Runner tab activation failed.");
    });
  }, 0);
}

async function activateRunnerTab(message, sender) {
  const tabId = sender?.tab?.id;
  const newChat = message?.newChat === true;
  const expectedUrl = canonicalRunnerActivationUrl(message?.expectedUrl, newChat);
  if (!Number.isInteger(tabId) || !expectedUrl) {
    return { ok: false, error: "A canonical Gemini conversation and its sender tab are required." };
  }
  const senderUrl = canonicalRunnerActivationUrl(sender?.tab?.url || sender?.url, newChat);
  if (senderUrl !== expectedUrl) {
    return { ok: false, error: "The requesting tab is not on the expected Gemini conversation." };
  }

  try {
    const state = await runnerTabState(tabId, expectedUrl, newChat);
    if (state.ready) {
      runnerActivationJobs.delete(runnerActivationKey(tabId, expectedUrl, newChat));
      return {
        ok: true,
        activationPending: false,
        tabId,
        windowId: state.tab.windowId,
        conversationUrl: expectedUrl
      };
    }
    scheduleRunnerTabActivation(tabId, expectedUrl, newChat);
    return {
      ok: true,
      activationPending: true,
      tabId,
      windowId: state.tab.windowId,
      conversationUrl: expectedUrl
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function confirmRunnerTabActivation(message, sender) {
  const tabId = sender?.tab?.id;
  const newChat = message?.newChat === true;
  const expectedUrl = canonicalRunnerActivationUrl(message?.expectedUrl, newChat);
  const senderUrl = canonicalRunnerActivationUrl(sender?.tab?.url || sender?.url, newChat);
  if (!Number.isInteger(tabId) || !expectedUrl || senderUrl !== expectedUrl) {
    return { ok: false, error: "Activation confirmation is not bound to the expected Gemini sender tab." };
  }
  const key = runnerActivationKey(tabId, expectedUrl, newChat);
  const job = runnerActivationJobs.get(key);
  if (job?.status === "failed") {
    runnerActivationJobs.delete(key);
    return { ok: false, error: job.error || "The Gemini runner tab could not be activated safely." };
  }
  try {
    const state = await runnerTabState(tabId, expectedUrl, newChat);
    if (state.ready) {
      runnerActivationJobs.delete(key);
      return {
        ok: true,
        activationPending: false,
        tabId,
        windowId: state.tab.windowId,
        conversationUrl: expectedUrl
      };
    }
    if (!job || job.status !== "pending") scheduleRunnerTabActivation(tabId, expectedUrl, newChat);
    return {
      ok: true,
      activationPending: true,
      tabId,
      windowId: state.tab.windowId,
      conversationUrl: expectedUrl
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeOnce().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  initializeOnce().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) updateBadge().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "NW_WAIT_INITIALIZED") {
    initializeOnce()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_API_REQUEST") {
    apiRequest(message.request || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_FLUSH_OUTBOX") {
    flushOutbox()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, pending: -1, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_ENQUEUE_OUTBOX") {
    withOutboxLock(() => enqueueOutbox(message.entry))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_RUNNER_LOCK") {
    withRunnerLock(() => runnerLock(message, sender))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, acquired: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_ACTIVATE_RUNNER_TAB") {
    activateRunnerTab(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_CONFIRM_RUNNER_TAB_ACTIVATION") {
    confirmRunnerTabActivation(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "NW_GET_BACKGROUND_STATUS") {
    initializeOnce()
      .then(() => Promise.all([
        readSettings(),
        readOutbox(),
        chrome.storage.local.get({ [RECOVERY_KEY]: [] })
      ]))
      .then(([settings, outbox, recoveryStore]) => sendResponse({
        ok: true,
        enabled: settings.enabled,
        workerId: settings.workerId,
        serverUrl: settings.serverUrl,
        outboxCount: outbox.length,
        recoveryCount: Array.isArray(recoveryStore[RECOVERY_KEY]) ? recoveryStore[RECOVERY_KEY].length : 0
      }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

initializeOnce().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  withRunnerLock(async () => {
    const stored = await chrome.storage.session.get({ [RUNNER_LOCK_KEY]: null });
    if (stored[RUNNER_LOCK_KEY]?.tabId === tabId) await chrome.storage.session.remove(RUNNER_LOCK_KEY);
  }).catch(() => {});
});
