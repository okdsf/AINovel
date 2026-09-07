"use strict";

(() => {
  const DEFAULTS = Object.freeze({
    enabled: true,
    prewarmEnabled: true,
    serverUrl: "http://127.0.0.1:3001",
    pairingToken: "",
    workerId: ""
  });
  const RESPONSE_BODY_SELECTORS = Object.freeze([
    "message-content .markdown",
    "message-content",
    ".model-response-text",
    ".response-container-content"
  ]);
  let initializationPromise = null;

  function randomId(prefix = "nw") {
    const value = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${value}`;
  }

  function normalizeServerUrl(value) {
    const parsed = new URL(String(value || DEFAULTS.serverUrl).trim());
    const allowedHosts = new Set(["127.0.0.1", "localhost"]);
    if (parsed.protocol !== "http:" || !allowedHosts.has(parsed.hostname)) {
      throw new Error("服务器地址必须是本机 http://127.0.0.1 或 http://localhost 地址。");
    }
    parsed.username = "";
    parsed.password = "";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.replace(/\/$/, "");
  }

  function isLostLeaseStatus(status) {
    return [404, 409, 410].includes(Number(status));
  }

  function normalizeGeminiConversationUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.origin !== "https://gemini.google.com") return "";
      const appMatch = parsed.pathname.match(/^\/app\/([A-Za-z0-9_-]+)$/);
      if (appMatch?.[1]) return `${parsed.origin}/app/${appMatch[1]}`;
      const gemMatch = parsed.pathname.match(/^\/gem\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
      if (gemMatch?.[1] && gemMatch?.[2]) {
        return `${parsed.origin}/gem/${gemMatch[1]}/${gemMatch[2]}`;
      }
      return "";
    } catch {
      return "";
    }
  }

  function provenanceMatches(expected, actual) {
    const normalizedExpected = normalizeGeminiConversationUrl(expected);
    const normalizedActual = normalizeGeminiConversationUrl(actual);
    return Boolean(normalizedExpected && normalizedActual && normalizedExpected === normalizedActual);
  }

  function isRedoTask(task) {
    return Boolean(task && (task.conversationAction === "redo" || task.runKind === "redo"));
  }

  function responseSnapshotChanged(baseline = {}, current = {}) {
    return Number(current.count || 0) !== Number(baseline.count || 0)
      || String(current.text || "") !== String(baseline.text || "")
      || String(current.html || "") !== String(baseline.html || "");
  }

  function responseRootReplaced(baseline = {}, current = {}) {
    return Boolean(
      baseline.documentInstanceId
      && baseline.documentInstanceId === current.documentInstanceId
      && baseline.responseElementId
      && current.responseElementId
      && baseline.responseElementId !== current.responseElementId
    );
  }

  function responseSnapshotEquivalent(baseline = {}, current = {}) {
    if (responseSnapshotChanged(baseline, current)) return false;
    return Boolean(
      baseline.documentInstanceId
      && baseline.documentInstanceId === current.documentInstanceId
      && baseline.responseElementId
      && baseline.responseElementId === current.responseElementId
    );
  }

  function evidenceDocumentMatches(observedDocumentId, currentDocumentId) {
    return Boolean(
      observedDocumentId
      && currentDocumentId
      && observedDocumentId === currentDocumentId
    );
  }

  function redoGenerationObserved({
    baseline = {},
    current = {},
    stopCycleCompleted = false,
    domMutationSeen = false,
    actionCycleCompleted = false
  } = {}) {
    return Boolean(
      stopCycleCompleted
      || domMutationSeen
      || actionCycleCompleted
      || responseSnapshotChanged(baseline, current)
      || responseRootReplaced(baseline, current)
    );
  }

  function redoFirstVisibleBodyEvidence({ baseline = {}, current = {}, sameDocument = false } = {}) {
    if (!sameDocument || !String(current.text || "")) return "";
    const sameRoot = Boolean(
      baseline.responseElementId
      && current.responseElementId
      && baseline.responseElementId === current.responseElementId
    );
    if (sameRoot && String(current.text || "") !== String(baseline.text || "")) {
      return "same-root-text-change";
    }
    if (sameRoot && String(current.html || "") !== String(baseline.html || "")) {
      return "same-root-html-change";
    }
    // When Gemini replaces the final response root, the temporarily exposed
    // previous answer has a smaller response count. Only a populated replacement
    // occupying the final slot, with different body text, is post-click evidence.
    if (responseRootReplaced(baseline, current)
        && Number(current.count || 0) >= Number(baseline.count || 0)
        && String(current.text || "") !== String(baseline.text || "")) {
      return "replacement-root-text-change";
    }
    return "";
  }

  function redoCompletionEvidence({ stopCycleCompleted = false, domMutationSeen = false, actionCycleCompleted = false } = {}) {
    if (actionCycleCompleted) return "redo-action-cycle";
    if (stopCycleCompleted) return "stop-cycle";
    return "";
  }

  function isSafeRedoAccessibleName(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .replace(/[\s\u00a0]+/g, " ")
      .trim()
      .toLocaleLowerCase();
    return new Set([
      "redo",
      "重做",
      "重新生成",
      "重新生成回答",
      "重新生成回复"
    ]).has(normalized);
  }

  const REDO_MENU_CHOICE_NAMES = Object.freeze({
    try_again: "Try again",
    longer: "Longer",
    shorter: "Shorter"
  });

  function normalizeRedoOption(value) {
    const normalized = String(value || "").trim().toLocaleLowerCase();
    return Object.hasOwn(REDO_MENU_CHOICE_NAMES, normalized) ? normalized : "";
  }

  function redoMenuChoiceAccessibleName(redoOption) {
    return REDO_MENU_CHOICE_NAMES[normalizeRedoOption(redoOption)] || "";
  }

  function isRedoMenuChoiceName(redoOption, value) {
    const expected = redoMenuChoiceAccessibleName(redoOption);
    const actual = String(value || "")
      .normalize("NFKC")
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
    return Boolean(expected && actual === expected);
  }

  function isDefaultRedoMenuChoiceName(value) {
    return isRedoMenuChoiceName("try_again", value);
  }

  function canonicalPrompt(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  }

  // This is the same canonical form used by the Windows native-paste helper.
  // Gemini/Quill and Windows UI Automation can expose a run of empty
  // paragraphs with different newline counts, while preserving every nonempty
  // line.  Hashing this form lets a snapshot, an edit target, and the native
  // readback prove that they refer to the same visible user turn.
  function canonicalNativePasteText(value) {
    const output = [];
    let previousBlank = false;
    for (const line of String(value ?? "").replace(/\r\n?/g, "\n").split("\n")) {
      const blank = !line.trim();
      if (!blank) output.push(line);
      else if (!previousBlank) output.push("");
      previousBlank = blank;
    }
    return output.join("\n");
  }

  // Gemini renders a submitted prompt as `.query-text-line` paragraphs. Text
  // paragraphs do not carry their own delimiter; a separate `<p><br></p>` is
  // emitted for every literal newline. Reading the wrapper's innerText also
  // includes the visually-hidden "You said" accessibility label, so turn the
  // explicit line records back into the submitted text instead.
  function geminiQueryLinesText(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return "";
    return lines.map((line) => {
      const text = String(line?.text || "").replace(/\r\n?/g, "\n");
      if (text.trim()) return text;
      return line?.hasBreak === true ? "\n" : "";
    }).join("");
  }

  // Gemini's pre-existing Edit textarea exposes each logical newline through
  // Windows/UI accessibility as an otherwise empty line. For example A\n\nB\nC
  // is read as [A, "", "", B, "", C]. Rebuild that source form only while
  // verifying the text that was already present; a value written by the runner
  // uses ordinary textarea newlines and must keep the normal canonical path.
  function geminiEditSourceText(value) {
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    if (lines.length <= 1) return lines[0] || "";
    return lines.map((line) => (line.trim() ? line : "\n")).join("");
  }

  function normalizeTurnTarget(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const turnKey = String(value.turnKey || "");
    const ordinal = Number(value.ordinal);
    const sourceTextSha256 = String(value.sourceTextSha256 || "").toLowerCase();
    const sourceTextLength = Number(value.sourceTextLength);
    if (!/^user:\d+:[a-f0-9]{16}$/.test(turnKey)
        || !Number.isInteger(ordinal) || ordinal < 0
        || !/^[a-f0-9]{64}$/.test(sourceTextSha256)
        || !Number.isInteger(sourceTextLength) || sourceTextLength < 0) {
      return null;
    }
    return { turnKey, ordinal, sourceTextSha256, sourceTextLength };
  }

  function turnTargetMatches(expected, observed) {
    const left = normalizeTurnTarget(expected);
    const right = normalizeTurnTarget(observed);
    return Boolean(left && right
      && left.turnKey === right.turnKey
      && left.ordinal === right.ordinal
      && left.sourceTextSha256 === right.sourceTextSha256
      && left.sourceTextLength === right.sourceTextLength);
  }

  function canBindNewConversation({ candidate, previous, stopVisible, observedUserPrompt, expectedPrompt } = {}) {
    const normalizedCandidate = normalizeGeminiConversationUrl(candidate);
    const normalizedPrevious = normalizeGeminiConversationUrl(previous);
    return Boolean(
      normalizedCandidate
      && normalizedCandidate !== normalizedPrevious
      && stopVisible === true
      && canonicalPrompt(observedUserPrompt)
      && canonicalPrompt(observedUserPrompt) === canonicalPrompt(expectedPrompt)
    );
  }

  function heartbeatDisposition(status) {
    if (isLostLeaseStatus(status)) return "read-only";
    const numeric = Number(status);
    if (numeric >= 200 && numeric < 300) return "active";
    return "transient";
  }

  function idleHeartbeatDue(lastAt, now = Date.now(), intervalMs = 30000) {
    const current = Number(now);
    const previous = Number(lastAt || 0);
    const interval = Math.max(1000, Number(intervalMs) || 30000);
    return Number.isFinite(current)
      && Number.isFinite(previous)
      && current >= previous
      && current - previous >= interval;
  }

  function renderedNodeText(node) {
    if (!node) return "";
    const value = typeof node.innerText === "string" ? node.innerText : node.textContent;
    return typeof value === "string" ? value.trim() : "";
  }

  function responseContentElement(root) {
    if (!root) return null;
    for (const selector of RESPONSE_BODY_SELECTORS) {
      const candidates = [];
      try {
        if (typeof root.matches === "function" && root.matches(selector)) candidates.push(root);
        if (typeof root.querySelectorAll === "function") candidates.push(...root.querySelectorAll(selector));
      } catch {
        continue;
      }
      const content = candidates.find((candidate) => renderedNodeText(candidate));
      if (content) return content;
    }
    try {
      if (typeof root.matches === "function"
          && root.matches(".model-response-text, .response-container-content")
          && renderedNodeText(root)) {
        return root;
      }
    } catch {
      // An unknown wrapper is deliberately not used as a response body.
    }
    return null;
  }

  function responseContentSnapshot(root) {
    const content = responseContentElement(root);
    return {
      text: renderedNodeText(content),
      html: content && typeof content.innerHTML === "string" ? content.innerHTML : ""
    };
  }

  function waitForInitialization() {
    if (!initializationPromise) {
      initializationPromise = runtimeMessage({ type: "NW_WAIT_INITIALIZED" }).then((response) => {
        if (!response?.ok) throw new Error(response?.error || "Gemini runner background initialization failed.");
        return true;
      });
    }
    return initializationPromise;
  }

  async function getSettings() {
    await waitForInitialization();
    const settings = await chrome.storage.local.get(DEFAULTS);
    // This extension lives in NovelWeb's separate Chrome profile. It is not a
    // general-purpose browser add-on: once paired to the local app, it should
    // be ready without a second hidden on/off switch.
    if (settings.pairingToken && !settings.enabled) {
      settings.enabled = true;
      await chrome.storage.local.set({ enabled: true });
    }
    if (!settings.workerId) {
      settings.workerId = randomId("nw-gemini");
      await chrome.storage.local.set({ workerId: settings.workerId });
    }
    settings.serverUrl = normalizeServerUrl(settings.serverUrl);
    return settings;
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  async function apiRequest(path, options = {}) {
    const result = await runtimeMessage({
      type: "NW_API_REQUEST",
      request: {
        path,
        method: options.method || "GET",
        body: options.body,
        timeoutMs: options.timeoutMs,
        serverUrl: options.serverUrl
      }
    });
    return result || { ok: false, status: 0, error: "Background worker returned no response." };
  }

  globalThis.NWGeminiShared = Object.freeze({
    DEFAULTS,
    apiRequest,
    canonicalNativePasteText,
    canBindNewConversation,
    evidenceDocumentMatches,
    geminiEditSourceText,
    geminiQueryLinesText,
    getSettings,
    heartbeatDisposition,
    idleHeartbeatDue,
    isRedoTask,
    isDefaultRedoMenuChoiceName,
    isRedoMenuChoiceName,
    isSafeRedoAccessibleName,
    isLostLeaseStatus,
    normalizeGeminiConversationUrl,
    normalizeRedoOption,
    normalizeServerUrl,
    normalizeTurnTarget,
    provenanceMatches,
    randomId,
    redoMenuChoiceAccessibleName,
    redoCompletionEvidence,
    redoFirstVisibleBodyEvidence,
    redoGenerationObserved,
    responseContentElement,
    responseContentSnapshot,
    responseRootReplaced,
    responseSnapshotChanged,
    responseSnapshotEquivalent,
    turnTargetMatches,
    runtimeMessage,
    waitForInitialization
  });
})();
