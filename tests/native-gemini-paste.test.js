import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  canonicalNativeGeminiTarget,
  canonicalizeNativePasteText,
  runNativeGeminiPaste,
} from '../server/native-gemini-paste.js';

const TARGET = 'https://gemini.google.com/gem/ad95cc35755e/5456455a154aafe5';

function successfulTelemetry(prompt, overrides = {}) {
  const promptCanonical = canonicalizeNativePasteText(prompt);
  const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
  return {
    schemaVersion: 1,
    transport: 'windows-native-clipboard',
    pasteMode: 'fill-empty',
    sourceVerified: false,
    sourceCanonicalSha256: null,
    targetUrl: TARGET,
    chromeProcessId: 1234,
    promptCharacters: prompt.length,
    promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
    findWindowMs: 12.3,
    focusMs: 8.2,
    pasteMs: 4.1,
    clipboardHeldMs: 1.2,
    readbackMs: 15.5,
    totalMs: 40.1,
    idempotent: false,
    clipboardTouched: true,
    clipboardRestored: true,
    blankLinesCollapsed: true,
    normalizationApplied: true,
    promptSha256: sha256(prompt),
    promptCanonicalSha256: sha256(promptCanonical),
    readbackSha256: sha256(promptCanonical),
    readbackCanonicalSha256: sha256(promptCanonical),
    verifiedAt: '2026-08-21T12:00:00.000Z',
    ...overrides,
  };
}

function fakeSpawnFactory({ responseForInput, capture }) {
  return (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        const inputText = Buffer.concat(chunks).toString('utf8');
        capture({ file, args, options, inputText });
        const { exitCode = 0, stdout = '', stderr = '' } = responseForInput(inputText);
        queueMicrotask(() => {
          if (stdout) child.stdout.write(stdout);
          if (stderr) child.stderr.write(stderr);
          child.stdout.end();
          child.stderr.end();
          child.emit('close', exitCode);
        });
        callback();
      },
    });
    return child;
  };
}

test('native Gemini targets accept only exact existing app and custom Gem conversations', () => {
  assert.equal(canonicalNativeGeminiTarget(TARGET), TARGET);
  assert.equal(
    canonicalNativeGeminiTarget('https://gemini.google.com/app/thread_abc-123'),
    'https://gemini.google.com/app/thread_abc-123',
  );
  for (const invalid of [
    'https://gemini.google.com/app',
    `${TARGET}?source=test`,
    `${TARGET}#answer`,
    'http://gemini.google.com/app/thread',
    'https://example.com/app/thread',
    'https://gemini.google.com/gem/only-one-id',
  ]) assert.equal(canonicalNativeGeminiTarget(invalid), null, invalid);
});

test('native paste keeps prompt off argv and returns only bounded verification telemetry', async () => {
  const prompt = '第一段。\n\n\n第二段。';
  let invocation;
  const spawnImpl = fakeSpawnFactory({
    capture(value) { invocation = value; },
    responseForInput(inputText) {
      const input = JSON.parse(inputText);
      assert.equal(input.prompt, prompt);
      assert.equal(input.targetUrl, TARGET);
      return {
        stdout: JSON.stringify({
          ok: true,
          telemetry: {
            ...successfulTelemetry(prompt, {
              transport: 'windows-native-uia-value',
              clipboardTouched: false,
              clipboardHeldMs: 0,
              focusMs: 0,
            }),
            untrustedExtra: prompt,
          },
        }),
      };
    },
  });

  const result = await runNativeGeminiPaste({
    prompt,
    targetUrl: TARGET,
    profilePath: 'C:\\Runner\\profile',
    runtimeRoot: 'C:\\Runner\\runtime',
    powershellPath: 'powershell-test.exe',
    scriptPath: path.resolve('scripts/native-gemini-paste.ps1'),
    spawnImpl,
  });

  assert.equal(invocation.file, 'powershell-test.exe');
  assert.equal(invocation.args.includes(prompt), false);
  assert.equal(invocation.args.includes(TARGET), false);
  assert.equal(JSON.stringify(invocation.options).includes(prompt), false);
  assert.equal(result.telemetry.promptUtf8Bytes, Buffer.byteLength(prompt, 'utf8'));
  assert.equal(result.telemetry.transport, 'windows-native-uia-value');
  assert.equal(result.telemetry.clipboardTouched, false);
  assert.equal('untrustedExtra' in result.telemetry, false);
  assert.equal(JSON.stringify(result).includes(prompt), false);
});

test('native paste never reflects helper stderr or an unsafe helper error message', async () => {
  const prompt = 'private prompt must not escape';
  const spawnImpl = fakeSpawnFactory({
    capture() {},
    responseForInput() {
      return {
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, code: 'READBACK_MISMATCH', error: prompt }),
        stderr: prompt,
      };
    },
  });

  await assert.rejects(
    runNativeGeminiPaste({
      prompt,
      targetUrl: TARGET,
      profilePath: 'C:\\Runner\\profile',
      runtimeRoot: 'C:\\Runner\\runtime',
      scriptPath: path.resolve('scripts/native-gemini-paste.ps1'),
      spawnImpl,
    }),
    error => error.code === 'READBACK_MISMATCH' && !error.message.includes(prompt),
  );
});

test('native paste rejects a helper success if the previous clipboard was not restored', async () => {
  const prompt = 'clipboard restoration must be proven';
  const spawnImpl = fakeSpawnFactory({
    capture() {},
    responseForInput() {
      return {
        stdout: JSON.stringify({
          ok: true,
          telemetry: successfulTelemetry(prompt, { clipboardRestored: false }),
        }),
      };
    },
  });
  await assert.rejects(
    runNativeGeminiPaste({
      prompt,
      targetUrl: TARGET,
      profilePath: 'C:\\Runner\\profile',
      runtimeRoot: 'C:\\Runner\\runtime',
      scriptPath: path.resolve('scripts/native-gemini-paste.ps1'),
      spawnImpl,
    }),
    error => error.code === 'NATIVE_PASTE_BAD_RESULT',
  );
});

test('native open-edit paste uses the already-bound edit surface without a UIA source hash', async () => {
  const prompt = '替换后的多段\n\n内容';
  let privateInput;
  const spawnImpl = fakeSpawnFactory({
    capture({ inputText }) { privateInput = JSON.parse(inputText); },
    responseForInput() {
      return {
        stdout: JSON.stringify({
          ok: true,
          telemetry: successfulTelemetry(prompt, {
            pasteMode: 'replace-open-edit',
            sourceVerified: false,
            sourceCanonicalSha256: null,
          }),
        }),
      };
    },
  });
  const result = await runNativeGeminiPaste({
    prompt,
    targetUrl: TARGET,
    pasteMode: 'replace-open-edit',
    profilePath: 'C:\\Runner\\profile',
    runtimeRoot: 'C:\\Runner\\runtime',
    scriptPath: path.resolve('scripts/native-gemini-paste.ps1'),
    spawnImpl,
  });
  assert.equal(privateInput.pasteMode, 'replace-open-edit');
  assert.equal('expectedExistingCanonicalSha256' in privateInput, false);
  assert.equal(result.telemetry.sourceVerified, false);
  assert.equal(result.telemetry.sourceCanonicalSha256, null);
});

test('native open-edit paste is safely idempotent when the edit box already contains the target prompt', async () => {
  const prompt = '已经替换完成';
  const spawnImpl = fakeSpawnFactory({
    capture() {},
    responseForInput() {
      return {
        stdout: JSON.stringify({
          ok: true,
          telemetry: successfulTelemetry(prompt, {
            pasteMode: 'replace-open-edit',
            sourceVerified: false,
            sourceCanonicalSha256: null,
            idempotent: true,
            clipboardTouched: false,
          }),
        }),
      };
    },
  });
  const result = await runNativeGeminiPaste({
    prompt,
    targetUrl: TARGET,
    pasteMode: 'replace-open-edit',
    profilePath: 'C:\\Runner\\profile',
    runtimeRoot: 'C:\\Runner\\runtime',
    scriptPath: path.resolve('scripts/native-gemini-paste.ps1'),
    spawnImpl,
  });
  assert.equal(result.telemetry.idempotent, true);
  assert.equal(result.telemetry.clipboardTouched, false);
  assert.equal(result.telemetry.sourceCanonicalSha256, null);
});

test('PowerShell helper uses exact native UI Automation input and contains no Enter-key action', async () => {
  const source = await fs.readFile(path.resolve('scripts/native-gemini-paste.ps1'), 'utf8');
  assert.match(source, /COMPOSER_NOT_EMPTY/);
  assert.match(source, /\(\^\|\\s\)ql-blank\(\\s\|\$\)/);
  assert.match(source, /\$editComposerNames = @\('Edit prompt'/);
  assert.match(source, /\$pasteMode -eq 'replace-open-edit'[\s\S]*\$isExactEditComposer[\s\S]*else \{[\s\S]*\$isMainComposer/);
  assert.match(source, /CLIPBOARD_SNAPSHOT_FAILED/);
  assert.match(source, /CLIPBOARD_RESTORE_FAILED/);
  assert.match(source, /EnumWindows/);
  assert.match(source, /GetWindowThreadProcessId/);
  assert.match(source, /Chrome_WidgetWin_1/);
  assert.match(source, / - Google Chrome for Testing/);
  assert.match(source, /FindChromeForTestingWindows\(\[int\]\$runner\.ProcessId\)/);
  assert.match(source, /RUNNER_WINDOW_NOT_UNIQUE/);
  assert.doesNotMatch(source, /MainWindowHandle/);
  assert.doesNotMatch(source, /IsWindowVisible/);
  assert.match(source, /transport = 'windows-native-uia-value'/);
  assert.match(source, /ValuePattern\]::Pattern/);
  assert.doesNotMatch(source, /expectedExistingCanonicalSha256|replace-exact|ConvertFrom-GeminiEditSource/);
  assert.ok(source.indexOf('$focusedReadback = Get-ComposerText') < source.indexOf('$nativeValue.SetValue($prompt)'));
  const focusedEditGuard = source.slice(
    source.indexOf('$focusedReadback = Get-ComposerText'),
    source.indexOf('$nativeValue.SetValue($prompt)'),
  );
  assert.match(focusedEditGuard, /elseif \(\$pasteMode -eq 'replace-open-edit'\)[\s\S]*\$editComposerNames -notcontains/);
  const nativeWriteAndReadback = source.slice(
    source.indexOf('$nativeValue.SetValue($prompt)'),
    source.indexOf('$readbackMs = $stopwatch.Elapsed.TotalMilliseconds'),
  );
  assert.match(nativeWriteAndReadback, /\$readbackDeadline = \[DateTime\]::UtcNow\.AddSeconds\(3\)/);
  assert.match(nativeWriteAndReadback, /\$readback = Get-ComposerText/);
  assert.doesNotMatch(source, /Clipboard\]::SetText/);
  assert.doesNotMatch(source, /SendControlChord\(/i);
  assert.doesNotMatch(source, /SendWait\([^\r\n]*\{ENTER\}/i);
  assert.doesNotMatch(source, /SendKeys[^\r\n]*(?:ENTER|RETURN)/i);
});
