import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {access, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const batch = await readFile(new URL('../start.bat', import.meta.url));
const checker = await readFile(new URL('../scripts/check-runtime-dependencies.mjs', import.meta.url), 'utf8');
const dependencies = ['express', 'cors', 'dotenv', 'vite', '@vitejs/plugin-vue', 'vue', 'vue-router', 'pinia', 'marked'];

async function runBatch(t, {metadata, missing, broken} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'novelweb-dependency-test-with spaces-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('novelweb-dependency-test-'));
    await rm(root, {recursive: true, force: true});
  });
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/check-runtime-dependencies.mjs'), checker);
  await writeFile(path.join(root, 'start.bat'), batch);
  for (const name of dependencies) {
    if (name === missing) continue;
    const directory = path.join(root, 'node_modules', name);
    await mkdir(directory, {recursive: true});
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({name, type: 'module', exports: './index.js'}));
    await writeFile(path.join(directory, 'index.js'), name === broken
      ? 'throw new Error("Fixture native binding cannot load");\n'
      : 'export default {};\n');
  }
  const metadataPath = path.join(root, 'node_modules/.package-lock.json');
  if (metadata !== undefined) await writeFile(metadataPath, metadata);
  // These local npm stubs cannot install packages or launch the real project.
  // A ci call deliberately fails so the batch's existing failure path is tested.
  await writeFile(path.join(root, 'npm.cmd'), '@echo off\r\necho %*>>npm-calls.txt\r\nif "%1"=="ci" exit /b 47\r\nexit /b 0\r\n');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start.bat'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, input: '\r\n',
  });
  assert.ifError(result.error);
  const calls = (await readFile(path.join(root, 'npm-calls.txt'), 'utf8')).trim().split(/\r?\n/);
  return {...result, calls, metadataPath, root};
}

test('the real Windows batch starts with loadable dependencies and no npm hidden lockfile',
  {skip: process.platform !== 'win32'}, async t => {
    const result = await runBatch(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.calls, ['run gemini']);
    await assert.rejects(access(result.metadataPath), {code: 'ENOENT'});
    await assert.rejects(access(path.join(result.root, 'node_modules/concurrently')), {code: 'ENOENT'});
    assert.match(result.stdout, /dependencies are available/);
  });

test('damaged npm metadata does not trigger reinstall when actual modules load',
  {skip: process.platform !== 'win32'}, async t => {
    const result = await runBatch(t, {metadata: 'not valid npm metadata'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.calls, ['run gemini']);
    assert.equal(await readFile(result.metadataPath, 'utf8'), 'not valid npm metadata');
  });

for (const [scenario, options, packageName] of [
  ['missing core dependency', {missing: 'express'}, 'express'],
  ['unloadable core dependency', {broken: 'vite'}, 'vite'],
]) {
  test(`${scenario} still invokes the install path and reports its failure`,
    {skip: process.platform !== 'win32'}, async t => {
      const result = await runBatch(t, options);
      assert.equal(result.status, 1, result.stdout + result.stderr + JSON.stringify(result.calls));
      assert.deepEqual(result.calls, ['ci']);
      assert.match(result.stderr, new RegExp(`Cannot load required dependency ${packageName}`));
      assert.match(result.stdout, /npm ci failed/);
    });
}
