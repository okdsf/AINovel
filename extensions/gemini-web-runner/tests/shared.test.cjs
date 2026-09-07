"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const optionsSource = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");

function loadShared(chromeOverride) {
  const context = vm.createContext({
    URL,
    chrome: chromeOverride || { storage: { local: {} }, runtime: {} },
    crypto: { randomUUID: () => "test" },
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "shared.js" });
  return context.NWGeminiShared;
}

function fakeNode({ matches = [], queries = {}, innerText = "", textContent, innerHTML = "" } = {}) {
  return {
    innerText,
    textContent: typeof textContent === "string" ? textContent : innerText,
    innerHTML,
    matches(selector) { return matches.includes(selector); },
    querySelectorAll(selector) { return queries[selector] || []; }
  };
}

test("lost server leases enter read-only monitoring instead of stopping answer capture", () => {
  const shared = loadShared();
  assert.equal(shared.isLostLeaseStatus(404), true);
  assert.equal(shared.isLostLeaseStatus(409), true);
  assert.equal(shared.isLostLeaseStatus(410), true);
  assert.equal(shared.heartbeatDisposition(404), "read-only");
  assert.equal(shared.heartbeatDisposition(409), "read-only");
  assert.equal(shared.heartbeatDisposition(410), "read-only");
  assert.equal(shared.heartbeatDisposition(200), "active");
  assert.equal(shared.heartbeatDisposition(0), "transient");
  assert.equal(shared.heartbeatDisposition(401), "transient");
  assert.equal(shared.heartbeatDisposition(500), "transient");
});

test("idle heartbeat cadence is due at thirty seconds and never on clock rollback", () => {
  const shared = loadShared();
  assert.equal(shared.idleHeartbeatDue(0, 100000, 30000), true);
  assert.equal(shared.idleHeartbeatDue(100000, 129999, 30000), false);
  assert.equal(shared.idleHeartbeatDue(100000, 130000, 30000), true);
  assert.equal(shared.idleHeartbeatDue(100000, 99999, 30000), false);
});

test("network prewarm is enabled by default and can be disabled in options", () => {
  const shared = loadShared();
  assert.equal(shared.DEFAULTS.prewarmEnabled, true);
  assert.match(backgroundSource, /prewarmEnabled:\s*true/);
  assert.match(optionsHtml, /id="prewarm-enabled"[\s\S]*checked/);
  assert.match(optionsSource, /prewarmEnabled:\s*prewarmEnabled\.checked/);
  assert.match(optionsSource, /settings\.prewarmEnabled !== false/);
});

test("prompt and redo dispatch prewarm once after validation and before their write-ahead fence", () => {
  assert.doesNotMatch(contentSource, /experimental-control|prewarmGeminiOriginIfIdle/);
  assert.match(contentSource, /method:\s*"HEAD"/);
  assert.match(contentSource, /cache:\s*"no-store"/);
  assert.match(contentSource, /credentials:\s*"same-origin"/);
  assert.match(contentSource, /const PREWARM_TIMEOUT_MS = 3000/);

  const redoStart = contentSource.indexOf("async function dispatchRedoTask(active)");
  const promptStart = contentSource.indexOf("async function dispatchFilledTask(active)", redoStart);
  const processStart = contentSource.indexOf("async function processLeasedTask(active)", promptStart);
  const redoBody = contentSource.slice(redoStart, promptStart);
  const promptBody = contentSource.slice(promptStart, processStart);
  for (const body of [redoBody, promptBody]) {
    assert.ok(body.indexOf("currentModelLabel()") < body.indexOf("ensureTaskPrewarm(active"));
    assert.ok(body.indexOf("ensureTaskPrewarm(active") < body.indexOf("postFenceEvent(active"));
    assert.ok(body.indexOf("postFenceEvent(active") < body.indexOf(".click()"));
    assert.match(body, /telemetry:\s*active\.telemetry \|\| undefined/);
  }
  assert.equal((redoBody.match(/ensureTaskPrewarm\(active/g) || []).length, 1);
  assert.equal((promptBody.match(/ensureTaskPrewarm\(active/g) || []).length, 1);
});

test("exact-conversation sends prewarm before composer write and fence only after readback", () => {
  const prepareStart = contentSource.indexOf("async function prepareNativeContinueTask(active, settings)");
  const editStart = contentSource.indexOf("async function prepareEditTask(active, settings)", prepareStart);
  const prepareBody = contentSource.slice(prepareStart, editStart);
  const prewarm = prepareBody.indexOf("ensureTaskPrewarm(active, settings)");
  const write = prepareBody.indexOf("setComposerText(composer, active.task.prompt)");
  assert.ok(prewarm >= 0 && prewarm < write);
  assert.doesNotMatch(prepareBody, /requestNativePaste\(active\)/);

  const pasteStart = contentSource.indexOf("async function requestNativePaste(active)");
  const flushStart = contentSource.indexOf("async function flushOutbox()", pasteStart);
  const pasteBody = contentSource.slice(pasteStart, flushStart);
  assert.ok(pasteBody.indexOf("NW_ACTIVATE_RUNNER_TAB") < pasteBody.indexOf("/native-paste"));
  assert.ok(pasteBody.indexOf("NW_CONFIRM_RUNNER_TAB_ACTIVATION") < pasteBody.indexOf("/native-paste"));
  assert.match(pasteBody, /while \(activated\?\.ok && activated\.activationPending === true/);
  assert.match(pasteBody, /isTransientActivationPortError/);
  assert.match(pasteBody, /\(\?:port\|channel\)\.\*closed\|closed\.\*/);
  assert.ok(pasteBody.indexOf("/native-paste") < pasteBody.indexOf("NATIVE_PASTE_DOM_READBACK_MISMATCH"));
  assert.match(pasteBody, /stableNativeReads >= 2/);
  assert.match(pasteBody, /\}, 3000, 120\)/);
  assert.match(pasteBody, /nativeComposerEvidence/);
  assert.match(pasteBody, /domReadbackSha256/);

  const dispatchStart = contentSource.indexOf("async function dispatchFilledTask(active)");
  const processStart = contentSource.indexOf("async function processLeasedTask(active)", dispatchStart);
  const dispatchBody = contentSource.slice(dispatchStart, processStart);
  assert.equal((dispatchBody.match(/composerStillMatchesPreparedInput\(active/g) || []).length, 3);
  assert.ok(dispatchBody.indexOf("COMPOSER_CHANGED") < dispatchBody.indexOf("postFenceEvent(active"));
  assert.ok(dispatchBody.indexOf("postFenceEvent(active") < dispatchBody.indexOf("button.click()"));
});

test("rich Quill fallback writes top-level paragraphs and waits for stable canonical reads", () => {
  const start = contentSource.indexOf("async function setComposerText(element, prompt)");
  const end = contentSource.indexOf("async function setStatus", start);
  const body = contentSource.slice(start, end);
  assert.match(body, /document\.createElement\("p"\)/);
  assert.match(body, /await sleep\(120\)/);
  assert.match(body, /stableReads >= 2/);
  assert.doesNotMatch(body, /fragment\.append\(document\.createElement\("br"\)\)/);
});

test("native UI Automation Quill readback preserves BR-separated paragraphs", () => {
  const start = contentSource.indexOf("function composerText(element = composerElement())");
  const end = contentSource.indexOf("function normalizedNewlines", start);
  const body = contentSource.slice(start, end);
  assert.match(body, /node\.tagName === "BR"/);
  assert.match(body, /textWithBreaks\(paragraph\)/);
  assert.ok(body.indexOf('node.tagName === "BR"') < body.indexOf("textWithBreaks(paragraph)"));
});

test("Gemini query-line extraction excludes accessibility chrome and preserves literal newlines", () => {
  const shared = loadShared();
  assert.equal(shared.geminiQueryLinesText([
    { text: "NovelWeb Windows UIA E2E 测试。" },
    { text: "\n", hasBreak: true },
    { text: "\n", hasBreak: true },
    { text: "第二段。" },
    { text: "\n", hasBreak: true },
    { text: "请只回复：NW-E2E" }
  ]), "NovelWeb Windows UIA E2E 测试。\n\n第二段。\n请只回复：NW-E2E");
  assert.equal(shared.geminiQueryLinesText([
    { text: "  缩进正文  " }
  ]), "  缩进正文  ");
  assert.equal(shared.geminiQueryLinesText([
    { text: "You said" },
    { text: "\n", hasBreak: true },
    { text: "这也是正文" }
  ]), "You said\n这也是正文");
  assert.equal(shared.geminiQueryLinesText([
    { text: "You said this should remain literal." }
  ]), "You said this should remain literal.");

  const start = contentSource.indexOf("function userTurnText(root)");
  const end = contentSource.indexOf("function editPromptControlSelection", start);
  const body = contentSource.slice(start, end);
  assert.match(body, /\[\.\.\.content\.children\]\.filter/);
  assert.match(body, /matches\?\.\("\.query-text-line"\)/);
  assert.doesNotMatch(body, /querySelectorAll\("\.query-text-line"\)/);
  assert.match(body, /Shared\.geminiQueryLinesText\(exactLines\)/);
  assert.match(body, /\.screen-reader-user-query-label/);
  assert.doesNotMatch(body, /replace\([^\n]*(?:You said|你说)/i);

  const lastStart = contentSource.indexOf("function lastUserPromptText()");
  const lastEnd = contentSource.indexOf("function userTurnRoots()", lastStart);
  const lastBody = contentSource.slice(lastStart, lastEnd);
  assert.ok(lastBody.indexOf("userTurnRoots()") < lastBody.indexOf("selectorGroups"));
  assert.ok(lastBody.indexOf("userTurnText(semanticRoots.at(-1))") < lastBody.indexOf("selectorGroups"));
});

test("Gemini Edit source accessibility newlines reconstruct the snapshotted prompt", () => {
  const shared = loadShared();
  assert.equal(
    shared.geminiEditSourceText("Line A\n\n\nLine B\n\nLine C"),
    "Line A\n\nLine B\nLine C"
  );
  assert.equal(shared.geminiEditSourceText("one line"), "one line");
  assert.equal(shared.geminiEditSourceText("  indented  \n\nnext"), "  indented  \nnext");

});

test("edit workflow verifies the snapshotted turn before opening edit mode and before a single fenced update", () => {
  const start = contentSource.indexOf("async function prepareEditTask(active, settings)");
  const end = contentSource.indexOf("async function captureResultSourceTurn", start);
  const body = contentSource.slice(start, end);
  assert.ok(body.indexOf("verifyTaskUserTurn(task, task.targetTurn)") < body.indexOf("selection.button.click()"));
  assert.ok(body.indexOf("selection.button.click()") < body.indexOf("ensureTaskPrewarm(active, settings)"));
  const prewarm = body.indexOf("ensureTaskPrewarm(active, settings)");
  const write = body.indexOf("setComposerText(editComposer, task.prompt)");
  assert.ok(prewarm >= 0 && prewarm < write);
  assert.match(body.slice(prewarm, write), /verifyEditLiveBinding\(active\)/);
  assert.match(body.slice(write), /verifyEditLiveBinding\(active, \{ requirePrompt: true \}\)/);
  assert.match(contentSource, /targetTurnEvidence/);
  assert.match(contentSource, /resultSourceTurn/);
  const selectorStart = contentSource.indexOf("function editPromptControlSelection(root)");
  const selectorEnd = contentSource.indexOf("function editComposerSelection", selectorStart);
  const selectorBody = contentSource.slice(selectorStart, selectorEnd);
  assert.match(selectorBody, /new Set\(\["edit", "edit prompt"/);
});

test("conversation inspection is read-only and posts semantic turns to its dedicated endpoint", () => {
  const start = contentSource.indexOf("async function processConversationSnapshot(active)");
  const end = contentSource.indexOf("async function emitConversationSnapshotFailure", start);
  const body = contentSource.slice(start, end);
  assert.match(body, /stableConversationTurns\(\)/);
  assert.match(body, /turns: turns\.map\(publicConversationTurn\)/);
  assert.doesNotMatch(body, /conversationSnapshot\s*:/);
  assert.doesNotMatch(body, /\.click\(\)/);
  assert.match(contentSource, /\/api\/automation\/worker\/conversation-snapshots\/\$\{encodeURIComponent/);
});

test("only visible thinking UI and first-visible client timing are persisted", () => {
  assert.match(contentSource, /kind: "visible_ui_summary"/);
  assert.match(contentSource, /firstResponseVisibleAt/);
  assert.match(contentSource, /clickToFirstResponseMs/);
  assert.match(contentSource, /firstResponseTimingQuality/);
  assert.doesNotMatch(contentSource, /hidden[_ -]?cot|hidden chain.of.thought/i);
});

test("first-visible timing requires post-click response body evidence, not a generation lifecycle", () => {
  const start = contentSource.indexOf("async function waitForCompletion(active)");
  const end = contentSource.indexOf("async function finishCompleted", start);
  const body = contentSource.slice(start, end);
  const generation = body.indexOf("const redoObserved");
  const bodyEvidence = body.indexOf("const firstResponseBodyEvidence", generation);
  const timingGate = body.indexOf("if (firstResponseBodyEvidence", bodyEvidence);
  assert.ok(generation >= 0 && generation < bodyEvidence && bodyEvidence < timingGate);
  assert.match(body, /Shared\.redoFirstVisibleBodyEvidence\(\{/);
  assert.match(body, /responseBodyAfterSubmittedUser\(active\)/);
  assert.doesNotMatch(body.slice(bodyEvidence, timingGate), /redoObserved|domMutationSeen|stopCycleCompleted/);

  const finishStart = contentSource.indexOf("async function finishCompleted(active, snapshot)");
  const finishEnd = contentSource.indexOf("async function dispatchRedoTask(active)", finishStart);
  const finishBody = contentSource.slice(finishStart, finishEnd);
  assert.match(finishBody, /firstResponseVisibleAt = hasFirstResponseEvidence[\s\S]*?: null/);
  assert.match(finishBody, /firstResponseTimingQuality[\s\S]*?: "unobserved"/);
  assert.doesNotMatch(finishBody, /firstResponseVisibleAt\s*=.*\|\|\s*completedAt/);
});

test("Edit first-response timing stays unobserved when an old following response remains visible", () => {
  const start = contentSource.indexOf("function responseBodyAfterSubmittedUser(active)");
  const end = contentSource.indexOf("function accessibleName", start);
  const body = contentSource.slice(start, end);
  const editGuard = body.indexOf('active?.task?.conversationAction === "edit"');
  const userLookup = body.indexOf("userTurnRoots()");
  const responseLookup = body.indexOf("responseElements()");
  assert.ok(editGuard >= 0 && editGuard < userLookup && userLookup < responseLookup);
  assert.match(body.slice(editGuard, userLookup), /return null/);
  assert.match(contentSource, /firstResponseTimingQuality = firstResponseVisibleAt[\s\S]*?: "unobserved"/);
});

test("completion freezes the full event once and completing resume only replays that payload", () => {
  const finishStart = contentSource.indexOf("async function finishCompleted(active, snapshot)");
  const finishEnd = contentSource.indexOf("async function dispatchRedoTask(active)", finishStart);
  const body = contentSource.slice(finishStart, finishEnd);
  const freezeGuard = body.indexOf("if (!active.completionPayload)");
  const thinkingRead = body.indexOf("visibleThinkingText(responseElements().at(-1))");
  const payloadWrite = body.indexOf("active.completionPayload = JSON.parse(JSON.stringify({");
  const durableSave = body.indexOf("await saveActive(active)", payloadWrite);
  const replay = body.indexOf('enqueueEvent(active, "completed", active.completionPayload)');
  assert.ok(freezeGuard >= 0 && freezeGuard < thinkingRead);
  assert.ok(thinkingRead < payloadWrite && payloadWrite < durableSave && durableSave < replay);
  assert.equal((body.match(/visibleThinkingText\(/g) || []).length, 1);
  assert.match(body, /responseHtml:[\s\S]*conversationUrl:[\s\S]*visibleThinkingSummary[\s\S]*timing:[\s\S]*telemetry/);

  const resumeStart = contentSource.indexOf("async function resumeTask(active)");
  const resumeEnd = contentSource.indexOf("async function postConversationSnapshotEvent", resumeStart);
  const resumeBody = contentSource.slice(resumeStart, resumeEnd);
  assert.match(resumeBody, /!active\.completionSnapshot\?\.text \|\| !active\.completionPayload/);
  assert.match(resumeBody, /finishCompleted\(active, active\.completionSnapshot\)/);
  assert.doesNotMatch(resumeBody, /visibleThinkingText|firstResponseVisibleAt\s*=/);
  assert.match(
    contentSource,
    /existing\.stage === "completing"[\s\S]{0,180}?existing\.completionPayload[\s\S]{0,900}?finishCompleted\(existing, existing\.completionSnapshot\)/
  );
});

test("prompt-filled recovery returns to leased and re-prepares instead of fencing the old DOM", () => {
  const start = contentSource.indexOf('if (active.stage === "prompt-filled")');
  const end = contentSource.indexOf('if (active.stage === "redo-ready")', start);
  const body = contentSource.slice(start, end);
  assert.match(body, /active\.stage = "leased"/);
  assert.match(body, /delete active\.baseline/);
  assert.match(body, /await saveActive\(active\)/);
  assert.match(body, /await processLeasedTask\(active\)/);
  assert.doesNotMatch(body, /dispatchFilledTask/);
});

test("redo-ready recovery discards its old baseline and fully re-prepares before any fence", () => {
  const start = contentSource.indexOf('if (active.stage === "redo-ready")');
  const end = contentSource.indexOf('if (active.stage === "dispatching-fenced")', start);
  const body = contentSource.slice(start, end);
  assert.match(body, /active\.stage = "leased"/);
  for (const transient of ["baseline", "redoEvidence", "preparedLocation", "submittedModelLabel", "submittedDocumentId"]) {
    assert.match(body, new RegExp(`delete active\\.${transient}`));
  }
  assert.match(body, /await saveActive\(active\)/);
  assert.match(body, /await processLeasedTask\(active\)/);
  assert.doesNotMatch(body, /dispatchRedoTask/);
});

test("edit recovery never reuses an already-open same-text editor and verifies again after Cancel", () => {
  const start = contentSource.indexOf("async function prepareEditTask(active, settings)");
  const end = contentSource.indexOf("async function captureResultSourceTurn", start);
  const body = contentSource.slice(start, end);
  const existingStart = body.indexOf("if (editComposer) {");
  const reopenStart = body.indexOf("if (!editComposer) {", existingStart);
  const existingBody = body.slice(existingStart, reopenStart);
  assert.match(existingBody, /editCancelControlSelection\(editComposer\)/);
  assert.match(existingBody, /cancel\.button\.click\(\)/);
  assert.match(existingBody, /editComposerSelection\(\)\.count === 0/);
  assert.doesNotMatch(existingBody, /stableConversationTurns|turnEvidence|composerText|sourceTextSha256/);
  assert.ok(existingBody.indexOf("cancel.button.click()") < existingBody.indexOf("editComposer = null"));
  assert.match(body.slice(reopenStart), /verifyTaskUserTurn\(task, task\.targetTurn\)/);
});

test("same-text turn switch immediately after Edit opens cannot inherit the verified root", () => {
  const start = contentSource.indexOf("async function prepareEditTask(active, settings)");
  const end = contentSource.indexOf("async function captureResultSourceTurn", start);
  const body = contentSource.slice(start, end);
  const click = body.indexOf("selection.button.click()");
  const appeared = body.indexOf("editComposer = await waitFor", click);
  const immediateRoot = body.indexOf("editComposerUserRoot(editComposer) !== verified.selected.root", appeared);
  const establish = body.indexOf("establishEditLiveBinding(active, provenRoot, editComposer", immediateRoot);
  assert.ok(click >= 0 && click < appeared && appeared < immediateRoot && immediateRoot < establish);
  assert.doesNotMatch(body.slice(appeared, establish), /stableConversationTurns|verifyTaskUserTurn/);
  assert.match(body.slice(appeared, establish), /provenRoot = verified\.selected\.root/);
  assert.match(body.slice(appeared, establish), /active\.targetTurnEvidence = verified\.evidence/);
  assert.doesNotMatch(body.slice(appeared, establish), /sourceObserved|geminiEditSourceText/);
});

test("same-text turn switch at dispatch awaits fails the root-textarea live binding before click", () => {
  const bindingStart = contentSource.indexOf("async function verifyEditLiveBinding(active");
  const bindingEnd = contentSource.indexOf("function findControlByLabel", bindingStart);
  const bindingBody = contentSource.slice(bindingStart, bindingEnd);
  assert.doesNotMatch(bindingBody, /stableConversationTurns|conversationTurnsWithRoots/);
  assert.match(bindingBody, /live\.evidenceSignature !== JSON\.stringify\(serializable\.targetTurnEvidence\)/);
  assert.match(bindingBody, /selectedComposer\.element !== live\.composer/);
  assert.match(bindingBody, /editComposerUserRoot\(live\.composer\) !== live\.root/);
  assert.match(bindingBody, /editConversationContainerId\(live\.root\) !== live\.containerId/);
  assert.doesNotMatch(bindingBody, /editLiveSemanticOrdinal|currentOrdinal/);
  assert.match(bindingBody, /for \(let stableRead = 0; stableRead < 2/);
  assert.match(bindingBody, /requirePrompt && !promptMatches\(composerText\(live\.composer\), active\.task\.prompt\)/);

  const dispatchStart = contentSource.indexOf("async function dispatchFilledTask(active)");
  const dispatchEnd = contentSource.indexOf("async function processLeasedTask(active)", dispatchStart);
  const dispatchBody = contentSource.slice(dispatchStart, dispatchEnd);
  const callPattern = /verifyEditLiveBinding\(active, \{ requirePrompt: true \}\)/g;
  const checks = [...dispatchBody.matchAll(callPattern)].map((match) => match.index);
  assert.equal(checks.length, 3);
  const prewarm = dispatchBody.indexOf("ensureTaskPrewarm(active");
  const fence = dispatchBody.indexOf("postFenceEvent(active");
  const clickButton = dispatchBody.indexOf("button.click()");
  assert.ok(checks[0] < prewarm && prewarm < checks[1] && checks[1] < fence && fence < checks[2] && checks[2] < clickButton);
  assert.equal((dispatchBody.slice(checks[0], fence).match(/reprepareEditBeforeFence\(active\)/g) || []).length, 2);
  assert.match(dispatchBody.slice(checks[2], clickButton), /EDIT_LIVE_BINDING_MISSING_AFTER_FENCE/);
  assert.doesNotMatch(dispatchBody.slice(checks[2] + "verifyEditLiveBinding".length, clickButton), /await\s/);
});

test("send and edit completion requires a new stable response with no active stop control", () => {
  const start = contentSource.indexOf("async function waitForCompletion(active)");
  const end = contentSource.indexOf("async function finishCompleted", start);
  const body = contentSource.slice(start, end);
  const nonRedoBranch = body.match(/const isNewResponse = snapshot\.text && \(redo[\s\S]*?Shared\.responseRootReplaced\(baseline, snapshot\)\)\);/);
  assert.ok(nonRedoBranch);
  assert.match(body, /const generationEnded = !redo && stopWasSeen && !stopNow && stopDisappearedAt/);
  assert.match(body, /const stableNewResponseWithoutStop = !redo\s*&& !stopNow\s*&& isNewResponse\s*&& stableSince\s*&& Date\.now\(\) - stableSince >= RESPONSE_STABLE_MS/);
  assert.match(body, /if \(\(generationEnded \|\| stableNewResponseWithoutStop\)\s*&& isNewResponse\s*&& stableSince/);
  assert.match(body, /Shared\.provenanceMatches\(expectedUrl, conversationUrlFrom\(\)\)/);
});

test("snapshot failure reports the lease-bound URL even when navigation failed", () => {
  const start = contentSource.indexOf("async function emitConversationSnapshotFailure(active, error)");
  const end = contentSource.indexOf("function validateClaimedTask", start);
  const body = contentSource.slice(start, end);
  assert.match(body, /conversationUrl: active\.task\.conversationUrl/);
  assert.doesNotMatch(body, /provenanceMatches|conversationUrlFrom/);
});

test("snapshot owner handoff restarts read-only inspection and never enters generation outbox", () => {
  const ownerStart = contentSource.indexOf("if (existing.ownerKey && existing.ownerKey !== lock.ownerKey)");
  const ownerEnd = contentSource.indexOf("if (!existing.ownerKey)", ownerStart);
  const body = contentSource.slice(ownerStart, ownerEnd);
  const snapshotBranch = body.indexOf('existing.task?.jobType === "conversation_snapshot"');
  const generationBranch = body.indexOf('["leased", "prompt-filled", "redo-ready"]', snapshotBranch);
  assert.ok(snapshotBranch >= 0 && snapshotBranch < generationBranch);
  const snapshotBody = body.slice(snapshotBranch, generationBranch);
  assert.match(snapshotBody, /existing\.ownerKey = lock\.ownerKey/);
  assert.match(snapshotBody, /existing\.stage = "leased"/);
  assert.match(snapshotBody, /delete existing\.navigationTarget/);
  assert.match(snapshotBody, /await saveActive\(existing\)/);
  assert.doesNotMatch(snapshotBody, /emitBlocked|emitFailed|enqueueEvent|NW_ENQUEUE_OUTBOX/);

  const catchStart = contentSource.indexOf("if (existing.task?.jobType === \"conversation_snapshot\")", ownerEnd);
  assert.ok(catchStart > ownerEnd);
  assert.match(
    contentSource.slice(catchStart, catchStart + 220),
    /emitConversationSnapshotFailure\(existing, error\)/
  );
});

test("prewarm telemetry is attached to every worker event path", () => {
  for (const type of ["blocked", "failed", "submitted"]) {
    const pattern = new RegExp(`enqueueEvent\\(active, ["']${type}["'][\\s\\S]{0,900}?telemetry:\\s*active\\.telemetry`);
    assert.match(contentSource, pattern, type);
  }
  assert.match(contentSource, /active\.completionPayload = JSON\.parse\(JSON\.stringify\([\s\S]{0,1200}?telemetry: active\.telemetry/);
  assert.match(contentSource, /enqueueEvent\(active, "completed", active\.completionPayload\)/);
  assert.match(contentSource, /postFenceEvent\(active,[\s\S]{0,400}?telemetry:\s*active\.telemetry/);
});

test("disabled paired content posts only an idle heartbeat before returning", () => {
  const disabledBranch = contentSource.match(
    /if \(!settings\.enabled && !existing\) \{([\s\S]*?)\r?\n\s*\}\r?\n\s*if \(!settings\.pairingToken\)/
  );
  assert.ok(disabledBranch, "disabled branch contract must remain recognizable");
  assert.match(disabledBranch[1], /settings\.pairingToken/);
  assert.match(disabledBranch[1], /postIdleHeartbeatIfDue\("disabled-idle"\)/);
  assert.match(disabledBranch[1], /runnerLock\("release"\)/);
  assert.doesNotMatch(disabledBranch[1], /claimNextTask/);
  assert.match(contentSource, /pageUrl:\s*pageUrl\(\),\s*\n\s*modelLabel:\s*currentModelLabel\(\)/);
});

test("a handoff tab on conversation Y can never supply conversation X provenance", () => {
  const shared = loadShared();
  const x = "https://gemini.google.com/app/conversation-x";
  const y = "https://gemini.google.com/app/conversation-y";
  assert.equal(shared.provenanceMatches(x, x), true);
  assert.equal(shared.provenanceMatches(x, `${x}?hl=zh-CN`), true);
  assert.equal(shared.provenanceMatches(x, y), false);
  assert.equal(shared.provenanceMatches(x, "https://gemini.google.com/app"), false);
  assert.equal(shared.provenanceMatches("", y), false);
});

test("custom Gem conversation URLs normalize canonically and preserve provenance", () => {
  const shared = loadShared();
  const canonical = "https://gemini.google.com/gem/gem_123/thread-456";
  assert.equal(
    shared.normalizeGeminiConversationUrl(`${canonical}?utm_source=test#answer`),
    canonical
  );
  assert.equal(shared.provenanceMatches(canonical, `${canonical}?view=latest`), true);
  assert.equal(
    shared.normalizeGeminiConversationUrl("https://gemini.google.com/gem/gem_123"),
    ""
  );
});

test("new conversation binding requires URL, live stop signal, and the exact sent prompt", () => {
  const shared = loadShared();
  const oldUrl = "https://gemini.google.com/app/old";
  const newUrl = "https://gemini.google.com/app/new";
  const input = {
    candidate: newUrl,
    previous: oldUrl,
    stopVisible: true,
    observedUserPrompt: "第一行\n第二行",
    expectedPrompt: "第一行\r\n第二行"
  };
  assert.equal(shared.canBindNewConversation(input), true);
  assert.equal(shared.canBindNewConversation({ ...input, candidate: oldUrl }), false);
  assert.equal(shared.canBindNewConversation({ ...input, stopVisible: false }), false);
  assert.equal(shared.canBindNewConversation({ ...input, observedUserPrompt: "另一个任务" }), false);
  assert.equal(shared.canBindNewConversation({ ...input, observedUserPrompt: "" }), false);
});

test("snapshot and native edit use one canonical multiline hash contract", () => {
  const shared = loadShared();
  assert.equal(
    shared.canonicalNativePasteText("第一段\r\n\r\n\r\n第二段\r第三段"),
    "第一段\n\n第二段\n第三段"
  );
  assert.equal(shared.canonicalNativePasteText("  保留行内空格  "), "  保留行内空格  ");
});

test("edit and redo turn provenance requires key ordinal hash and length to all match", () => {
  const shared = loadShared();
  const target = {
    turnKey: `user:4:${"a".repeat(16)}`,
    ordinal: 4,
    sourceTextSha256: "a".repeat(64),
    sourceTextLength: 123
  };
  assert.deepEqual({ ...shared.normalizeTurnTarget(target) }, target);
  assert.equal(shared.turnTargetMatches(target, { ...target }), true);
  for (const changed of [
    { turnKey: `user:5:${"a".repeat(16)}` },
    { ordinal: 5 },
    { sourceTextSha256: "b".repeat(64) },
    { sourceTextLength: 124 }
  ]) {
    assert.equal(shared.turnTargetMatches(target, { ...target, ...changed }), false);
  }
  assert.equal(shared.normalizeTurnTarget({ ...target, turnKey: "model:4:aaaaaaaaaaaaaaaa" }), null);
});

test("the live Pro Extended mode picker remains part of the DOM contract", () => {
  assert.match(contentSource, /button\[aria-label\*="mode picker" i\]/);
});

test("settings storage is unread until background initialization acknowledges", async () => {
  let initializationCallback;
  let storageReads = 0;
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        assert.equal(message.type, "NW_WAIT_INITIALIZED");
        initializationCallback = callback;
      }
    },
    storage: {
      local: {
        async get(defaults) {
          storageReads += 1;
          return { ...defaults, pairingToken: "paired", workerId: "worker-1" };
        },
        async set() {}
      }
    }
  };
  const shared = loadShared(chrome);
  const settingsPromise = shared.getSettings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storageReads, 0);
  initializationCallback({ ok: true });
  const settings = await settingsPromise;
  assert.equal(storageReads, 1);
  assert.equal(settings.workerId, "worker-1");
});

test("failed background initialization prevents settings and claims from proceeding", async () => {
  let storageReads = 0;
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) { callback({ ok: false, error: "malformed bootstrap" }); }
    },
    storage: {
      local: {
        async get() { storageReads += 1; return {}; },
        async set() {}
      }
    }
  };
  const shared = loadShared(chrome);
  await assert.rejects(shared.getSettings(), /malformed bootstrap/);
  assert.equal(storageReads, 0);
});

test("response snapshots prefer exact markdown body over Gemini accessibility chrome", () => {
  const shared = loadShared();
  const markdown = fakeNode({ innerText: "你好！", innerHTML: "<p>你好！</p>" });
  const messageContent = fakeNode({ innerText: "备用正文", innerHTML: "<p>备用正文</p>" });
  const legacy = fakeNode({ innerText: "旧正文", innerHTML: "<p>旧正文</p>" });
  const wrapper = fakeNode({
    innerText: "Gemini said\n\n你好！\n复制回答",
    innerHTML: "<h2>Gemini said</h2><message-content>...</message-content><button>复制回答</button>",
    queries: {
      "message-content .markdown": [markdown],
      "message-content": [messageContent],
      ".model-response-text": [legacy]
    }
  });
  const snapshot = shared.responseContentSnapshot(wrapper);
  assert.equal(snapshot.text, "你好！");
  assert.equal(snapshot.html, "<p>你好！</p>");
  assert.doesNotMatch(snapshot.html, /Gemini said|复制回答/);
});

test("unknown model wrapper is never saved as response body chrome", () => {
  const shared = loadShared();
  const wrapper = fakeNode({
    innerText: "Gemini said\n复制回答",
    innerHTML: "<h2>Gemini said</h2><button>复制回答</button>"
  });
  assert.deepEqual(
    { ...shared.responseContentSnapshot(wrapper) },
    { text: "", html: "" }
  );
});

test("literal Gemini said text inside an identified response body is preserved", () => {
  const shared = loadShared();
  const body = fakeNode({
    matches: [".model-response-text"],
    innerText: "Gemini said this phrase belongs in the novel.",
    innerHTML: "<p>Gemini said this phrase belongs in the novel.</p>"
  });
  const snapshot = shared.responseContentSnapshot(body);
  assert.equal(snapshot.text, "Gemini said this phrase belongs in the novel.");
});

test("redo evidence accepts an identical answer after the exact control disappears and returns", () => {
  const shared = loadShared();
  const baseline = {
    count: 1,
    text: "你好！",
    html: "<p>你好！</p>",
    documentInstanceId: "doc-a",
    responseElementId: "response-a"
  };
  const identical = { ...baseline };
  assert.equal(shared.redoGenerationObserved({ baseline, current: identical }), false);
  assert.equal(shared.redoGenerationObserved({ baseline, current: identical, stopCycleCompleted: true }), true);
  assert.equal(shared.redoGenerationObserved({ baseline, current: identical, domMutationSeen: true }), true);
  assert.equal(shared.redoGenerationObserved({ baseline, current: identical, actionCycleCompleted: true }), true);
  assert.equal(shared.redoFirstVisibleBodyEvidence({ baseline, current: identical, sameDocument: true }), "");
  assert.equal(shared.redoFirstVisibleBodyEvidence({
    baseline,
    current: { ...identical, responseElementId: "response-b" },
    sameDocument: true
  }), "");
  assert.equal(shared.redoFirstVisibleBodyEvidence({
    baseline,
    current: { ...identical, count: 0, text: "older answer", html: "<p>older answer</p>", responseElementId: "response-old" },
    sameDocument: true
  }), "");
  assert.equal(shared.redoFirstVisibleBodyEvidence({
    baseline,
    current: { ...identical, text: "新正文", html: "<p>新正文</p>" },
    sameDocument: true
  }), "same-root-text-change");
  assert.equal(shared.redoFirstVisibleBodyEvidence({
    baseline,
    current: { ...identical, html: "<div>你好！</div>" },
    sameDocument: true
  }), "same-root-html-change");
  assert.equal(shared.redoFirstVisibleBodyEvidence({
    baseline,
    current: { ...identical, text: "新正文", html: "<p>新正文</p>", responseElementId: "response-b" },
    sameDocument: true
  }), "replacement-root-text-change");
  assert.equal(shared.redoFirstVisibleBodyEvidence({
    baseline,
    current: { ...identical, text: "新正文", html: "<p>新正文</p>" },
    sameDocument: false
  }), "");
  assert.equal(shared.redoCompletionEvidence({ domMutationSeen: true }), "");
  assert.equal(shared.redoCompletionEvidence({ actionCycleCompleted: true }), "redo-action-cycle");
  assert.equal(shared.redoCompletionEvidence({ domMutationSeen: true, actionCycleCompleted: true }), "redo-action-cycle");
  assert.equal(shared.redoCompletionEvidence({ stopCycleCompleted: true }), "stop-cycle");
});

test("redo DOM replacement evidence is scoped to one document instance", () => {
  const shared = loadShared();
  const baseline = {
    count: 1,
    text: "same",
    html: "<p>same</p>",
    documentInstanceId: "doc-a",
    responseElementId: "response-a"
  };
  assert.equal(shared.responseRootReplaced(baseline, {
    ...baseline,
    responseElementId: "response-b"
  }), true);
  assert.equal(shared.responseRootReplaced(baseline, {
    ...baseline,
    documentInstanceId: "doc-b",
    responseElementId: "response-b"
  }), false);
  assert.equal(shared.responseSnapshotEquivalent(baseline, { ...baseline }), true);
  assert.equal(shared.responseSnapshotEquivalent(baseline, { ...baseline, html: "<p>changed</p>" }), false);
});

test("redo accessible names are exact and reject broad retry controls", () => {
  const shared = loadShared();
  for (const label of ["Redo", " redo ", "重做", "重新生成", "重新生成回答", "重新生成回复"]) {
    assert.equal(shared.isSafeRedoAccessibleName(label), true, label);
  }
  for (const label of ["Redo all", "Redo prompt", "Retry", "Edit", "重新发送提示词", "重做全部"]) {
    assert.equal(shared.isSafeRedoAccessibleName(label), false, label);
  }
});

test("redo menu accepts only the task's exact observed Gemini option", () => {
  const shared = loadShared();
  const cases = [
    ["try_again", "Try again"],
    ["longer", "Longer"],
    ["shorter", "Shorter"]
  ];
  for (const [option, label] of cases) {
    assert.equal(shared.normalizeRedoOption(option), option);
    assert.equal(shared.redoMenuChoiceAccessibleName(option), label);
    assert.equal(shared.isRedoMenuChoiceName(option, label), true, `${option}:${label}`);
    for (const otherLabel of cases.map(([, candidate]) => candidate).filter((candidate) => candidate !== label)) {
      assert.equal(shared.isRedoMenuChoiceName(option, otherLabel), false, `${option}:${otherLabel}`);
    }
  }
  assert.equal(shared.isDefaultRedoMenuChoiceName("Try again"), true);
  assert.equal(shared.isDefaultRedoMenuChoiceName("Retry"), false);
  assert.equal(shared.normalizeRedoOption("more_casual"), "");
  assert.match(contentSource, /visibleElements\('gem-menu\[role="menu"\]'\)/);
  assert.match(contentSource, /visibleElements\('gem-menu-item\[role="menuitem"\]', scope\)/);
  assert.match(contentSource, /Shared\.isRedoMenuChoiceName\(redoOption, accessibleName\(element\)\)/);
  assert.doesNotMatch(contentSource, /\.\.\.visibleElements\(selector\)/);
});

test("redo dispatch is scoped, fenced, prompt-free, and resumable without a second click", () => {
  const start = contentSource.indexOf("async function dispatchRedoTask(active)");
  const end = contentSource.indexOf("async function dispatchFilledTask(active)", start);
  assert.ok(start > 0 && end > start, "redo dispatch function must exist");
  const body = contentSource.slice(start, end);
  assert.match(contentSource, /const root = responseElements\(\)\.at\(-1\)/);
  assert.match(contentSource, /visibleElements\("button", root\)/);
  assert.match(body, /conversationUrl: requiredUrl/);
  assert.ok(body.indexOf("postFenceEvent(active") < body.indexOf("selection.button.click()"));
  assert.ok(body.indexOf('active.stage = "dispatching-fenced"') < body.indexOf("selection.button.click()"));
  assert.ok(body.indexOf("selection.button.click()") < body.indexOf('active.stage = "submitted-local"'));
  assert.doesNotMatch(body, /setComposerText|userText/);
  assert.match(contentSource, /active\.stage === "redo-ready"/);
  assert.match(contentSource, /\["leased", "prompt-filled", "redo-ready"\]/);
});

test("redo claim contract requires null prompt, canonical URL, and repetition metadata", () => {
  assert.match(contentSource, /task\.prompt !== null/);
  assert.match(contentSource, /String\(task\.conversationUrl\) !== conversationUrl/);
  assert.match(contentSource, /redoIndex: task\.redoIndex/);
  assert.match(contentSource, /repeatIndex: task\.repeatIndex/);
  assert.match(contentSource, /repeatCount: task\.repeatCount/);
  assert.match(contentSource, /redoOption: task\.redoOption/);
  assert.match(contentSource, /task\.redoSource !== "current_last_response"/);
  assert.match(contentSource, /REDO_COMPLETION_EVIDENCE_MISSING/);
});

test("pre-fence redo errors never report a different current conversation URL", () => {
  const start = contentSource.indexOf("function eventConversationUrl(active, postDispatch)");
  const end = contentSource.indexOf("async function persistRecoverySnapshot", start);
  assert.ok(start > 0 && end > start);
  const body = contentSource.slice(start, end);
  assert.match(body, /if \(postDispatch\) return expectedConversationUrl\(active\)/);
  assert.match(body, /Shared\.isRedoTask\(active\?\.task\)/);
  assert.match(body, /Shared\.provenanceMatches\(required, conversationUrlFrom\(\)\) \? required : undefined/);
});

test("redo action cycle starts only when the exact control is truly unavailable", () => {
  const start = contentSource.indexOf("async function waitForRedoSubmission(active, tracker)");
  const end = contentSource.indexOf("async function waitForCompletion(active)", start);
  assert.ok(start > 0 && end > start);
  const body = contentSource.slice(start, end);
  assert.match(body, /const actionUnavailable = currentControl\.count !== 1/);
  assert.doesNotMatch(body, /currentControl\.button !==/);
  assert.doesNotMatch(contentSource, /REDO_END_SIGNAL_NOT_OBSERVED/);
  assert.match(contentSource, /&& redoActionAvailable/);
  assert.match(contentSource, /&& active\.redoEvidence\?\.actionCycleCompleted/);
});

test("redo stop and action observations cannot be stitched across page reloads", () => {
  const shared = loadShared();
  assert.equal(shared.evidenceDocumentMatches("doc-a", "doc-a"), true);
  assert.equal(shared.evidenceDocumentMatches("doc-a", "doc-b"), false);
  assert.equal(shared.evidenceDocumentMatches("", "doc-b"), false);
  assert.match(contentSource, /stopSeenDocumentId: documentInstanceId/);
  assert.match(contentSource, /actionUnavailableDocumentId: documentInstanceId/);
  assert.match(
    contentSource,
    /Shared\.evidenceDocumentMatches\(active\.redoEvidence\?\.stopSeenDocumentId, documentInstanceId\)/
  );
});

test("new-document hydration cannot masquerade as redo generation", () => {
  const shared = loadShared();
  const incompleteOldDocumentEvidence = {
    domMutationSeen: true,
    domMutationDocumentId: "doc-old",
    actionUnavailableSeen: true,
    actionUnavailableDocumentId: "doc-old"
  };
  assert.equal(shared.redoCompletionEvidence(incompleteOldDocumentEvidence), "");
  assert.match(contentSource, /active\.submittedDocumentId = documentInstanceId/);
  assert.match(
    contentSource,
    /const sameSubmittedDocument = !redo \|\| Shared\.evidenceDocumentMatches\(active\.submittedDocumentId, documentInstanceId\)/
  );
  assert.match(contentSource, /if \(redo && sameSubmittedDocument\)/);
  assert.match(contentSource, /if \(redo && sameSubmittedDocument && snapshotChanged/);
  assert.match(contentSource, /&& active\.redoEvidence\?\.actionCycleCompleted/);
});
