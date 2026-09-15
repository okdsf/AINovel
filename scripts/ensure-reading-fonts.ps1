[CmdletBinding()]
param(
  [string]$FontDirectory,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $readingRoot = Join-Path $projectRoot 'userstyles\ai-reading'
  if (-not $FontDirectory) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for reading font preparation.' }
    $manifest = Get-Content -LiteralPath (Join-Path $readingRoot 'fonts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $FontDirectory = Join-Path $env:LOCALAPPDATA $manifest.downloadSubdirectory
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  $downloadArguments = @((Join-Path $readingRoot 'download-fonts.mjs'), '--out', $FontDirectory)
  if ($Check) { $downloadArguments += '--check' }
  & $node @downloadArguments
  if ($LASTEXITCODE -ne 0) { throw 'Reading font files are missing, damaged, or could not be downloaded.' }
  & (Join-Path $readingRoot 'install-fonts.ps1') -FontDirectory $FontDirectory -Check:$Check
  exit 0
} catch {
  Write-Error -Message "Reading font preparation failed: $($_.Exception.Message)" -ErrorAction Continue
  exit 1
}
