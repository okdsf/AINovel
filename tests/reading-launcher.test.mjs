import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const launcher = await readFile(new URL('../scripts/start-gemini-runner.ps1', import.meta.url), 'utf8');
const powerShellEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !['PSMODULEPATH', 'NOVELWEB_AUTOMATION_DIR'].includes(name.toUpperCase())));
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-launcher-test-with spaces-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('novelweb-launcher-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}

// AST offsets insert stub boundaries into the actual launcher. Its entry,
// parameter defaults, finally block and exit status execute without copying
// selected snippets or reimposing the old mandatory provisioning sequence.
async function runLauncher(t, scenario = 'success') {
  const directory = await temporary(t);
  const scriptDirectory = path.join(directory, 'scripts');
  await mkdir(scriptDirectory);
  const logPath = path.join(directory, 'events.jsonl');
  const stubs = String.raw`
$env:LOCALAPPDATA = Join-Path $PSScriptRoot '..\local'
$global:testReadyChecks = 0
function Record-Event {
  param([string]$Step, [object]$Details = @{})
  $line = @{step = $Step; details = $Details} | ConvertTo-Json -Compress -Depth 8
  [IO.File]::AppendAllText($env:NOVELWEB_TEST_EVENT_LOG, $line + [Environment]::NewLine)
}
function Start-Transcript { param([string]$LiteralPath) Record-Event 'transcript-start' }
function Stop-Transcript { Record-Event 'transcript-stop' }
function Get-ManagedNovelWebService {
  param([string]$LogDirectory, [string]$RepositoryRoot, [string]$ExpectedStorageDirectory)
  Record-Event 'managed-service-lookup'
  if ($env:NOVELWEB_TEST_SCENARIO -eq 'recover-managed') {
    return [pscustomobject]@{pid = 12345; repositoryRoot = $RepositoryRoot; storageDir = $ExpectedStorageDirectory;
      serverUrl = 'http://127.0.0.1:43123'; uiUrl = 'http://127.0.0.1:43124/automation';
      configPath = (Join-Path $LogDirectory 'config.json'); statePath = (Join-Path $LogDirectory 'state.json'); stderrPath = (Join-Path $LogDirectory 'stderr.log')}
  }
  return $null
}
function Test-ManagedNovelWebProcess { param([object]$Record, [string]$LogDirectory) Record-Event 'owned-process-check'; return $true }
function Test-NovelWebReady {
  param([string]$ServerUrl, [string]$ApplicationUrl, [string]$ExpectedStorageDirectory)
  $global:testReadyChecks++
  Record-Event 'http-check' @{serverUrl = $ServerUrl; uiUrl = $ApplicationUrl; count = $global:testReadyChecks}
  return (($env:NOVELWEB_TEST_SCENARIO -eq 'recover-managed' -and $global:testReadyChecks -ge 3) -or
    ($env:NOVELWEB_TEST_SCENARIO -eq 'pointer-failure' -and $global:testReadyChecks -ge 4))
}
function Get-SavedNovelWebEndpoints { param([string]$StatePath, [string]$RepositoryRoot, [string]$ExpectedStorageDirectory) return $null }
function Get-FreeNovelWebPortPair { param([string]$RepositoryRoot) Record-Event 'select-free-ports'; return [pscustomobject]@{WebPort = 6173; ApiPort = 4001} }
if ($env:NOVELWEB_TEST_SCENARIO -notin @('recover-managed', 'pointer-failure')) {
  function Start-NovelWebIfNeeded {
    param([string]$RepositoryRoot, [string]$ServerUrl, [string]$ApplicationUrl, [string]$ExpectedStorageDirectory,
      [int]$WebPort, [int]$ApiPort, [string]$LogDirectory, [int]$TimeoutSeconds)
    Record-Event 'service-start' @{serverUrl = $ServerUrl; uiUrl = $ApplicationUrl; webPort = $WebPort; apiPort = $ApiPort}
    if ($env:NOVELWEB_TEST_SCENARIO -eq 'service-failure') { throw 'Injected local HTTP service failure' }
  }
}
function Start-Sleep { param([int]$Milliseconds) Record-Event 'service-wait' }
function Write-Utf8TextAtomic {
  param([string]$Path, [string]$Content)
  Record-Event 'record-write' @{name = [IO.Path]::GetFileName($Path)}
  if ($env:NOVELWEB_TEST_SCENARIO -in @('record-failure', 'pointer-failure')) { throw 'Injected diagnostic record lock' }
}
function Get-DedicatedRunnerProcesses {
  param([string]$ProfilePath)
  Record-Event 'browser-inspect'
  if ($env:NOVELWEB_TEST_SCENARIO -eq 'warm') { return [pscustomobject]@{ExecutablePath = 'fixture-chrome.exe'} }
}
function Get-ChromeForTesting { param([string]$RuntimeRoot) Record-Event 'browser-runtime'; return 'fixture-chrome.exe' }
function Install-StagedExtension { param([string]$SourcePath, [string]$DestinationPath, [string]$LocalRoot) Record-Event 'stage-extension' }
function Start-Process {
  param([string]$FilePath, [object[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle)
  if (($ArgumentList -join ' ') -match 'diagnose-installation\.mjs') {
    Record-Event 'diagnostic-start' @{windowStyle = $WindowStyle}
    if ($env:NOVELWEB_TEST_SCENARIO -eq 'diagnostic-failure') { throw 'Injected optional diagnostic failure' }
  } elseif ($FilePath -match '^http://') { Record-Event 'open-workbench' @{url = $FilePath} }
  else { Record-Event 'browser-start' @{windowStyle = $WindowStyle} }
}
function Invoke-RestMethod {
  param([string]$Uri, [int]$TimeoutSec)
  Record-Event 'browser-tabs'
  return @([pscustomobject]@{url = 'https://gemini.google.com/app'}, [pscustomobject]@{url = [string]$uiUri.AbsoluteUri})
}
function Stop-Process { param([int]$Id, [switch]$Force) Record-Event 'unexpected-process-stop'; throw 'Unexpected process stop' }
function Stop-StartedProcessTree { param([object]$Process) Record-Event 'unexpected-process-stop'; throw 'Unexpected process-tree stop' }
`;
  await writeFile(path.join(directory, 'source.ps1'), launcher);
  await writeFile(path.join(directory, 'stubs.ps1'), stubs);
  const nodeStub = step => `
import fs from 'node:fs';
fs.appendFileSync(process.env.NOVELWEB_TEST_EVENT_LOG, JSON.stringify({step:${JSON.stringify(step)}, details:{}})+'\\n');
if (${JSON.stringify(step)} === 'runner-connection') {
  if (process.env.NOVELWEB_TEST_SCENARIO === 'browser-failure') {console.log('Injected Runner connection failure'); process.exitCode = 9;}
  else console.log(JSON.stringify({responsiveTabs:1, warnings:[]}));
}
if (${JSON.stringify(step)} === 'show-workbench' && process.env.NOVELWEB_TEST_SCENARIO === 'window-failure') {
  console.error('Injected window display failure'); process.exitCode = 1;
}
if (${JSON.stringify(step)} === 'unexpected-new-supervisor' && process.env.NOVELWEB_TEST_SCENARIO === 'pointer-failure') {
  console.log(JSON.stringify({pid:12345,configPath:${JSON.stringify(path.join(directory, 'config.json'))},statePath:${JSON.stringify(path.join(directory, 'state.json'))},stderrPath:${JSON.stringify(path.join(directory, 'stderr.log'))}}));
}
`;
  await writeFile(path.join(scriptDirectory, 'check-runner-connection.mjs'), nodeStub('runner-connection'));
  await writeFile(path.join(scriptDirectory, 'show-runner-workbench.mjs'), nodeStub('show-workbench'));
  await writeFile(path.join(scriptDirectory, 'ensure-runner-developer-mode.mjs'), nodeStub('developer-mode'));
  await writeFile(path.join(scriptDirectory, 'start-local-services.mjs'), nodeStub('unexpected-new-supervisor'));
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'source.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors.Message -join '; ') }
$functions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
if ($functions.Count -eq 0) { throw 'No launcher function definitions found' }
$offset = ($functions | Select-Object -Last 1).Extent.EndOffset
$source = [IO.File]::ReadAllText($sourcePath)
$stubs = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'stubs.ps1'))
$target = Join-Path $PSScriptRoot 'scripts\start-gemini-runner.ps1'
[IO.File]::WriteAllText($target, $source.Insert($offset, [Environment]::NewLine + $stubs + [Environment]::NewLine), [Text.UTF8Encoding]::new($true))
& $target
exit $LASTEXITCODE
`;
  await writeFile(path.join(directory, 'run.ps1'), harness);
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'run.ps1')], {
    env: {...powerShellEnv, NOVELWEB_TEST_EVENT_LOG: logPath, NOVELWEB_TEST_SCENARIO: scenario}, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  let events;
  try {events = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, '')));}
  catch (error) {throw new Error(`${error.message}\n${result.stdout}\n${result.stderr}`);}
  assert.equal(events.some(event => event.step === 'unexpected-process-stop'), false, result.stdout + result.stderr);
  return {...result, events};
}

test('workbench HTTP startup precedes browser setup and optional background diagnostics', {skip: process.platform !== 'win32'}, async t => {
  const result = await runLauncher(t);
  assert.equal(result.status, 0, result.stderr);
  const steps = result.events.map(event => event.step);
  assert.ok(steps.indexOf('service-start') < steps.indexOf('diagnostic-start'));
  assert.ok(steps.indexOf('service-start') < steps.indexOf('browser-inspect'));
  assert.ok(steps.includes('runner-connection'), result.stdout);
  assert.equal(result.events.find(event => event.step === 'diagnostic-start').details.windowStyle, 'Hidden');
  assert.match(result.stdout, /Runner connection ready/);
  assert.equal(steps.at(-1), 'transcript-stop');
});
test('a Runner connection failure preserves the available workbench and exits successfully', {skip: process.platform !== 'win32'}, async t => {
  const result = await runLauncher(t, 'browser-failure');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NovelWeb remains available/);
  assert.ok(result.events.some(event => event.step === 'open-workbench' && event.details.url.endsWith('/automation')));
  assert.doesNotMatch(result.stdout, /Runner connection ready/);
});
test('a local service failure exits nonzero before starting browser or optional checks', {skip: process.platform !== 'win32'}, async t => {
  const result = await runLauncher(t, 'service-failure');
  assert.equal(result.status, 1);
  assert.match(result.stderr.replace(/\s+/g, ' '), /Injected local HTTP service failure/);
  assert.equal(result.events.some(event => ['browser-inspect', 'browser-start', 'diagnostic-start', 'runner-connection'].includes(event.step)), false);
  assert.equal(result.events.at(-1).step, 'transcript-stop');
});
for (const scenario of ['diagnostic-failure', 'record-failure', 'window-failure']) {
  test(`${scenario} is logged without blocking functional service or browser startup`, {skip: process.platform !== 'win32'}, async t => {
    const result = await runLauncher(t, scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.events.some(event => event.step === 'runner-connection'));
    assert.match(result.stdout, /Runner connection ready/);
    assert.match(result.stdout, /could not/i);
  });
}
test('a recovering managed service keeps its ports and waits without launching another supervisor', {skip: process.platform !== 'win32'}, async t => {
  const result = await runLauncher(t, 'recover-managed');
  assert.equal(result.status, 0, result.stderr);
  const steps = result.events.map(event => event.step);
  assert.equal(steps.includes('select-free-ports'), false);
  assert.equal(steps.includes('unexpected-new-supervisor'), false);
  assert.ok(steps.includes('service-wait'));
  const checks = result.events.filter(event => event.step === 'http-check');
  assert.ok(checks.length >= 3);
  assert.ok(checks.every(event => event.details.serverUrl.replace(/\/$/, '') === 'http://127.0.0.1:43123'));
  assert.ok(checks.every(event => event.details.uiUrl === 'http://127.0.0.1:43124/automation'));
  assert.match(result.stdout, /Waiting for the existing local services/);
  assert.match(result.stdout, /Runner connection ready/);
});
test('an open dedicated browser is reused without staging extensions or launching another Chrome', {skip: process.platform !== 'win32'}, async t => {
  const result = await runLauncher(t, 'warm');
  assert.equal(result.status, 0, result.stderr);
  const steps = result.events.map(event => event.step);
  assert.ok(steps.includes('runner-connection'));
  assert.ok(steps.includes('show-workbench'));
  assert.equal(steps.some(step => ['stage-extension', 'browser-runtime', 'browser-start'].includes(step)), false);
});
test('an unwritable service pointer does not invalidate the running supervisor while HTTP starts', {skip: process.platform !== 'win32'}, async t => {
  const result = await runLauncher(t, 'pointer-failure');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.events.filter(event => event.step === 'unexpected-new-supervisor').length, 1);
  assert.ok(result.events.some(event => event.step === 'owned-process-check'));
  assert.match(result.stdout, /pointer could not be saved/);
  assert.match(result.stdout, /Runner connection ready/);
});
test('Windows startup batch remains ASCII only', async () => {
  const bytes = await readFile(new URL('../start.bat', import.meta.url));
  assert.ok(bytes.every(value => value < 128), 'start.bat must work across Windows ANSI codepages');
});
test('PowerShell parses the shipped launcher', {skip: process.platform !== 'win32'}, async t => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, 'launcher.ps1'), launcher);
  const parser = String.raw`
$tokens = $null; $parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'launcher.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors.Message -join '; ') }
Write-Host 'POWERSHELL_SYNTAX_OK'
`;
  await writeFile(path.join(directory, 'parse.ps1'), parser);
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'parse.ps1')], {env: powerShellEnv, encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /POWERSHELL_SYNTAX_OK/);
});
