import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export class NativeGeminiPasteError extends Error {
  constructor(code, message, { status = 409, details } = {}) {
    super(message);
    this.name = 'NativeGeminiPasteError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    if (details !== undefined) this.details = details;
  }
}

export function canonicalNativeGeminiTarget(value) {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'gemini.google.com'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || !(
        /^\/app\/[A-Za-z0-9_-]+$/.test(url.pathname)
        || /^\/gem\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
      )
    ) return null;
    return `https://gemini.google.com${url.pathname}`;
  } catch {
    return null;
  }
}

export function canonicalizeNativePasteText(value) {
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = !line.trim();
    if (!blank) output.push(line);
    else if (!previousBlank) output.push('');
    previousBlank = blank;
  }
  return output.join('\n');
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function defaultPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) return 'powershell.exe';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function defaultRunnerPaths() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new NativeGeminiPasteError(
      'NATIVE_PASTE_ENV_MISSING',
      'Windows LOCALAPPDATA is unavailable; native paste was not attempted.',
      { status: 503 },
    );
  }
  const runnerRoot = path.resolve(localAppData, 'NovelWeb', 'GeminiRunner');
  return {
    profilePath: path.join(runnerRoot, 'chrome-profile'),
    runtimeRoot: path.join(runnerRoot, 'runtime'),
  };
}

function sanitizedHelperError(parsed, exitCode) {
  const code = typeof parsed?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(parsed.code)
    ? parsed.code
    : 'NATIVE_PASTE_FAILED';
  const knownMessages = {
    INVALID_INPUT: 'Windows native paste helper rejected its private stdin payload.',
    INVALID_TARGET: 'Windows native paste helper rejected the Gemini conversation URL.',
    INVALID_RUNNER_PATH: 'The dedicated Gemini Runner path is invalid.',
    RUNNER_PROCESS_NOT_UNIQUE: 'Exactly one dedicated Chrome for Testing window is required.',
    RUNNER_EXECUTABLE_UNTRUSTED: 'The matching Chrome process is outside the dedicated runner runtime.',
    RUNNER_WINDOW_MISSING: 'The dedicated Chrome for Testing window is unavailable.',
    ADDRESS_BAR_NOT_UNIQUE: 'The dedicated browser address bar could not be identified safely.',
    TARGET_URL_MISMATCH: 'The dedicated browser is not on the exact queued Gemini conversation.',
    COMPOSER_NOT_UNIQUE: 'The Gemini composer could not be identified safely.',
    COMPOSER_NOT_EMPTY: 'The Gemini composer contains different unsent text; it was not overwritten.',
    WINDOW_FOCUS_FAILED: 'The dedicated browser could not be focused safely.',
    COMPOSER_FOCUS_FAILED: 'The Gemini composer could not be focused safely.',
    CLIPBOARD_SNAPSHOT_FAILED: 'The existing Windows clipboard could not be preserved; nothing was pasted.',
    CLIPBOARD_FAILED: 'The prompt could not be placed on the Windows clipboard.',
    CLIPBOARD_CLEAR_FAILED: 'Windows could not clear the private prompt from the clipboard; Enter was not pressed.',
    CLIPBOARD_RESTORE_FAILED: 'The previous Windows clipboard could not be restored; Enter was not pressed.',
    PASTE_FAILED: 'Windows could not paste into the Gemini composer.',
    COMPOSER_READBACK_UNAVAILABLE: 'The Gemini composer could not be read back.',
    READBACK_MISMATCH: 'The pasted Gemini composer text did not match the queued prompt; Enter was not pressed.',
  };
  const diagnosticType = typeof parsed?.diagnosticType === 'string'
      && /^System\.[A-Za-z0-9_.+]{1,160}$/.test(parsed.diagnosticType)
    ? parsed.diagnosticType
    : null;
  const diagnosticLine = Number.isInteger(parsed?.diagnosticLine)
      && parsed.diagnosticLine > 0
      && parsed.diagnosticLine < 10_000
    ? parsed.diagnosticLine
    : null;
  const diagnosticSuffix = diagnosticType && diagnosticLine
    ? ` (${diagnosticType} at helper line ${diagnosticLine})`
    : '';
  const message = knownMessages[code]
    || `Windows native paste helper stopped safely with exit code ${exitCode ?? 'unknown'}; Enter was not pressed.${diagnosticSuffix}`;
  return new NativeGeminiPasteError(code, message, {
    details: diagnosticSuffix ? { diagnosticType, diagnosticLine } : undefined,
  });
}

function validateResult(result, expectedUrl, prompt, pasteMode) {
  if (!result || result.ok !== true || !result.telemetry || typeof result.telemetry !== 'object') {
    throw new NativeGeminiPasteError('NATIVE_PASTE_BAD_RESULT', 'Windows native paste helper returned an invalid result.');
  }
  const value = result.telemetry;
  const hash = name => typeof value[name] === 'string' && /^[a-f0-9]{64}$/.test(value[name])
    ? value[name]
    : null;
  const numeric = name => {
    const candidate = Number(value[name]);
    if (!Number.isFinite(candidate) || candidate < 0 || candidate > 120_000) {
      throw new NativeGeminiPasteError('NATIVE_PASTE_BAD_RESULT', 'Windows native paste helper returned invalid timing metadata.');
    }
    return candidate;
  };
  const verifiedAtMs = Date.parse(value.verifiedAt);
  const promptCanonical = canonicalizeNativePasteText(prompt);
  const promptSha256 = sha256Text(prompt);
  const promptCanonicalSha256 = sha256Text(promptCanonical);
  if (
    value.schemaVersion !== 1
    || !['windows-native-clipboard', 'windows-native-uia-value'].includes(value.transport)
    || value.pasteMode !== pasteMode
    || value.targetUrl !== expectedUrl
    || !Number.isInteger(value.chromeProcessId)
    || value.chromeProcessId < 1
    || value.promptCharacters !== prompt.length
    || value.promptUtf8Bytes !== Buffer.byteLength(prompt, 'utf8')
    || typeof value.blankLinesCollapsed !== 'boolean'
    || typeof value.normalizationApplied !== 'boolean'
    || typeof value.idempotent !== 'boolean'
    || typeof value.clipboardTouched !== 'boolean'
    || (value.transport === 'windows-native-clipboard'
      ? value.clipboardTouched === value.idempotent
      : value.clipboardTouched !== false)
    || value.clipboardRestored !== true
    || hash('promptSha256') !== promptSha256
    || hash('promptCanonicalSha256') !== promptCanonicalSha256
    || !hash('readbackSha256')
    || hash('readbackCanonicalSha256') !== promptCanonicalSha256
    || !Number.isFinite(verifiedAtMs)
    || (['fill-empty', 'replace-open-edit'].includes(pasteMode)
      && (value.sourceVerified !== false || value.sourceCanonicalSha256 !== null))
  ) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_BAD_RESULT', 'Windows native paste helper returned invalid verification metadata.');
  }
  return {
    ok: true,
    telemetry: {
      schemaVersion: 1,
      transport: value.transport,
      pasteMode,
      targetUrl: expectedUrl,
      chromeProcessId: value.chromeProcessId,
      promptCharacters: value.promptCharacters,
      promptUtf8Bytes: value.promptUtf8Bytes,
      findWindowMs: numeric('findWindowMs'),
      focusMs: numeric('focusMs'),
      pasteMs: numeric('pasteMs'),
      clipboardHeldMs: numeric('clipboardHeldMs'),
      readbackMs: numeric('readbackMs'),
      totalMs: numeric('totalMs'),
      idempotent: value.idempotent,
      clipboardTouched: value.clipboardTouched,
      clipboardRestored: value.clipboardRestored,
      blankLinesCollapsed: value.blankLinesCollapsed,
      normalizationApplied: value.normalizationApplied,
      promptSha256,
      promptCanonicalSha256,
      readbackSha256: value.readbackSha256,
      readbackCanonicalSha256: value.readbackCanonicalSha256,
      sourceVerified: value.sourceVerified === true,
      sourceCanonicalSha256: typeof value.sourceCanonicalSha256 === 'string'
        ? value.sourceCanonicalSha256
        : null,
      verifiedAt: new Date(verifiedAtMs).toISOString(),
    },
  };
}

/**
 * Paste a prompt into the dedicated Chrome for Testing window.
 *
 * Sensitive text is serialized only to the child process stdin. The command
 * line is constant, stdout is bounded, and helper failures are sanitized.
 */
export async function runNativeGeminiPaste({
  prompt,
  targetUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  profilePath,
  runtimeRoot,
  pasteMode = 'fill-empty',
  powershellPath = defaultPowerShellPath(),
  scriptPath = path.resolve(__dirname, '..', 'scripts', 'native-gemini-paste.ps1'),
  spawnImpl = spawn,
} = {}) {
  if (process.platform !== 'win32' && spawnImpl === spawn) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_WINDOWS_ONLY', 'Native Gemini paste is available only on Windows.', { status: 503 });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_EMPTY_PROMPT', 'Native paste requires a non-empty prompt.', { status: 400 });
  }
  if (!['fill-empty', 'replace-open-edit'].includes(pasteMode)) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_INVALID_MODE', 'Native paste mode is invalid.', { status: 400 });
  }
  const canonicalUrl = canonicalNativeGeminiTarget(targetUrl);
  if (!canonicalUrl || canonicalUrl !== targetUrl) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_INVALID_TARGET', 'Native paste requires an exact canonical Gemini conversation URL.', { status: 400 });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_INVALID_TIMEOUT', 'Native paste timeout must be between 1000 and 60000 ms.', { status: 400 });
  }

  const defaults = profilePath && runtimeRoot ? null : defaultRunnerPaths();
  const resolvedProfile = path.resolve(profilePath || defaults.profilePath);
  const resolvedRuntime = path.resolve(runtimeRoot || defaults.runtimeRoot);
  const resolvedScript = path.resolve(scriptPath);
  if (!fs.existsSync(resolvedScript)) {
    throw new NativeGeminiPasteError('NATIVE_PASTE_HELPER_MISSING', 'Windows native paste helper is missing.', { status: 503 });
  }

  const input = JSON.stringify({
    schemaVersion: 1,
    prompt,
    targetUrl: canonicalUrl,
    profilePath: resolvedProfile,
    runtimeRoot: resolvedRuntime,
    timeoutMs,
    pasteMode,
  });
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', resolvedScript];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(powershellPath, args, {
        cwd: path.dirname(resolvedScript),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new NativeGeminiPasteError('NATIVE_PASTE_START_FAILED', 'Windows native paste helper could not be started.', { status: 503 }));
      return;
    }

    let stdout = '';
    let stderrBytes = 0;
    let outputTooLarge = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new NativeGeminiPasteError('NATIVE_PASTE_TIMEOUT', 'Windows native paste helper timed out without pressing Enter.'));
    }, timeoutMs + 2_000);

    child.stdout?.on('data', chunk => {
      if (outputTooLarge) return;
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        stdout = '';
        child.kill();
      }
    });
    // Never retain or surface helper stderr. Count only to detect a runaway.
    child.stderr?.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) child.kill();
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NativeGeminiPasteError('NATIVE_PASTE_START_FAILED', 'Windows native paste helper could not be started.', { status: 503 }));
    });
    child.on('close', exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputTooLarge || stderrBytes > MAX_OUTPUT_BYTES) {
        reject(new NativeGeminiPasteError('NATIVE_PASTE_OUTPUT_INVALID', 'Windows native paste helper produced invalid output.'));
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch {}
      if (exitCode !== 0 || parsed?.ok !== true) {
        reject(sanitizedHelperError(parsed, exitCode));
        return;
      }
      try {
        resolve(validateResult(parsed, canonicalUrl, prompt, pasteMode));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin?.on('error', () => {});
    child.stdin?.end(input, 'utf8');
    // Drop the only serialized copy held by this function after stdin accepts it.
  });
}
