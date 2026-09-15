import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {assertHealth, checkReadingStyle, readExpectedRuntime} from '../scripts/verify-reading-style.mjs';
import {extensionIdForKey} from '../userstyles/ai-reading/install-manager.mjs';

const expected = {extensionId: 'abcdefghijklmnopabcdefghijklmnop', version: '1.2.0', sourceHash: 'd'.repeat(64)};
const healthy = () => ({version: expected.version, sourceHash: expected.sourceHash,
  loadedBuild: {backgroundHash: expected.sourceHash, workerHash: expected.sourceHash},
  defaults: {status: 'complete', installed: []}, error: null});

function transport({results = [{status: 'complete', data: healthy()}], pageStates, pollErrors = [], reloadError,
  failAt, failCleanup = false, invalidatedFirstPage = false} = {}) {
  const calls = [];
  let closed = false;
  let clock = 0;
  let pages = 0;
  const client = {
    async call(method, params, options) {
      calls.push({method, params, options});
      if (method === failAt) throw new Error('Simulated ' + method + ' failure');
      if (method === 'Target.createTarget') return {targetId: 'only-owned-health-target' + (++pages === 1 ? '' : '-' + pages)};
      if (method === 'Target.attachToTarget') return {sessionId: 'health-session'};
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('chrome.runtime.reload()')) {
          if (reloadError) throw new Error(reloadError);
          return {result: {value: true}};
        }
        const error = pollErrors.shift();
        if (error) throw new Error(error);
        const value = pageStates ? (pageStates.length > 1 ? pageStates.shift() : pageStates[0]) : {
          href: `chrome-extension://${expected.extensionId}/manager/health.html`, readyState: 'complete',
          health: results.length > 1 ? results.shift() : results[0],
        };
        return {result: {value}};
      }
      if (method === 'Target.closeTarget' && invalidatedFirstPage && params.targetId === 'only-owned-health-target') throw new Error('No target with given id found');
      if (method === 'Target.closeTarget' && failCleanup) throw new Error('Simulated cleanup failure');
      return {};
    },
    close() { closed = true; },
  };
  return {
    calls, closed: () => closed,
    run: options => checkReadingStyle({expected, timeoutMs: 600, connect: async () => client,
      now: () => clock, sleep: async ms => { clock += ms; }, ...options}),
  };
}

function assertOwnCleanup(mock) {
  const cleanup = mock.calls.filter(call => call.method === 'Target.closeTarget');
  const created = mock.calls.filter(call => call.method === 'Target.createTarget');
  assert.deepEqual(cleanup.map(call => call.params), created.map((_, index) => ({targetId: 'only-owned-health-target' + (index ? '-' + (index + 1) : '')})));
  assert.equal(mock.closed(), true);
  assert.equal(mock.calls.some(call => /reload|terminate|Browser.close/i.test(call.method)), false);
}

const reloadCalls = mock => mock.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('chrome.runtime.reload()'));

test('startup checks loaded build in its own background page and cleans up on success', async () => {
  const mock = transport({results: [null, {status: 'pending'}, {status: 'complete', data: healthy()}]});
  const result = await mock.run();
  assert.equal(result.defaults.status, 'complete');
  assert.deepEqual(mock.calls.find(call => call.method === 'Target.createTarget').params, {
    url: `chrome-extension://${expected.extensionId}/manager/health.html`, background: true,
  });
  assert.equal(mock.calls.filter(call => call.method === 'Runtime.evaluate').length, 3);
  assert.ok(mock.calls.filter(call => call.method.startsWith('Runtime.')).every(call => call.options.sessionId === 'health-session'));
  assertOwnCleanup(mock);
});

test('startup rejects stale loaded source hash even when disk and version look current', async () => {
  const mock = transport({results: [{status: 'complete', data: {...healthy(), sourceHash: 'old'}}]});
  await assert.rejects(mock.run(), /源码与安装目录不一致/);
  assertOwnCleanup(mock);
  assert.equal(reloadCalls(mock).length, 0, 'warm checks stay read-only');
});

test('cold start reloads only its verified extension once and checks the new executable build', async () => {
  const old = {...healthy(), loadedBuild: undefined};
  const mock = transport({results: [{status: 'complete', data: old}, {status: 'complete', data: healthy()}], invalidatedFirstPage: true});
  assert.equal((await mock.run({coldStart: true})).sourceHash, expected.sourceHash);
  assertOwnCleanup(mock);
  const reloads = reloadCalls(mock);
  assert.equal(reloads.length, 1);
  assert.match(reloads[0].params.expression, /location\.href !==/);
  assert.match(reloads[0].params.expression, /chrome\.runtime\.id !==/);
  assert.ok(reloads[0].params.expression.includes(JSON.stringify(expected.extensionId)));
  assert.match(reloads[0].params.expression, /setTimeout\(\(\) => chrome\.runtime\.reload\(\), 50\)/);
  assert.ok(reloads[0].options.timeoutMs <= 5000);
  assert.equal(mock.calls.filter(call => call.method === 'Target.createTarget').length, 2);
});

test('cold reload evaluation is bounded to five seconds and context destruction reconnects safely', async () => {
  const mock = transport({results: [{status: 'complete', data: {...healthy(), sourceHash: 'stale'}}, {status: 'complete', data: healthy()}],
    reloadError: 'Execution context was destroyed', invalidatedFirstPage: true});
  assert.equal((await mock.run({coldStart: true, timeoutMs: 45000})).sourceHash, expected.sourceHash);
  assert.equal(reloadCalls(mock)[0].options.timeoutMs, 5000);
  assertOwnCleanup(mock);
});

test('Chrome extension error page fails immediately instead of polling until startup timeout', async () => {
  const mock = transport({pageStates: [{href: 'chrome-error://chromewebdata/', readyState: 'complete', health: null}]});
  await assert.rejects(mock.run({coldStart: true, timeoutMs: 45000}), /Chrome 拒绝加载阅读样式扩展检查页/);
  assert.equal(mock.calls.filter(call => call.method === 'Runtime.evaluate').length, 1);
  assert.equal(reloadCalls(mock).length, 0);
  assertOwnCleanup(mock);
});

test('a vanished owned check target reconnects without touching another page', async () => {
  const mock = transport({pollErrors: ['Target closed'], invalidatedFirstPage: true});
  assert.equal((await mock.run()).sourceHash, expected.sourceHash);
  assert.equal(mock.calls.filter(call => call.method === 'Target.createTarget').length, 2);
  assertOwnCleanup(mock);
});

test('cold start stops after one unsuccessful extension reload', async () => {
  const mock = transport({results: [{status: 'complete', data: {...healthy(), sourceHash: 'stale'}}]});
  await assert.rejects(mock.run({coldStart: true}), /源码与安装目录不一致/);
  assertOwnCleanup(mock);
  assert.equal(reloadCalls(mock).length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'Target.createTarget').length, 2);
});

test('cold start never reloads a current build whose defaults failed to initialize', async () => {
  const mock = transport({results: [{status: 'complete', data: {...healthy(), defaults: {status: 'error', error: 'Missing defaults'}}}]});
  await assert.rejects(mock.run({coldStart: true}), /Missing defaults/);
  assertOwnCleanup(mock);
  assert.equal(reloadCalls(mock).length, 0);
});

test('cold start upgrades the exact pre-health manager API error while warm checks remain read-only', async () => {
  const legacy = {status: 'error', error: 'Unknown API.novelwebReading.getHealth'};
  const cold = transport({results: [legacy, {status: 'complete', data: healthy()}]});
  assert.equal((await cold.run({coldStart: true})).sourceHash, expected.sourceHash);
  assert.equal(reloadCalls(cold).length, 1);
  assertOwnCleanup(cold);
  const warm = transport({results: [legacy]});
  await assert.rejects(warm.run(), /尚未提供启动检查接口/);
  assert.equal(reloadCalls(warm).length, 0);
  assertOwnCleanup(warm);
});

test('cold start does not treat another API error or a similar message as an upgrade signal', async () => {
  for (const error of ['Unknown API.other.getHealth', 'Unknown API.novelwebReading.getHealth extra', 'No receiving end']) {
    const mock = transport({results: [{status: 'error', error}]});
    await assert.rejects(mock.run({coldStart: true}), /检查页无法读取后台/);
    assert.equal(reloadCalls(mock).length, 0);
    assertOwnCleanup(mock);
  }
});

test('startup rejects an old worker reporting a new fetched hash without executed-build proof', async () => {
  for (const loadedBuild of [undefined,
    {backgroundHash: expected.sourceHash, workerHash: 'e'.repeat(64)},
    {backgroundHash: 'e'.repeat(64), workerHash: expected.sourceHash},
  ]) {
    const mock = transport({results: [{status: 'complete', data: {...healthy(), loadedBuild}}]});
    await assert.rejects(mock.run(), /磁盘版本信息不能证明实际代码已更新/);
    assertOwnCleanup(mock);
  }
});

test('startup times out pending initialization and still closes only its check page', async () => {
  const mock = transport({results: [{status: 'pending'}]});
  await assert.rejects(mock.run(), /后台就绪超时/);
  assertOwnCleanup(mock);
});

test('startup reports extension message errors and closes its own target', async () => {
  const mock = transport({results: [{status: 'error', error: 'No receiving end'}]});
  await assert.rejects(mock.run(), /No receiving end/);
  assertOwnCleanup(mock);
});

test('startup cleans up after attach fails without masking the original failure', async () => {
  const mock = transport({failAt: 'Target.attachToTarget', failCleanup: true});
  await assert.rejects(mock.run(), /Target.attachToTarget failure/);
  assertOwnCleanup(mock);
});

test('readiness accepts deliberately deleted defaults after successful initial seed', () => {
  const result = healthy();
  assert.deepEqual(result.defaults.installed, []);
  assert.equal(assertHealth(result, expected), result);
});

test('readiness distinguishes wrong version, failed seed and incomplete seed', () => {
  assert.throws(() => assertHealth({...healthy(), version: '1.1.0'}, expected), /版本不一致/);
  assert.throws(() => assertHealth({...healthy(), error: 'Broken storage'}, expected), /Broken storage/);
  assert.throws(() => assertHealth({...healthy(), defaults: {status: 'error', error: 'Missing defaults'}}, expected), /Missing defaults/);
});

test('connection wait has a bounded timeout before creating any browser target', async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(checkReadingStyle({expected, timeoutMs: 500,
    now: () => clock, sleep: async ms => { clock += ms; },
    connect: async () => { attempts++; throw new Error('Connection refused'); },
  }), /等待 Runner CDP 就绪超时：Connection refused/);
  assert.equal(attempts, 2);
});

test('runtime expectation derives stable extension ID from manifest key and reads its build hash', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-reading-runtime-'));
  const key = Buffer.from('test-public-key').toString('base64');
  try {
    await mkdir(path.join(directory, 'manager'));
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({key}));
    await writeFile(path.join(directory, 'manager/build-info.json'), JSON.stringify({version: expected.version, sourceHash: expected.sourceHash}));
    assert.deepEqual(await readExpectedRuntime(directory), {...expected, extensionId: extensionIdForKey(key)});
  } finally { await rm(directory, {recursive: true, force: true}); }
});
