import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {checkRunnerConnection, resolveRunnerExtensionId} from '../scripts/check-runner-connection.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const otherExtensionId = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const profile = path.resolve('fixture-missing-runner-profile');
const runtime = path.resolve('fixture-missing-runner-runtime');
const tokenFile = path.resolve('fixture-pairing-token.txt');
const serverUrl = 'http://127.0.0.1:3001';
const token = 'PAIRING_TOKEN_PRIVATE_MUST_NEVER_BE_LEAKED_0123456789';
const pageSecret = 'PRIVATE_GEMINI_PAGE_CONTENT_MUST_NOT_LEAK';
const allowedSummaryKeys = ['enabled', 'ok', 'pingOk', 'responsiveTabs', 'serverUrl', 'warnings', 'workerId'];

function copied(value) { return structuredClone(value); }

// The expression is evaluated in an isolated popup realm against these Chrome
// APIs. The mock never answers Runtime.evaluate with a canned success result.
function fixture(options = {}) {
  const storage = {
    serverUrl,
    pairingToken: token,
    workerId: 'worker-keep-me',
    enabled: false,
    nwGeminiRunnerActiveTask: null,
    nwGeminiRunnerOutbox: [],
    ...copied(options.storage ?? {}),
  };
  const originalStorage = copied(storage);
  const calls = [];
  const messages = [];
  const tabMessages = [];
  const writes = [];
  const reads = [];
  const queriedTabs = [];
  const connections = [];
  const preferences = options.preferences ?? {extensions: {settings: {
    [extensionId]: {path: runtime, state: 1},
    [otherExtensionId]: {path: `${runtime}-different-extension`, state: 1},
  }}};
  const tabs = options.tabs ?? [{id: 41, url: 'https://gemini.google.com/app/fixture', title: pageSecret}];
  let clock = 1_000;
  let closed = 0;
  let evaluations = 0;
  let clientCloseCount = 0;
  let storageGetCount = 0;
  const chrome = {
    runtime: {
      id: extensionId,
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(copied(message));
        let value;
        switch (message.type) {
          case 'NW_WAIT_INITIALIZED': value = {ok: true}; break;
          case 'NW_GET_BACKGROUND_STATUS':
            value = {ok: true, workerId: storage.workerId, serverUrl: storage.serverUrl,
              enabled: storage.enabled, outboxCount: storage.nwGeminiRunnerOutbox.length};
            break;
          case 'NW_API_REQUEST':
            value = options.ping ?? {ok: true, status: 200, data: {ok: true, service: 'novelweb-gemini-worker'}};
            break;
          default: throw new Error(`Unexpected extension message ${message.type}`);
        }
        if (typeof callback === 'function') callback(copied(value));
        else return Promise.resolve(copied(value));
      },
    },
    storage: {local: {
      get(keys, callback) {
        options.storageGetHook?.(++storageGetCount, storage);
        const value = Object.fromEntries(keys.map(key => [key, copied(storage[key])]));
        if (typeof callback === 'function') callback(value);
        else return Promise.resolve(value);
      },
      set(values, callback) {
        writes.push(copied(values));
        Object.assign(storage, copied(values));
        if (typeof callback === 'function') callback();
        else return Promise.resolve();
      },
    }},
    tabs: {
      query(query, callback) {
        queriedTabs.push(copied(query));
        if (typeof callback === 'function') callback(copied(tabs));
        else return Promise.resolve(copied(tabs));
      },
      sendMessage(tabId, message, ...rest) {
        tabMessages.push({tabId, message: copied(message)});
        const callback = rest.find(value => typeof value === 'function');
        const failed = options.unresponsiveTabs?.includes(tabId) || options.allTabsUnresponsive;
        if (failed) {
          if (callback) {
            chrome.runtime.lastError = {message: `No receiver; ${pageSecret}`};
            try {callback(undefined);} finally {chrome.runtime.lastError = undefined;}
          } else return Promise.reject(new Error(`No receiver; ${pageSecret}`));
          return;
        }
        const value = copied(options.contentResponse ??
          {ok: true, status: {ready: true, title: pageSecret}, text: pageSecret});
        if (callback) callback(value);
        else return Promise.resolve(value);
      },
    },
  };
  const realm = vm.createContext({chrome, setTimeout, clearTimeout, URL, Promise});
  const client = {
    async call(method, params = {}, callOptions = {}) {
      calls.push({method, params: copied(params), options: copied(callOptions)});
      switch (method) {
        case 'Target.createTarget': return {targetId: 'own-popup'};
        case 'Target.attachToTarget':
          if (options.attachError) throw new Error(`${pageSecret}: attach failed`);
          return {sessionId: 'popup-session'};
        case 'Runtime.evaluate': {
          evaluations++;
          assert.equal(callOptions.sessionId, 'popup-session');
          assert.equal(params.awaitPromise, true);
          assert.equal(params.returnByValue, true);
          if (options.evaluateError) throw new Error(`${token} ${pageSecret}: evaluation failed`);
          const value = await vm.runInContext(params.expression, realm, {timeout: 1_000});
          return {result: {value}};
        }
        case 'Target.detachFromTarget': return {};
        case 'Target.closeTarget': closed++; return {success: true};
        default: throw new Error(`Unexpected CDP command ${method}`);
      }
    },
    async close() { clientCloseCount++; },
  };
  async function readFileImpl(file) {
    const resolved = path.resolve(String(file));
    reads.push(resolved);
    if (resolved === tokenFile) return `${token}\r\n`;
    if (resolved === path.join(profile, 'Default', 'Preferences')) return JSON.stringify(preferences);
    const error = new Error(`Fixture file does not exist: ${resolved}`);
    error.code = 'ENOENT';
    throw error;
  }
  const input = {profile, runtime, serverUrl, tokenFile, timeoutMs: 2_500,
    readFileImpl, connect: async (endpoint, options) => {
      connections.push({endpoint, options: copied(options)});
      return client;
    },
    now: () => clock, sleep: async ms => {clock += Math.max(1, ms);}};
  return {
    storage, originalStorage, calls, messages, tabMessages, writes, reads, queriedTabs, connections, input,
    readFileImpl,
    run: () => checkRunnerConnection(input),
    get evaluations() { return evaluations; },
    get elapsed() { return clock - 1_000; },
    get closed() { return closed; },
    get clientCloseCount() { return clientCloseCount; },
    get storageGetCount() { return storageGetCount; },
  };
}

function assertSafeSummary(result) {
  assert.deepEqual(Object.keys(result).sort(), allowedSummaryKeys);
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.pingOk, 'boolean');
  assert.equal(typeof result.responsiveTabs, 'number');
  assert.ok(Array.isArray(result.warnings));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false, 'pairing token is private');
  assert.equal(serialized.includes(pageSecret), false, 'page content and raw errors are private');
}

function assertPassiveOperations(f) {
  for (const {method} of f.calls) {
    assert.ok(['Target.createTarget', 'Target.attachToTarget', 'Runtime.evaluate',
      'Target.detachFromTarget', 'Target.closeTarget'].includes(method), method);
  }
  for (const message of f.messages) {
    assert.ok(['NW_WAIT_INITIALIZED', 'NW_GET_BACKGROUND_STATUS', 'NW_API_REQUEST'].includes(message.type));
    if (message.type === 'NW_API_REQUEST') {
      const {timeoutMs, ...request} = message.request;
      assert.deepEqual(request, {path: '/api/automation/worker/ping', method: 'GET'});
      if (timeoutMs !== undefined) assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
    }
  }
  for (const {message} of f.tabMessages) assert.equal(message.type, 'NW_CONTENT_STATUS');
  for (const query of f.queriedTabs) assert.deepEqual(query, {url: 'https://gemini.google.com/*'});
}

function assertOwnPopupCleanup(f, {attached = true} = {}) {
  const creates = f.calls.filter(call => call.method === 'Target.createTarget');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.url, `chrome-extension://${extensionId}/popup.html`);
  assert.equal(creates[0].params.background, true);
  assert.deepEqual(f.calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ['own-popup']);
  const detaches = f.calls.filter(call => call.method === 'Target.detachFromTarget');
  assert.equal(detaches.length, attached ? 1 : 0);
  if (attached) assert.equal(detaches[0].params.sessionId, 'popup-session');
  assert.equal(f.clientCloseCount, 1);
  assertPassiveOperations(f);
}

test('resolves the loaded extension from the exact runtime path in profile preferences', async () => {
  const f = fixture();
  assert.equal(await resolveRunnerExtensionId(profile, runtime, {readFileImpl: f.readFileImpl}), extensionId);
  assert.ok(f.reads.includes(path.join(profile, 'Default', 'Preferences')));
  assert.ok(f.reads.every(file => ['Preferences', 'Secure Preferences'].includes(path.basename(file))));
});

test('ambiguous extension IDs at the same runtime path fail before a popup is created', async () => {
  const f = fixture({preferences: {extensions: {settings: {
    [extensionId]: {path: runtime, state: 1},
    [otherExtensionId]: {path: runtime, state: 1},
  }}}});
  await assert.rejects(resolveRunnerExtensionId(profile, runtime, {readFileImpl: f.readFileImpl}),
    {code: 'RUNNER_EXTENSION_AMBIGUOUS'});
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.pingOk, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.connections, []);
  assert.equal(f.elapsed, 0, 'an ambiguous extension identity must not be retried');
  assert.deepEqual(f.writes, []);
  assertSafeSummary(result);
});

test('source files and runtime manifest may be absent while the loaded runner passes ping', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.pingOk, true);
  assert.equal(result.responsiveTabs, 1);
  assert.equal(result.workerId, 'worker-keep-me');
  assert.equal(result.enabled, false);
  assert.equal(result.serverUrl, serverUrl);
  assert.deepEqual(f.writes, []);
  assert.ok(f.reads.every(file => file === tokenFile || ['Preferences', 'Secure Preferences'].includes(path.basename(file))));
  assert.ok(f.messages.some(message => message.type === 'NW_WAIT_INITIALIZED'));
  assert.ok(f.messages.some(message => message.type === 'NW_GET_BACKGROUND_STATUS'));
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('repairs only idle credentials and preserves worker, enabled, outbox and active state', async () => {
  const f = fixture({storage: {pairingToken: 'old-token', serverUrl: 'http://127.0.0.1:9999'}});
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.writes, [{serverUrl, pairingToken: token}]);
  assert.deepEqual(f.storage, {...f.originalStorage, serverUrl, pairingToken: token});
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('a task that starts between credential reads prevents the pending repair', async () => {
  const startedTask = {id: 'task-started-during-check', prompt: pageSecret};
  const f = fixture({
    storage: {pairingToken: 'old-token'},
    storageGetHook(count, state) {
      if (count === 2) state.nwGeminiRunnerActiveTask = copied(startedTask);
    },
  });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.ok(f.storageGetCount >= 2, 'must recheck task state immediately before writing credentials');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.storage, {...f.originalStorage, nwGeminiRunnerActiveTask: startedTask});
  assert.equal(f.messages.some(message => message.type === 'NW_API_REQUEST'), false);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

for (const [name, busyState] of [
  ['active task', {nwGeminiRunnerActiveTask: {id: 'active-17', prompt: pageSecret}}],
  ['pending outbox', {nwGeminiRunnerOutbox: [{taskId: 'queued-18', response: pageSecret}]}],
]) {
  test(`does not repair mismatched credentials while a ${name} exists`, async () => {
    const f = fixture({storage: {pairingToken: 'old-token', ...busyState}});
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.storage, f.originalStorage);
    assertSafeSummary(result);
    assertOwnPopupCleanup(f);
  });

  test(`matching credentials can pass with a ${name} without changing stored state`, async () => {
    const f = fixture({storage: busyState});
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.storage, f.originalStorage);
    assertSafeSummary(result);
    assertOwnPopupCleanup(f);
  });
}

test('bridge 401 cannot report a healthy connection or expose its response body', async () => {
  const f = fixture({ping: {ok: false, status: 401, error: `${token} ${pageSecret}`}});
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.pingOk, false);
  assert.deepEqual(f.writes, []);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('an arbitrary successful HTTP response is not accepted as the NovelWeb worker service', async () => {
  const f = fixture({ping: {ok: true, status: 200, data: {ok: true, service: 'some-other-service'}}});
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.pingOk, false);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('stale Gemini tabs do not block a connection when one content script responds', async () => {
  const f = fixture({tabs: [
    {id: 40, url: 'https://gemini.google.com/app/old', title: pageSecret},
    {id: 41, url: 'https://gemini.google.com/app/healthy', title: pageSecret},
  ], unresponsiveTabs: [40]});
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.responsiveTabs, 1);
  assert.ok(f.tabMessages.some(message => message.tabId === 40));
  assert.ok(f.tabMessages.some(message => message.tabId === 41));
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('a responding page blocker preserves connection success and exposes only a fixed warning', async () => {
  const f = fixture({
    storage: {enabled: true},
    contentResponse: {ok: true, blocker: {type: 'login', message: pageSecret, text: pageSecret}},
  });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.pingOk, true);
  assert.equal(result.responsiveTabs, 1);
  assert.deepEqual(result.warnings, [
    'A Gemini page reports a login or interaction blocker; inspect the page before starting a task.',
  ]);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

for (const [name, options] of [
  ['no Gemini tabs', {tabs: []}],
  ['no responding content scripts', {allTabsUnresponsive: true}],
]) {
  test(`${name} retries until the timeout without reloading or navigating pages`, async () => {
    const f = fixture(options);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.pingOk, true);
    assert.equal(result.responsiveTabs, 0);
    assert.ok(f.evaluations >= 2, 'transient content failure must be retried');
    assert.ok(f.elapsed >= f.input.timeoutMs, 'retry should use the injected deadline');
    assertSafeSummary(result);
    assertOwnPopupCleanup(f);
  });
}

test('evaluation failures still detach and close only the helper popup and redact errors', async () => {
  const f = fixture({evaluateError: true});
  const result = await f.run();
  assert.equal(result.ok, false);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('attach failure closes the created popup and client without touching any other target', async () => {
  const f = fixture({attachError: true});
  const result = await f.run();
  assert.equal(result.ok, false);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f, {attached: false});
});

function privateError(code) {
  return Object.assign(new Error(`${code}: ${token} ${pageSecret}`), {code});
}

for (const unavailable of ['missing', 'incomplete JSON']) {
  test(`cold-start ${unavailable} preferences are retried until the installed extension is registered`, async () => {
    const f = fixture();
    let preferenceReads = 0;
    f.input.readFileImpl = async (file, ...args) => {
      if (path.resolve(String(file)) === path.join(profile, 'Default', 'Preferences') && ++preferenceReads === 1) {
        if (unavailable === 'missing') throw privateError('ENOENT');
        return '{"extensions":';
      }
      return f.readFileImpl(file, ...args);
    };
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.pingOk, true);
    assert.ok(preferenceReads >= 2, 'the startup profile must be checked again');
    assert.ok(f.elapsed > 0 && f.elapsed < f.input.timeoutMs);
    assertSafeSummary(result);
    assertOwnPopupCleanup(f);
  });
}

test('cold-start ECONNREFUSED is retried and the eventual browser connection passes', async () => {
  const f = fixture();
  const connect = f.input.connect;
  let attempts = 0;
  f.input.connect = async (...args) => {
    if (++attempts === 1) throw privateError('ECONNREFUSED');
    return connect(...args);
  };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.ok(f.elapsed > 0 && f.elapsed < f.input.timeoutMs);
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

test('preferences, connection and content readiness consume one shared deadline', async () => {
  const f = fixture({allTabsUnresponsive: true});
  f.input.timeoutMs = 1_000;
  const connect = f.input.connect;
  let preferenceReads = 0;
  let attempts = 0;
  f.input.readFileImpl = async (file, ...args) => {
    if (path.resolve(String(file)) === path.join(profile, 'Default', 'Preferences')) {
      preferenceReads++;
      if (f.elapsed < 300) throw privateError('ENOENT');
    }
    return f.readFileImpl(file, ...args);
  };
  f.input.connect = async (...args) => {
    attempts++;
    assert.ok(args[1].timeoutMs <= f.input.timeoutMs - f.elapsed,
      'connecting must receive only the remaining total budget');
    if (f.elapsed < 600) throw privateError('ECONNREFUSED');
    return connect(...args);
  };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.pingOk, true, 'setup must complete and reach the content check');
  assert.equal(result.responsiveTabs, 0);
  assert.ok(preferenceReads >= 2);
  assert.ok(attempts >= 2);
  assert.ok(f.evaluations >= 1);
  assert.equal(f.elapsed, f.input.timeoutMs, 'no stage may restart the timeout clock');
  assertSafeSummary(result);
  assertOwnPopupCleanup(f);
});

for (const stage of ['preferences', 'connection']) {
  test(`persistently unavailable ${stage} are retried until the original deadline`, async () => {
    const f = fixture();
    f.input.timeoutMs = 700;
    let attempts = 0;
    if (stage === 'preferences') {
      f.input.readFileImpl = async (file, ...args) => {
        if (path.resolve(String(file)) !== tokenFile) {
          if (path.basename(String(file)) === 'Preferences') attempts++;
          throw privateError('ENOENT');
        }
        return f.readFileImpl(file, ...args);
      };
    } else {
      f.input.connect = async () => {attempts++; throw privateError('ECONNREFUSED');};
    }
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.pingOk, false);
    assert.ok(attempts >= 2, 'a transient startup failure must not fail immediately');
    assert.equal(f.elapsed, f.input.timeoutMs);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
    assertSafeSummary(result);
  });
}

test('unreadable preferences fail immediately without retrying or disclosing the filesystem error', async () => {
  const f = fixture();
  let attempts = 0;
  f.input.readFileImpl = async (file, ...args) => {
    if (path.resolve(String(file)) !== tokenFile) {
      attempts++;
      throw privateError('EACCES');
    }
    return f.readFileImpl(file, ...args);
  };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.equal(f.elapsed, 0);
  assert.deepEqual(f.connections, []);
  assert.deepEqual(f.calls, []);
  assertSafeSummary(result);
});

test('an unknown connection error fails immediately instead of being swallowed by startup retries', async () => {
  const f = fixture();
  let attempts = 0;
  f.input.connect = async () => {attempts++; throw privateError('UNEXPECTED_CDP_FAILURE');};
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.equal(f.elapsed, 0);
  assert.deepEqual(f.calls, []);
  assertSafeSummary(result);
});

test('a client arriving after the connection deadline is closed without touching any page', {timeout: 100}, async () => {
  const f = fixture();
  const lateCalls = [];
  let closeCount = 0;
  let resolveConnection;
  const pendingConnection = new Promise(resolve => {resolveConnection = resolve;});
  const lateClient = {
    async call(method) {lateCalls.push(method); return {};},
    close() {closeCount++;},
  };
  f.input.timeoutMs = 20;
  f.input.now = Date.now;
  f.input.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  f.input.connect = () => pendingConnection;

  const result = await f.run();
  assert.equal(result.ok, false, 'the check must finish before the pending connection resolves');
  assert.equal(result.pingOk, false);
  assert.equal(closeCount, 0);
  assert.deepEqual(f.calls, []);
  assertSafeSummary(result);

  resolveConnection(lateClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeCount, 1, 'an expired connection must be closed exactly once when it arrives');
  assert.deepEqual(lateCalls, [], 'no popup or existing page may be touched after expiration');
  assert.deepEqual(f.writes, []);
});
