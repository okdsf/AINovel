"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(query) {
      if (query == null) return { ...data };
      if (typeof query === "string") return { [query]: data[query] };
      if (Array.isArray(query)) return Object.fromEntries(query.map((key) => [key, data[key]]));
      const result = { ...query };
      for (const key of Object.keys(query)) {
        if (Object.hasOwn(data, key)) result[key] = data[key];
      }
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    }
  };
}

async function harness(fetchImpl = async () => response(200), options = {}) {
  const listeners = {};
  const tabState = new Map();
  const windowState = new Map([[7, { id: 7, focused: options.windowFocused !== false }]]);
  const activationCalls = [];
  const local = storageArea({
    enabled: false,
    serverUrl: "http://127.0.0.1:3001",
    pairingToken: "test-token",
    workerId: "worker-test",
    nwGeminiRunnerOutbox: [],
    ...(options.initialLocal || {})
  });
  const session = storageArea();
  let bootstrapFetchCount = 0;
  const chrome = {
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    },
    runtime: {
      getURL(name) { return `chrome-extension://unit/${name}`; },
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } },
      onMessage: { addListener(fn) { listeners.message = fn; } }
    },
    storage: {
      local,
      session,
      onChanged: { addListener(fn) { listeners.storageChanged = fn; } }
    },
    tabs: {
      async get(tabId) {
        if (!tabState.has(tabId)) throw new Error("missing tab");
        return { ...tabState.get(tabId) };
      },
      async update(tabId, patch) {
        const current = tabState.get(tabId);
        if (!current) throw new Error("missing tab");
        if (typeof options.beforeTabUpdate === "function") await options.beforeTabUpdate(tabId, patch);
        const next = { ...current, ...patch };
        tabState.set(tabId, next);
        activationCalls.push({ type: "tab", tabId, patch });
        return { ...next };
      },
      onRemoved: { addListener(fn) { listeners.tabRemoved = fn; } }
    },
    windows: {
      async get(windowId) {
        if (!windowState.has(windowId)) throw new Error("missing window");
        return { ...windowState.get(windowId) };
      },
      async update(windowId, patch) {
        if (typeof options.beforeWindowUpdate === "function") await options.beforeWindowUpdate(windowId, patch);
        const current = windowState.get(windowId);
        if (!current) throw new Error("missing window");
        const next = { ...current, ...patch };
        windowState.set(windowId, next);
        activationCalls.push({ type: "window", windowId, patch });
        return { ...next };
      }
    }
  };
  const context = vm.createContext({
    AbortController,
    URL,
    chrome,
    console,
    crypto: { randomUUID },
    fetch: async (...args) => {
      if (String(args[0]).startsWith("chrome-extension://unit/bootstrap.local.json")) {
        bootstrapFetchCount += 1;
        const configured = options.bootstrapResponse;
        if (typeof configured === "function") return configured(...args);
        return configured || response(404);
      }
      return fetchImpl(...args);
    },
    globalThis: null,
    setTimeout,
    clearTimeout,
    structuredClone
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "background.js" });
  await new Promise((resolve) => setImmediate(resolve));

  async function message(payload, tabId = 1, senderUrl = "https://gemini.google.com/app") {
    return new Promise((resolve, reject) => {
      if (!tabState.has(tabId)) {
        tabState.set(tabId, { id: tabId, windowId: 7, url: senderUrl, active: false });
      }
      const sender = { tab: { ...tabState.get(tabId), url: senderUrl }, url: senderUrl };
      const timeout = setTimeout(() => reject(new Error("message timeout")), 2000);
      const asyncResponse = listeners.message(payload, sender, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
      if (asyncResponse !== true) {
        clearTimeout(timeout);
        reject(new Error("listener did not keep the response channel open"));
      }
    });
  }

  return {
    local,
    message,
    session,
    tabState,
    windowState,
    activationCalls,
    listeners,
    bootstrapFetchCount: () => bootstrapFetchCount
  };
}

function response(status, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; }
  };
}

function eventEntry(id, taskId, type) {
  return {
    id,
    eventId: id,
    taskId,
    serverUrl: "http://127.0.0.1:3001",
    body: { workerId: "worker-test", leaseId: "lease-1", eventId: id, type },
    createdAt: new Date().toISOString(),
    attempts: 0
  };
}

function bootstrapConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    bootstrapId: "bootstrap-unit-test-0001",
    serverUrl: "http://localhost:3001",
    pairingToken: "B".repeat(43),
    ...overrides
  };
}

test("bootstrap resource is neither committed nor web accessible", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "bootstrap.local.json")), false);
  const exposed = (manifest.web_accessible_resources || [])
    .flatMap((entry) => Array.isArray(entry.resources) ? entry.resources : []);
  assert.equal(exposed.includes("bootstrap.local.json"), false);
  assert.doesNotMatch(source, /getPackageDirectoryEntry/);
});

test("all startup paths share one initialization barrier", async () => {
  let releaseBootstrap;
  const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
  let apiFetches = 0;
  const app = await harness(async () => {
    apiFetches += 1;
    return response(200);
  }, {
    bootstrapResponse: async () => bootstrapGate
  });

  app.listeners.installed();
  app.listeners.startup();
  const waits = [
    app.message({ type: "NW_WAIT_INITIALIZED" }),
    app.message({ type: "NW_WAIT_INITIALIZED" }),
    app.message({
      type: "NW_API_REQUEST",
      request: { path: "/api/automation/worker/ping" }
    })
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.bootstrapFetchCount(), 1);
  assert.equal(apiFetches, 0);

  releaseBootstrap(response(404));
  const [readyA, readyB, ping] = await Promise.all(waits);
  assert.equal(readyA.ok, true);
  assert.equal(readyB.ok, true);
  assert.equal(ping.ok, true);
  assert.equal(apiFetches, 1);
});

test("launcher bootstrap enables the runner, resets its active marker, and preserves durable answers", async () => {
  const outbox = [eventEntry("saved-answer", "task-1", "completed")];
  const recovery = [{ id: "recovery-1", responsePartial: "answer" }];
  const active = { task: { id: "task-1" }, stage: "submitted" };
  const config = bootstrapConfig({
    serverUrl: "http://127.0.0.1:3001",
    pairingToken: "T".repeat(43)
  });
  const calls = [];
  const app = await harness(async (url, request) => {
    calls.push({ url: String(url), request });
    return response(200, JSON.stringify({ ok: true, idle: true }));
  }, {
    initialLocal: {
      enabled: true,
      serverUrl: config.serverUrl,
      pairingToken: config.pairingToken,
      workerId: "stable-worker",
      nwGeminiRunnerOutbox: outbox,
      nwGeminiRunnerRecoveries: recovery,
      nwGeminiRunnerActiveTask: active
    },
    bootstrapResponse: response(200, JSON.stringify(config))
  });

  const ready = await app.message({ type: "NW_WAIT_INITIALIZED" });
  assert.equal(ready.ok, true);
  assert.equal(Object.hasOwn(ready, "pairingToken"), false);
  assert.equal(app.local.data.enabled, true);
  assert.equal(app.local.data.serverUrl, config.serverUrl);
  assert.equal(app.local.data.pairingToken, config.pairingToken);
  assert.equal(app.local.data.workerId, "stable-worker");
  assert.deepEqual(app.local.data.nwGeminiRunnerOutbox, outbox);
  assert.deepEqual(app.local.data.nwGeminiRunnerRecoveries, recovery);
  assert.equal(app.local.data.nwGeminiRunnerActiveTask, undefined);
  assert.equal(app.local.data.nwGeminiRunnerLastBootstrapId, config.bootstrapId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${config.serverUrl}/api/automation/worker/heartbeat`);
  assert.equal(calls[0].request.headers["X-NovelWeb-Worker-Token"], config.pairingToken);
  assert.deepEqual(JSON.parse(calls[0].request.body), {
    workerId: "stable-worker",
    taskId: null,
    modelLabel: `bootstrap:${config.bootstrapId}`
  });
});

test("bootstrap connection changes fail closed while an outbox exists", async () => {
  const outbox = [eventEntry("saved-answer", "task-1", "completed")];
  const app = await harness(async () => {
    throw new Error("heartbeat must not run");
  }, {
    initialLocal: {
      enabled: true,
      serverUrl: "http://127.0.0.1:3001",
      pairingToken: "O".repeat(43),
      workerId: "stable-worker",
      nwGeminiRunnerOutbox: outbox
    },
    bootstrapResponse: response(200, JSON.stringify(bootstrapConfig({ pairingToken: "N".repeat(43) })))
  });

  const ready = await app.message({ type: "NW_WAIT_INITIALIZED" });
  assert.equal(ready.ok, false);
  assert.match(ready.error, /active task or local outbox/i);
  assert.equal(app.local.data.enabled, false);
  assert.equal(app.local.data.pairingToken, "O".repeat(43));
  assert.equal(app.local.data.workerId, "stable-worker");
  assert.deepEqual(app.local.data.nwGeminiRunnerOutbox, outbox);
  assert.equal(app.local.data.nwGeminiRunnerLastBootstrapId, undefined);
});

test("malformed bootstrap is rejected without partially applying secrets or identity", async () => {
  const invalidConfigs = [
    "not json",
    JSON.stringify(null),
    JSON.stringify([]),
    JSON.stringify(bootstrapConfig({ schemaVersion: 2 })),
    JSON.stringify(bootstrapConfig({ bootstrapId: "bad/id" })),
    JSON.stringify(bootstrapConfig({ pairingToken: "short" })),
    JSON.stringify(bootstrapConfig({ pairingToken: `${"A".repeat(32)}!` })),
    JSON.stringify(bootstrapConfig({ serverUrl: "https://localhost:3001" })),
    JSON.stringify(bootstrapConfig({ serverUrl: "http://localhost.evil:3001" })),
    JSON.stringify(bootstrapConfig({ serverUrl: "http://user:pass@localhost:3001" })),
    JSON.stringify(bootstrapConfig({ serverUrl: "http://localhost:3001/api" })),
    JSON.stringify(bootstrapConfig({ serverUrl: "http://localhost:3001?token=x" })),
    JSON.stringify({ ...bootstrapConfig(), enabled: true })
  ];

  for (const raw of invalidConfigs) {
    const app = await harness(async () => {
      throw new Error("heartbeat must not run");
    }, {
      initialLocal: {
        enabled: true,
        serverUrl: "http://127.0.0.1:3001",
        pairingToken: "O".repeat(43),
        workerId: "stable-worker",
        nwGeminiRunnerOutbox: []
      },
      bootstrapResponse: response(200, raw)
    });
    const ready = await app.message({ type: "NW_WAIT_INITIALIZED" });
    assert.equal(ready.ok, false, raw);
    assert.equal(app.local.data.enabled, false, raw);
    assert.equal(app.local.data.serverUrl, "http://127.0.0.1:3001", raw);
    assert.equal(app.local.data.pairingToken, "O".repeat(43), raw);
    assert.equal(app.local.data.workerId, "stable-worker", raw);
  }
});

test("missing bootstrap preserves state and consumed bootstrap re-ACKs without mutation", async () => {
  const missing = await harness(undefined, {
    initialLocal: { enabled: true }
  });
  assert.equal((await missing.message({ type: "NW_WAIT_INITIALIZED" })).ok, true);
  assert.equal(missing.local.data.enabled, true);

  const rejectedFetch = await harness(undefined, {
    initialLocal: { enabled: true },
    bootstrapResponse: async () => { throw new TypeError("Failed to fetch"); }
  });
  assert.equal((await rejectedFetch.message({ type: "NW_WAIT_INITIALIZED" })).ok, true);
  assert.equal(rejectedFetch.local.data.enabled, true);

  const config = bootstrapConfig();
  const storedToken = "S".repeat(43);
  const calls = [];
  const consumed = await harness(async (url, request) => {
    calls.push({ url: String(url), request });
    return response(200, JSON.stringify({ ok: true, idle: true }));
  }, {
    initialLocal: {
      enabled: true,
      serverUrl: "http://127.0.0.1:3001",
      pairingToken: storedToken,
      workerId: "stored-worker",
      nwGeminiRunnerLastBootstrapId: config.bootstrapId
    },
    bootstrapResponse: response(200, JSON.stringify(config))
  });
  assert.equal((await consumed.message({ type: "NW_WAIT_INITIALIZED" })).ok, true);
  assert.equal(consumed.local.data.enabled, true);
  assert.equal(consumed.local.data.serverUrl, "http://127.0.0.1:3001");
  assert.equal(consumed.local.data.pairingToken, storedToken);
  assert.equal(consumed.local.data.workerId, "stored-worker");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3001/api/automation/worker/heartbeat");
  assert.equal(calls[0].request.headers["X-NovelWeb-Worker-Token"], storedToken);
  assert.deepEqual(JSON.parse(calls[0].request.body), {
    workerId: "stored-worker",
    taskId: null,
    modelLabel: `bootstrap:${config.bootstrapId}`
  });
});

test("explicitly disabling a bootstrapped runner prevents worker next from claiming", async () => {
  const calls = [];
  const config = bootstrapConfig();
  const app = await harness(async (url) => {
    calls.push(String(url));
    return response(200, JSON.stringify({ ok: true }));
  }, {
    initialLocal: { enabled: true, serverUrl: config.serverUrl, pairingToken: config.pairingToken },
    bootstrapResponse: response(200, JSON.stringify(config))
  });
  assert.equal((await app.message({ type: "NW_WAIT_INITIALIZED" })).ok, true);
  assert.equal(app.local.data.enabled, true);
  await app.local.set({ enabled: false });
  const result = await app.message({
    type: "NW_API_REQUEST",
    request: { path: "/api/automation/worker/next?workerId=worker-test" }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 423);
  assert.deepEqual(calls, [`${config.serverUrl}/api/automation/worker/heartbeat`]);
});

test("concurrent Gemini tabs cannot both acquire the runner lock", async () => {
  const app = await harness();
  const [a, b] = await Promise.all([
    app.message({ type: "NW_RUNNER_LOCK", action: "acquire" }, 11),
    app.message({ type: "NW_RUNNER_LOCK", action: "acquire" }, 22)
  ]);
  assert.equal([a.acquired, b.acquired].filter(Boolean).length, 1);
});

test("native paste activation is bound to the requesting exact conversation tab", async () => {
  const app = await harness();
  const target = "https://gemini.google.com/gem/gem-1/conversation-2";
  app.windowState.set(7, { id: 7, focused: false });
  const pending = await app.message({
    type: "NW_ACTIVATE_RUNNER_TAB",
    expectedUrl: target
  }, 41, target);
  assert.equal(pending.ok, true);
  assert.equal(pending.activationPending, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const activated = await app.message({
    type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION",
    expectedUrl: target
  }, 41, target);
  assert.equal(activated.ok, true);
  assert.equal(activated.activationPending, false);
  assert.equal(activated.tabId, 41);
  assert.equal(activated.conversationUrl, target);
  assert.equal(JSON.stringify(app.activationCalls), JSON.stringify([
    { type: "tab", tabId: 41, patch: { active: true } },
    { type: "window", windowId: 7, patch: { focused: true } }
  ]));

  const mismatch = await app.message({
    type: "NW_ACTIVATE_RUNNER_TAB",
    expectedUrl: "https://gemini.google.com/app/other"
  }, 41, target);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /not on the expected/i);
  assert.equal(app.activationCalls.length, 2);
});

test("an already active tab first ACKs, then focuses its window before confirming", async () => {
  const app = await harness();
  const target = "https://gemini.google.com/app/already-active";
  app.tabState.set(42, { id: 42, windowId: 7, url: target, active: true });
  app.windowState.set(7, { id: 7, focused: false });
  const activated = await app.message({
    type: "NW_ACTIVATE_RUNNER_TAB",
    expectedUrl: target
  }, 42, target);
  assert.equal(activated.ok, true);
  assert.equal(activated.activationPending, true);
  assert.equal(activated.conversationUrl, target);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const confirmed = await app.message({
    type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION",
    expectedUrl: target
  }, 42, target);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.activationPending, false);
  assert.equal(JSON.stringify(app.activationCalls), JSON.stringify([
    { type: "window", windowId: 7, patch: { focused: true } }
  ]));
});

test("an inactive tab receives a pending ACK before a stalled activation update", async () => {
  let releaseUpdate;
  let updateStarted;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const started = new Promise((resolve) => { updateStarted = resolve; });
  const app = await harness(undefined, {
    beforeTabUpdate: async () => {
      updateStarted();
      await updateGate;
    }
  });
  const target = "https://gemini.google.com/app/background-activation";
  const pending = await app.message({
    type: "NW_ACTIVATE_RUNNER_TAB",
    expectedUrl: target
  }, 43, target);
  assert.equal(pending.ok, true);
  assert.equal(pending.activationPending, true);
  await started;
  assert.equal(app.activationCalls.length, 0);

  const stillPending = await app.message({
    type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION",
    expectedUrl: target
  }, 43, target);
  assert.equal(stillPending.ok, true);
  assert.equal(stillPending.activationPending, true);

  releaseUpdate();
  let confirmed = stillPending;
  for (let attempt = 0; attempt < 20 && confirmed.activationPending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    confirmed = await app.message({
      type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION",
      expectedUrl: target
    }, 43, target);
  }
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.activationPending, false);
  assert.equal(app.activationCalls.length, 1);
});

test("new-chat base-page activation requires an explicit flag and current sender-owned lock", async () => {
  const app = await harness(undefined, { windowFocused: false });
  const target = "https://gemini.google.com/app";
  const baseRequest = { type: "NW_ACTIVATE_RUNNER_TAB", expectedUrl: target };
  assert.equal((await app.message(baseRequest, 51, target)).ok, false, "native callers still require a concrete conversation");
  const request = { ...baseRequest, newChat: true };
  assert.equal((await app.message(request, 51, target)).ok, false, "unowned tabs cannot activate");
  await app.message({ type: "NW_RUNNER_LOCK", action: "acquire" }, 51, target);
  assert.equal((await app.message(request, 52, target)).ok, false, "another tab cannot use the owner's lock");
  assert.equal(app.activationCalls.length, 0);
  const pending = await app.message(request, 51, target);
  assert.equal(pending.ok, true);
  assert.equal(pending.activationPending, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  const confirmed = await app.message({ ...request, type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION" }, 51, target);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.activationPending, false);
  assert.equal(confirmed.tabId, 51);
  assert.equal(confirmed.conversationUrl, target);
  assert.equal(JSON.stringify(app.activationCalls), JSON.stringify([
    { type: "tab", tabId: 51, patch: { active: true } },
    { type: "window", windowId: 7, patch: { focused: true } },
  ]));
  await app.message({ type: "NW_RUNNER_LOCK", action: "release" }, 51, target);
  const released = await app.message({ ...request, type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION" }, 51, target);
  assert.equal(released.ok, false, "confirmation must recheck ownership even when the tab is focused");
  assert.match(released.error, /runner lock/);
});

test("new-chat activation refuses exact URL changes before confirming", async () => {
  const app = await harness();
  const target = "https://gemini.google.com/app";
  await app.message({ type: "NW_RUNNER_LOCK", action: "acquire" }, 53, target);
  app.tabState.set(53, { id: 53, windowId: 7, url: "https://gemini.google.com/app/different", active: true });
  const result = await app.message({ type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION", expectedUrl: target, newChat: true }, 53, target);
  assert.equal(result.ok, false);
  assert.match(result.error, /changed conversations/);
  assert.equal(app.activationCalls.length, 0);
});

test("the background proxy rejects normalized paths outside the automation API", async () => {
  let fetchCalls = 0;
  const app = await harness(async () => {
    fetchCalls += 1;
    return response(200);
  });
  const result = await app.message({
    type: "NW_API_REQUEST",
    request: { path: "/api/automation/../../shutdown", method: "POST" }
  });
  assert.equal(result.ok, false);
  assert.equal(fetchCalls, 0);
});

test("enqueue during a slow flush is serialized and not overwritten", async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const app = await harness(async () => {
    await fetchGate;
    return response(200);
  });
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("a", "task-a", "submitted") });
  const flushing = app.message({ type: "NW_FLUSH_OUTBOX" });
  await new Promise((resolve) => setImmediate(resolve));
  const enqueueing = app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("b", "task-b", "submitted") });
  releaseFetch();
  await Promise.all([flushing, enqueueing]);
  assert.deepEqual(app.local.data.nwGeminiRunnerOutbox.map((item) => item.id), ["b"]);
});

test("completed supersedes an undelivered submitted event for the same task", async () => {
  const app = await harness();
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("submitted", "task-1", "submitted") });
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("completed", "task-1", "completed") });
  assert.deepEqual(app.local.data.nwGeminiRunnerOutbox.map((item) => item.id), ["completed"]);
});

test("a queued completed answer cannot be overwritten by later blocked or failed reports", async () => {
  const app = await harness();
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("completed", "task-1", "completed") });
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("blocked", "task-1", "blocked") });
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("failed", "task-1", "failed") });
  assert.deepEqual(app.local.data.nwGeminiRunnerOutbox.map((item) => item.id), ["completed"]);
});

test("a newer lease completion replaces a stale completion for the same task", async () => {
  const app = await harness();
  const stale = eventEntry("completed-old", "task-1", "completed");
  const current = eventEntry("completed-new", "task-1", "completed");
  current.body.leaseId = "lease-2";
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: stale });
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: current });
  assert.deepEqual(app.local.data.nwGeminiRunnerOutbox.map((item) => item.id), ["completed-new"]);
});

test("HTTP 409 retains the local event for manual resolution", async () => {
  const app = await harness(async () => response(409, JSON.stringify({ error: "lease_owner_mismatch" })));
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("answer", "task-1", "completed") });
  const result = await app.message({ type: "NW_FLUSH_OUTBOX" });
  assert.equal(result.ok, false);
  assert.equal(app.local.data.nwGeminiRunnerOutbox.length, 1);
  assert.equal(app.local.data.nwGeminiRunnerOutbox[0].id, "answer");
  assert.equal(app.local.data.nwGeminiRunnerOutbox[0].attempts, 1);
});

test("successful completed delivery clears only its matching local recovery", async () => {
  const app = await harness(async () => response(200));
  app.local.data.nwGeminiRunnerRecoveries = [
    { id: "task-1:lease-1", taskId: "task-1", leaseId: "lease-1", responsePartial: "first" },
    { id: "task-1:lease-2", taskId: "task-1", leaseId: "lease-2", responsePartial: "second" }
  ];
  await app.message({ type: "NW_ENQUEUE_OUTBOX", entry: eventEntry("answer", "task-1", "completed") });
  await app.message({ type: "NW_FLUSH_OUTBOX" });
  assert.deepEqual(
    app.local.data.nwGeminiRunnerRecoveries.map((item) => item.id),
    ["task-1:lease-2"]
  );
});
