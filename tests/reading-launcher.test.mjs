import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const launcher = await readFile(new URL('../scripts/start-gemini-runner.ps1', import.meta.url), 'utf8');
const fontBootstrap = await readFile(new URL('../scripts/ensure-reading-fonts.ps1', import.meta.url), 'utf8');
const preparationStart = launcher.indexOf('  # Network provisioning runs before');
const preparationEnd = launcher.indexOf('  $startupAttempt = 0', preparationStart);
assert.ok(preparationStart > 0 && preparationEnd > preparationStart, 'Find the actual launcher preparation block');
const preparation = launcher.slice(preparationStart, preparationEnd);
const powerShellEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-launcher-test-with spaces-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('novelweb-launcher-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}

async function runPreparation(t, {warm = false, fail, invalidBuild = false} = {}) {
  const directory = await temporary(t);
  const scriptDirectory = path.join(directory, 'scripts');
  const readingDirectory = path.join(directory, 'userstyles', 'ai-reading');
  const buildDirectory = path.join(directory, 'runtime', 'manager');
  for (const item of [scriptDirectory, readingDirectory, buildDirectory]) await mkdir(item, {recursive: true});
  await writeFile(path.join(scriptDirectory, 'ensure-reading-fonts.ps1'), fontBootstrap);
  await writeFile(path.join(readingDirectory, 'fonts.json'), JSON.stringify({downloadSubdirectory: 'NovelWeb/ReadingStyle/fonts'}));
  await writeFile(path.join(buildDirectory, 'build-info.json'), JSON.stringify({sourceHash: invalidBuild ? 'invalid' : 'a'.repeat(64)}));
  const logPath = path.join(directory, 'events.jsonl');
  const nodeStub = step => `
import fs from 'node:fs';
const event = {step: ${JSON.stringify(step)}, check: process.argv.includes('--check')};
fs.appendFileSync(process.env.NOVELWEB_TEST_EVENT_LOG, JSON.stringify(event) + '\\n');
if (process.env.NOVELWEB_TEST_FAIL === event.step) process.exitCode = 9;
`;
  for (const [relative, step] of [
    ['userstyles/ai-reading/download-fonts.mjs', 'font-files'],
    ['scripts/ensure-reading-style.mjs', 'reading-style'],
    ['scripts/ensure-fonts.mjs', 'public-fonts'],
  ]) await writeFile(path.join(directory, relative), nodeStub(step));
  await writeFile(path.join(readingDirectory, 'install-fonts.ps1'), String.raw`
param([string]$FontDirectory, [switch]$Check)
$event = @{step = 'font-install'; check = [bool]$Check} | ConvertTo-Json -Compress
Add-Content -LiteralPath $env:NOVELWEB_TEST_EVENT_LOG -Value $event
if ($env:NOVELWEB_TEST_FAIL -eq 'font-install') { throw 'Injected installation failure' }
`);
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:LOCALAPPDATA = Join-Path $PSScriptRoot 'local'
$scriptDirectory = Join-Path $PSScriptRoot 'scripts'
$readingStyleRoot = Join-Path $env:LOCALAPPDATA 'NovelWeb/ReadingStyle'
$stagedReadingExtension = Join-Path $PSScriptRoot 'runtime'
$chromeProfile = Join-Path $env:LOCALAPPDATA 'NovelWeb/GeminiRunner/chrome-profile'
$global:LASTEXITCODE = 37
function Get-DedicatedRunnerProcesses {
  param([string]$ProfilePath)
  if ($env:NOVELWEB_TEST_WARM -eq '1') { [pscustomobject]@{Id = 12345} }
}
try {
` + preparation + String.raw`
  # A sentinel stands in for the later browser start; no browser is called.
  Add-Content -LiteralPath $env:NOVELWEB_TEST_EVENT_LOG -Value '{"step":"chrome-sentinel"}'
  Write-Host 'PARENT_LAUNCHER_CONTINUED'
  exit 0
} catch {
  $event = @{step = 'failure'; message = $_.Exception.Message} | ConvertTo-Json -Compress
  Add-Content -LiteralPath $env:NOVELWEB_TEST_EVENT_LOG -Value $event
  exit 1
}
`;
  await writeFile(path.join(directory, 'run.ps1'), harness);
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'run.ps1')], {
    env: {...powerShellEnv, NOVELWEB_TEST_EVENT_LOG: logPath, NOVELWEB_TEST_WARM: warm ? '1' : '0', NOVELWEB_TEST_FAIL: fail || ''},
    encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  const events = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, '')));
  return {...result, events};
}

test('cold launcher waits for fonts and styles, and a nested successful exit returns to its caller',
  {skip: process.platform !== 'win32'}, async t => {
    const result = await runPreparation(t);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PARENT_LAUNCHER_CONTINUED/);
    assert.deepEqual(result.events.map(event => event.step), ['font-files', 'font-install', 'reading-style', 'public-fonts', 'chrome-sentinel']);
    assert.ok(result.events.slice(0, 4).every(event => event.check === false));
  });

test('warm launcher only checks browser font and style preparation', {skip: process.platform !== 'win32'}, async t => {
  const result = await runPreparation(t, {warm: true});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events.slice(0, 3), [
    {step: 'font-files', check: true}, {step: 'font-install', check: true}, {step: 'reading-style', check: true},
  ]);
  assert.equal(result.events.at(-1).step, 'chrome-sentinel');
});

for (const fail of ['font-files', 'font-install', 'reading-style', 'public-fonts']) {
  test(`launcher stops before Chrome when ${fail} fails`, {skip: process.platform !== 'win32'}, async t => {
    const result = await runPreparation(t, {fail});
    assert.equal(result.status, 1);
    const steps = ['font-files', 'font-install', 'reading-style', 'public-fonts'];
    assert.deepEqual(result.events.map(event => event.step), [...steps.slice(0, steps.indexOf(fail) + 1), 'failure']);
    assert.doesNotMatch(result.stdout, /PARENT_LAUNCHER_CONTINUED/);
    assert.match(result.events.at(-1).message, /font|style/i);
  });
}

for (const fail of ['font-files', 'font-install', 'reading-style']) {
  test(`warm ${fail} failure asks for cold setup without changing the live font cache`, {skip: process.platform !== 'win32'}, async t => {
    const result = await runPreparation(t, {warm: true, fail});
    assert.equal(result.status, 1);
    assert.ok(result.events.slice(0, -1).every(event => event.check === true));
    assert.match(result.events.at(-1).message, /Close all dedicated NovelWeb Runner windows/);
    assert.equal(result.events.some(event => event.step === 'chrome-sentinel'), false);
  });
}

test('launcher rejects an invalid prepared style fingerprint before Chrome', {skip: process.platform !== 'win32'}, async t => {
  const result = await runPreparation(t, {invalidBuild: true});
  assert.equal(result.status, 1);
  assert.equal(result.events.at(-1).message, 'Invalid reading style build fingerprint.');
  assert.equal(result.events.some(event => event.step === 'chrome-sentinel'), false);
});

test('provisioning precedes application startup and all browser launch call sites', () => {
  assert.ok(launcher.indexOf('Start-NovelWebIfNeeded @novelWebParameters') > preparationEnd);
  assert.ok(launcher.indexOf('$chromePath = Get-ChromeForTesting -RuntimeRoot') > preparationEnd);
  assert.ok(launcher.indexOf('Start-Process -FilePath $chromePath') > preparationEnd);
});

test('Windows startup batch remains ASCII only', async () => {
  const bytes = await readFile(new URL('../start.bat', import.meta.url));
  assert.ok(bytes.every(value => value < 128), 'start.bat must work across Windows ANSI codepages');
});

test('PowerShell parses the shipped launcher and font preparation scripts', {skip: process.platform !== 'win32'}, async t => {
  const directory = await temporary(t);
  for (const [name, source] of [['launcher.ps1', launcher], ['fonts.ps1', fontBootstrap]]) await writeFile(path.join(directory, name), source);
  const parser = String.raw`
$ErrorActionPreference = 'Stop'
foreach ($name in @('launcher.ps1', 'fonts.ps1')) {
  $tokens = $null
  $parseErrors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors.Message -join '; ') }
}
Write-Host 'POWERSHELL_SYNTAX_OK'
`;
  await writeFile(path.join(directory, 'parse.ps1'), parser);
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'parse.ps1')],
    {env: powerShellEnv, encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /POWERSHELL_SYNTAX_OK/);
});
