import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FIND_PORTS_SCRIPT = fileURLToPath(new URL('../scripts/find-ports.mjs', import.meta.url));
const GEMINI_LAUNCHER = fileURLToPath(new URL('../scripts/start-gemini-runner.ps1', import.meta.url));
const SEARCH_SPAN = 50;
const MAX_START_PORT = 65_535 - SEARCH_SPAN;

async function listenOnSuitablePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');
    if (address.port <= MAX_START_PORT) return server;

    await closeServer(server);
  }

  throw new Error('Could not allocate a preferred port with a full search span');
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function listenOnPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  return server;
}

async function occupySearchRange() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const start = 10_000 + Math.floor(Math.random() * 30_000);
    const listeners = [];
    try {
      for (let offset = 0; offset < SEARCH_SPAN; offset++) {
        listeners.push(await listenOnPort(start + offset));
      }
      return { start, listeners };
    } catch {
      await Promise.all(listeners.map(closeServer));
    }
  }
  throw new Error('Could not reserve a contiguous range for the exhausted-port regression');
}

function parsePorts(stdout) {
  return Object.fromEntries(stdout.trim().split(/\r?\n/).map(line => {
    const match = /^(NOVELWEB_(?:WEB|API)_PORT)=(\d+)$/.exec(line);
    assert.ok(match, `Unexpected find-ports output line: ${line}`);
    return [match[1], Number(match[2])];
  }));
}

test('find-ports CLI avoids occupied preferred web and API ports', async (t) => {
  const listeners = [];
  const closeListeners = async () => {
    await Promise.all(listeners.map(closeServer));
  };
  t.after(closeListeners);

  try {
    listeners.push(await listenOnSuitablePort());
    listeners.push(await listenOnSuitablePort());

    const webPreferred = listeners[0].address().port;
    const apiPreferred = listeners[1].address().port;
    const { stdout } = await execFileAsync(process.execPath, [FIND_PORTS_SCRIPT], {
      env: {
        ...process.env,
        NOVELWEB_WEB_PORT: String(webPreferred),
        NOVELWEB_API_PORT: String(apiPreferred),
      },
      timeout: 10_000,
      windowsHide: true,
    });
    const ports = parsePorts(stdout);
    const web = ports.NOVELWEB_WEB_PORT;
    const api = ports.NOVELWEB_API_PORT;

    assert.deepEqual(
      Object.keys(ports).sort(),
      ['NOVELWEB_API_PORT', 'NOVELWEB_WEB_PORT'],
    );
    for (const port of [web, api]) {
      assert.ok(Number.isInteger(port));
      assert.ok(port >= 1 && port <= 65_535);
      assert.notEqual(port, webPreferred);
      assert.notEqual(port, apiPreferred);
    }
    assert.notEqual(web, api);
    // Ephemeral preferred ports may border OS exclusion ranges. A correct
    // fallback can lie outside the preferred span, but must still be bindable.
    listeners.push(await listenOnPort(web));
    listeners.push(await listenOnPort(api));
  } finally {
    await closeListeners();
  }
});

test('find-ports allocates distinct usable ports when both preferred search ranges are exhausted', async (t) => {
  const { start, listeners } = await occupySearchRange();
  t.after(async () => { await Promise.all(listeners.map(closeServer)); });
  const { stdout } = await execFileAsync(process.execPath, [FIND_PORTS_SCRIPT], {
    env: { ...process.env, NOVELWEB_WEB_PORT: String(start), NOVELWEB_API_PORT: String(start) },
    timeout: 10_000,
    windowsHide: true,
  });
  const ports = parsePorts(stdout);
  const web = ports.NOVELWEB_WEB_PORT;
  const api = ports.NOVELWEB_API_PORT;
  assert.notEqual(web, api);
  for (const port of [web, api]) {
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
    assert.ok(port < start || port >= start + SEARCH_SPAN, 'all ports in the preferred range are held open');
    listeners.push(await listenOnPort(port));
  }
});

test('Gemini launcher forwards its selected port pair and diagnoses early exit', async () => {
  const source = await fs.readFile(path.resolve(GEMINI_LAUNCHER), 'utf8');
  const setWebPort = source.indexOf('$env:NOVELWEB_WEB_PORT = [string]$WebPort');
  const setApiPort = source.indexOf('$env:NOVELWEB_API_PORT = [string]$ApiPort');
  const startChild = source.indexOf('$process = Start-Process @startParameters');

  assert.match(source, /Get-FreeNovelWebPortPair[\s\S]*scripts\/find-ports\.mjs/);
  assert.ok(setWebPort >= 0 && setWebPort < startChild);
  assert.ok(setApiPort >= 0 && setApiPort < startChild);
  assert.match(source, /PassThru = \$true/);
  assert.match(source, /\$process\.HasExited/);
  assert.match(source, /novelweb\.stdout\.log[\s\S]*novelweb\.stderr\.log/);
  assert.match(source, /endpoints\.json/);
  assert.match(source, /ExpectedServerUrl[\s\S]*pairing\.serverUrl/);
  assert.match(source, /directStatus\.pairing\.token -cne \[string\]\$proxiedStatus\.pairing\.token/);
  assert.match(source, /Stop-StartedProcessTree -Process \$process/);
  assert.match(source, /runnerPageResponse[\s\S]*\$runnerPages = @\(\$runnerPageResponse\)/);
  assert.match(source, /\$urlsToOpen\.Count -gt 0/);
});
