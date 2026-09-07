[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace NovelWeb {
  public static class NativeWindow {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    public static IntPtr[] FindChromeForTestingWindows(int trustedRootProcessId) {
      var matches = new List<IntPtr>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        if (processId != (uint)trustedRootProcessId) return true;

        var className = new StringBuilder(256);
        if (GetClassName(hWnd, className, className.Capacity) == 0 ||
            !String.Equals(className.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) {
          return true;
        }

        int titleLength = GetWindowTextLength(hWnd);
        if (titleLength < 1) return true;
        var title = new StringBuilder(titleLength + 1);
        GetWindowText(hWnd, title, title.Capacity);
        if (title.ToString().EndsWith(" - Google Chrome for Testing", StringComparison.Ordinal)) {
          matches.Add(hWnd);
        }
        return true;
      }, IntPtr.Zero);
      return matches.ToArray();
    }

  }
}
'@

function Stop-NativePaste {
  param([string]$Code)
  throw [InvalidOperationException]::new($Code)
}

function Get-CanonicalTarget {
  param([string]$Value)
  try { $uri = [Uri]$Value } catch { return $null }
  if (-not $uri.IsAbsoluteUri -or
      $uri.Scheme -ne 'https' -or
      $uri.Host -ne 'gemini.google.com' -or
      -not $uri.IsDefaultPort -or
      $uri.UserInfo -or
      $uri.Query -or
      $uri.Fragment -or
      ($uri.AbsolutePath -notmatch '^/app/[A-Za-z0-9_-]+$' -and
       $uri.AbsolutePath -notmatch '^/gem/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$')) {
    return $null
  }
  return "https://gemini.google.com$($uri.AbsolutePath)"
}

function Get-PatternValue {
  param(
    [Windows.Automation.AutomationElement]$Element,
    [Windows.Automation.AutomationPattern]$Pattern
  )
  $value = $null
  if (-not $Element.TryGetCurrentPattern($Pattern, [ref]$value)) { return $null }
  return $value
}

function Get-ComposerText {
  param([Windows.Automation.AutomationElement]$Element)
  # Quill exposes its placeholder (for example "Ask Gemini") through both
  # UIA text patterns. ql-blank is the authoritative empty-editor signal; do
  # not mistake the placeholder for unsent user text.
  if ($Element.Current.ClassName -match '(^|\s)ql-blank(\s|$)') { return '' }
  $textPattern = Get-PatternValue -Element $Element -Pattern ([Windows.Automation.TextPattern]::Pattern)
  if ($null -ne $textPattern) { return [string]$textPattern.DocumentRange.GetText(-1) }
  $valuePattern = Get-PatternValue -Element $Element -Pattern ([Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $valuePattern) { return [string]$valuePattern.Current.Value }
  Stop-NativePaste 'COMPOSER_READBACK_UNAVAILABLE'
}

function ConvertTo-BlankLineCanonical {
  param([string]$Value)
  $normalized = ConvertTo-NewlineNormalized -Value $Value
  $lines = $normalized.Split(@("`n"), [StringSplitOptions]::None)
  $output = New-Object Collections.Generic.List[string]
  $previousBlank = $false
  foreach ($line in $lines) {
    $blank = [string]::IsNullOrWhiteSpace($line)
    if ($blank) {
      if (-not $previousBlank) { $output.Add('') }
    } else {
      $output.Add($line)
    }
    $previousBlank = $blank
  }
  return [string]::Join("`n", $output)
}

function ConvertTo-NewlineNormalized {
  param([string]$Value)
  return $Value.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Get-TextSha256 {
  param([string]$Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) |
      ForEach-Object { $_.ToString('x2') })
  } finally {
    $algorithm.Dispose()
  }
}

function Get-SafeError {
  param([string]$Code)
  $messages = @{
    'INVALID_INPUT' = 'Native paste input was invalid; nothing was pasted.'
    'INVALID_TARGET' = 'The requested Gemini conversation URL was not an exact supported URL; nothing was pasted.'
    'INVALID_RUNNER_PATH' = 'The dedicated Gemini Runner path was invalid; nothing was pasted.'
    'RUNNER_PROCESS_NOT_UNIQUE' = 'Exactly one dedicated Chrome for Testing window is required; nothing was pasted.'
    'RUNNER_EXECUTABLE_UNTRUSTED' = 'The matching Chrome process was outside the dedicated runner runtime; nothing was pasted.'
    'RUNNER_WINDOW_MISSING' = 'The dedicated Chrome for Testing window was unavailable; nothing was pasted.'
    'RUNNER_WINDOW_NOT_UNIQUE' = 'Exactly one dedicated Chrome for Testing top-level window is required; nothing was pasted.'
    'ADDRESS_BAR_NOT_UNIQUE' = 'The dedicated browser address bar could not be identified safely; nothing was pasted.'
    'TARGET_URL_MISMATCH' = 'The dedicated browser was not on the exact queued Gemini conversation; nothing was pasted.'
    'COMPOSER_NOT_UNIQUE' = 'The Gemini composer could not be identified safely; nothing was pasted.'
    'COMPOSER_NOT_EMPTY' = 'The Gemini composer contains different unsent text; it was not overwritten and Enter was not pressed.'
    'WINDOW_FOCUS_FAILED' = 'The dedicated browser could not be focused safely; nothing was pasted.'
    'COMPOSER_FOCUS_FAILED' = 'The Gemini composer could not be focused safely; nothing was pasted.'
    'COMPOSER_NATIVE_INPUT_UNAVAILABLE' = 'The Gemini composer did not expose a safe native Windows text-input interface; nothing was submitted.'
    'CLIPBOARD_SNAPSHOT_FAILED' = 'The existing Windows clipboard could not be preserved; nothing was pasted.'
    'CLIPBOARD_FAILED' = 'The prompt could not be placed on the Windows clipboard; nothing was submitted.'
    'CLIPBOARD_CLEAR_FAILED' = 'Windows could not clear the private prompt from the clipboard; Enter was not pressed.'
    'CLIPBOARD_RESTORE_FAILED' = 'The previous Windows clipboard could not be restored; Enter was not pressed.'
    'PASTE_FAILED' = 'Windows could not paste into the Gemini composer; nothing was submitted.'
    'COMPOSER_READBACK_UNAVAILABLE' = 'The Gemini composer could not be read back; nothing was submitted.'
    'READBACK_MISMATCH' = 'The pasted Gemini composer text did not match the queued prompt; Enter was not pressed.'
  }
  if ($messages.ContainsKey($Code)) { return [string]$messages[$Code] }
  return 'Windows native paste failed safely; Enter was not pressed.'
}

$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$clipboardRestored = $true

try {
  $rawInput = [Console]::In.ReadToEnd()
  try { $request = $rawInput | ConvertFrom-Json } catch { Stop-NativePaste 'INVALID_INPUT' }
  $rawInput = $null
  if ($null -eq $request -or
      $request.schemaVersion -ne 1 -or
      $request.prompt -isnot [string] -or
      [string]::IsNullOrWhiteSpace([string]$request.prompt) -or
      $request.targetUrl -isnot [string] -or
      $request.profilePath -isnot [string] -or
      $request.runtimeRoot -isnot [string]) {
    Stop-NativePaste 'INVALID_INPUT'
  }

  $pasteMode = if ($request.PSObject.Properties.Name -contains 'pasteMode') {
    [string]$request.pasteMode
  } else { 'fill-empty' }
  if ($pasteMode -notin @('fill-empty', 'replace-open-edit')) { Stop-NativePaste 'INVALID_INPUT' }

  $prompt = [string]$request.prompt
  $targetUrl = Get-CanonicalTarget -Value ([string]$request.targetUrl)
  if ($null -eq $targetUrl -or $targetUrl -cne [string]$request.targetUrl) {
    Stop-NativePaste 'INVALID_TARGET'
  }
  try {
    $profilePath = [IO.Path]::GetFullPath([string]$request.profilePath).TrimEnd('\')
    $runtimeRoot = [IO.Path]::GetFullPath([string]$request.runtimeRoot).TrimEnd('\')
  } catch { Stop-NativePaste 'INVALID_RUNNER_PATH' }
  if (-not $profilePath -or -not $runtimeRoot) { Stop-NativePaste 'INVALID_RUNNER_PATH' }

  $findStarted = $stopwatch.Elapsed.TotalMilliseconds
  $escapedProfile = [Regex]::Escape($profilePath)
  $profilePattern = "--user-data-dir=(?:`"$escapedProfile`"|$escapedProfile)(?:\s|$)"
  $runnerProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match $profilePattern })
  if ($runnerProcesses.Count -ne 1) { Stop-NativePaste 'RUNNER_PROCESS_NOT_UNIQUE' }
  $runner = $runnerProcesses[0]
  $executable = [IO.Path]::GetFullPath([string]$runner.ExecutablePath)
  $runtimePrefix = $runtimeRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $executable.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-NativePaste 'RUNNER_EXECUTABLE_UNTRUSTED'
  }
  $chromeWindowHandles = @([NovelWeb.NativeWindow]::FindChromeForTestingWindows([int]$runner.ProcessId))
  if ($chromeWindowHandles.Count -eq 0) { Stop-NativePaste 'RUNNER_WINDOW_MISSING' }
  if ($chromeWindowHandles.Count -ne 1) { Stop-NativePaste 'RUNNER_WINDOW_NOT_UNIQUE' }
  $chromeWindowHandle = [IntPtr]$chromeWindowHandles[0]
  $window = [Windows.Automation.AutomationElement]::FromHandle($chromeWindowHandle)
  if ($null -eq $window) { Stop-NativePaste 'RUNNER_WINDOW_MISSING' }
  $findWindowMs = $stopwatch.Elapsed.TotalMilliseconds - $findStarted

  $editCondition = New-Object Windows.Automation.PropertyCondition(
    [Windows.Automation.AutomationElement]::ControlTypeProperty,
    [Windows.Automation.ControlType]::Edit
  )
  $edits = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $editCondition)
  $addressBars = New-Object Collections.Generic.List[Windows.Automation.AutomationElement]
  $composers = New-Object Collections.Generic.List[Windows.Automation.AutomationElement]
  # The current Gemini edit textarea exposes this exact English aria-label
  # even under the tested zh-CN Chrome UI. Keep this script ASCII-safe because
  # Windows PowerShell 5 reads BOM-less scripts using the legacy code page.
  $editComposerNames = @('Edit prompt')
  for ($i = 0; $i -lt $edits.Count; $i++) {
    $element = $edits.Item($i)
    if ($element.Current.ClassName -eq 'OmniboxViewViews') { $addressBars.Add($element) }
    $isMainComposer = $element.Current.ClassName -match '(^|\s)ql-editor(\s|$)'
    $isExactEditComposer = $editComposerNames -contains ([string]$element.Current.Name)
    $modeMatches = if ($pasteMode -eq 'replace-open-edit') {
      $isExactEditComposer
    } else {
      $isMainComposer
    }
    if ($modeMatches -and
        $element.Current.IsEnabled -and
        $element.Current.IsKeyboardFocusable -and
        -not $element.Current.IsOffscreen) {
      $composers.Add($element)
    }
  }
  if ($addressBars.Count -ne 1) { Stop-NativePaste 'ADDRESS_BAR_NOT_UNIQUE' }
  $addressValue = Get-PatternValue -Element $addressBars[0] -Pattern ([Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $addressValue) { Stop-NativePaste 'ADDRESS_BAR_NOT_UNIQUE' }
  $observedUrl = [string]$addressValue.Current.Value
  if ($observedUrl -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') { $observedUrl = "https://$observedUrl" }
  $observedCanonical = Get-CanonicalTarget -Value $observedUrl
  if ($null -eq $observedCanonical -or $observedCanonical -cne $targetUrl) {
    Stop-NativePaste 'TARGET_URL_MISMATCH'
  }
  $promptCanonical = ConvertTo-BlankLineCanonical -Value $prompt
  $promptCanonicalSha256 = Get-TextSha256 -Value $promptCanonical
  $eligibleComposers = New-Object Collections.Generic.List[Windows.Automation.AutomationElement]
  $eligibleReadbacks = New-Object Collections.Generic.List[string]
  for ($i = 0; $i -lt $composers.Count; $i++) {
    $candidateReadback = Get-ComposerText -Element $composers[$i]
    $candidateCanonical = ConvertTo-BlankLineCanonical -Value $candidateReadback
    $candidateSha256 = Get-TextSha256 -Value $candidateCanonical
    $eligible = if ($pasteMode -eq 'replace-open-edit') {
      # The content script has already bound this exact live Edit textarea to
      # the verified Gemini user turn. UIA cannot preserve Gemini's paragraph
      # representation, so it only requires one visible Edit prompt control.
      $true
    } else {
      [string]::IsNullOrEmpty($candidateCanonical) -or $candidateCanonical -ceq $promptCanonical
    }
    if ($eligible) {
      $eligibleComposers.Add($composers[$i])
      $eligibleReadbacks.Add($candidateReadback)
    }
  }
  if ($eligibleComposers.Count -ne 1) { Stop-NativePaste 'COMPOSER_NOT_UNIQUE' }
  $composer = $eligibleComposers[0]
  $readbackStarted = $stopwatch.Elapsed.TotalMilliseconds
  $readback = $eligibleReadbacks[0]
  $readbackCanonical = ConvertTo-BlankLineCanonical -Value $readback
  $composerEmpty = [string]::IsNullOrEmpty($readbackCanonical)
  $idempotent = -not $composerEmpty -and $readbackCanonical -ceq $promptCanonical
  $sourceCanonicalSha256 = $null
  $sourceVerified = $false
  if ($pasteMode -eq 'fill-empty' -and -not $composerEmpty -and -not $idempotent) {
    Stop-NativePaste 'COMPOSER_NOT_EMPTY'
  }

  $focusMs = 0
  $pasteMs = 0
  $transport = 'windows-native-uia-value'
  $clipboardTouched = $false
  if (-not $idempotent) {
    # Re-read immediately before the native write. If the user typed in the
    # small discovery-to-write window, do not overwrite their text.
    $focusedReadback = Get-ComposerText -Element $composer
    $focusedCanonical = ConvertTo-BlankLineCanonical -Value $focusedReadback
    if ($focusedCanonical -ceq $promptCanonical) {
      $idempotent = $true
      $readback = $focusedReadback
    } elseif ($pasteMode -eq 'replace-open-edit') {
      # Keep the OS-side fence narrow: the chosen element must still be the
      # one visible, enabled Edit prompt control on the exact Gemini URL.
      if (-not $composer.Current.IsEnabled -or
          $composer.Current.IsOffscreen -or
          $editComposerNames -notcontains ([string]$composer.Current.Name)) {
        Stop-NativePaste 'COMPOSER_NOT_UNIQUE'
      }
      $readback = $focusedReadback
    } elseif (-not [string]::IsNullOrEmpty($focusedCanonical)) {
      Stop-NativePaste 'COMPOSER_NOT_EMPTY'
    }

    if (-not $idempotent) {
      # Gemini's Quill composer and its edit textarea both expose a native
      # Windows UI Automation ValuePattern. Writing through that OS interface
      # is reliable for long, multi-paragraph Unicode text and does not depend
      # on a background process stealing global keyboard focus. The content
      # script still performs a second exact DOM readback before its dispatch
      # fence and click.
      $nativeValue = Get-PatternValue -Element $composer -Pattern ([Windows.Automation.ValuePattern]::Pattern)
      if ($null -eq $nativeValue -or $nativeValue.Current.IsReadOnly) {
        Stop-NativePaste 'COMPOSER_NATIVE_INPUT_UNAVAILABLE'
      }
      $nativeInputStarted = $stopwatch.Elapsed.TotalMilliseconds
      try {
        $nativeValue.SetValue($prompt)
      } catch {
        Stop-NativePaste 'PASTE_FAILED'
      }
      $readbackDeadline = [DateTime]::UtcNow.AddSeconds(3)
      do {
        $readback = Get-ComposerText -Element $composer
        $readbackCanonical = ConvertTo-BlankLineCanonical -Value $readback
        if ($readbackCanonical -ceq $promptCanonical) { break }
        Start-Sleep -Milliseconds 25
      } while ([DateTime]::UtcNow -lt $readbackDeadline)
      $pasteMs = $stopwatch.Elapsed.TotalMilliseconds - $nativeInputStarted
    }
  }
  $readbackCanonical = ConvertTo-BlankLineCanonical -Value $readback
  if ($readbackCanonical -cne $promptCanonical) { Stop-NativePaste 'READBACK_MISMATCH' }
  $readbackMs = $stopwatch.Elapsed.TotalMilliseconds - $readbackStarted

  $utf8Bytes = [Text.Encoding]::UTF8.GetByteCount($prompt)
  $result = [ordered]@{
    ok = $true
    telemetry = [ordered]@{
      schemaVersion = 1
      transport = $transport
      pasteMode = $pasteMode
      targetUrl = $targetUrl
      chromeProcessId = [int]$runner.ProcessId
      promptCharacters = $prompt.Length
      promptUtf8Bytes = $utf8Bytes
      findWindowMs = [Math]::Round($findWindowMs, 1)
      focusMs = [Math]::Round($focusMs, 1)
      pasteMs = [Math]::Round($pasteMs, 1)
      clipboardHeldMs = 0
      readbackMs = [Math]::Round($readbackMs, 1)
      totalMs = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
      idempotent = $idempotent
      clipboardTouched = $clipboardTouched
      clipboardRestored = $clipboardRestored
      blankLinesCollapsed = (
        (ConvertTo-NewlineNormalized -Value $prompt) -cne $promptCanonical -or
        (ConvertTo-NewlineNormalized -Value $readback) -cne $readbackCanonical
      )
      normalizationApplied = ($readback -cne $prompt)
      promptSha256 = Get-TextSha256 -Value $prompt
      promptCanonicalSha256 = Get-TextSha256 -Value $promptCanonical
      readbackSha256 = Get-TextSha256 -Value $readback
      readbackCanonicalSha256 = Get-TextSha256 -Value $readbackCanonical
      sourceVerified = $sourceVerified
      sourceCanonicalSha256 = $sourceCanonicalSha256
      verifiedAt = [DateTime]::UtcNow.ToString('o')
    }
  }
  $prompt = $null
  $request = $null
  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 5))
  exit 0
} catch {
  $code = if ($_.Exception.Message -match '^[A-Z0-9_]{3,80}$') { $_.Exception.Message } else { 'NATIVE_PASTE_FAILED' }
  $failure = [ordered]@{
    ok = $false
    code = $code
    error = Get-SafeError -Code $code
    diagnosticType = $_.Exception.GetType().FullName
    diagnosticLine = [int]$_.InvocationInfo.ScriptLineNumber
  }
  [Console]::Out.Write(($failure | ConvertTo-Json -Compress))
  exit 1
}
