[CmdletBinding()]
param(
  [ValidateSet('Status', 'Tabs', 'Open', 'Inspect', 'Click', 'Screenshot', 'Reload')]
  [string]$Action = 'Status',
  [string]$TargetUrl = '',
  [string]$Selector = 'button, [role="button"], [role="menu"], [role="menuitem"], textarea, input, [contenteditable="true"]',
  [string]$ExactName = '',
  [int]$MaxMatches = 40,
  [string]$OutputPath = '',
  [string]$CdpEndpoint = 'http://127.0.0.1:9223'
)

$ErrorActionPreference = 'Stop'

function Invoke-CdpCommand {
  param(
    [Parameter(Mandatory = $true)][string]$WebSocketUrl,
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Parameters = @{}
  )

  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $cancellation = [Threading.CancellationToken]::None
  $commandId = 1729
  $null = $socket.ConnectAsync([Uri]$WebSocketUrl, $cancellation).GetAwaiter().GetResult()

  try {
    $payload = @{
      id = $commandId
      method = $Method
      params = $Parameters
    } | ConvertTo-Json -Compress -Depth 30
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $null = $socket.SendAsync(
      [ArraySegment[byte]]::new($bytes),
      [Net.WebSockets.WebSocketMessageType]::Text,
      $true,
      $cancellation
    ).GetAwaiter().GetResult()

    while ($true) {
      $buffer = New-Object byte[] 131072
      $stream = [IO.MemoryStream]::new()
      do {
        $part = $socket.ReceiveAsync(
          [ArraySegment[byte]]::new($buffer),
          $cancellation
        ).GetAwaiter().GetResult()
        if ($part.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
          throw "CDP target closed before replying to $Method."
        }
        $stream.Write($buffer, 0, $part.Count)
      } while (-not $part.EndOfMessage)

      $message = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
      if ($message.id -ne $commandId) {
        continue
      }
      if ($message.error) {
        throw "CDP $Method failed: $($message.error.message)"
      }
      if ($message.result.exceptionDetails) {
        $detail = $message.result.exceptionDetails.exception.description
        if (-not $detail) { $detail = $message.result.exceptionDetails.text }
        throw "Page evaluation failed: $detail"
      }
      return $message.result
    }
  } finally {
    if ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
      $null = $socket.CloseAsync(
        [Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
        'done',
        $cancellation
      ).GetAwaiter().GetResult()
    }
    $socket.Dispose()
  }
}

function Get-CdpTargets {
  try {
    return @(Invoke-RestMethod "$($CdpEndpoint.TrimEnd('/'))/json/list")
  } catch {
    throw "Cannot reach the dedicated NovelWeb Runner browser at $CdpEndpoint. Start it with 'npm run gemini'. $($_.Exception.Message)"
  }
}

function Resolve-PageTarget {
  param([object[]]$Targets)

  $pages = @($Targets | Where-Object { $_.type -eq 'page' })
  if ($TargetUrl) {
    $pages = @($pages | Where-Object { $_.url -eq $TargetUrl })
    if ($pages.Count -ne 1) {
      throw "Expected exactly one page whose URL is '$TargetUrl'; found $($pages.Count). Run -Action Tabs first."
    }
    return $pages[0]
  }

  $geminiPages = @($pages | Where-Object { $_.url -match '^https://gemini\.google\.com/' })
  if ($geminiPages.Count -eq 1) {
    return $geminiPages[0]
  }
  if ($pages.Count -eq 1) {
    return $pages[0]
  }
  throw "Cannot choose one real browser page unambiguously. Found $($pages.Count) pages and $($geminiPages.Count) Gemini pages. Pass -TargetUrl after running -Action Tabs."
}

function Get-DirectoryFingerprint {
  param([string]$RootPath)

  if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
    return $null
  }
  $rows = @(Get-ChildItem -LiteralPath $RootPath -File -Recurse |
    Where-Object {
      $_.Name -ne 'bootstrap.local.json' -and
      $_.Extension -ne '.md' -and
      $_.FullName.Substring($RootPath.Length).TrimStart('\', '/') -notmatch '^tests[\\/]'
    } |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($RootPath.Length).TrimStart('\', '/')
      $fileStream = [IO.File]::OpenRead($_.FullName)
      $fileSha = [Security.Cryptography.SHA256]::Create()
      try {
        $hash = ([BitConverter]::ToString($fileSha.ComputeHash($fileStream))).Replace('-', '')
      } finally {
        $fileSha.Dispose()
        $fileStream.Dispose()
      }
      "$relative`t$hash"
    })
  $joined = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($joined))).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
}

function Invoke-PageEvaluation {
  param(
    [Parameter(Mandatory = $true)][object]$Page,
    [Parameter(Mandatory = $true)][string]$Expression
  )

  $reply = Invoke-CdpCommand -WebSocketUrl $Page.webSocketDebuggerUrl -Method 'Runtime.evaluate' -Parameters @{
    expression = $Expression
    returnByValue = $true
    awaitPromise = $true
  }
  return $reply.result.value
}

function New-ElementExpression {
  param([switch]$Click)

  $selectorJson = $Selector | ConvertTo-Json -Compress
  $nameJson = if ($ExactName) { $ExactName | ConvertTo-Json -Compress } else { 'null' }
  $limit = [Math]::Max(1, [Math]::Min($MaxMatches, 200))
  $clickJson = if ($Click) { 'true' } else { 'false' }

  return @"
JSON.stringify((() => {
  const selector = $selectorJson;
  const exactName = $nameJson;
  const shouldClick = $clickJson;
  const limit = $limit;
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (element) => {
    const aria = (element.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const labelledBy = (element.getAttribute('aria-labelledby') || '').trim();
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (label) return label;
    }
    return (element.innerText || element.textContent || element.getAttribute('title') || '').trim();
  };
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const ancestors = [];
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
      ancestors.push({
        tag: parent.tagName.toLowerCase(),
        id: parent.id || null,
        role: parent.getAttribute('role'),
        testId: parent.getAttribute('data-test-id'),
        className: typeof parent.className === 'string' ? parent.className.slice(0, 240) : null
      });
    }
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      role: element.getAttribute('role'),
      type: element.getAttribute('type'),
      testId: element.getAttribute('data-test-id'),
      ariaLabel: element.getAttribute('aria-label'),
      accessibleName: accessibleName(element).slice(0, 500),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      ancestors,
      outerHTML: element.outerHTML.slice(0, 4000)
    };
  };
  let matches = [...document.querySelectorAll(selector)].filter(visible);
  if (exactName !== null) matches = matches.filter(element => accessibleName(element) === exactName);
  const total = matches.length;
  if (shouldClick) {
    if (total !== 1) throw new Error('Refusing to click: expected one visible exact DOM match, found ' + total + '.');
    const clicked = describe(matches[0]);
    matches[0].scrollIntoView({ block: 'center', inline: 'center' });
    matches[0].click();
    return { url: location.href, title: document.title, clicked: true, element: clicked };
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    selector,
    exactName,
    total,
    truncated: total > limit,
    elements: matches.slice(0, limit).map(describe)
  };
})())
"@
}

$targets = Get-CdpTargets

if ($Action -eq 'Open') {
  $targetUri = $null
  $validTargetUri = [Uri]::TryCreate($TargetUrl, [UriKind]::Absolute, [ref]$targetUri)
  if (-not $validTargetUri -or @('http', 'https') -notcontains $targetUri.Scheme) {
    throw 'Open requires an absolute http(s) -TargetUrl.'
  }
  $encodedUrl = [Uri]::EscapeDataString($targetUri.AbsoluteUri)
  $opened = Invoke-RestMethod -Method Put "$($CdpEndpoint.TrimEnd('/'))/json/new?$encodedUrl"
  [ordered]@{ opened = $true; id = $opened.id; url = $opened.url; title = $opened.title } |
    ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'Tabs') {
  @($targets | Where-Object { $_.type -eq 'page' } | Select-Object id, title, url, webSocketDebuggerUrl) |
    ConvertTo-Json -Depth 5
  exit 0
}

if ($Action -eq 'Status') {
  $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  $sourceExtension = Join-Path $repositoryRoot 'extensions\gemini-web-runner'
  $runtimeExtension = Join-Path $env:LOCALAPPDATA 'NovelWeb\GeminiRunner\extension'
  $sourceHash = Get-DirectoryFingerprint -RootPath $sourceExtension
  $runtimeHash = Get-DirectoryFingerprint -RootPath $runtimeExtension
  $version = Invoke-RestMethod "$($CdpEndpoint.TrimEnd('/'))/json/version"
  [ordered]@{
    endpoint = $CdpEndpoint
    browser = $version.Browser
    pageCount = @($targets | Where-Object { $_.type -eq 'page' }).Count
    pages = @($targets | Where-Object { $_.type -eq 'page' } | Select-Object id, title, url)
    sourceExtension = $sourceExtension
    runtimeExtension = $runtimeExtension
    sourceExtensionSha256 = $sourceHash
    runtimeExtensionSha256 = $runtimeHash
    runtimeMatchesSource = ($null -ne $sourceHash -and $sourceHash -eq $runtimeHash)
  } | ConvertTo-Json -Depth 8
  exit 0
}

$page = Resolve-PageTarget -Targets $targets

if ($Action -eq 'Inspect') {
  $expression = New-ElementExpression
  Invoke-PageEvaluation -Page $page -Expression $expression
  exit 0
}

if ($Action -eq 'Click') {
  if (-not $PSBoundParameters.ContainsKey('Selector')) {
    throw 'Click requires an explicit -Selector. Broad default selectors are inspection-only.'
  }
  $expression = New-ElementExpression -Click
  Invoke-PageEvaluation -Page $page -Expression $expression
  exit 0
}

if ($Action -eq 'Reload') {
  $null = Invoke-CdpCommand -WebSocketUrl $page.webSocketDebuggerUrl -Method 'Page.reload' -Parameters @{ ignoreCache = $true }
  [ordered]@{ reloaded = $true; id = $page.id; url = $page.url } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'Screenshot') {
  if (-not $OutputPath) {
    $directory = Join-Path ([IO.Path]::GetTempPath()) 'NovelWeb-Codex'
    $null = New-Item -ItemType Directory -Path $directory -Force
    $OutputPath = Join-Path $directory ("runner-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  } else {
    $OutputPath = [IO.Path]::GetFullPath($OutputPath)
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { $null = New-Item -ItemType Directory -Path $parent -Force }
  }
  $capture = Invoke-CdpCommand -WebSocketUrl $page.webSocketDebuggerUrl -Method 'Page.captureScreenshot' -Parameters @{
    format = 'png'
    fromSurface = $true
    captureBeyondViewport = $false
  }
  [IO.File]::WriteAllBytes($OutputPath, [Convert]::FromBase64String($capture.data))
  [ordered]@{ saved = $true; path = $OutputPath; url = $page.url } | ConvertTo-Json -Compress
}
