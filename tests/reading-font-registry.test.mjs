import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const installer = await readFile(new URL('../userstyles/ai-reading/install-fonts.ps1', import.meta.url), 'utf8');
const directoryPreparation = 'New-Item -ItemType Directory -Path $installRoot -Force | Out-Null';
const directoryStart = installer.indexOf(directoryPreparation);
const start = directoryStart + directoryPreparation.length;
const end = installer.indexOf('$installedCount = 0', start);
assert.ok(directoryStart > 0 && end > start, 'Locate the shipped registry preparation block');
const prepareRegistry = installer.slice(start, end);
const powerShellEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));

async function runRegistryFixture(t, existing) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-font-registry-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('novelweb-font-registry-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  const fixture = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$registryRoot = 'HKCU:\Software\NovelWebFontRegistryTest_' + [Guid]::NewGuid().ToString('N')
$existing = ${existing ? '$true' : '$false'}
try {
  if ($existing) {
    New-Item -Path $registryRoot | Out-Null
    New-ItemProperty -LiteralPath $registryRoot -Name 'Other application font' -Value 'keep-unrelated.ttf' -PropertyType String | Out-Null
    New-ItemProperty -LiteralPath $registryRoot -Name 'NovelWeb existing font' -Value 'keep-novelweb.ttf' -PropertyType String | Out-Null
    New-Item -Path ($registryRoot + '\UnrelatedChild') | Out-Null
    New-ItemProperty -LiteralPath ($registryRoot + '\UnrelatedChild') -Name 'Keep' -Value 'nested-value' -PropertyType String | Out-Null
  }
  # The production preflight computes this before preparing the shared key.
  $hasRegistry = $existing
  & {
${prepareRegistry}
  }
  if (-not $hasRegistry) {
    New-ItemProperty -LiteralPath $registryRoot -Name 'NovelWeb existing font' -Value 'new-novelweb.ttf' -PropertyType String | Out-Null
  }
  # A repeated launch must preserve the current registrations as well.
  & {
${prepareRegistry}
  }
  $values = Get-ItemProperty -LiteralPath $registryRoot
  if ($existing) {
    if ($values.'Other application font' -ne 'keep-unrelated.ttf') { throw 'Unrelated font registration was changed.' }
    if ($values.'NovelWeb existing font' -ne 'keep-novelweb.ttf') { throw 'Preflight-reused font registration was lost.' }
    if ((Get-ItemProperty -LiteralPath ($registryRoot + '\UnrelatedChild')).Keep -ne 'nested-value') { throw 'Unrelated subkey was changed.' }
  } elseif ($values.'NovelWeb existing font' -ne 'new-novelweb.ttf') {
    throw 'New registration did not survive the second launch.'
  }
  Write-Output 'FONT_REGISTRY_PRESERVED'
} finally {
  if ($registryRoot -notmatch '^HKCU:\\Software\\NovelWebFontRegistryTest_[a-f0-9]{32}$') { throw 'Refusing unsafe fixture cleanup target.' }
  if (Test-Path -LiteralPath $registryRoot) { Remove-Item -LiteralPath $registryRoot -Recurse -Force }
}
`;
  const script = path.join(directory, 'fixture.ps1');
  await writeFile(script, fixture);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    {env: powerShellEnv, encoding: 'utf8', timeout: 15_000, windowsHide: true});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FONT_REGISTRY_PRESERVED/);
}

test('repeated font setup preserves preflight-reused fonts, unrelated values and subkeys',
  {skip: process.platform !== 'win32'}, async t => runRegistryFixture(t, true));

test('first font setup creates a missing key and later launches preserve its registration',
  {skip: process.platform !== 'win32'}, async t => runRegistryFixture(t, false));
