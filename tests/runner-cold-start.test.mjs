import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const launcher = await readFile(new URL('../scripts/start-gemini-runner.ps1', import.meta.url), 'utf8');
const functionStart = launcher.indexOf('function Assert-RunnerBackgroundLoaded');
const marker = "$verificationScript = @'";
const start = launcher.indexOf(marker, functionStart) + marker.length;
const end = launcher.indexOf("'@", start);
assert.ok(functionStart > 0 && start > functionStart && end > start, 'Locate the actual embedded background verifier');
const verifier = launcher.slice(start, end).replace(/^import .*;\r?\n/gm, '');
const expectedSource = '"use strict";\nvoid "current background";';
const manifest = {name: 'NovelWeb Gemini Runner', background: {service_worker: 'background.js'}};
const workerId = 'fixture-worker-12345678';
const bootstrapId = 'fixture-bootstrap-12345678';
const worker = {type: 'service_worker', url: `chrome-extension://${'a'.repeat(32)}/background.js`,
  webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/worker'};
const page = {type: 'page', url: 'https://gemini.google.com/app/restored-conversation'};

async function run({restoredPage = false, pageAppearsLater = false, stale = false, staysStale = false,
  busy = false, outboxCount = 0, mode = 'cold', wrongIdentity = false} = {}) {
  const calls = [], logs = [], errors = [], sockets = [];
  let clock = 0;
  let requests = 0;
  let reloaded = false;
  const process = {argv: ['node', '-', '/fixture', workerId, bootstrapId, '0.7', mode], exitCode: 0};
  class Socket {
    constructor() { this.closed = false; sockets.push(this); queueMicrotask(() => this.onopen()); }
    close() { this.closed = true; }
    send(text) {
      const request = JSON.parse(text);
      calls.push(request);
      let result = {};
      if (request.method === 'Runtime.evaluate') {
        if (request.params.expression.includes('chrome.runtime.reload()')) { reloaded = true; result = {result: {value: true}}; }
        else result = {result: {value: {extensionId: 'a'.repeat(32), workerId: wrongIdentity ? 'wrong-worker' : workerId,
          bootstrapId, busy, outboxCount}}};
      } else if (request.method === 'Debugger.enable') {
        this.onmessage({data: JSON.stringify({method: 'Debugger.scriptParsed', params: {scriptId: 'script-background', url: worker.url}})});
      } else if (request.method === 'Debugger.getScriptSource') {
        result = {scriptSource: stale && (!reloaded || staysStale) ? 'void "old background";' : expectedSource + '\r\n'};
      }
      queueMicrotask(() => this.onmessage({data: JSON.stringify({id: request.id, result})}));
    }
  }
  const context = vm.createContext({
    createHash, path, URL, AbortSignal, process, WebSocket: Socket,
    Date: {now: () => clock},
    setTimeout(callback, milliseconds) {
      if (milliseconds === 300) { clock += milliseconds; queueMicrotask(callback); return undefined; }
      return setTimeout(callback, milliseconds);
    }, clearTimeout,
    console: {log: value => logs.push(value), error: value => errors.push(value)},
    async readFile(file) { return path.basename(file) === 'manifest.json' ? JSON.stringify(manifest) : expectedSource; },
    async fetch(url) {
      assert.equal(url, 'http://127.0.0.1:9223/json/list');
      requests++;
      return {json: async () => [worker, ...(restoredPage || (pageAppearsLater && requests >= 2) ? [page] : [])]};
    },
  });
  await vm.runInContext(`(async () => { ${verifier}\n})()`, context);
  assert.ok(sockets.every(socket => socket.closed), 'Every inspection connection is closed');
  assert.ok(calls.every(call => ['Runtime.evaluate', 'Debugger.enable', 'Debugger.getScriptSource'].includes(call.method)),
    'Verifier never navigates or closes user pages');
  const reloads = calls.filter(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('chrome.runtime.reload()'));
  return {code: process.exitCode, calls, logs, errors, reloads};
}

test('cold start accepts already current background with a restored Gemini page without reload', async () => {
  const result = await run({restoredPage: true});
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.match(result.logs.join('\n'), /Verified loaded Gemini Runner background/);
  assert.equal(result.reloads.length, 0);
});

test('current background with restored page preserves an active task and pending results', async () => {
  const result = await run({restoredPage: true, busy: true, outboxCount: 1});
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.reloads.length, 0);
});

test('stale background with restored Gemini page remains protected from reload', async () => {
  const result = await run({restoredPage: true, stale: true});
  assert.equal(result.code, 1);
  assert.match(result.errors.join('\n'), /no extension reload was attempted/);
  assert.equal(result.reloads.length, 0);
});

test('a Gemini page restored during source inspection also prevents stale-code reload', async () => {
  const result = await run({pageAppearsLater: true, stale: true});
  assert.equal(result.code, 1);
  assert.equal(result.reloads.length, 0);
  assert.match(result.errors.join('\n'), /no extension reload was attempted/);
});

for (const state of [{busy: true}, {outboxCount: 1}]) {
  test(`stale background cannot reload with ${state.busy ? 'active work' : 'pending results'}`, async () => {
    const result = await run({stale: true, ...state});
    assert.equal(result.code, 1);
    assert.match(result.errors.join('\n'), /active task or pending result/);
    assert.equal(result.reloads.length, 0);
  });
}

test('idle cold start without user pages reloads stale code once and verifies the new code', async () => {
  const result = await run({stale: true});
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.reloads.length, 1);
  assert.match(result.logs.join('\n'), /Verified loaded Gemini Runner background/);
});

test('a failed cold reload is bounded and never repeats the reload', async () => {
  const result = await run({stale: true, staysStale: true});
  assert.equal(result.code, 1);
  assert.equal(result.reloads.length, 1);
  assert.match(result.errors.join('\n'), /startup timed out/);
});

test('warm checks never reload stale background', async () => {
  const result = await run({stale: true, mode: 'verify'});
  assert.equal(result.code, 1);
  assert.equal(result.reloads.length, 0);
  assert.match(result.errors.join('\n'), /open Runner has stale/);
});

test('cold verification does not accept another worker identity with matching source', async () => {
  const result = await run({wrongIdentity: true});
  assert.equal(result.code, 1);
  assert.equal(result.reloads.length, 0);
  assert.equal(result.logs.length, 0);
});
