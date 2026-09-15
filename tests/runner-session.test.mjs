import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {assertIdentity, readRuntime, verifyRunnerSession} from '../scripts/verify-runner-session.mjs';

const serverUrl = 'http://127.0.0.1:3001';
const pairingToken = 'test-only-private-pairing-token-1234567890';
const tokenHash = createHash('sha256').update(pairingToken).digest('hex');
const liveIdentity = {workerId: 'nw-gemini-live-worker', bootstrapId: 'live-bootstrap-1234567890'};

function fixtures() {
  return [
    {id: 'a'.repeat(32), name: 'NovelWeb Gemini Runner', content: ['shared.js', 'content.js']},
    {id: 'b'.repeat(32), name: 'Gemini Manual Prewarm', content: ['core.js', 'content.js']},
  ].map(({id, name, content}) => ({
    id,
    manifest: {name, background: {service_worker: 'background.js'}, action: {default_popup: 'popup.html'},
      content_scripts: [{matches: ['https://gemini.google.com/*'], js: content, run_at: 'document_idle'}]},
    scripts: Object.fromEntries(['background.js', ...content].map(file => [file, `void ${JSON.stringify(name + '/' + file)};`])),
  }));
}

function transport({extensions = fixtures(), storedChanges = {}, alterManifest, missingWorker, duplicateWorker,
  omitScript, staleScript, extraScript, failMethod, failCreateAt, geminiPages = 1, asleepWorkers = []} = {}) {
  const calls = [];
  const stored = {serverUrl, pairingToken, workerId: liveIdentity.workerId,
    nwGeminiRunnerLastBootstrapId: liveIdentity.bootstrapId,
    nwGeminiRunnerActiveTask: {id: 'ongoing-task'}, nwGeminiRunnerOutbox: [{id: 'unsent-result'}],
    enabled: false, ...storedChanges};
  const untouched = structuredClone(stored);
  const pages = Array.from({length: geminiPages}, (_, index) => ({targetId: 'gemini-' + index,
    type: 'page', url: 'https://gemini.google.com/app/conversation-' + index, input: 'unsent user text'}));
  const targets = [
    ...extensions.map((extension, index) => ({targetId: 'worker-' + index, type: 'service_worker',
      url: `chrome-extension://${extension.id}/${extension.manifest.background.service_worker}`}))
      .filter((_, index) => index !== missingWorker),
    ...pages,
    {targetId: 'unrelated-page', type: 'page', url: 'https://example.test/'},
    {targetId: 'lookalike-worker', type: 'service_worker', url: `chrome-extension://${'c'.repeat(32)}/background.js`},
  ];
  if (duplicateWorker !== undefined) targets.push({...targets.find(target => target.targetId === 'worker-' + duplicateWorker), targetId: 'duplicate-worker'});
  const beforePages = structuredClone(pages);
  const sessions = new Map();
  const parsed = new Map();
  const ownTargets = [];
  const wokenWorkers = new Set();
  let eventHandler;
  let clock = 0;
  let closed = false;
  let unsubscribed = false;
  let createCount = 0;
  const client = {
    onEvent(handler) { eventHandler = handler; return () => { unsubscribed = true; }; },
    async call(method, params = {}, options = {}) {
      calls.push({method, params, options});
      if (method === failMethod) throw new Error('Injected ' + method + ' failure');
      if (method === 'Target.createTarget') {
        if (++createCount === failCreateAt) throw new Error('Injected creation failure');
        const targetId = 'owned-popup-' + createCount;
        ownTargets.push(targetId);
        return {targetId};
      }
      if (method === 'ServiceWorker.startWorker') {
        const index = extensions.findIndex(extension => params.scopeURL === `chrome-extension://${extension.id}/`);
        assert.notEqual(index, -1, 'Only the known extension scopes may be started');
        wokenWorkers.add(index);
        return {};
      }
      if (method === 'Target.getTargets') return {targetInfos: structuredClone(targets.filter(target =>
        !asleepWorkers.some(index => target.targetId === 'worker-' + index && !wokenWorkers.has(index))))};
      if (method === 'Target.attachToTarget') {
        const sessionId = 'session-' + params.targetId;
        sessions.set(sessionId, targets.find(target => target.targetId === params.targetId));
        return {sessionId};
      }
      if (method === 'Debugger.enable') {
        const target = sessions.get(options.sessionId);
        const applicable = target.type === 'page' ? extensions : extensions.filter(extension => target.url.includes(extension.id));
        for (const extension of applicable) {
          const files = target.type === 'page' ? extension.manifest.content_scripts.flatMap(item => item.js) : [extension.manifest.background.service_worker];
          for (const file of files) {
            const context = {target, extension, file};
            if (omitScript?.(context)) continue;
            const scriptId = `${target.targetId}-${extension.id}-${file}`;
            parsed.set(scriptId, staleScript?.(context) ? 'void "old build";' : extension.scripts[file]);
            eventHandler({method: 'Debugger.scriptParsed', sessionId: options.sessionId,
              params: {scriptId, url: `chrome-extension://${extension.id}/${file}`}});
            if (extraScript?.(context)) {
              parsed.set(scriptId + '-old', 'void "old duplicate build";');
              eventHandler({method: 'Debugger.scriptParsed', sessionId: options.sessionId,
                params: {scriptId: scriptId + '-old', url: `chrome-extension://${extension.id}/${file}`}});
            }
          }
        }
        return {};
      }
      if (method === 'Debugger.getScriptSource') return {scriptSource: parsed.get(params.scriptId)};
      if (method === 'Runtime.evaluate') {
        const target = sessions.get(options.sessionId);
        const extension = extensions.find(item => target.url.includes(item.id));
        const manifest = structuredClone(extension.manifest);
        alterManifest?.(manifest, extension);
        const value = await vm.runInNewContext(params.expression, {
          TextEncoder, crypto: webcrypto,
          chrome: {runtime: {id: extension.id, getManifest: () => manifest}, storage: {local: {
            async get(keys) { return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])])); },
            async set() { assert.fail('Session verification must never write extension storage'); },
            async remove() { assert.fail('Session verification must never clear extension storage'); },
          }}},
        });
        return {result: {value: JSON.parse(JSON.stringify(value))}};
      }
      return {};
    },
    close() { closed = true; },
  };
  return {
    calls, stored, extensions,
    run: options => verifyRunnerSession({extensions, serverUrl, tokenHash, timeoutMs: 600,
      connect: async endpoint => { assert.equal(endpoint, 'http://127.0.0.1:9223'); return client; },
      now: () => clock, sleep: async milliseconds => { clock += milliseconds; }, ...options}),
    assertPreserved() {
      assert.deepEqual(stored, untouched, 'Active work, outbox, enablement, and credentials are untouched');
      assert.deepEqual(pages, beforePages, 'Conversation URLs and unsent inputs are untouched');
      assert.equal(closed, true);
      assert.equal(unsubscribed, true);
      assert.deepEqual(calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ownTargets);
      const allowed = new Set(['Target.createTarget', 'Target.getTargets', 'Target.attachToTarget', 'Debugger.enable',
        'Debugger.getScriptSource', 'Runtime.evaluate', 'Debugger.disable', 'Target.detachFromTarget', 'Target.closeTarget',
        'ServiceWorker.enable', 'ServiceWorker.startWorker', 'ServiceWorker.disable']);
      assert.ok(calls.every(call => allowed.has(call.method)), 'No browser shutdown, navigation, or extension reload');
      assert.ok(calls.filter(call => call.method === 'Target.createTarget').every(call => call.params.background === true && call.params.url.endsWith('/popup.html')));
      assert.ok(calls.filter(call => call.method === 'ServiceWorker.startWorker').every(call =>
        extensions.some(extension => call.params.scopeURL === `chrome-extension://${extension.id}/`)), 'Only the two verified extension workers can be woken');
      for (const call of calls.filter(call => call.method === 'Runtime.evaluate')) {
        assert.doesNotMatch(call.params.expression, /runtime\.reload|storage\.[\w]+\.(set|remove|clear)\s*\(|initializeOnce|getSettings\s*\(/);
        assert.ok(!call.params.expression.includes(pairingToken), 'The raw token is not passed into the browser expression');
      }
    },
  };
}

test('recovers live pairing independently of a stale launcher marker without changing existing work', async () => {
  const mock = transport({geminiPages: 2});
  const result = await mock.run();
  assert.deepEqual(result, liveIdentity);
  assert.deepEqual(Object.keys(result).sort(), ['bootstrapId', 'workerId']);
  assert.ok(!JSON.stringify(result).includes(pairingToken));
  assert.deepEqual(mock.calls.filter(call => call.method === 'Target.attachToTarget' && !call.params.targetId.startsWith('owned-popup-')).map(call => call.params.targetId),
    ['worker-0', 'worker-1', 'gemini-0', 'gemini-1']);
  mock.assertPreserved();
});

for (const [label, changes] of [
  ['different token', {pairingToken: 'wrong-token'}],
  ['different API port', {serverUrl: 'http://127.0.0.1:3002'}],
  ['remote API', {serverUrl: 'https://example.test'}],
  ['incomplete bootstrap', {nwGeminiRunnerLastBootstrapId: ''}],
  ['invalid worker', {workerId: 'bad'}],
]) {
  test(`rejects ${label} and preserves all browser state`, async () => {
    const mock = transport({storedChanges: changes});
    await assert.rejects(mock.run(), /different server|expected local API|completed local pairing/);
    mock.assertPreserved();
  });
}

test('accepts localhost alias with the same API port and normalized trailing slash', () => {
  assert.deepEqual(assertIdentity({...liveIdentity, serverUrl: 'http://localhost:3001/', tokenHash}, {serverUrl, tokenHash}), liveIdentity);
  for (const bad of ['http://127.0.0.1:3001/other', 'http://user@localhost:3001/', 'http://localhost:3001/?q=1']) {
    assert.throws(() => assertIdentity({...liveIdentity, serverUrl: bad, tokenHash}, {serverUrl, tokenHash}), /expected local API/);
  }
});

for (const [name, matches] of [
  ['Runner background', ({target}) => target.targetId === 'worker-0'],
  ['manual-prewarm background', ({target}) => target.targetId === 'worker-1'],
  ['Runner content', ({target, extension, file}) => target.type === 'page' && extension.id[0] === 'a' && file === 'content.js'],
  ['manual-prewarm content', ({target, extension, file}) => target.type === 'page' && extension.id[0] === 'b' && file === 'content.js'],
]) {
  test(`rejects stale ${name} even when identity and staged source match`, async () => {
    const mock = transport({staleScript: matches});
    await assert.rejects(mock.run(), /is outdated/);
    mock.assertPreserved();
  });
}

test('does not treat a current injected copy as proof when an old duplicate is still loaded', async () => {
  const mock = transport({extraScript: ({target, file}) => target.type === 'page' && file === 'shared.js'});
  await assert.rejects(mock.run(), /is outdated/);
  mock.assertPreserved();
});

test('refuses a Gemini page whose required content script cannot be observed', async () => {
  const mock = transport({omitScript: ({target, file}) => target.type === 'page' && file === 'core.js'});
  await assert.rejects(mock.run(), /Cannot verify loaded/);
  mock.assertPreserved();
});

for (const [label, options] of [['missing', {missingWorker: 1}], ['duplicate', {duplicateWorker: 0}]]) {
  test(`requires exactly one worker per exact extension URL: ${label}`, async () => {
    const mock = transport(options);
    await assert.rejects(mock.run(), /workers did not become available/);
    assert.equal(mock.calls.some(call => call.method === 'Target.attachToTarget' && !call.params.targetId.startsWith('owned-popup-')), false);
    mock.assertPreserved();
  });
}

test('rejects a live Runner manifest whose content injection declaration changed', async () => {
  const mock = transport({alterManifest(manifest) { manifest.content_scripts[0].run_at = 'document_start'; }});
  await assert.rejects(mock.run(), /manifest does not match/);
  mock.assertPreserved();
});

test('rejects a live manual-prewarm manifest whose injection declaration changed', async () => {
  const mock = transport({alterManifest(manifest, extension) {
    if (extension.id[0] === 'b') manifest.content_scripts[0].run_at = 'document_start';
  }});
  await assert.rejects(mock.run(), /manifest does not match/);
  mock.assertPreserved();
});

test('accepts equivalent Chrome manifest objects regardless of JSON key order', async () => {
  const mock = transport({alterManifest(manifest) {
    manifest.content_scripts = manifest.content_scripts.map(item => Object.fromEntries(Object.entries(item).reverse()));
  }});
  assert.deepEqual(await mock.run(), liveIdentity);
  mock.assertPreserved();
});

test('wakes suspended workers using only the verified extension scopes before inspecting source', async () => {
  const mock = transport({asleepWorkers: [0, 1]});
  assert.deepEqual(await mock.run(), liveIdentity);
  assert.deepEqual(mock.calls.filter(call => call.method === 'ServiceWorker.startWorker').map(call => call.params.scopeURL),
    mock.extensions.map(extension => `chrome-extension://${extension.id}/`));
  mock.assertPreserved();
});

for (const [label, options] of [
  ['second popup creation', {failCreateAt: 2}],
  ['attachment', {failMethod: 'Target.attachToTarget'}],
  ['source inspection', {failMethod: 'Debugger.getScriptSource'}],
  ['identity inspection', {failMethod: 'Runtime.evaluate'}],
]) {
  test(`cleans up only owned popups when ${label} fails`, async () => {
    const mock = transport(options);
    await assert.rejects(mock.run(), /Injected/);
    mock.assertPreserved();
  });
}

test('does not require a Gemini page in a background-only running profile', async () => {
  const mock = transport({geminiPages: 0});
  assert.deepEqual(await mock.run(), liveIdentity);
  mock.assertPreserved();
});

test('runtime identity is resolved by exact staged directory, not extension name or arbitrary profile entries', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-session-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('novelweb-session-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  const profile = path.join(directory, 'profile');
  await mkdir(path.join(profile, 'Default'), {recursive: true});
  const extensions = fixtures();
  const roots = [];
  for (const [index, extension] of extensions.entries()) {
    const source = path.join(directory, 'source-' + index);
    const runtime = path.join(directory, 'runtime with spaces-' + index);
    await mkdir(source);
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify(extension.manifest));
    for (const [file, contents] of Object.entries(extension.scripts)) await writeFile(path.join(source, file), contents + '\r\n');
    roots.push({source, runtime});
  }
  const preferencePath = path.join(profile, 'Default', 'Preferences');
  const preferences = {extensions: {settings: {
    [extensions[0].id]: {path: roots[0].runtime}, [extensions[1].id]: {path: roots[1].runtime},
    ['c'.repeat(32)]: {path: roots[0].runtime + '-lookalike'},
  }}};
  await writeFile(preferencePath, JSON.stringify(preferences));
  assert.deepEqual(await readRuntime(profile, roots), extensions);
  assert.equal(await readFile(preferencePath, 'utf8'), JSON.stringify(preferences), 'Profile preferences are never rewritten');
  preferences.extensions.settings['d'.repeat(32)] = {path: roots[0].runtime};
  await writeFile(preferencePath, JSON.stringify(preferences));
  await assert.rejects(readRuntime(profile, roots), /Cannot uniquely identify/);
});
