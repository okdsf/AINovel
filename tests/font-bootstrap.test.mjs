import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {ensureFontAssets, sha256} from '../scripts/font-downloads.mjs';
import {ensurePublicFonts} from '../scripts/fetch-fonts.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const bytes = Buffer.from('fixture font contents');
const fixture = {filename: 'subsets/example.woff2', sha256: sha256(bytes), urls: ['https://fonts.example/pinned.woff2']};
const silent = () => {};

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novelweb-font-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith('novelweb-font-test-') && !relative.includes(path.sep));
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}

test('missing fonts download into a chosen directory and verified caches work offline', async t => {
  const destination = await temporary(t);
  let requests = 0;
  const options = {destination, assets: [fixture], log: silent, fetchImpl: async () => {
    requests++; return new Response(bytes);
  }};
  assert.equal((await ensureFontAssets(options))[0].status, 'downloaded');
  assert.deepEqual(await readFile(path.join(destination, fixture.filename)), bytes);
  assert.equal((await ensureFontAssets({...options, fetchImpl: () => assert.fail('cache contacted network')}))[0].status, 'verified');
  assert.equal(requests, 1);
});

test('checksum verification repairs corruption while preserving the other cached files', async t => {
  const destination = await temporary(t);
  await mkdir(path.join(destination, 'subsets'));
  await writeFile(path.join(destination, fixture.filename), 'broken');
  await writeFile(path.join(destination, 'other.woff2'), bytes);
  let requests = 0;
  const results = await ensureFontAssets({destination, assets: [fixture, {...fixture, filename: 'other.woff2'}], log: silent,
    fetchImpl: async () => {requests++; return new Response(bytes);}});
  assert.deepEqual(results.map(result => result.status), ['downloaded', 'verified']);
  assert.equal(requests, 1);
});

test('read-only checks neither download nor create missing directories', async t => {
  const destination = path.join(await temporary(t), 'absent');
  await assert.rejects(ensureFontAssets({destination, assets: [fixture], checkOnly: true, log: silent,
    fetchImpl: () => assert.fail('check contacted network')}), /Missing or damaged/);
  await assert.rejects(readFile(path.join(destination, fixture.filename)), {code: 'ENOENT'});
  await assert.rejects(readdir(destination), {code: 'ENOENT'});
});

test('failed downloads report errors, preserve the old file and leave no partial files', async t => {
  const destination = await temporary(t);
  await mkdir(path.join(destination, 'subsets'));
  await writeFile(path.join(destination, fixture.filename), 'previous contents');
  await assert.rejects(ensureFontAssets({destination, assets: [fixture], log: silent, attempts: 1,
    fetchImpl: async () => new Response('wrong hash')}), /SHA-256 mismatch/);
  assert.equal(await readFile(path.join(destination, fixture.filename), 'utf8'), 'previous contents');
  assert.deepEqual(await readdir(path.join(destination, 'subsets')), ['example.woff2']);
});

test('downloads try the next pinned mirror after a network failure', async t => {
  const destination = await temporary(t);
  const visited = [];
  await ensureFontAssets({destination, assets: [{...fixture, urls: ['https://first.example/font', 'https://second.example/font']}],
    attempts: 1, log: silent, fetchImpl: async url => {
      visited.push(url);
      if (visited.length === 1) throw new Error('network unavailable');
      return new Response(bytes);
    }});
  assert.deepEqual(visited, ['https://first.example/font', 'https://second.example/font']);
});

test('manifest paths cannot escape the selected cache directory', async t => {
  const destination = await temporary(t);
  await assert.rejects(ensureFontAssets({destination, assets: [{...fixture, filename: '../outside.woff2'}],
    fetchImpl: () => assert.fail('unsafe path contacted network')}), /Unsafe font asset path/);
});

test('all public font assets use pinned hashes and package or commit URLs', async t => {
  const manifest = JSON.parse(await readFile(new URL('../scripts/web-fonts.json', import.meta.url), 'utf8'));
  assert.equal(new Set(manifest.assets.map(asset => asset.filename)).size, manifest.assets.length);
  assert.ok(manifest.assets.filter(asset => asset.filename.endsWith('.woff2')).length > 90);
  for (const asset of manifest.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(manifest.sources[asset.source].every(url => /(?:@1\.7\.0|@2\.0\.4|809e4d8b8d7e9364a914909bb777679606c178b8)\//.test(url)));
  }
  const destination = path.join(await temporary(t), 'web-fonts');
  await assert.rejects(ensurePublicFonts({destination, checkOnly: true, log: silent,
    fetchImpl: () => assert.fail('public font check contacted network')}), /Missing or damaged/);
});

test('the CLI returns a failing exit code for missing fonts without creating its output directory', async t => {
  const destination = path.join(await temporary(t), 'not-created');
  const result = spawnSync(process.execPath, ['userstyles/ai-reading/download-fonts.mjs', '--check', '--out', destination],
    {cwd: projectRoot, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing or damaged/);
  await assert.rejects(readdir(destination), {code: 'ENOENT'});
});

test('Windows installer is idempotent, reuses identical existing fonts and refuses conflicts (isolated doubles)',
  {skip: process.platform !== 'win32'}, async t => {
    const directory = await temporary(t);
    const font = {id: 'test', family: 'Test Family', familyAliases: ['Test Family'], fullName: 'Test Family',
      filename: 'Fixture.ttf', sha256: sha256(bytes)};
    await mkdir(path.join(directory, 'cache'));
    await writeFile(path.join(directory, 'cache', font.filename), bytes);
    await writeFile(path.join(directory, 'fonts.json'), JSON.stringify({fonts: [font]}));
    await writeFile(path.join(directory, 'install-fonts.ps1'), await readFile(new URL('../userstyles/ai-reading/install-fonts.ps1', import.meta.url)));
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
Get-Command Get-FileHash | Out-Null
$env:LOCALAPPDATA = Join-Path $PSScriptRoot 'local'
$global:FontRegistry = @{}
$global:FontRegistryWrites = 0
Add-Type @'
using System;
public static class NovelWebReadingFontsV2 {
  public static int Count = 0;
  public static string[] GetFamilyNames() { return Count > 0 ? new[] { "Test Family" } : new string[0]; }
  public static int AddFontResourceEx(string path, uint flags, IntPtr reserved) { Count++; return 1; }
  public static IntPtr SendMessageTimeout(IntPtr w, uint m, UIntPtr p, IntPtr l, uint f, uint t, out UIntPtr r) { r = UIntPtr.Zero; return IntPtr.Zero; }
}
'@
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -like 'HKCU:*') { return $true }
  Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-ItemProperty { param($LiteralPath) return [pscustomobject]$global:FontRegistry }
function New-Item {
  param($Path, $ItemType, [switch]$Force)
  if ($Path -notlike 'HKCU:*') { Microsoft.PowerShell.Management\New-Item @PSBoundParameters }
}
function New-ItemProperty {
  param($LiteralPath, $Name, $Value, $PropertyType, [switch]$Force)
  if ($LiteralPath -notlike 'HKCU:*') { throw 'Test harness registry scope error' }
  $global:FontRegistryWrites++
  $global:FontRegistry[$Name] = $Value
}
$installer = Join-Path $PSScriptRoot 'install-fonts.ps1'
$cache = Join-Path $PSScriptRoot 'cache'
$checkFailed = $false
try { & $installer -FontDirectory $cache -Check } catch { $checkFailed = $_.Exception.Message -like '*need preparation*' }
if (-not $checkFailed -or [NovelWebReadingFontsV2]::Count -ne 0 -or [IO.Directory]::Exists($env:LOCALAPPDATA)) { throw 'Check mode changed an incomplete installation.' }
& $installer -FontDirectory $cache
& $installer -FontDirectory $cache
& $installer -FontDirectory $cache -Check
if ([NovelWebReadingFontsV2]::Count -ne 1) { throw 'Font activation was repeated.' }
$report = Get-Content -LiteralPath (Join-Path $cache 'installed.json') -Raw | ConvertFrom-Json
if ($report.activatedCount -ne 0 -or $report.installedCount -ne 0) { throw 'Cache hit was not reported.' }
$installed = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts\NovelWeb-Reading-Fixture.ttf'
[IO.File]::WriteAllText($installed, 'unrelated font')
$conflictDetected = $false
try { & $installer -FontDirectory $cache } catch { $conflictDetected = $_.Exception.Message -like '*not overwritten*' }
if (-not $conflictDetected -or [IO.File]::ReadAllText($installed) -ne 'unrelated font') { throw 'Conflicting font was changed.' }
Copy-Item -LiteralPath (Join-Path $cache 'Fixture.ttf') -Destination $installed
$global:FontRegistry['Test Family (TrueType)'] = 'C:\another-font.ttf'
$registryConflict = $false
try { & $installer -FontDirectory $cache } catch { $registryConflict = $_.Exception.Message -like '*was not changed*' }
if (-not $registryConflict -or $global:FontRegistry['Test Family (TrueType)'] -ne 'C:\another-font.ttf' -or [NovelWebReadingFontsV2]::Count -ne 1) { throw 'Registry conflict was changed.' }
$externalFont = Join-Path $PSScriptRoot 'existing user font.ttf'
Copy-Item -LiteralPath (Join-Path $cache 'Fixture.ttf') -Destination $externalFont
$global:FontRegistry['Test Family (TrueType)'] = $externalFont
[IO.File]::WriteAllText($installed, 'unrelated font in the managed filename')
$previousReport = [IO.File]::ReadAllText((Join-Path $cache 'installed.json'))
& $installer -FontDirectory $cache -Check
if ([IO.File]::ReadAllText((Join-Path $cache 'installed.json')) -ne $previousReport) { throw 'Check rewrote the installation report.' }
& $installer -FontDirectory $cache
$reused = Get-Content -LiteralPath (Join-Path $cache 'installed.json') -Raw | ConvertFrom-Json
if ($reused.fonts[0].path -ne $externalFont -or -not $reused.fonts[0].reusedExisting -or $reused.installedCount -ne 0 -or $reused.activatedCount -ne 0) { throw 'Existing identical font was not reused.' }
if ($global:FontRegistry['Test Family (TrueType)'] -ne $externalFont -or $global:FontRegistryWrites -ne 1 -or [NovelWebReadingFontsV2]::Count -ne 1) { throw 'Existing font registration or activation changed.' }
if ([IO.File]::ReadAllText($installed) -ne 'unrelated font in the managed filename') { throw 'Unused destination was overwritten.' }
[IO.File]::WriteAllText($externalFont, 'different version')
$externalConflict = $false
try { & $installer -FontDirectory $cache } catch { $externalConflict = $_.Exception.Message -like '*different SHA-256*' }
if (-not $externalConflict -or [IO.File]::ReadAllText($externalFont) -ne 'different version') { throw 'Different existing font was not protected.' }
$relativeFont = 'Existing-Fixture.ttf'
$relativePath = Join-Path (Split-Path -Parent $installed) $relativeFont
Copy-Item -LiteralPath (Join-Path $cache 'Fixture.ttf') -Destination $relativePath
$global:FontRegistry['Test Family (TrueType)'] = $relativeFont
& $installer -FontDirectory $cache -Check
& $installer -FontDirectory $cache
$relativeReport = Get-Content -LiteralPath (Join-Path $cache 'installed.json') -Raw | ConvertFrom-Json
if ($relativeReport.fonts[0].path -ne $relativePath -or $global:FontRegistry['Test Family (TrueType)'] -ne $relativeFont -or $global:FontRegistryWrites -ne 1) { throw 'Relative existing registry value was not preserved.' }
Write-Host 'ISOLATED_FONT_INSTALLER_PASS'
`;
    await writeFile(path.join(directory, 'run.ps1'), harness);
    // A parent PowerShell 7 session may export incompatible module directories
    // into Node; let Windows PowerShell rebuild its own module search path.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
    const output = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'run.ps1')],
      {encoding: 'utf8', timeout: 30_000, env});
    assert.match(output, /ISOLATED_FONT_INSTALLER_PASS/);
  });
