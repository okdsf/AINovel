import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {launchLocalServices} from '../scripts/start-local-services.mjs';

const supervisorUrl = new URL('../scripts/start-local-services.mjs', import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(operation, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {const value = await operation(); if (value) return value;}
    catch (error) {lastError = error;}
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function alive(pid) {
  if (!pid) return false;
  try {process.kill(pid, 0); return true;}
  catch (error) {if (error.code === 'ESRCH') return false; throw error;}
}

async function freePort() {
  // Keep fixtures out of the Windows ephemeral client range; otherwise the
  // test's own fetch sockets can claim a just-released listen(0) port.
  for (let attempt = 0; attempt < 100; attempt++) {
    const selected = 20000 + Math.floor(Math.random() * 10000);
    const server = net.createServer();
    const available = await new Promise(resolve => {
      server.once('error', () => resolve(false));
      server.listen(selected, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return selected;
  }
  throw new Error('No free fixture port');
}

async function request(port, endpoint = '/pid') {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {signal: AbortSignal.timeout(750)});
  assert.equal(response.status, 200);
  return response.json();
}

async function fixture(t, {apiMode = 'normal', frontendMode = 'normal', maxRestarts = 3} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-service-test-with spaces-'));
  const webPort = await freePort();
  let apiPort;
  do {apiPort = await freePort();} while (apiPort === webPort);
  const script = path.join(directory, 'fixture service.mjs');
  const fixtureSource = `
import http from 'node:http';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
const [role, mode, root] = process.argv.slice(2);
appendFileSync(path.join(root, 'fixture-pids.jsonl'), JSON.stringify({role, pid:process.pid})+'\\n');
console.log('fixture stdout '+role+' '+process.pid);
console.error('fixture stderr '+role+' '+process.pid);
const port = Number(role === 'api' ? process.env.NOVELWEB_API_PORT : process.env.NOVELWEB_WEB_PORT);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({pid:process.pid, role, storageDir:process.env.NOVELWEB_AUTOMATION_DIR}));
  if (req.url === '/crash') setTimeout(() => process.exit(9), 25);
  if (req.url === '/shutdown' || req.url === '/zero') setTimeout(() => process.exit(0), 25);
});
server.listen(port, '127.0.0.1', () => {if (mode === 'always-crash') setTimeout(() => process.exit(17), 25);});
// A failed test cannot leave fixture HTTP processes running indefinitely.
setTimeout(() => process.exit(0), 30000).unref();
`;
  await writeFile(script, fixtureSource);
  const storageDir = path.join(directory, 'automation data');
  const logDir = path.join(directory, 'logs');
  await mkdir(storageDir);
  const input = {repositoryRoot: directory, webPort, apiPort, storageDir, logDir};
  const options = {services: {
    api: {file: script, args: ['api', apiMode, directory]},
    frontend: {file: script, args: ['frontend', frontendMode, directory]},
  }, restartPolicy: {maxRestarts, windowMs: 60000, backoffMs: 75}};
  let handle;
  const state = async () => JSON.parse(await readFile(handle.statePath, 'utf8'));
  const pids = async () => {
    try {return (await readFile(path.join(directory, 'fixture-pids.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line).pid);}
    catch (error) {if (error.code === 'ENOENT') return []; throw error;}
  };
  t.after(async () => {
    if (handle) {
      try {await state();} catch {
        t.diagnostic(`Missing state. Supervisor stdout: ${await readFile(handle.stdoutPath, 'utf8')}`);
        t.diagnostic(`Supervisor stderr: ${await readFile(handle.stderrPath, 'utf8')}`);
      }
      await waitFor(async () => {
        if (!alive(handle.pid)) return true;
        try {await request(apiPort, '/shutdown');} catch {}
        return false;
      }, 'fixture supervisor cleanup', 35000);
      assert.ok((await pids()).every(pid => !alive(pid)), 'Fixture child processes are gone before cleanup');
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('novelweb-service-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  return {directory, input, options, state, pids, webPort, apiPort,
    setHandle: value => {handle = value;}, get handle() {return handle;}};
}

async function startFixture(t, settings) {
  const item = await fixture(t, settings);
  item.setHandle(await launchLocalServices(item.input, item.options));
  return item;
}

async function ready(item) {
  return waitFor(async () => {
    const [api, frontend, state] = await Promise.all([request(item.apiPort), request(item.webPort), item.state()]);
    if (state.phase !== 'running' || state.services.api.pid !== api.pid || state.services.frontend.pid !== frontend.pid) return false;
    return {api, frontend, state};
  }, 'both HTTP services').catch(async error => {
    let state;
    try {state = await item.state();} catch {state = {services: {}};}
    const details = [JSON.stringify(state)];
    for (const logfile of [item.handle.stdoutPath, item.handle.stderrPath, ...Object.values(state.services).flatMap(service => [service.stdoutPath, service.stderrPath])]) {
      details.push(`${path.basename(logfile)}: ${await readFile(logfile, 'utf8')}`);
    }
    throw new Error(`${error.message}\n${details.join('\n')}`);
  });
}

test('detached services survive the bootstrap parent exit, with explicit ports and persistent logs', {timeout: 30000}, async t => {
  const item = await fixture(t);
  const bootstrap = path.join(item.directory, 'bootstrap.mjs');
  await writeFile(bootstrap, `import {launchLocalServices} from ${JSON.stringify(supervisorUrl)}; console.log(JSON.stringify(await launchLocalServices(${JSON.stringify(item.input)}, ${JSON.stringify(item.options)})));`);
  const child = spawn(process.execPath, [bootstrap], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const exitCode = await new Promise(resolve => child.once('close', resolve));
  assert.equal(exitCode, 0, stderr);
  item.setHandle(JSON.parse(stdout.trim()));
  assert.equal(alive(child.pid), false, 'Short-lived bootstrap has exited');
  const first = await ready(item);
  await sleep(250);
  const second = await ready(item);
  assert.equal(first.api.pid, second.api.pid);
  assert.equal(first.frontend.pid, second.frontend.pid);
  assert.equal(second.api.storageDir, item.input.storageDir);
  assert.equal(second.state.repositoryRoot, item.directory);
  assert.equal(second.state.configPath, item.handle.configPath);
  assert.equal(second.state.webPort, item.webPort);
  assert.equal(second.state.apiPort, item.apiPort);
  for (const name of ['api', 'frontend']) {
    assert.match(await readFile(second.state.services[name].stdoutPath, 'utf8'), new RegExp('fixture stdout '+name));
    assert.match(await readFile(second.state.services[name].stderrPath, 'utf8'), new RegExp('fixture stderr '+name));
  }
  assert.match(await readFile(item.handle.stdoutPath, 'utf8'), /supervisor-start/);
  assert.ok(path.dirname(item.handle.configPath).startsWith(item.input.logDir + path.sep));
});

test('one API crash restarts only the API and keeps both attempts in the logs', {timeout: 30000}, async t => {
  const item = await startFixture(t);
  const before = await ready(item);
  await request(item.apiPort, '/crash');
  const after = await waitFor(async () => {
    const current = await ready(item);
    return current.api.pid !== before.api.pid ? current : false;
  }, 'API recovery');
  assert.equal(after.frontend.pid, before.frontend.pid, 'Healthy frontend was not restarted');
  assert.equal(after.state.services.api.restarts, 1);
  assert.equal(after.state.services.api.lastExit.code, 9);
  const log = await readFile(after.state.services.api.stdoutPath, 'utf8');
  assert.match(log, new RegExp(String(before.api.pid)));
  assert.match(log, new RegExp(String(after.api.pid)));
});

test('repeated crashes have a bounded restart budget and leave no orphan child', {timeout: 30000}, async t => {
  const item = await startFixture(t, {apiMode: 'always-crash', maxRestarts: 2});
  const failed = await waitFor(async () => {const state = await item.state(); return state.phase === 'failed' ? state : false;}, 'bounded failure');
  assert.equal(failed.services.api.restarts, 2);
  assert.equal(failed.services.api.status, 'failed');
  assert.match(failed.reason, /api exceeded 2 restarts/);
  assert.equal(failed.services.frontend.pid, null);
  await waitFor(() => !alive(item.handle.pid), 'failed supervisor exit');
  const recorded = await item.pids();
  assert.equal(recorded.length, 4, 'Initial API + two API retries + one frontend');
  assert.ok(recorded.every(pid => !alive(pid)), 'Every child started by this supervisor exited');
  await assert.rejects(request(item.webPort));
  await assert.rejects(request(item.apiPort));
  const lifecycle = await readFile(item.handle.stdoutPath, 'utf8');
  assert.match(lifecycle, /service-restart-scheduled/);
  assert.match(lifecycle, /supervisor-exit/);
  assert.match(await readFile(failed.services.api.stderrPath, 'utf8'), /fixture stderr api/);
});

test('normal API shutdown closes frontend and supervisor without restarting', {timeout: 30000}, async t => {
  const item = await startFixture(t);
  const before = await ready(item);
  await request(item.apiPort, '/shutdown');
  const stopped = await waitFor(async () => {const state = await item.state(); return state.phase === 'stopped' ? state : false;}, 'normal shutdown');
  assert.match(stopped.reason, /API exited normally/);
  assert.equal(stopped.services.api.restarts, 0);
  assert.equal(stopped.services.frontend.restarts, 0);
  await waitFor(() => !alive(item.handle.pid), 'supervisor exit');
  assert.equal(alive(before.api.pid), false);
  assert.equal(alive(before.frontend.pid), false);
  assert.ok((await item.pids()).every(pid => !alive(pid)));
});

test('an unexpected normal frontend exit is recovered without stopping the API', {timeout: 30000}, async t => {
  const item = await startFixture(t);
  const before = await ready(item);
  await request(item.webPort, '/zero');
  const after = await waitFor(async () => {
    const current = await ready(item);
    return current.frontend.pid !== before.frontend.pid ? current : false;
  }, 'frontend recovery');
  assert.equal(after.api.pid, before.api.pid);
  assert.equal(after.state.services.frontend.restarts, 1);
  assert.equal(after.state.services.frontend.lastExit.code, 0);
});

test('a Windows state-file reader cannot stop healthy services or prevent recovery',
  {skip: process.platform !== 'win32', timeout: 30000}, async t => {
    const item = await startFixture(t);
    const before = await ready(item);
    const lockerScript = path.join(item.directory, 'hold-state.ps1');
    await writeFile(lockerScript, String.raw`
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($env:NOVELWEB_TEST_LOCKFILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('STATE_LOCKED')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally { $stream.Dispose() }
`);
    const locker = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lockerScript], {
      env: {...process.env, NOVELWEB_TEST_LOCKFILE: item.handle.statePath}, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    locker.stdout.on('data', data => output += data);
    locker.stderr.on('data', data => errors += data);
    const closed = new Promise(resolve => locker.once('close', resolve));
    try {
      await waitFor(() => output.includes('STATE_LOCKED'), `Windows file lock ${errors}`);
      await request(item.apiPort, '/crash');
      const recovered = await waitFor(async () => {
        const current = await request(item.apiPort);
        return current.pid !== before.api.pid ? current : false;
      }, 'API recovery despite a locked state snapshot');
      assert.notEqual(recovered.pid, before.api.pid);
      assert.equal((await request(item.webPort)).pid, before.frontend.pid);
      assert.equal(alive(item.handle.pid), true);
      assert.match(await readFile(item.handle.stderrPath, 'utf8'), /state-write-failed/);
    } finally {
      locker.stdin.end('\n');
      await closed;
    }
    const current = await ready(item);
    assert.equal(current.state.services.api.restarts, 1);
    assert.equal(current.frontend.pid, before.frontend.pid);
  });

test('launch validates port pairs before spawning a process', async () => {
  await assert.rejects(launchLocalServices({webPort: 0, apiPort: 3001, logDir: os.tmpdir(), storageDir: os.tmpdir()}), /webPort/);
  await assert.rejects(launchLocalServices({webPort: 5173, apiPort: 5173, logDir: os.tmpdir(), storageDir: os.tmpdir()}), /different/);
});
