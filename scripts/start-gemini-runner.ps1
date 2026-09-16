[CmdletBinding()]
param(
  [string]$ServerUrl = 'http://127.0.0.1:3001',
  [string]$UiUrl = 'http://127.0.0.1:5173/automation',
  [ValidateRange(10, 180)]
  [int]$StartupTimeoutSeconds = 45,
  [ValidateRange(15, 600)]
  [int]$ServiceStartupTimeoutSeconds = 180
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
  # Running an installed browser does not require a byte-for-byte copy of a
  # downloaded archive. Chrome legitimately adds data such as dictionaries.
  $installedVersions = @(Get-ChildItem -LiteralPath $RuntimeRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
  foreach ($installedVersion in $installedVersions) {
    $installedChrome = Assert-PathWithin -BasePath $RuntimeRoot -CandidatePath (Join-Path $installedVersion.FullName 'chrome-win64/chrome.exe')
    if (Test-Path -LiteralPath $installedChrome -PathType Leaf) {
      Write-Host "Using installed Chrome $($installedVersion.Name)."
      return $installedChrome
    }
  }
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

function Test-ManagedNovelWebProcess {
  param([object]$Record, [string]$LogDirectory)
  try {
    $configPath = Assert-PathWithin -BasePath $LogDirectory -CandidatePath ([string]$Record.configPath)
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Record.pid)" -ErrorAction Stop
    return $null -ne $owner -and $owner.Name -eq 'node.exe' -and
      ([string]$owner.CommandLine).IndexOf($configPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch { return $false }
}

function Get-ManagedNovelWebService {
  param([string]$LogDirectory, [string]$RepositoryRoot, [string]$ExpectedStorageDirectory)
  $pointerPath = Join-Path $LogDirectory 'services-current.json'
  if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
  try {
    $record = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
    if ($record.repositoryRoot -ne $RepositoryRoot -or $record.storageDir -ne $ExpectedStorageDirectory) { return $null }
    if (-not (Test-ManagedNovelWebProcess -Record $record -LogDirectory $LogDirectory)) { return $null }
    return $record
  } catch { return $null }
}

function Get-ManagedServiceFailure {
  param([object]$Record, [string]$Reason)
  $details = @($Reason, "Service state: $($Record.statePath)")
  try {
    $state = Get-Content -LiteralPath $Record.statePath -Raw | ConvertFrom-Json
    $details += "Phase: $($state.phase); reason: $($state.reason)"
    foreach ($name in @('api', 'frontend')) {
      $service = $state.services.$name
      $details += "--- $name stdout ---", (Get-LogTail -Path $service.stdoutPath), "--- $name stderr ---", (Get-LogTail -Path $service.stderrPath)
    }
  } catch {}
  $details += '--- supervisor stderr ---', (Get-LogTail -Path $Record.stderrPath)
  return $details -join [Environment]::NewLine
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
  $record = Get-ManagedNovelWebService -LogDirectory $LogDirectory -RepositoryRoot $RepositoryRoot -ExpectedStorageDirectory $ExpectedStorageDirectory
  if ($record) {
    if ($record.serverUrl -ne $ServerUrl.TrimEnd('/') -or $record.uiUrl -ne $ApplicationUrl) {
      throw "A managed NovelWeb service is already running at $($record.uiUrl). Its endpoints were preserved."
    }
    Write-Host "Waiting for the existing local services (PID $($record.pid))..."
  } else {
    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $output = @(& $nodeCommand (Join-Path $RepositoryRoot 'scripts/start-local-services.mjs') `
      --web-port $WebPort --api-port $ApiPort --storage-dir $ExpectedStorageDirectory --log-dir $LogDirectory 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Local service supervisor could not start: $($output -join ' ')" }
    $record = ($output -join "`n") | ConvertFrom-Json
    $record | Add-Member -NotePropertyName repositoryRoot -NotePropertyValue $RepositoryRoot
    $record | Add-Member -NotePropertyName storageDir -NotePropertyValue $ExpectedStorageDirectory
    $record | Add-Member -NotePropertyName serverUrl -NotePropertyValue $ServerUrl.TrimEnd('/')
    $record | Add-Member -NotePropertyName uiUrl -NotePropertyValue $ApplicationUrl
    try { Write-Utf8TextAtomic -Path (Join-Path $LogDirectory 'services-current.json') -Content ($record | ConvertTo-Json -Compress) }
    catch { Write-Warning "Services started, but their pointer could not be saved: $($_.Exception.Message)" }
    Write-Host "Started local service supervisor (PID $($record.pid)). Logs: $($record.statePath)"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-NovelWebReady `
        -ServerUrl $ServerUrl `
        -ApplicationUrl $ApplicationUrl `
        -ExpectedStorageDirectory $ExpectedStorageDirectory) {
      return
    }
    $state = $null
    try { $state = Get-Content -LiteralPath $record.statePath -Raw | ConvertFrom-Json } catch {}
    if (($state -and $state.phase -in @('failed', 'stopped')) -or
        -not (Test-ManagedNovelWebProcess -Record $record -LogDirectory $LogDirectory)) {
      throw (Get-ManagedServiceFailure -Record $record -Reason 'The local service supervisor stopped before both endpoints became ready.')
    }
    Start-Sleep -Milliseconds 500
  }
  # A slow cold start is not proof of a crashed process. Leave the owned
  # supervisor running; a subsequent click reuses it and its diagnostic logs.
  if (Test-NovelWebReady -ServerUrl $ServerUrl -ApplicationUrl $ApplicationUrl -ExpectedStorageDirectory $ExpectedStorageDirectory) { return }
  $reason = "Local services are still starting after $TimeoutSeconds seconds at $ApplicationUrl and $ServerUrl. They were not killed; retrying reuses this instance."
  throw (Get-ManagedServiceFailure -Record $record -Reason $reason)
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
          // Chrome may restore user pages during a cold launch. Correct code
          // can be verified in place; only an actual reload needs this guard.
          const reloadTargets = await (await fetch('http://127.0.0.1:9223/json/list', { signal: AbortSignal.timeout(3000) })).json();
          if (reloadTargets.some(target => target.type === 'page' && /^https:\/\/gemini\.google\.com\//.test(target.url))) {
            throw new Error('Gemini pages opened before background verification; no extension reload was attempted. Close the dedicated Runner and retry.');
          }
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
$sourceExtension = Join-Path $repositoryRoot 'extensions/gemini-web-runner'
$sourceManualPrewarmExtension = Join-Path $repositoryRoot 'extensions/gemini-manual-prewarm'
$localRoot = Join-Path $env:LOCALAPPDATA 'NovelWeb/GeminiRunner'
$stagedExtension = Join-Path $localRoot 'extension'
$stagedManualPrewarmExtension = Join-Path $localRoot 'manual-prewarm-extension'
$readingStyleRoot = Join-Path $env:LOCALAPPDATA 'NovelWeb/ReadingStyle'
$chromeProfile = Join-Path $localRoot 'chrome-profile'
$runtimeRoot = Join-Path $localRoot 'runtime'
$logDirectory = Join-Path $localRoot 'logs'
$bootstrapPath = Join-Path $stagedExtension 'bootstrap.local.json'
$pairingMarkerPath = Join-Path $localRoot 'paired.json'
$endpointStatePath = Join-Path $localRoot 'endpoints.json'
$launcherLockPath = Join-Path $localRoot 'launcher.lock'
$expectedStorageDirectory = if ($env:NOVELWEB_AUTOMATION_DIR) {
  [IO.Path]::GetFullPath($env:NOVELWEB_AUTOMATION_DIR)
} else { [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'data/drafts/ai-runs')) }
$mayReselectEndpoints = -not ($PSBoundParameters.ContainsKey('ServerUrl') -or $PSBoundParameters.ContainsKey('UiUrl'))
$launcherLock = $null
$applicationReady = $false
$transcriptStarted = $false
$pairingToken = $null
$exitStatus = 0
try {
  New-Item -ItemType Directory -Force -Path $localRoot, $chromeProfile, $logDirectory | Out-Null
  $transcriptPath = Join-Path $logDirectory ('launcher-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '-' + $PID + '.log')
  try { Start-Transcript -LiteralPath $transcriptPath | Out-Null; $transcriptStarted = $true } catch { Write-Warning "Could not start transcript: $($_.Exception.Message)" }
  Write-Host "Launcher log: $transcriptPath"
  try { $launcherLock = [IO.File]::Open($launcherLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { throw 'Another NovelWeb launcher is already starting the application. Its services were left running.' }
  $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source

  # Reuse an owned supervisor while either child is starting or recovering.
  $managedService = Get-ManagedNovelWebService -LogDirectory $logDirectory -RepositoryRoot $repositoryRoot -ExpectedStorageDirectory $expectedStorageDirectory
  if ($mayReselectEndpoints -and $managedService) {
    $ServerUrl = $managedService.serverUrl
    $UiUrl = $managedService.uiUrl
  } elseif ($mayReselectEndpoints -and -not (Test-NovelWebReady -ServerUrl $ServerUrl -ApplicationUrl $UiUrl -ExpectedStorageDirectory $expectedStorageDirectory)) {
    $savedEndpoints = Get-SavedNovelWebEndpoints -StatePath $endpointStatePath -RepositoryRoot $repositoryRoot -ExpectedStorageDirectory $expectedStorageDirectory
    if ($savedEndpoints) { $ServerUrl = $savedEndpoints.ServerUrl; $UiUrl = $savedEndpoints.UiUrl }
    else {
      $ports = Get-FreeNovelWebPortPair -RepositoryRoot $repositoryRoot
      $ServerUrl = "http://127.0.0.1:$($ports.ApiPort)"
      $UiUrl = "http://127.0.0.1:$($ports.WebPort)/automation"
    }
  }
  $serverUri = Assert-LocalHttpUrl -Value $ServerUrl -Label 'ServerUrl' -RequiredPath '/'
  $uiUri = Assert-LocalHttpUrl -Value $UiUrl -Label 'UiUrl' -RequiredPath '/automation'
  $serverBaseUrl = $serverUri.GetLeftPart([UriPartial]::Authority)
  $novelWebParameters = @{
    RepositoryRoot = $repositoryRoot; ServerUrl = $serverUri.AbsoluteUri; ApplicationUrl = $uiUri.AbsoluteUri
    ExpectedStorageDirectory = $expectedStorageDirectory; WebPort = $uiUri.Port; ApiPort = $serverUri.Port
    LogDirectory = $logDirectory; TimeoutSeconds = $ServiceStartupTimeoutSeconds
  }
  Write-Host 'Starting the local workbench...'
  Start-NovelWebIfNeeded @novelWebParameters
  $applicationReady = $true
  Write-Host "NovelWeb UI: $($uiUri.AbsoluteUri)"
  Write-Host "NovelWeb API: $serverBaseUrl"
  $endpointState = [ordered]@{schemaVersion = 1; repositoryRoot = $repositoryRoot; serverUrl = $serverBaseUrl; uiUrl = $uiUri.AbsoluteUri; selectedAt = [DateTime]::UtcNow.ToString('o')}
  try { Write-Utf8TextAtomic -Path $endpointStatePath -Content ($endpointState | ConvertTo-Json -Compress) }
  catch { Write-Warning "Endpoint record could not be saved: $($_.Exception.Message)" }

  # Optional installation differences are diagnostic data, never startup gates.
  $diagnosticPath = Join-Path $logDirectory ('installation-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '.json')
  try {
    $diagnosticArguments = @((ConvertTo-ChromeArgument -Name '' -Value (Join-Path $scriptDirectory 'diagnose-installation.mjs')), '--log', (ConvertTo-ChromeArgument -Name '' -Value $diagnosticPath))
    Start-Process -FilePath $nodeCommand -ArgumentList $diagnosticArguments -WorkingDirectory $repositoryRoot -WindowStyle Hidden | Out-Null
    Write-Host "Optional installation checks run in the background: $diagnosticPath"
  } catch { Write-Warning "Optional diagnostics could not start: $($_.Exception.Message)" }

  $runnerProcesses = @(Get-DedicatedRunnerProcesses -ProfilePath $chromeProfile)
  $runnerIsOpen = $runnerProcesses.Count -gt 0
  $chromePath = if ($runnerIsOpen) { [string]$runnerProcesses[0].ExecutablePath } else { Get-ChromeForTesting -RuntimeRoot $runtimeRoot }
  if (-not $runnerIsOpen) {
    # Stage current code only while Chrome is closed. Existing sessions are
    # never reloaded merely because their files differ from the workspace.
    Install-StagedExtension -SourcePath $sourceExtension -DestinationPath $stagedExtension -LocalRoot $localRoot
    try { Install-StagedExtension -SourcePath $sourceManualPrewarmExtension -DestinationPath $stagedManualPrewarmExtension -LocalRoot $localRoot }
    catch { Write-Warning "Manual prewarm is unavailable: $($_.Exception.Message)" }
  }
  $extensionPaths = @($stagedExtension)
  if (Test-Path -LiteralPath (Join-Path $stagedManualPrewarmExtension 'manifest.json') -PathType Leaf) { $extensionPaths += $stagedManualPrewarmExtension }
  # A usable installed Stylus may have another version or user modifications.
  $installedStyles = @(Get-ChildItem -LiteralPath $readingStyleRoot -Directory -Filter 'stylus-v*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  foreach ($style in $installedStyles) {
    if (Test-Path -LiteralPath (Join-Path $style.FullName 'manifest.json') -PathType Leaf) { $extensionPaths += $style.FullName; break }
  }
  if ($extensionPaths | Where-Object { $_.Contains(',') }) { throw 'An extension installation path contains a comma and cannot be passed to Chrome.' }
  $loadedExtensions = $extensionPaths -join ','
  if (-not $runnerIsOpen) {
    $launchArguments = @(
      (ConvertTo-ChromeArgument -Name '--user-data-dir' -Value $chromeProfile), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
      '--no-first-run', '--no-default-browser-check', '--no-startup-window', (ConvertTo-ChromeArgument -Name '--load-extension' -Value $loadedExtensions)
    )
    Start-Process -FilePath $chromePath -ArgumentList $launchArguments -WindowStyle Hidden | Out-Null
    & $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'ensure-runner-developer-mode.mjs') --endpoint 'http://127.0.0.1:9223' --timeout $StartupTimeoutSeconds
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Developer-mode setup reported a problem; checking the actual extension connection next.' }
  }
  $runnerPages = @()
  try { $pageResponse = Invoke-RestMethod -Uri 'http://127.0.0.1:9223/json/list' -TimeoutSec 3; $runnerPages = @($pageResponse) } catch {}
  $urlsToOpen = @()
  if (@($runnerPages | Where-Object { [string]$_.url -eq $uiUri.AbsoluteUri }).Count -eq 0) { $urlsToOpen += $uiUri.AbsoluteUri }
  if (@($runnerPages | Where-Object { [string]$_.url -match '^https://gemini\.google\.com/(?:app|gem)(?:[/#?]|$)' }).Count -eq 0) { $urlsToOpen += 'https://gemini.google.com/app' }
  if ($urlsToOpen.Count) {
    $openArguments = @((ConvertTo-ChromeArgument -Name '--user-data-dir' -Value $chromeProfile), '--no-first-run', '--no-default-browser-check', (ConvertTo-ChromeArgument -Name '--load-extension' -Value $loadedExtensions))
    foreach ($url in $urlsToOpen) { $openArguments += ConvertTo-ChromeArgument -Name '' -Value $url }
    Start-Process -FilePath $chromePath -ArgumentList $openArguments -WindowStyle Normal | Out-Null
  }
  # Repeated launches must also show an existing, possibly minimized window.
  try {
    $windowResult = @(& $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'show-runner-workbench.mjs') $uiUri.AbsoluteUri 2>&1)
    if ($LASTEXITCODE -ne 0) { Write-Warning "Workbench window could not be shown: $($windowResult -join ' ')" }
  } catch { Write-Warning "Workbench window could not be shown: $($_.Exception.Message)" }
  $pairingTokenPath = Join-Path $expectedStorageDirectory 'worker-token'
  $connectionResult = @(& $nodeCommand --experimental-websocket (Join-Path $scriptDirectory 'check-runner-connection.mjs') `
    --profile $chromeProfile --runtime $stagedExtension --server-url $serverBaseUrl --token-file $pairingTokenPath --timeout $StartupTimeoutSeconds 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "The workbench is running, but the Runner connection needs attention: $($connectionResult -join ' ')" }
  $connection = ($connectionResult -join "`n") | ConvertFrom-Json
  Write-Host "Runner connection ready: authenticated API bridge and $($connection.responsiveTabs) responsive Gemini tab(s)."
  foreach ($warning in @($connection.warnings)) { Write-Warning $warning }
  Write-Host "NovelWeb is ready: $($uiUri.AbsoluteUri)"
} catch {
  if ($applicationReady) {
    Write-Warning "NovelWeb remains available at $UiUrl. Browser issue recorded: $($_.Exception.Message)"
    try { Start-Process -FilePath $UiUrl -WindowStyle Normal | Out-Null } catch {}
    # Optional browser setup does not turn a usable writing app into a failure.
  } else {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    $exitStatus = 1
  }
} finally {
  $pairingToken = $null
  if ($launcherLock) { $launcherLock.Dispose() }
  if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
}
exit $exitStatus
