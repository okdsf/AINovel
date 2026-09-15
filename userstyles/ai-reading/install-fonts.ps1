[CmdletBinding()]
param(
  [string]$FontDirectory = (Join-Path $env:LOCALAPPDATA 'NovelWeb\ReadingStyle\fonts'),
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-ReadingFontSha256 {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for current-user font installation.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fonts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sourceRoot = [IO.Path]::GetFullPath($FontDirectory).TrimEnd('\', '/')
$installRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$registryRoot = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'

if (-not ('NovelWebReadingFontsV2' -as [type])) {
  Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NovelWebReadingFontsV2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct LogFont {
    public int height, width, escapement, orientation, weight;
    public byte italic, underline, strikeOut, charSet, outPrecision, clipPrecision, quality, pitchAndFamily;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string faceName;
  }
  public delegate int EnumFontCallback(ref LogFont font, IntPtr metrics, uint type, IntPtr data);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
  public static extern int EnumFontFamiliesEx(IntPtr dc, ref LogFont font, EnumFontCallback callback, IntPtr data, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
    UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  public static string[] GetFamilyNames() {
    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var dc = GetDC(IntPtr.Zero);
    if (dc == IntPtr.Zero) throw new InvalidOperationException("Cannot inspect Windows font families.");
    try {
      var font = new LogFont { charSet = 1, faceName = "" };
      EnumFontCallback callback = delegate(ref LogFont found, IntPtr metrics, uint type, IntPtr data) {
        names.Add(found.faceName); return 1;
      };
      EnumFontFamiliesEx(dc, ref font, callback, IntPtr.Zero, 0);
      GC.KeepAlive(callback);
    } finally { ReleaseDC(IntPtr.Zero, dc); }
    var result = new string[names.Count]; names.CopyTo(result); return result;
  }
}
'@
}

$visibleFamilies = [NovelWebReadingFontsV2]::GetFamilyNames()
$registry = if (Test-Path -LiteralPath $registryRoot) { Get-ItemProperty -LiteralPath $registryRoot } else { $null }
# Preflight every source and conflict before changing any files or registry values.
$plan = @(foreach ($font in $manifest.fonts) {
  $source = [IO.Path]::GetFullPath((Join-Path $sourceRoot $font.filename))
  if (-not $source.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Font source is outside the download directory: $source"
  }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
      (Get-ReadingFontSha256 -Path $source) -ne $font.sha256) {
    throw "Font missing or checksum mismatch: $($font.filename). Run the font bootstrap again."
  }
  if ([IO.Path]::GetExtension($source) -notin @('.ttf', '.otf')) { throw "Unsupported font file: $source" }
  $destination = Join-Path $installRoot ('NovelWeb-Reading-' + [IO.Path]::GetFileName($source))
  $registryName = $font.fullName + ' (TrueType)'
  $property = if ($registry) { $registry.PSObject.Properties[$registryName] } else { $null }
  $existing = if ($property) { [string]$property.Value } else { '' }
  $hasRegistry = $existing -eq $destination
  $reusedExisting = $false
  if ($existing -and $existing -ne $destination) {
    $expanded = [Environment]::ExpandEnvironmentVariables($existing)
    $candidates = if ([IO.Path]::IsPathRooted($expanded)) {
      @([IO.Path]::GetFullPath($expanded))
    } else {
      @((Join-Path ([Environment]::GetFolderPath('Fonts')) $expanded), (Join-Path $installRoot $expanded))
    }
    $registeredFiles = @($candidates | Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    $differentFiles = @($registeredFiles | Where-Object { (Get-ReadingFontSha256 -Path $_) -ne $font.sha256 })
    if (-not $registeredFiles.Count -or $differentFiles.Count) {
      throw "A font named '$registryName' is already registered at '$existing', but its file is missing or has a different SHA-256. It was not changed."
    }
    # An identical font installed outside NovelWeb is already suitable. Keep
    # its registry value and file ownership instead of installing a second copy.
    $destination = [IO.Path]::GetFullPath($registeredFiles[0])
    $hasRegistry = $true
    $reusedExisting = $true
  }
  $hasFile = Test-Path -LiteralPath $destination -PathType Leaf
  if ($hasFile -and (Get-ReadingFontSha256 -Path $destination) -ne $font.sha256) {
    throw "A different font already occupies $destination. It was not overwritten."
  }
  $visible = @($font.familyAliases | Where-Object { $visibleFamilies -contains $_ }).Count -gt 0
  [pscustomobject]@{font = $font; source = $source; destination = $destination; registryName = $registryName;
    hasFile = $hasFile; hasRegistry = $hasRegistry; reusedExisting = $reusedExisting; visible = $visible}
})

if ($Check) {
  $notReady = @($plan | Where-Object { -not $_.hasFile -or -not $_.hasRegistry -or -not $_.visible })
  if ($notReady.Count) {
    $details = ($notReady | ForEach-Object { "$($_.font.family) [file=$($_.hasFile), registered=$($_.hasRegistry), visible=$($_.visible)]" }) -join '; '
    throw "Reading fonts need preparation before Chrome starts: $details"
  }
  Write-Host "Reading font check passed: $($plan.Count) installed and visible; no changes."
  return
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
New-Item -Path $registryRoot -Force | Out-Null
$installedCount = 0
$activatedCount = 0
$installed = @(foreach ($item in $plan) {
  if (-not $item.hasFile) {
    Copy-Item -LiteralPath $item.source -Destination $item.destination
    $installedCount++
  }
  if (-not $item.hasRegistry) {
    New-ItemProperty -LiteralPath $registryRoot -Name $item.registryName -Value $item.destination -PropertyType String -Force | Out-Null
  }
  $faces = 0
  # AddFontResourceEx is reference-counted. Never add another reference when
  # the unchanged installation is already visible in this Windows session.
  if (-not $item.hasFile -or -not $item.hasRegistry -or -not $item.visible) {
    $faces = [NovelWebReadingFontsV2]::AddFontResourceEx($item.destination, 0, [IntPtr]::Zero)
    if ($faces -eq 0) { throw "Windows could not activate the font: $($item.destination)" }
    $activatedCount++
  }
  [pscustomobject]@{id = $item.font.id; family = $item.font.family; path = $item.destination;
    registryName = $item.registryName; reusedExisting = $item.reusedExisting; registeredFaces = $faces; sha256 = $item.font.sha256}
})

if ($activatedCount -gt 0) {
  $broadcastResult = [UIntPtr]::Zero
  $null = [NovelWebReadingFontsV2]::SendMessageTimeout([IntPtr]0xffff, 0x001d,
    [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$broadcastResult)
}
$visibleAfter = [NovelWebReadingFontsV2]::GetFamilyNames()
foreach ($item in $plan) {
  if (@($item.font.familyAliases | Where-Object { $visibleAfter -contains $_ }).Count -eq 0) {
    throw "Windows accepted but did not expose the font family: $($item.font.family). Restart Windows and retry."
  }
}
$report = [ordered]@{checkedAt = (Get-Date).ToUniversalTime().ToString('o'); scope = 'current-user';
  installedCount = $installedCount; activatedCount = $activatedCount; fonts = $installed}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $sourceRoot 'installed.json') -Encoding UTF8
Write-Host "Reading fonts ready: $($installed.Count) verified; $installedCount installed; $activatedCount activated."
