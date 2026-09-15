[CmdletBinding()]
param(
  [string]$ServerUrl = 'http://127.0.0.1:3001',
  [string]$UiUrl = 'http://127.0.0.1:5173/automation',
  [ValidateRange(10, 180)]
  [int]$StartupTimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-LocalHttpUrl {
  param([string]$Value, [string]$Label, [string]$RequiredPath = '')

  $uri = [Uri]$Value
  if ($uri.Scheme -ne 'http' -or
      $uri.Host -notin @('127.0.0.1', 'localhost') -or
      $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
      ($RequiredPath -and $uri.AbsolutePath -ne $RequiredPath)) {
    throw "$Label must use local http://127.0.0.1 or http://localhost."
  }
  return $uri
}

function Test-HttpReady {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-AutomationStatus {
  param([string]$Url)

  try {
    return Invoke-RestMethod -Uri $Url -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-AutomationStatus {
  param(
    [object]$Status,
    [string]$ExpectedStorageDirectory,
    [string]$ExpectedServerUrl
  )

  if ($null -eq $Status -or
      $null -eq $Status.PSObject.Properties['worker'] -or
      $null -eq $Status.PSObject.Properties['storageDir'] -or
      $null -eq $Status.PSObject.Properties['pairing'] -or
      $null -eq $Status.pairing -or
      $null -eq $Status.pairing.PSObject.Properties['serverUrl'] -or
      $null -eq $Status.pairing.PSObject.Properties['token']) {
    return $false
  }

  try {
    $actualStorage = [IO.Path]::GetFullPath([string]$Status.storageDir).TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    $expectedStorage = [IO.Path]::GetFullPath($ExpectedStorageDirectory).TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    $actualServer = [Uri][string]$Status.pairing.serverUrl
    $expectedServer = [Uri]$ExpectedServerUrl
    $loopbackHosts = @('127.0.0.1', 'localhost')
    $serverMatches = $actualServer.Scheme -eq 'http' -and
      $expectedServer.Scheme -eq 'http' -and
      $actualServer.Host -in $loopbackHosts -and
      $expectedServer.Host -in $loopbackHosts -and
      $actualServer.Port -eq $expectedServer.Port
    return $actualStorage.Equals($expectedStorage, [StringComparison]::OrdinalIgnoreCase) -and
      $serverMatches -and
      [string]$Status.pairing.token -match '^[A-Za-z0-9_-]{32,}$'
  } catch {
    return $false
  }
}

function Test-NovelWebReady {
  param(
    [string]$ServerUrl,
    [string]$ApplicationUrl,
    [string]$ExpectedStorageDirectory
  )

  try {
    $serverUri = [Uri]$ServerUrl
    $applicationUri = [Uri]$ApplicationUrl
    $apiStatusUrl = "$($serverUri.GetLeftPart([UriPartial]::Authority))/api/automation/status"
    $proxiedStatusUrl = "$($applicationUri.GetLeftPart([UriPartial]::Authority))/api/automation/status"
    $directStatus = Get-AutomationStatus -Url $apiStatusUrl
    $proxiedStatus = Get-AutomationStatus -Url $proxiedStatusUrl

    if (-not (Test-AutomationStatus `
        -Status $directStatus `
        -ExpectedStorageDirectory $ExpectedStorageDirectory `
        -ExpectedServerUrl $ServerUrl) -or
        -not (Test-AutomationStatus `
        -Status $proxiedStatus `
        -ExpectedStorageDirectory $ExpectedStorageDirectory `
        -ExpectedServerUrl $ServerUrl) -or
        [string]$directStatus.pairing.token -cne [string]$proxiedStatus.pairing.token) {
      return $false
    }

    return Test-HttpReady -Url $ApplicationUrl
  } catch {
    return $false
  }
}

function Get-FreeNovelWebPortPair {
  param([string]$RepositoryRoot)

  $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
  $selectorPath = Join-Path $RepositoryRoot 'scripts/find-ports.mjs'
  $output = @(& $nodeCommand $selectorPath 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "NovelWeb port selection failed with exit code $exitCode. $($output -join ' ')"
  }

  $values = @{}
  foreach ($line in $output) {
    $text = [string]$line
    if ($text -match '^(NOVELWEB_(?:WEB|API)_PORT)=(\d+)$') {
      $values[$Matches[1]] = [int]$Matches[2]
    }
  }

  $webPort = $values['NOVELWEB_WEB_PORT']
  $apiPort = $values['NOVELWEB_API_PORT']
  if ($null -eq $webPort -or $null -eq $apiPort -or
      $webPort -lt 1 -or $webPort -gt 65535 -or
      $apiPort -lt 1 -or $apiPort -gt 65535 -or
      $webPort -eq $apiPort) {
    throw "NovelWeb port selection returned an invalid pair. $($output -join ' ')"
  }

  return [pscustomobject]@{
    WebPort = $webPort
    ApiPort = $apiPort
  }
}

function Get-LogTail {
  param([string]$Path, [int]$MaximumLines = 40)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '(missing)' }
  $lines = @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return '(empty)' }
  return ($lines | Select-Object -Last $MaximumLines) -join [Environment]::NewLine
}

function Get-NovelWebStartupFailure {
  param(
    [string]$Reason,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $stdout = Get-LogTail -Path $StdoutPath
  $stderr = Get-LogTail -Path $StderrPath
  return "$Reason`n--- novelweb.stdout.log ---`n$stdout`n--- novelweb.stderr.log ---`n$stderr"
}

function Get-TokenHash {
  param([string]$Token)

  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $algorithm.Dispose()
  }
}

function Set-PrivateFileAcl {
  param([string]$Path)

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $security = New-Object Security.AccessControl.FileSecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($currentSid, $fullControl, $allow)))
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, $fullControl, $allow)))
  (New-Object IO.FileInfo($Path)).SetAccessControl($security)
}

function Assert-PathWithin {
  param([string]$BasePath, [string]$CandidatePath)

  $base = [IO.Path]::GetFullPath($BasePath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $candidate = [IO.Path]::GetFullPath($CandidatePath)
  if (-not $candidate.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to use a runtime path outside the NovelWeb runner directory.'
  }
  return $candidate
}

function Get-FileMd5Base64 {
  param([string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.MD5]::Create()
  try {
    return [Convert]::ToBase64String($algorithm.ComputeHash($stream))
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-FileSha256Hex {
  param([string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-DirectorySha256Hex {
  param([string]$RootPath, [string[]]$ExcludedNames = @())

  $root = [IO.Path]::GetFullPath($RootPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $records = foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Force | Sort-Object FullName) {
    if ($file.Name -in $ExcludedNames) { continue }
    $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
    "$relative`0$(Get-FileSha256Hex -Path $file.FullName)"
  }
  return Get-TokenHash -Token ($records -join "`n")
}

function ConvertTo-ChromeArgument {
  param([string]$Name, [string]$Value)

  if ($Value.Contains('"')) { throw "Chrome argument $Name contained an invalid quote." }
  if (-not $Name) { return "`"$Value`"" }
  return "$Name=`"$Value`""
}

function Write-Utf8TextAtomic {
  param([string]$Path, [string]$Content)

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporaryPath = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $backupPath = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.bak')
  try {
    [IO.File]::WriteAllText($temporaryPath, $Content, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
    } else {
      Move-Item -LiteralPath $temporaryPath -Destination $Path
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
  }
}

function Get-DedicatedRunnerProcesses {
  param([string]$ProfilePath)

  $escaped = [Regex]::Escape([IO.Path]::GetFullPath($ProfilePath))
  $pattern = "--user-data-dir=(?:`"$escaped`"|$escaped)(?:\s|$)"
  return @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match $pattern })
}

function Stop-StartedProcessTree {
  param([Diagnostics.Process]$Process)

  try {
    $Process.Refresh()
    if ($Process.HasExited) { return }

    $snapshot = @(Get-CimInstance Win32_Process)
    $pending = @([pscustomobject]@{ ProcessId = $Process.Id; Depth = 0 })
    $targets = @()
    for ($index = 0; $index -lt $pending.Count; $index++) {
      $current = $pending[$index]
      $targets += $current
      foreach ($child in @($snapshot | Where-Object { $_.ParentProcessId -eq $current.ProcessId })) {
        $pending += [pscustomobject]@{ ProcessId = [int]$child.ProcessId; Depth = $current.Depth + 1 }
      }
    }

    foreach ($target in @($targets | Sort-Object Depth -Descending)) {
      Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

function Install-StagedExtension {
  param([string]$SourcePath, [string]$DestinationPath, [string]$LocalRoot)

  $candidate = Assert-PathWithin -BasePath $LocalRoot -CandidatePath (Join-Path $LocalRoot ('.extension-' + [Guid]::NewGuid().ToString('N')))
  try {
    Copy-Item -LiteralPath $SourcePath -Destination $candidate -Recurse
    if (-not (Test-Path -LiteralPath (Join-Path $candidate 'manifest.json') -PathType Leaf)) {
      throw 'The staged Gemini Runner extension was incomplete.'
    }
    if (Test-Path -LiteralPath $DestinationPath) {
      $verifiedDestination = Assert-PathWithin -BasePath $LocalRoot -CandidatePath $DestinationPath
      Remove-Item -LiteralPath $verifiedDestination -Recurse -Force
    }
    Move-Item -LiteralPath $candidate -Destination $DestinationPath
  } finally {
    if (Test-Path -LiteralPath $candidate) {
      $verifiedCandidate = Assert-PathWithin -BasePath $LocalRoot -CandidatePath $candidate
      Remove-Item -LiteralPath $verifiedCandidate -Recurse -Force
    }
  }
}

function Assert-SafeChromeArchive {
  param([string]$ArchivePath, [string]$ExtractionRoot)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = [IO.Path]::GetFullPath($ExtractionRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    [long]$totalBytes = 0
    $entryCount = 0
    foreach ($entry in $archive.Entries) {
      $entryCount += 1
      $totalBytes += $entry.Length
      if ($entryCount -gt 20000 -or $totalBytes -gt 2GB -or [IO.Path]::IsPathRooted($entry.FullName)) {
        throw 'The Chrome for Testing archive exceeded its safety limits.'
      }
      $entryTarget = [IO.Path]::GetFullPath((Join-Path $ExtractionRoot $entry.FullName))
      if (-not $entryTarget.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The Chrome for Testing archive contained an unsafe path.'
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-ChromeForTesting {
  param([string]$RuntimeRoot)

  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $markerPath = Join-Path $RuntimeRoot 'runtime.json'
  $trustedMarker = $null
  $trustedExecutable = $null
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    try {
      $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
      if ($marker.schemaVersion -eq 2 -and
          $marker.version -match '^\d+\.\d+\.\d+\.\d+$' -and
          $marker.directorySha256 -match '^[0-9a-f]{64}$') {
        $versionDirectory = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $RuntimeRoot $marker.version)
        $expectedExecutable = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $versionDirectory 'chrome-win64/chrome.exe')
        $cachedExecutable = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath $marker.executable
        if ($cachedExecutable -eq $expectedExecutable -and
            (Test-Path -LiteralPath $cachedExecutable -PathType Leaf) -and
            (Get-DirectorySha256Hex -RootPath $versionDirectory) -ceq $marker.directorySha256) {
          $trustedMarker = $marker
          $trustedExecutable = $cachedExecutable
        }
      }
    } catch {}
  }

  $metadataUrl = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
  try {
    $metadata = Invoke-RestMethod -Uri $metadataUrl -TimeoutSec 30
  } catch {
    if ($trustedExecutable) {
      Write-Warning 'Could not check Chrome for Testing updates; using the last verified local runtime.'
      return $trustedExecutable
    }
    throw
  }
  $stable = $metadata.channels.Stable
  $downloads = @($stable.downloads.chrome | Where-Object { $_.platform -eq 'win64' })
  if ($downloads.Count -ne 1 -or $stable.version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw 'The official Chrome for Testing metadata did not contain a valid Windows build.'
  }
  if ($trustedExecutable -and $trustedMarker.version -eq $stable.version) {
    return $trustedExecutable
  }

  Write-Host 'Installing or updating the dedicated Chrome for Testing runtime...'
  $download = $downloads[0]
  $downloadUri = [Uri]$download.url
  $expectedDownloadPath = "/chrome-for-testing-public/$($stable.version)/win64/chrome-win64.zip"
  if ($downloadUri.Scheme -ne 'https' -or
      $downloadUri.Host -ne 'storage.googleapis.com' -or
      $downloadUri.AbsolutePath -cne $expectedDownloadPath -or
      $downloadUri.UserInfo -or $downloadUri.Query -or $downloadUri.Fragment) {
    throw 'The Chrome for Testing download URL was not an expected official Google URL.'
  }

  $headers = Invoke-WebRequest -UseBasicParsing -Uri $downloadUri.AbsoluteUri -Method Head -MaximumRedirection 0 -TimeoutSec 30
  [long]$expectedLength = @($headers.Headers['Content-Length'])[0]
  $googleHash = @($headers.Headers['x-goog-hash']) -join ','
  if ($expectedLength -lt 10MB -or $googleHash -notmatch '(?:^|,)md5=([^,]+)') {
    throw 'The official Chrome for Testing response did not include its expected integrity metadata.'
  }
  $expectedMd5 = $Matches[1]

  $installDirectory = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $RuntimeRoot $stable.version)
  $chromeExecutable = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $installDirectory 'chrome-win64/chrome.exe')
  $downloadsDirectory = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $RuntimeRoot 'downloads')
  New-Item -ItemType Directory -Force -Path $downloadsDirectory | Out-Null
  $cachedArchive = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $downloadsDirectory "chrome-win64-$($stable.version).zip")
  if (Test-Path -LiteralPath $cachedArchive -PathType Leaf) {
    $cachedLength = (Get-Item -LiteralPath $cachedArchive).Length
    if ($cachedLength -ne $expectedLength -or (Get-FileMd5Base64 -Path $cachedArchive) -cne $expectedMd5) {
      Remove-Item -LiteralPath $cachedArchive -Force
    }
  }
  if (-not (Test-Path -LiteralPath $cachedArchive -PathType Leaf)) {
    $partialArchive = "$cachedArchive.partial"
    if (Test-Path -LiteralPath $partialArchive) { Remove-Item -LiteralPath $partialArchive -Force }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $downloadUri.AbsoluteUri -OutFile $partialArchive -MaximumRedirection 0 -TimeoutSec 600
      if ((Get-Item -LiteralPath $partialArchive).Length -ne $expectedLength -or
          (Get-FileMd5Base64 -Path $partialArchive) -cne $expectedMd5) {
        throw 'The Chrome for Testing download failed its Google Cloud integrity check.'
      }
      Move-Item -LiteralPath $partialArchive -Destination $cachedArchive
    } finally {
      if (Test-Path -LiteralPath $partialArchive) { Remove-Item -LiteralPath $partialArchive -Force }
    }
  }

  $temporaryDirectory = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $RuntimeRoot ('.install-' + [Guid]::NewGuid().ToString('N')))
  $extractDirectory = Join-Path $temporaryDirectory 'extract'
  New-Item -ItemType Directory -Force -Path $extractDirectory | Out-Null
  try {
    Assert-SafeChromeArchive -ArchivePath $cachedArchive -ExtractionRoot $extractDirectory
    Expand-Archive -LiteralPath $cachedArchive -DestinationPath $extractDirectory -Force
    $extractedChrome = Join-Path $extractDirectory 'chrome-win64/chrome.exe'
    if (-not (Test-Path -LiteralPath $extractedChrome -PathType Leaf)) {
      throw 'The Chrome for Testing archive did not contain chrome.exe.'
    }
    if (Test-Path -LiteralPath $installDirectory) {
      $verifiedInstallDirectory = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath $installDirectory
      Remove-Item -LiteralPath $verifiedInstallDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $installDirectory | Out-Null
    Move-Item -LiteralPath (Join-Path $extractDirectory 'chrome-win64') -Destination (Join-Path $installDirectory 'chrome-win64')
  } finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
      $verifiedTemporaryDirectory = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath $temporaryDirectory
      Remove-Item -LiteralPath $verifiedTemporaryDirectory -Recurse -Force
    }
  }
  if (-not (Test-Path -LiteralPath $chromeExecutable -PathType Leaf)) {
    throw 'Chrome for Testing installation did not complete.'
  }

  $runtimeMarker = [ordered]@{
    schemaVersion = 2
    version = $stable.version
    executable = $chromeExecutable
    directorySha256 = Get-DirectorySha256Hex -RootPath $installDirectory
    installedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  Write-Utf8TextAtomic -Path $markerPath -Content $runtimeMarker
  return $chromeExecutable
}

function Start-NovelWebIfNeeded {
  param(
    [string]$RepositoryRoot,
    [string]$ServerUrl,
    [string]$ApplicationUrl,
    [string]$ExpectedStorageDirectory,
    [int]$WebPort,
    [int]$ApiPort,
    [string]$LogDirectory,
    [int]$TimeoutSeconds
  )

  if (Test-NovelWebReady `
      -ServerUrl $ServerUrl `
      -ApplicationUrl $ApplicationUrl `
      -ExpectedStorageDirectory $ExpectedStorageDirectory) {
    return
  }

  New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
  $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
  $stdoutPath = Join-Path $LogDirectory 'novelweb.stdout.log'
  $stderrPath = Join-Path $LogDirectory 'novelweb.stderr.log'
  $startParameters = @{
    FilePath = $npmCommand
    ArgumentList = @('run', 'dev')
    WorkingDirectory = $RepositoryRoot
    WindowStyle = 'Hidden'
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    PassThru = $true
  }
  $webPortWasDefined = Test-Path Env:\NOVELWEB_WEB_PORT
  $apiPortWasDefined = Test-Path Env:\NOVELWEB_API_PORT
  $previousWebPort = if ($webPortWasDefined) { (Get-Item Env:\NOVELWEB_WEB_PORT).Value } else { $null }
  $previousApiPort = if ($apiPortWasDefined) { (Get-Item Env:\NOVELWEB_API_PORT).Value } else { $null }
  $process = $null
  try {
    $env:NOVELWEB_WEB_PORT = [string]$WebPort
    $env:NOVELWEB_API_PORT = [string]$ApiPort
    $process = Start-Process @startParameters
  } finally {
    if ($webPortWasDefined) { $env:NOVELWEB_WEB_PORT = $previousWebPort }
    else { Remove-Item Env:\NOVELWEB_WEB_PORT -ErrorAction SilentlyContinue }
    if ($apiPortWasDefined) { $env:NOVELWEB_API_PORT = $previousApiPort }
    else { Remove-Item Env:\NOVELWEB_API_PORT -ErrorAction SilentlyContinue }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-NovelWebReady `
        -ServerUrl $ServerUrl `
        -ApplicationUrl $ApplicationUrl `
        -ExpectedStorageDirectory $ExpectedStorageDirectory) {
      return
    }
    $process.Refresh()
    if ($process.HasExited) {
      Start-Sleep -Milliseconds 200
      $reason = "NovelWeb dev process exited before it became ready (exit code $($process.ExitCode))."
      throw (Get-NovelWebStartupFailure -Reason $reason -StdoutPath $stdoutPath -StderrPath $stderrPath)
    }
    Start-Sleep -Milliseconds 500
  }
  $reason = "NovelWeb did not become ready within $TimeoutSeconds seconds at $ApplicationUrl and $ServerUrl."
  Stop-StartedProcessTree -Process $process
  Start-Sleep -Milliseconds 200
  throw (Get-NovelWebStartupFailure -Reason $reason -StdoutPath $stdoutPath -StderrPath $stderrPath)
}

function Get-SavedNovelWebEndpoints {
  param(
    [string]$StatePath,
    [string]$RepositoryRoot,
    [string]$ExpectedStorageDirectory
  )

  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try {
    $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    $requiredFields = @('schemaVersion', 'repositoryRoot', 'serverUrl', 'uiUrl')
    if ($state.schemaVersion -ne 1 -or
        @($requiredFields | Where-Object { $null -eq $state.PSObject.Properties[$_] }).Count -ne 0 -or
        -not ([IO.Path]::GetFullPath([string]$state.repositoryRoot)).Equals(
          [IO.Path]::GetFullPath($RepositoryRoot),
          [StringComparison]::OrdinalIgnoreCase
        )) {
      return $null
    }

    $savedServerUri = Assert-LocalHttpUrl -Value ([string]$state.serverUrl) -Label 'Saved ServerUrl' -RequiredPath '/'
    $savedUiUri = Assert-LocalHttpUrl -Value ([string]$state.uiUrl) -Label 'Saved UiUrl' -RequiredPath '/automation'
    if (-not (Test-NovelWebReady `
        -ServerUrl $savedServerUri.AbsoluteUri `
        -ApplicationUrl $savedUiUri.AbsoluteUri `
        -ExpectedStorageDirectory $ExpectedStorageDirectory)) {
      return $null
    }

    return [pscustomobject]@{
      ServerUrl = $savedServerUri.AbsoluteUri
      UiUrl = $savedUiUri.AbsoluteUri
    }
  } catch {
    return $null
  }
}

function Assert-RunnerBackgroundLoaded {
  param(
    [string]$SourceExtension,
    [string]$WorkerId,
    [string]$BootstrapId,
    [int]$TimeoutSeconds,
    [switch]$ColdStart
  )

  # Reading the staged files or manifest version cannot attest the compiled
  # service worker: Chrome can keep an older worker across a cold restart.
  # Node's built-in WebSocket is available on the supported Node 20.19 with
  # --experimental-websocket; no additional browser dependency is required.
  $verificationScript = @'
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [sourceRoot, workerId, bootstrapId, timeoutText, mode] = process.argv.slice(2);
const coldStart = mode === 'cold';
const normalize = text => String(text).replace(/\r\n?/g, '\n').trimEnd();
const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
const scriptPath = manifest.background.service_worker;
const expectedSource = normalize(await readFile(path.join(sourceRoot, scriptPath), 'utf8'));
const deadline = Date.now() + Number(timeoutText) * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(target) {
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9223') {
    throw new Error('Runner CDP returned a non-local debugger address.');
  }
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Runner CDP connection timed out.')); }, 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Runner CDP connection failed.')); };
  });
  let sequence = 0;
  const pending = new Map();
  const scripts = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Debugger.scriptParsed') scripts.push(message.params);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  return {
    scripts,
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Runner CDP ${method} timed out.`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function verify() {
  let reloaded = false;
  while (Date.now() < deadline) {
    const targets = await (await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(3000) })).json();
    if (coldStart && targets.some(target => target.type === 'page' && /^https:\/\/gemini\.google\.com\//.test(target.url))) {
      throw new Error('Gemini pages opened before background verification; no extension reload was attempted. Close the dedicated Runner and retry.');
    }
    const candidates = targets.filter(target => target.type === 'service_worker'
      && /^chrome-extension:\/\/[a-p]{32}\//.test(target.url) && target.url.endsWith(`/${scriptPath}`));
    for (const target of candidates) {
      const client = await connect(target);
      try {
        const inspected = await client.call('Runtime.evaluate', {
          expression: `(async () => {
            const manifest = chrome.runtime.getManifest();
            if (manifest.name !== ${JSON.stringify(manifest.name)}) return null;
            const stored = await chrome.storage.local.get(['workerId', 'nwGeminiRunnerLastBootstrapId', 'nwGeminiRunnerActiveTask', 'nwGeminiRunnerOutbox']);
            return { extensionId: chrome.runtime.id, workerId: stored.workerId,
              bootstrapId: stored.nwGeminiRunnerLastBootstrapId,
              busy: Boolean(stored.nwGeminiRunnerActiveTask),
              outboxCount: Array.isArray(stored.nwGeminiRunnerOutbox) ? stored.nwGeminiRunnerOutbox.length : 0 };
          })()`, returnByValue: true, awaitPromise: true
        });
        const state = inspected.result?.value;
        if (!state || state.workerId !== workerId || state.bootstrapId !== bootstrapId) continue;
        await client.call('Debugger.enable');
        const loadedScripts = client.scripts.filter(script => script.url === target.url);
        if (loadedScripts.length !== 1) throw new Error('Runner background script cannot be identified uniquely in memory.');
        const loaded = await client.call('Debugger.getScriptSource', { scriptId: loadedScripts[0].scriptId });
        if (normalize(loaded.scriptSource) === expectedSource) {
          console.log(`Verified loaded Gemini Runner background: ${createHash('sha256').update(expectedSource).digest('hex')}`);
          return;
        }
        if (!coldStart) throw new Error('The open Runner has stale background code. Close its dedicated window and run npm run gemini again.');
        if (state.busy || state.outboxCount > 0) throw new Error('Stale Runner background has an active task or pending result; it was not reloaded.');
        if (!reloaded) {
          // No Gemini page exists in this cold background-only launch, so no
          // content script can claim work between the idle check and reload.
          await client.call('Runtime.evaluate', {
            expression: 'setTimeout(() => chrome.runtime.reload(), 100); true', returnByValue: true
          });
          reloaded = true;
        }
      } finally {
        client.close();
      }
    }
    await sleep(300);
  }
  throw new Error('Runner did not load the staged background source before startup timed out.');
}
try { await verify(); } catch (error) { console.error(error.message); process.exitCode = 1; }
'@
  $verificationMode = if ($ColdStart) { 'cold' } else { 'verify' }
  $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
  $verificationScript | & $nodeCommand --experimental-websocket --input-type=module - $SourceExtension $WorkerId $BootstrapId ([string]$TimeoutSeconds) $verificationMode
  if ($LASTEXITCODE -ne 0) {
    throw 'Loaded Gemini Runner background verification failed; startup stopped before opening Gemini.'
  }
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDirectory '..')).Path
$sourceExtension = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot 'extensions/gemini-web-runner')).Path
$sourceManualPrewarmExtension = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot 'extensions/gemini-manual-prewarm')).Path
$localRoot = Join-Path $env:LOCALAPPDATA 'NovelWeb/GeminiRunner'
$stagedExtension = Join-Path $localRoot 'extension'
$stagedManualPrewarmExtension = Join-Path $localRoot 'manual-prewarm-extension'
$readingStyleRoot = Join-Path $env:LOCALAPPDATA 'NovelWeb/ReadingStyle'
$readingRelease = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'userstyles/ai-reading/stylus-release.json') | ConvertFrom-Json
$stagedReadingExtension = Join-Path $readingStyleRoot "stylus-v$($readingRelease.version)"
$chromeProfile = Join-Path $localRoot 'chrome-profile'
$runtimeRoot = Join-Path $localRoot 'runtime'
$logDirectory = Join-Path $localRoot 'logs'
$bootstrapPath = Join-Path $stagedExtension 'bootstrap.local.json'
$pairingMarkerPath = Join-Path $localRoot 'paired.json'
$endpointStatePath = Join-Path $localRoot 'endpoints.json'
$launcherLockPath = Join-Path $localRoot 'launcher.lock'
$expectedStorageDirectory = if ($env:NOVELWEB_AUTOMATION_DIR) {
  [IO.Path]::GetFullPath($env:NOVELWEB_AUTOMATION_DIR)
} else {
  [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'data/drafts/ai-runs'))
}
$serverUrlWasExplicit = $PSBoundParameters.ContainsKey('ServerUrl')
$uiUrlWasExplicit = $PSBoundParameters.ContainsKey('UiUrl')
$mayReselectEndpoints = -not ($serverUrlWasExplicit -or $uiUrlWasExplicit)

New-Item -ItemType Directory -Force -Path $localRoot, $chromeProfile | Out-Null
if ($mayReselectEndpoints) {
  if (-not (Test-NovelWebReady `
      -ServerUrl $ServerUrl `
      -ApplicationUrl $UiUrl `
      -ExpectedStorageDirectory $expectedStorageDirectory)) {
    $savedEndpoints = Get-SavedNovelWebEndpoints `
      -StatePath $endpointStatePath `
      -RepositoryRoot $repositoryRoot `
      -ExpectedStorageDirectory $expectedStorageDirectory
    if ($null -ne $savedEndpoints) {
      $ServerUrl = $savedEndpoints.ServerUrl
      $UiUrl = $savedEndpoints.UiUrl
    } else {
      $ports = Get-FreeNovelWebPortPair -RepositoryRoot $repositoryRoot
      $ServerUrl = "http://127.0.0.1:$($ports.ApiPort)"
      $UiUrl = "http://127.0.0.1:$($ports.WebPort)/automation"
    }
  }
}
$serverUri = Assert-LocalHttpUrl -Value $ServerUrl -Label 'ServerUrl' -RequiredPath '/'
$uiUri = Assert-LocalHttpUrl -Value $UiUrl -Label 'UiUrl' -RequiredPath '/automation'
$launcherLock = $null
$pairingToken = $null
try {
  try {
    $launcherLock = [IO.File]::Open($launcherLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw 'Another NovelWeb Gemini Runner launcher is already active.'
  }

  # Network provisioning runs before the server's startup timeout. Install local
  # fonts before Chrome starts so its renderer sees the new DirectWrite faces.
  $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
  $openBeforeSetup = @(Get-DedicatedRunnerProcesses -ProfilePath $chromeProfile).Count -gt 0
  if ($openBeforeSetup) {
    Write-Host 'Checking reading fonts and Stylus for the running browser...'
    & (Join-Path $scriptDirectory 'ensure-reading-fonts.ps1') -Check
    if ($LASTEXITCODE -ne 0) {
      throw 'Reading fonts need setup. Close all dedicated NovelWeb Runner windows, then run start.bat again.'
    }
    & $nodeCommand (Join-Path $scriptDirectory 'ensure-reading-style.mjs') --root $readingStyleRoot --check
    if ($LASTEXITCODE -ne 0) {
      throw 'Reading styles need setup. Close all dedicated NovelWeb Runner windows, then run start.bat again.'
    }
  } else {
    Write-Host 'Preparing reading fonts and Stylus (first launch needs internet)...'
    & (Join-Path $scriptDirectory 'ensure-reading-fonts.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Reading font setup failed; browser startup stopped.' }
    & $nodeCommand (Join-Path $scriptDirectory 'ensure-reading-style.mjs') --root $readingStyleRoot
    if ($LASTEXITCODE -ne 0) { throw 'Reading style setup failed; browser startup stopped.' }
  }
  & $nodeCommand (Join-Path $scriptDirectory 'ensure-fonts.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'NovelWeb font setup failed.' }
  $readingBuild = Get-Content -Raw -LiteralPath (Join-Path $stagedReadingExtension 'manager/build-info.json') | ConvertFrom-Json
  $readingSourceHash = [string]$readingBuild.sourceHash
  if ($readingSourceHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid reading style build fingerprint.' }

  $startupAttempt = 0
  while ($true) {
    $startupAttempt++
    $serverUri = Assert-LocalHttpUrl -Value $ServerUrl -Label 'ServerUrl' -RequiredPath '/'
    $uiUri = Assert-LocalHttpUrl -Value $UiUrl -Label 'UiUrl' -RequiredPath '/automation'
    $novelWebParameters = @{
      RepositoryRoot = $repositoryRoot
      ServerUrl = $serverUri.AbsoluteUri
      ApplicationUrl = $uiUri.AbsoluteUri
      ExpectedStorageDirectory = $expectedStorageDirectory
      WebPort = $uiUri.Port
      ApiPort = $serverUri.Port
      LogDirectory = $logDirectory
      TimeoutSeconds = $StartupTimeoutSeconds
    }
    try {
      Start-NovelWebIfNeeded @novelWebParameters
      break
    } catch {
      $portRace = $_.Exception.Message -match '(?i)(port\s+\d+\s+is already in use|EADDRINUSE)'
      if (-not $mayReselectEndpoints -or -not $portRace -or $startupAttempt -ge 3) { throw }
      Write-Warning 'A selected NovelWeb port was claimed during startup; selecting another free pair.'
      $ports = Get-FreeNovelWebPortPair -RepositoryRoot $repositoryRoot
      $ServerUrl = "http://127.0.0.1:$($ports.ApiPort)"
      $UiUrl = "http://127.0.0.1:$($ports.WebPort)/automation"
    }
  }

  $apiStatusUrl = "$($serverUri.GetLeftPart([UriPartial]::Authority))/api/automation/status"
  $serverBaseUrl = $serverUri.GetLeftPart([UriPartial]::Authority)
  $endpointState = [ordered]@{
    schemaVersion = 1
    repositoryRoot = $repositoryRoot
    serverUrl = $serverBaseUrl
    uiUrl = $uiUri.AbsoluteUri
    selectedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  Write-Utf8TextAtomic -Path $endpointStatePath -Content $endpointState
  Write-Host "NovelWeb UI: $($uiUri.AbsoluteUri)"
  Write-Host "NovelWeb API: $serverBaseUrl"

  $pairingTokenPath = if ($env:NOVELWEB_AUTOMATION_DIR) {
    Join-Path ([IO.Path]::GetFullPath($env:NOVELWEB_AUTOMATION_DIR)) 'worker-token'
  } else {
    Join-Path $repositoryRoot 'data/drafts/ai-runs/worker-token'
  }
  if (-not (Test-Path -LiteralPath $pairingTokenPath -PathType Leaf)) {
    throw 'NovelWeb worker token was not created.'
  }
  $pairingToken = (Get-Content -Raw -LiteralPath $pairingTokenPath).Trim()
  if ($pairingToken -notmatch '^[A-Za-z0-9_-]{32,}$') {
    throw 'NovelWeb worker token has an invalid format.'
  }
  $tokenHash = Get-TokenHash -Token $pairingToken
  $runnerExtensionHash = Get-DirectorySha256Hex -RootPath $sourceExtension -ExcludedNames @('bootstrap.local.json')
  $manualPrewarmExtensionHash = Get-DirectorySha256Hex -RootPath $sourceManualPrewarmExtension
  $extensionHash = Get-TokenHash -Token "runner:$runnerExtensionHash`nmanual-prewarm:$manualPrewarmExtensionHash`nreading:$readingSourceHash"
  if (Test-Path -LiteralPath (Join-Path $sourceExtension 'bootstrap.local.json')) {
    throw 'Refusing to stage a source extension that contains bootstrap.local.json.'
  }

  $marker = $null
  if (Test-Path -LiteralPath $pairingMarkerPath -PathType Leaf) {
    try { $marker = Get-Content -Raw -LiteralPath $pairingMarkerPath | ConvertFrom-Json } catch { $marker = $null }
  }
  $requiredMarkerFields = @('schemaVersion', 'serverUrl', 'tokenSha256', 'extensionSha256', 'bootstrapId', 'workerId')
  $markerHasFields = $null -ne $marker -and @($requiredMarkerFields | Where-Object { $null -eq $marker.PSObject.Properties[$_] }).Count -eq 0
  $alreadyPaired = $markerHasFields -and
    $marker.schemaVersion -eq 2 -and
    $marker.serverUrl -eq $serverBaseUrl -and
    $marker.tokenSha256 -eq $tokenHash -and
    $marker.extensionSha256 -eq $extensionHash -and
    $marker.bootstrapId -match '^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$' -and
    $marker.workerId -match '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' -and
    (Test-Path -LiteralPath (Join-Path $chromeProfile 'Local State') -PathType Leaf)

  $runnerProcesses = @(Get-DedicatedRunnerProcesses -ProfilePath $chromeProfile)
  if ($runnerProcesses.Count -gt 1) {
    throw 'More than one dedicated NovelWeb Runner browser owns the same profile.'
  }
  $runnerIsOpen = $runnerProcesses.Count -eq 1

  $verifiedBootstrapPath = Assert-PathWithin -BasePath $localRoot -CandidatePath $bootstrapPath
  if (Test-Path -LiteralPath $verifiedBootstrapPath -PathType Leaf) {
    Remove-Item -LiteralPath $verifiedBootstrapPath -Force
  }

  if ($runnerIsOpen) {
    $verificationStartedAt = [DateTime]::UtcNow.AddSeconds(-2)
    if (-not (Test-Path -LiteralPath (Join-Path $stagedExtension 'manifest.json') -PathType Leaf)) {
      throw 'The running Gemini Runner extension directory is missing. Close its browser window, then run this command again.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stagedManualPrewarmExtension 'manifest.json') -PathType Leaf)) {
      throw 'The running Gemini manual prewarm extension directory is missing. Close its browser window, then run this command again.'
    }
    $chromePath = Assert-PathWithin -BasePath $runtimeRoot -CandidatePath $runnerProcesses[0].ExecutablePath
    if ((Get-DirectorySha256Hex -RootPath $stagedExtension -ExcludedNames @('bootstrap.local.json')) -ne $runnerExtensionHash -or
        (Get-DirectorySha256Hex -RootPath $stagedManualPrewarmExtension) -ne $manualPrewarmExtensionHash) {
      throw 'The open Runner has an older extension installation. Close its dedicated windows before updating; current pages were preserved.'
    }
    # A previous launch may pair successfully and fail a later startup check.
    # Recover its authenticated live identity instead of replaying bootstrap or
    # requiring a restart solely because paired.json was not committed.
    $livePairingOutput = @(& $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'verify-runner-session.mjs') `
      $chromeProfile $sourceExtension $stagedExtension $sourceManualPrewarmExtension $stagedManualPrewarmExtension `
      $serverBaseUrl $tokenHash ([string]$StartupTimeoutSeconds))
    if ($LASTEXITCODE -ne 0) { throw 'The open Runner could not be verified; its pages and pairing were preserved.' }
    $livePairing = ($livePairingOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if ([string]$livePairing.workerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' -or
        [string]$livePairing.bootstrapId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$') {
      throw 'Runner verification did not return a valid paired identity.'
    }
    $markerNeedsRefresh = -not $alreadyPaired -or
      [string]$marker.workerId -ne [string]$livePairing.workerId -or
      [string]$marker.bootstrapId -ne [string]$livePairing.bootstrapId
    $marker = $livePairing
    & $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'verify-reading-style.mjs') --runtime $stagedReadingExtension --timeout $StartupTimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw 'Loaded reading styles failed verification; startup stopped.' }
  } else {
    Install-StagedExtension -SourcePath $sourceExtension -DestinationPath $stagedExtension -LocalRoot $localRoot
    Install-StagedExtension -SourcePath $sourceManualPrewarmExtension -DestinationPath $stagedManualPrewarmExtension -LocalRoot $localRoot
    $chromePath = Get-ChromeForTesting -RuntimeRoot $runtimeRoot
    # Each deliberate runner restart starts from an empty worker state.  A
    # canceled task from an older browser page must never seize the new runner.
    $bootstrapId = [Guid]::NewGuid().ToString('N')
    $bootstrap = [ordered]@{
      schemaVersion = 1
      bootstrapId = $bootstrapId
      serverUrl = $serverBaseUrl
      pairingToken = $pairingToken
    } | ConvertTo-Json -Compress
    $launchedProcess = $null
    $paired = $false
    $pairedWorkerId = ''
    try {
      [IO.File]::WriteAllText($verifiedBootstrapPath, $bootstrap, (New-Object Text.UTF8Encoding($false)))
      Set-PrivateFileAcl -Path $verifiedBootstrapPath
      if ($stagedExtension.Contains(',') -or $stagedManualPrewarmExtension.Contains(',') -or $stagedReadingExtension.Contains(',')) {
        throw 'The local extension staging path cannot contain a comma because Chrome separates unpacked extensions with commas.'
      }
      $loadedExtensions = "$stagedExtension,$stagedManualPrewarmExtension,$stagedReadingExtension"
      $launchArguments = @(
        (ConvertTo-ChromeArgument -Name '--user-data-dir' -Value $chromeProfile),
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9223',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-startup-window',
        (ConvertTo-ChromeArgument -Name '--load-extension' -Value $loadedExtensions)
      )
      # The runner is an unattended worker.  Keep its dedicated browser out of
      # the user's foreground; the extension opens and drives Gemini itself.
      $launchedProcess = Start-Process -FilePath $chromePath -ArgumentList $launchArguments -WindowStyle Hidden -PassThru

      # Chrome permits command-line extensions on the first load, but requires
      # developer mode to keep an unpacked extension enabled after a reload.
      & $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'ensure-runner-developer-mode.mjs') --endpoint 'http://127.0.0.1:9223' --timeout $StartupTimeoutSeconds
      if ($LASTEXITCODE -ne 0) { throw 'The dedicated Runner could not enable its unpacked extensions.' }

      $bootstrapMarker = "bootstrap:$bootstrapId"
      $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
      while ([DateTime]::UtcNow -lt $deadline) {
        try {
          $status = Invoke-RestMethod -Uri $apiStatusUrl -TimeoutSec 2
          if ($status.worker.currentModel -eq $bootstrapMarker -and
              [string]$status.worker.id -match '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$') {
            $paired = $true
            $pairedWorkerId = [string]$status.worker.id
            break
          }
        } catch {}
        Start-Sleep -Milliseconds 500
      }
      if (-not $paired) {
        $failedRunnerProcesses = @(Get-DedicatedRunnerProcesses -ProfilePath $chromeProfile)
        foreach ($process in $failedRunnerProcesses) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
        throw 'The local Gemini Runner extension did not confirm pairing in time.'
      }

      Assert-RunnerBackgroundLoaded -SourceExtension $sourceExtension -WorkerId $pairedWorkerId -BootstrapId $bootstrapId -TimeoutSeconds $StartupTimeoutSeconds -ColdStart

      & $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'verify-reading-style.mjs') --runtime $stagedReadingExtension --timeout $StartupTimeoutSeconds --cold-start
      if ($LASTEXITCODE -ne 0) { throw 'Loaded reading styles failed verification; startup stopped before opening Gemini.' }

      $markerJson = [ordered]@{
        schemaVersion = 2
        serverUrl = $serverBaseUrl
        tokenSha256 = $tokenHash
        extensionSha256 = $extensionHash
        bootstrapId = $bootstrapId
        workerId = $pairedWorkerId
        pairedAt = [DateTime]::UtcNow.ToString('o')
      } | ConvertTo-Json -Compress
      Write-Utf8TextAtomic -Path $pairingMarkerPath -Content $markerJson
      $marker = $markerJson | ConvertFrom-Json
      $alreadyPaired = $true
      $verificationStartedAt = [DateTime]::UtcNow.AddSeconds(-2)
    } finally {
      if (Test-Path -LiteralPath $verifiedBootstrapPath -PathType Leaf) {
        Remove-Item -LiteralPath $verifiedBootstrapPath -Force
      }
    }
  }

  if ($stagedExtension.Contains(',') -or $stagedManualPrewarmExtension.Contains(',') -or $stagedReadingExtension.Contains(',')) {
    throw 'The local extension staging path cannot contain a comma because Chrome separates unpacked extensions with commas.'
  }
  $loadedExtensions = "$stagedExtension,$stagedManualPrewarmExtension,$stagedReadingExtension"
  $runnerPages = @()
  try {
    # Windows PowerShell 5.1 treats an Invoke-RestMethod JSON array as one
    # pipeline object when the command is wrapped directly in @(...).
    $runnerPageResponse = Invoke-RestMethod -Uri 'http://127.0.0.1:9223/json/list' -TimeoutSec 2
    $runnerPages = @($runnerPageResponse)
  } catch {}
  $urlsToOpen = @()
  if (@($runnerPages | Where-Object { [string]$_.url -eq $uiUri.AbsoluteUri }).Count -eq 0) {
    $urlsToOpen += $uiUri.AbsoluteUri
  }
  if (@($runnerPages | Where-Object { [string]$_.url -match '^https://gemini\.google\.com/(?:app|gem)(?:[/#?]|$)' }).Count -eq 0) {
    $urlsToOpen += 'https://gemini.google.com/app'
  }
  $openArguments = @(
    (ConvertTo-ChromeArgument -Name '--user-data-dir' -Value $chromeProfile),
    '--no-first-run',
    '--no-default-browser-check',
    (ConvertTo-ChromeArgument -Name '--load-extension' -Value $loadedExtensions)
  )
  foreach ($url in $urlsToOpen) {
    $openArguments += ConvertTo-ChromeArgument -Name '' -Value $url
  }
  if ($urlsToOpen.Count -gt 0) {
    Start-Process -FilePath $chromePath -ArgumentList $openArguments -WindowStyle Normal | Out-Null
  }

  $ready = $false
  if (-not $ready) {
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        $status = Invoke-RestMethod -Uri $apiStatusUrl -TimeoutSec 2
        $lastSeenAt = [DateTime]::Parse([string]$status.worker.lastSeenAt).ToUniversalTime()
        if ([string]$status.worker.id -eq [string]$marker.workerId -and $lastSeenAt -ge $verificationStartedAt) {
          $ready = $true
          break
        }
      } catch {}
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    throw 'The installed Gemini Runner did not provide a fresh authenticated heartbeat. Close its dedicated browser window and run npm run gemini again.'
  }

  if ($runnerIsOpen -and $markerNeedsRefresh) {
    $markerJson = [ordered]@{
      schemaVersion = 2
      serverUrl = $serverBaseUrl
      tokenSha256 = $tokenHash
      extensionSha256 = $extensionHash
      bootstrapId = [string]$marker.bootstrapId
      workerId = [string]$marker.workerId
      pairedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress
    Write-Utf8TextAtomic -Path $pairingMarkerPath -Content $markerJson
    Write-Host 'Recovered the existing Runner pairing record after verifying its loaded code and fresh heartbeat.'
  }

  Write-Host 'NovelWeb Gemini Runner and manual prewarm extension are ready.'
  Write-Host 'Reading fonts, Stylus, and the site style manager are ready.'
  Write-Host "Automation: $($uiUri.AbsoluteUri)"
  Write-Host 'The runner is connected and ready to execute NovelWeb tasks.'
} finally {
  if ($launcherLock -and (Test-Path -LiteralPath $bootstrapPath -PathType Leaf)) {
    $safeBootstrapPath = Assert-PathWithin -BasePath $localRoot -CandidatePath $bootstrapPath
    Remove-Item -LiteralPath $safeBootstrapPath -Force
  }
  $pairingToken = $null
  if ($launcherLock) { $launcherLock.Dispose() }
}
