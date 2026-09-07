"use strict";

(() => {
  if (location.hostname !== "gemini.google.com" || globalThis.__novelWebGeminiRunnerLoaded) return;
  globalThis.__novelWebGeminiRunnerLoaded = true;

  const Shared = globalThis.NWGeminiShared;
  const OUTBOX_KEY = "nwGeminiRunnerOutbox";
  const ACTIVE_TASK_KEY = "nwGeminiRunnerActiveTask";
  const RUN_CONVERSATIONS_KEY = "nwGeminiRunnerRunConversations";
  const STATUS_KEY = "nwGeminiRunnerStatus";
  const RECOVERY_KEY = "nwGeminiRunnerRecoveries";
  const POLL_MS = 2500;
  const HEARTBEAT_MS = 15000;
  const IDLE_HEARTBEAT_MS = 30000;
  const RESPONSE_STABLE_MS = 4000;
  const GENERATION_TIMEOUT_MS = 45 * 60 * 1000;
  const SUBMISSION_TIMEOUT_MS = 20000;
  const STOP_SIGNAL_GRACE_MS = 60000;
  const REDO_MENU_APPEARANCE_MS = 2000;
  const MAX_RESPONSE_HTML_BYTES = 4 * 1024 * 1024;
  const PREWARM_TIMEOUT_MS = 3000;
  const NETWORK_WARM_WINDOW_MS = 15000;
  const MAX_TELEMETRY_RESOURCES = 40;

  let tickRunning = false;
  let timer = null;
  let lastStatusSignature = "";
  let lastIdleHeartbeatAt = 0;
  const documentInstanceId = Shared.randomId("gemini-document");
  const responseElementIds = new WeakMap();
  const editLiveBindings = new Map();
  let nextResponseElementId = 1;

  class RunnerBlockedError extends Error {
    constructor(code, message, retryable = false) {
      super(message);
      this.name = "RunnerBlockedError";
      this.code = code;
      this.retryable = retryable;
    }
  }

  class NavigationRequested extends Error {
    constructor() {
      super("Navigating to the task conversation.");
      this.name = "NavigationRequested";
    }
  }

  class OwnershipLostError extends Error {
    constructor() {
      super("This Gemini tab no longer owns the extension runner lock.");
      this.name = "OwnershipLostError";
    }
  }

  class CompletionSavePendingError extends Error {
    constructor(cause) {
      super(`Generated answer is still pending local delivery: ${cause?.message || cause}`);
      this.name = "CompletionSavePendingError";
      this.cause = cause;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function roundedMs(value) {
    return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
  }

  // Gemini does not expose a server-side "packet received" event to page
  // scripts.  Freeze the first browser-visible acknowledgement instead: the
  // stop control, a new response body, or the prior Redo action disappearing.
  // The UI must label this as an observed handoff, never as a Google timestamp.
  function recordSubmissionAcceptance(active, signals = {}) {
    const telemetry = active?.telemetry;
    if (!telemetry || telemetry.submissionAcceptance) return;
    if (telemetry.documentInstanceId !== documentInstanceId
        || telemetry.clickPerformanceNow == null) return;
    const observedSignals = Object.entries(signals)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    if (!observedSignals.length) return;
    telemetry.submissionAcceptance = {
      kind: "browser-visible-gemini-acceptance",
      observedAt: new Date().toISOString(),
      afterClickMs: roundedMs(performance.now() - telemetry.clickPerformanceNow),
      signals: observedSignals,
      documentInstanceId
    };
  }

  function sameOriginResourceEntriesSince(startTime = 0) {
    return performance.getEntriesByType("resource")
      .filter((entry) => {
        if (entry.startTime < startTime) return false;
        try { return new URL(entry.name).origin === location.origin; } catch { return false; }
      });
  }

  function summarizeNetworkResources(startTime) {
    return sameOriginResourceEntriesSince(startTime)
      .filter((entry) => ["fetch", "xmlhttprequest", "beacon", "other"].includes(entry.initiatorType))
      .slice(-MAX_TELEMETRY_RESOURCES)
      .map((entry) => {
        const url = new URL(entry.name);
        return {
          path: url.pathname.slice(0, 300),
          initiatorType: entry.initiatorType,
          nextHopProtocol: entry.nextHopProtocol || "",
          startMs: roundedMs(entry.startTime - startTime),
          dnsMs: roundedMs(entry.domainLookupEnd - entry.domainLookupStart),
          connectMs: roundedMs(entry.connectEnd - entry.connectStart),
          tlsMs: entry.secureConnectionStart > 0
            ? roundedMs(entry.connectEnd - entry.secureConnectionStart)
            : 0,
          requestToResponseMs: roundedMs(entry.responseStart - entry.requestStart),
          responseMs: roundedMs(entry.responseEnd - entry.responseStart),
          durationMs: roundedMs(entry.duration),
          transferSize: Number(entry.transferSize || 0),
          encodedBodySize: Number(entry.encodedBodySize || 0)
        };
      });
  }

  async function prewarmGeminiOrigin(enabled = true) {
    if (!enabled) {
      return {
        attempted: false,
        reason: "disabled-by-setting",
        documentInstanceId,
        completedAt: new Date().toISOString()
      };
    }
    const now = performance.now();
    const recentEntry = sameOriginResourceEntriesSince(Math.max(0, now - NETWORK_WARM_WINDOW_MS))
      .filter((entry) => entry.responseEnd > 0 && now - entry.responseEnd <= NETWORK_WARM_WINDOW_MS)
      .sort((left, right) => right.responseEnd - left.responseEnd)[0];
    if (recentEntry) {
      return {
        attempted: false,
        reason: "recent-same-origin-traffic",
        documentInstanceId,
        recentTrafficAgeMs: roundedMs(now - recentEntry.responseEnd),
        nextHopProtocol: recentEntry.nextHopProtocol || "",
        completedAt: new Date().toISOString()
      };
    }
    const target = `${location.origin}/app`;
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let status = 0;
    let ok = false;
    let error = "";
    try {
      const response = await fetch(target, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS)
      });
      status = response.status;
      ok = response.ok;
    } catch (cause) {
      error = String(cause?.message || cause).slice(0, 300);
    }
    const entry = sameOriginResourceEntriesSince(started)
      .filter((candidate) => candidate.name === target && candidate.initiatorType === "fetch")
      .at(-1);
    return {
      attempted: true,
      method: "HEAD",
      path: "/app",
      cache: "no-store",
      credentials: "same-origin",
      timeoutMs: PREWARM_TIMEOUT_MS,
      documentInstanceId,
      startedAt,
      completedAt: new Date().toISOString(),
      ok,
      status,
      error,
      durationMs: roundedMs(performance.now() - started),
      nextHopProtocol: entry?.nextHopProtocol || "",
      dnsMs: entry ? roundedMs(entry.domainLookupEnd - entry.domainLookupStart) : null,
      connectMs: entry ? roundedMs(entry.connectEnd - entry.connectStart) : null,
      tlsMs: entry?.secureConnectionStart > 0
        ? roundedMs(entry.connectEnd - entry.secureConnectionStart)
        : 0
    };
  }

  async function ensureTaskPrewarm(active, settings) {
    active.telemetry ||= {};
    const existing = active.telemetry.prewarm;
    const enabled = settings?.prewarmEnabled !== false;
    const completedAtMs = Date.parse(existing?.completedAt || "");
    const completedAgeMs = Date.now() - completedAtMs;
    const recent = Number.isFinite(completedAtMs)
      && completedAgeMs >= 0
      && completedAgeMs <= NETWORK_WARM_WINDOW_MS;
    const sameDocument = existing?.documentInstanceId === documentInstanceId;
    const matchesSetting = enabled
      ? (existing?.attempted === true || existing?.reason === "recent-same-origin-traffic")
      : existing?.reason === "disabled-by-setting";
    if (recent && sameDocument && matchesSetting) return existing;

    const result = await prewarmGeminiOrigin(enabled);
    if (existing && typeof existing.completedAt === "string") {
      const history = Array.isArray(active.telemetry.prewarmHistory)
        ? active.telemetry.prewarmHistory.slice(-3)
        : [];
      history.push(existing);
      active.telemetry.prewarmHistory = history;
    }
    active.telemetry.prewarm = result;
    await saveActive(active);
    return result;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) !== 0
      && rect.width > 0
      && rect.height > 0;
  }

  function visibleElements(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(isVisible);
  }

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[“”‘’'"`]/g, "")
      .replace(/[\s\u00a0]+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function boundedHtml(value) {
    const source = String(value || "");
    const bytes = new TextEncoder().encode(source);
    if (bytes.byteLength <= MAX_RESPONSE_HTML_BYTES) return { html: source, truncated: false };
    return {
      html: new TextDecoder().decode(bytes.slice(0, MAX_RESPONSE_HTML_BYTES)),
      truncated: true
    };
  }

  function pageUrl() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function conversationUrlFrom(value = location.href) {
    try {
      return Shared.normalizeGeminiConversationUrl(new URL(value, location.origin).href);
    } catch {
      return "";
    }
  }

  function expectedConversationUrl(active) {
    return Shared.normalizeGeminiConversationUrl(active?.submittedConversationUrl || "");
  }

  function safeGeminiConversationUrl(value) {
    const normalized = conversationUrlFrom(value);
    if (!normalized) {
      throw new RunnerBlockedError("INVALID_CONVERSATION_URL", "任务中的 Gemini 会话地址无效。", false);
    }
    return normalized;
  }

  function redoEventFields(task) {
    if (!Shared.isRedoTask(task)) return {};
    return {
      runKind: task.runKind || "redo",
      conversationAction: "redo",
      redoIndex: task.redoIndex,
      repeatIndex: task.repeatIndex,
      repeatCount: task.repeatCount,
      redoOption: task.redoOption,
      ...(task.workflowStep ? { workflowStep: task.workflowStep } : {}),
      ...(task.resultRole ? { resultRole: task.resultRole } : {})
    };
  }

  // An edit submission forks Gemini's visible conversation.  Its follow-up
  // Redos are anchored to the fork's current last answer, exactly like a
  // normal Redo, rather than to the historical user-turn DOM that Edit just
  // replaced.
  function redoUsesCurrentLastResponse(task) {
    return Shared.isRedoTask(task) && task?.redoSource === "current_last_response";
  }

  function composerElement() {
    const selectors = [
      '[role="textbox"][contenteditable="true"][aria-label*="Gemini"]',
      '[role="textbox"][contenteditable="true"][aria-label*="提示"]',
      'rich-textarea [role="textbox"][contenteditable="true"]',
      '.ql-editor[role="textbox"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="提示"]'
    ];
    for (const selector of selectors) {
      const match = visibleElements(selector).find((element) => element.getAttribute("aria-disabled") !== "true");
      if (match) return match;
    }
    return null;
  }

  function composerText(element = composerElement()) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value || "";
    if (element.classList?.contains("ql-blank")) return "";
    if (element.classList?.contains("ql-editor")) {
      const blocks = Array.from(element.children);
      if (blocks.length > 0 && blocks.every((child) => child.tagName === "P")) {
        const textWithBreaks = (node) => {
          if (node?.nodeType === 3) return node.nodeValue || "";
          if (node?.nodeType === 1 && node.tagName === "BR") return "\n";
          return Array.from(node?.childNodes || []).map(textWithBreaks).join("");
        };
        // Windows UI Automation may represent a multiline native value as one
        // Quill paragraph containing <br> nodes, whereas a browser paste uses
        // one <p> per line. Preserve both shapes before canonical comparison.
        return blocks.map((paragraph) => textWithBreaks(paragraph)).join("\n");
      }
    }
    return element.innerText || element.textContent || "";
  }

  function normalizedNewlines(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  function blankLineCanonical(value) {
    const output = [];
    let previousBlank = false;
    for (const line of normalizedNewlines(value).split("\n")) {
      const blank = !line.trim();
      if (!blank) output.push(line);
      else if (!previousBlank) output.push("");
      previousBlank = blank;
    }
    return output.join("\n");
  }

  async function sha256Text(value) {
    const bytes = new TextEncoder().encode(String(value ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function promptCanonical(value) {
    return Shared.canonicalNativePasteText(value);
  }

  function promptMatches(left, right) {
    return promptCanonical(left) === promptCanonical(right);
  }

  // Gemini can flatten paragraph boundaries when an existing user turn is
  // edited: the edited textarea contains the exact replacement, while the
  // rendered history may omit one or more line breaks.  The edit action is
  // already bound to its exact user-turn root before Update is clicked.  For
  // the post-submit hand-off to Redo, retain every non-newline character and
  // accept only that display-only newline normalization.
  function renderedPromptMatches(left, right) {
    const flatten = (value) => normalizedNewlines(value).replace(/\n/g, "");
    return flatten(left) === flatten(right);
  }

  function currentModelLabel() {
    const selectors = [
      'button[aria-label*="当前模式"]',
      'button[aria-label*="current mode" i]',
      'button[aria-label*="mode picker" i]',
      'button[aria-label*="模式选择器"]',
      'button[aria-label*="mode selector" i]',
      '[data-test-id*="model-switcher"] button',
      'button[data-test-id*="mode"]'
    ];
    for (const selector of selectors) {
      const element = visibleElements(selector)[0];
      if (!element) continue;
      const label = element.getAttribute("aria-label") || element.innerText || element.textContent || "";
      if (label.trim()) return label.trim();
    }
    return "";
  }

  function modelMatches(requiredModel, actualModel) {
    if (!requiredModel || (Array.isArray(requiredModel) && requiredModel.length === 0)) return true;
    const actual = normalizedText(actualModel);
    const requirements = Array.isArray(requiredModel)
      ? requiredModel
      : String(requiredModel).split("|").map((item) => item.trim()).filter(Boolean);
    return requirements.some((requirement) => actual.includes(normalizedText(requirement)));
  }

  function textOfVisibleAlerts() {
    const selectors = [
      '[role="alert"]',
      '[role="dialog"]',
      'mat-snack-bar-container',
      '.toast',
      '.snackbar',
      '[class*="error-message" i]',
      '[class*="quota" i]'
    ];
    const parts = [];
    for (const selector of selectors) {
      for (const element of visibleElements(selector).slice(-4)) {
        const text = (element.innerText || element.textContent || "").trim();
        if (text) parts.push(text.slice(0, 5000));
      }
    }
    return normalizedText(parts.join("\n"));
  }

  function detectPageBlocker() {
    const pageText = textOfVisibleAlerts();
    const captchaFrame = visibleElements('iframe[src*="recaptcha" i], iframe[src*="challenge" i], [class*="captcha" i]').length > 0;
    if (captchaFrame || /(verify you are human|unusual traffic|人机身份验证|验证您是真人|验证码|安全验证)/i.test(pageText)) {
      return { code: "CAPTCHA", message: "Gemini 正在要求人工完成安全验证；扩展不会尝试绕过。", retryable: false };
    }

    const signInControls = visibleElements('a, button').filter((element) => {
      const labels = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.innerText || element.textContent
      ].map(normalizedText).filter(Boolean);
      return labels.some((label) => /^(登录|登入|sign in|log in)$/.test(label) || label.includes("sign in to gemini"));
    });
    if (signInControls.length > 0) {
      return { code: "AUTH_REQUIRED", message: "Gemini 尚未登录；请由你本人在此页面登录。", retryable: false };
    }

    const quotaPatterns = [
      /you.?ve reached (your|the) (usage )?limit/i,
      /rate limit(ed)?/i,
      /quota (has been )?(reached|exceeded)/i,
      /usage limit.*reached/i,
      /已达到.*(上限|限额)/,
      /(使用次数|请求次数|用量).*(上限|用完|耗尽)/,
      /(配额|额度).*(用完|耗尽|超出|不足)/
    ];
    if (quotaPatterns.some((pattern) => pattern.test(pageText))) {
      return { code: "QUOTA", message: "Gemini 显示用量或请求上限；扩展不会绕过配额。", retryable: false };
    }

    return null;
  }

  function stopButtonVisible() {
    const selectors = [
      'button[aria-label*="停止生成"]',
      'button[aria-label*="停止回答"]',
      'button[aria-label*="停止回复"]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop generating" i]',
      'button[data-test-id*="stop"]'
    ];
    for (const selector of selectors) {
      if (visibleElements(selector).length > 0) return true;
    }
    return visibleElements("button").some((button) => {
      const text = normalizedText(`${button.getAttribute("aria-label") || ""} ${button.innerText || button.textContent || ""}`);
      return /停止(生成|回答|回复)|stop (response|generating)/i.test(text);
    });
  }

  function responseElements() {
    const selectorGroups = [
      "model-response",
      '[data-message-author-role="model"]',
      '[data-test-id*="model-response"]',
      ".model-response-text",
      ".response-container-content"
    ];
    for (const selector of selectorGroups) {
      const matches = visibleElements(selector).filter((element) => {
        const text = (element.innerText || element.textContent || "").trim();
        return text.length > 0;
      });
      if (matches.length > 0) return matches;
    }
    return [];
  }

  function responseElementId(element) {
    if (!element) return "";
    let id = responseElementIds.get(element);
    if (!id) {
      id = `${documentInstanceId}:response-${nextResponseElementId++}`;
      responseElementIds.set(element, id);
    }
    return id;
  }

  function lastResponseSnapshot() {
    const responses = responseElements();
    const element = responses.at(-1) || null;
    const content = Shared.responseContentSnapshot(element);
    return {
      count: responses.length,
      text: content.text,
      html: content.html,
      documentInstanceId,
      responseElementId: responseElementId(element),
      sourceConversationUrl: conversationUrlFrom()
    };
  }

  function responseBodyAfterSubmittedUser(active) {
    // Updating an older prompt can rewrite the user text before Gemini removes
    // or replaces the old following response. Without a pre-click identity map,
    // that old body is indistinguishable from a first token. Keep Edit timing
    // explicitly unobserved instead of manufacturing a low latency.
    if (active?.task?.conversationAction === "edit") return null;
    if (!active?.resultSourceTurn || typeof active?.task?.prompt !== "string") return null;
    const users = userTurnRoots();
    const userRoot = users.at(-1) || null;
    if (!userRoot || !promptMatches(userTurnText(userRoot), active.task.prompt)) return null;
    const responseRoot = responseElements().filter((root) => domOrder(userRoot, root) < 0).at(-1) || null;
    if (!responseRoot) return null;
    const content = Shared.responseContentSnapshot(responseRoot);
    if (!content.text.trim()) return null;
    return {
      kind: "response-after-submitted-user",
      responseElementId: responseElementId(responseRoot)
    };
  }

  function accessibleName(element) {
    const ariaLabel = element?.getAttribute?.("aria-label");
    if (ariaLabel?.trim()) return ariaLabel.trim();
    const labelledBy = element?.getAttribute?.("aria-labelledby");
    if (labelledBy?.trim()) {
      const value = labelledBy.trim().split(/\s+/).map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || "").trim() : "";
      }).filter(Boolean).join(" ");
      if (value) return value;
    }
    const title = element?.getAttribute?.("title");
    if (title?.trim()) return title.trim();
    return (element?.innerText || element?.textContent || "").trim();
  }

  function redoControlSelection() {
    const root = responseElements().at(-1) || null;
    if (!root) return { root: null, button: null, count: 0 };
    const matches = visibleElements("button", root).filter((button) => (
      !button.disabled
      && button.getAttribute("aria-disabled") !== "true"
      && Shared.isSafeRedoAccessibleName(accessibleName(button))
    ));
    return { root, button: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  function redoMenuScopes() {
    return visibleElements('gem-menu[role="menu"]');
  }

  function redoMenuChoiceSelection(scopes, redoOption) {
    // Verified against Gemini's live DOM: all four rewrite choices share
    // data-test-id="regenerate-option". The only reliable discriminator is
    // the exact accessible name inside the newly opened gem-menu.
    const matches = [...new Set(scopes.flatMap((scope) => (
      visibleElements('gem-menu-item[role="menuitem"]', scope)
    )))].filter((element) => (
      !element.disabled
      && element.getAttribute("aria-disabled") !== "true"
      && Shared.isRedoMenuChoiceName(redoOption, accessibleName(element))
    ));
    return { button: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  async function chooseRedoMenuAction({ menusBeforeClick, baseline, tracker, redoOption }) {
    const deadline = Date.now() + REDO_MENU_APPEARANCE_MS;
    const previousMenus = new Set(menusBeforeClick || []);
    let menuSeenAt = 0;
    while (Date.now() < deadline) {
      const newMenus = redoMenuScopes().filter((menu) => !previousMenus.has(menu));
      if (newMenus.length > 0) {
        menuSeenAt ||= Date.now();
        const choice = redoMenuChoiceSelection(newMenus, redoOption);
        if (choice.count === 1 && choice.button) {
          choice.button.click();
          return true;
        }
        if (choice.count > 1 || Date.now() - menuSeenAt >= 1000) {
          throw new RunnerBlockedError(
            choice.count > 1 ? "REDO_MENU_AMBIGUOUS" : "REDO_MENU_CHOICE_MISSING",
            choice.count > 1
              ? `Gemini 的 Redo 菜单里出现多个精确 ${Shared.redoMenuChoiceAccessibleName(redoOption)} 选项；任务未继续点击。`
              : `Gemini 已打开 Redo 菜单，但其中没有唯一的 ${Shared.redoMenuChoiceAccessibleName(redoOption)} 选项；任务未继续点击。`,
            false
          );
        }
      }

      const snapshot = lastResponseSnapshot();
      const actionUnavailable = redoControlSelection().count !== 1
        || Boolean(tracker?.actionUnavailableSeen());
      const generationStarted = stopButtonVisible()
        || actionUnavailable
        || Shared.responseSnapshotChanged(baseline, snapshot)
        || Shared.responseRootReplaced(baseline, snapshot)
        || Boolean(tracker?.poll());
      // First Redo starts generation directly. Do not wait for or scan for a
      // menu that does not exist.
      if (generationStarted) return false;
      await sleep(50);
    }
    return false;
  }

  function createRedoMutationTracker(root) {
    const body = Shared.responseContentElement(root);
    const parent = root?.parentElement || null;
    let seen = false;
    let actionUnavailableSeen = false;
    const observers = [];

    const observeRedoControl = () => {
      if (redoControlSelection().count !== 1) actionUnavailableSeen = true;
    };

    const bodyObserver = body ? new MutationObserver(() => { seen = true; }) : null;
    if (bodyObserver) {
      bodyObserver.observe(body, { childList: true, characterData: true, subtree: true });
      observers.push(bodyObserver);
    }

    const rootObserver = root ? new MutationObserver(() => {
      if (!root.isConnected || Shared.responseContentElement(root) !== body) seen = true;
      observeRedoControl();
    }) : null;
    if (rootObserver) {
      rootObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-disabled", "disabled", "class"]
      });
      observers.push(rootObserver);
    }

    const parentObserver = parent ? new MutationObserver(() => {
      const currentRoot = responseElements().at(-1) || null;
      if (!root.isConnected || currentRoot !== root) seen = true;
      observeRedoControl();
    }) : null;
    if (parentObserver) {
      parentObserver.observe(parent, { childList: true });
      observers.push(parentObserver);
    }

    return {
      poll() {
        if (bodyObserver?.takeRecords().length) seen = true;
        if (rootObserver?.takeRecords().length) {
          if (!root.isConnected || Shared.responseContentElement(root) !== body) seen = true;
          observeRedoControl();
        }
        if (parentObserver?.takeRecords().length) {
          const currentRoot = responseElements().at(-1) || null;
          if (!root.isConnected || currentRoot !== root) seen = true;
          observeRedoControl();
        }
        return seen;
      },
      actionUnavailableSeen() {
        observeRedoControl();
        return actionUnavailableSeen;
      },
      disconnect() {
        for (const observer of observers) observer.disconnect();
      }
    };
  }

  function lastUserPromptText() {
    const semanticRoots = userTurnRoots();
    if (semanticRoots.length > 0) {
      const semanticText = userTurnText(semanticRoots.at(-1));
      if (semanticText) return semanticText;
    }
    const selectorGroups = [
      "user-query .query-text",
      "user-query .query-content",
      ".user-query-container .query-text",
      '[data-test-id="user-query"] .query-text',
      '[data-message-author-role="user"] .message-content',
      '[data-message-author-role="user"]',
      "user-query"
    ];
    for (const selector of selectorGroups) {
      const matches = visibleElements(selector).filter((element) => {
        const text = (element.innerText || element.textContent || "").trim();
        return text.length > 0;
      });
      if (matches.length > 0) return (matches.at(-1).innerText || matches.at(-1).textContent || "").trim();
    }
    return "";
  }

  function userTurnRoots() {
    const groups = [
      "user-query",
      '[data-message-author-role="user"]',
      '[data-test-id="user-query"]',
      ".user-query-container"
    ];
    for (const selector of groups) {
      const matches = visibleElements(selector).filter((element, index, all) => (
        !all.some((candidate, candidateIndex) => candidateIndex !== index && candidate.contains(element))
      ));
      if (matches.length) return matches;
    }
    return [];
  }

  function userTurnContentElement(root) {
    if (!root) return null;
    const selectors = [
      ".query-text",
      ".query-content",
      '[data-test-id="user-query-text"]',
      ".message-content",
      "message-content"
    ];
    for (const selector of selectors) {
      const candidates = [...root.querySelectorAll(selector)].filter((element) => {
        const text = (element.innerText || element.textContent || "").trim();
        return text.length > 0;
      });
      if (candidates.length) return candidates[0];
    }
    // `user-query` itself is a semantic Gemini element.  Clone it and remove
    // controls before reading as a bounded legacy fallback; generic wrappers
    // are deliberately never treated as prompt provenance.
    if (root.tagName?.toLocaleLowerCase() === "user-query") {
      const clone = root.cloneNode(true);
      clone.querySelectorAll("button, [role=button], mat-icon, svg").forEach((node) => node.remove());
      return clone;
    }
    return null;
  }

  function userTurnText(root) {
    const content = userTurnContentElement(root);
    if (!content) return "";
    const queryLines = [...content.children].filter((child) => child.matches?.(".query-text-line"));
    if (queryLines.length > 0) {
      const exactLines = queryLines.map((line) => ({
        text: line.innerText || line.textContent || "",
        hasBreak: Boolean(line.querySelector("br"))
      }));
      return promptCanonical(Shared.geminiQueryLinesText(exactLines));
    }

    // Legacy Gemini wrappers may not expose explicit query lines. Remove only
    // the known accessibility-label node by DOM identity; never strip a textual
    // prefix, because a real prompt may itself begin with "You said".
    const clone = content.cloneNode(true);
    clone.querySelectorAll(".screen-reader-user-query-label").forEach((node) => node.remove());
    return promptCanonical((clone.innerText || clone.textContent || "").trim());
  }

  function editPromptControlSelection(root) {
    if (!root) return { button: null, count: 0 };
    const names = new Set(["edit", "edit prompt", "编辑", "编辑提示词", "编辑提示", "修改提示词"]);
    const matches = [...root.querySelectorAll("button,[role=button]")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.isConnected
      && style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0
      && !element.disabled
      && element.getAttribute("aria-disabled") !== "true"
      && names.has(normalizedText(accessibleName(element)))
      ;
    });
    return { button: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  function editComposerSelection() {
    const names = new Set(["edit prompt", "编辑提示词", "编辑提示", "修改提示词"]);
    const matches = visibleElements('.edit-mode textarea,.edit-mode [contenteditable="true"],.edit-mode [role="textbox"]').filter((element) => (
      names.has(normalizedText(element.getAttribute("aria-label") || ""))
    ));
    return { element: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  function editSubmitControlSelection() {
    const names = new Set([
      "update", "submit", "save", "send edited prompt",
      "更新", "提交", "保存", "发送修改"
    ]);
    const matches = visibleElements(".edit-mode button,.edit-mode [role=button]").filter((element) => (
      !element.disabled
      && element.getAttribute("aria-disabled") !== "true"
      && names.has(normalizedText(accessibleName(element)))
    ));
    return { button: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  function editCancelControlSelection(composer = editComposerSelection().element) {
    const editRoot = composer?.closest?.(".edit-mode") || null;
    if (!editRoot) return { button: null, count: 0 };
    const names = new Set(["cancel", "取消"]);
    const matches = visibleElements("button,[role=button]", editRoot).filter((element) => (
      !element.disabled
      && element.getAttribute("aria-disabled") !== "true"
      && names.has(normalizedText(accessibleName(element)))
    ));
    return { button: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  function editComposerUserRoot(composer) {
    if (!composer) return null;
    return composer.closest?.("user-query")
      || composer.closest?.('[data-message-author-role="user"]')
      || composer.closest?.('[data-test-id="user-query"]')
      || composer.closest?.(".user-query-container")
      || null;
  }

  function domOrder(left, right) {
    if (left === right) return 0;
    const relation = left.compareDocumentPosition(right);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function visibleThinkingText(root) {
    if (!root) return "";
    const selectors = [
      '[data-test-id*="thinking-summary" i]',
      '[data-test-id="thinking-content"]',
      "thinking-process .markdown",
      ".thoughts-container .markdown",
      '[class*="thinking-summary" i]',
      '[class*="thought-summary" i]'
    ];
    const responseBody = Shared.responseContentElement(root);
    for (const selector of selectors) {
      const match = visibleElements(selector, root).find((element) => (
        element !== responseBody && !element.contains(responseBody) && !responseBody?.contains(element)
      ));
      const text = (match?.innerText || match?.textContent || "").trim();
      if (text) return text;
    }
    return "";
  }

  async function conversationTurnsWithRoots() {
    const nodes = [
      ...userTurnRoots().map((root) => ({ role: "user", root })),
      ...responseElements().map((root) => ({ role: "model", root }))
    ].sort((left, right) => domOrder(left.root, right.root));
    const turns = [];
    let responseOrdinal = 0;
    for (let ordinal = 0; ordinal < nodes.length; ordinal += 1) {
      const item = nodes[ordinal];
      const content = item.role === "user"
        ? userTurnText(item.root)
        : Shared.responseContentSnapshot(item.root).text.trim();
      if (!content) continue;
      const text = promptCanonical(content);
      const textSha256 = await sha256Text(text);
      const turn = {
        turnKey: `${item.role}:${ordinal}:${textSha256.slice(0, 16)}`,
        ordinal,
        role: item.role,
        text,
        textSha256,
        textLength: text.length,
        editable: item.role === "user" && editPromptControlSelection(item.root).count === 1,
        root: item.root
      };
      if (item.role === "model") {
        turn.responseOrdinal = responseOrdinal++;
        const thinkingText = visibleThinkingText(item.root);
        if (thinkingText) {
          turn.visibleThinkingSummary = {
            kind: "visible_ui_summary",
            text: thinkingText,
            textSha256: await sha256Text(thinkingText),
            capturedAt: new Date().toISOString()
          };
        }
      }
      turns.push(turn);
    }
    // Ordinals describe the persisted sequence and therefore must be dense even
    // if Gemini exposed an empty semantic wrapper while hydrating the page.
    turns.forEach((turn, ordinal) => {
      turn.ordinal = ordinal;
      turn.turnKey = `${turn.role}:${ordinal}:${turn.textSha256.slice(0, 16)}`;
    });
    return turns;
  }

  function publicConversationTurn(turn) {
    const { root: _root, ...publicTurn } = turn;
    return publicTurn;
  }

  function observedUserTurn(turn) {
    if (!turn || turn.role !== "user") return null;
    return {
      turnKey: turn.turnKey,
      ordinal: turn.ordinal,
      sourceTextSha256: turn.textSha256,
      sourceTextLength: turn.textLength
    };
  }

  async function stableConversationTurns() {
    let previousSignature = "";
    let stableSince = 0;
    const deadline = Date.now() + 5000;
    let latest = [];
    while (Date.now() < deadline) {
      latest = await conversationTurnsWithRoots();
      const signature = latest.map((turn) => `${turn.turnKey}:${turn.textLength}`).join("|");
      if (signature && signature === previousSignature) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 250) return latest;
      } else {
        previousSignature = signature;
        stableSince = 0;
      }
      await sleep(125);
    }
    return latest;
  }

  function turnEvidence(expected, observed) {
    const normalizedExpected = Shared.normalizeTurnTarget(expected);
    const normalizedObserved = Shared.normalizeTurnTarget(observed);
    if (!Shared.turnTargetMatches(normalizedExpected, normalizedObserved)) {
      throw new RunnerBlockedError(
        "TURN_PROVENANCE_MISMATCH",
        "Gemini 页面中的用户轮次与任务快照不一致；扩展不会编辑或重做。",
        false
      );
    }
    return {
      expected: normalizedExpected,
      observed: normalizedObserved,
      documentInstanceId
    };
  }

  function editBindingKey(active) {
    return `${active?.task?.id || ""}:${active?.task?.leaseId || ""}`;
  }

  function dropEditLiveBinding(active) {
    editLiveBindings.delete(editBindingKey(active));
    if (active) delete active.editLiveBinding;
  }

  function editConversationContainerId(root) {
    return String(root?.closest?.(".conversation-container")?.id || "");
  }

  async function establishEditLiveBinding(active, root, composer, evidence) {
    const containerId = editConversationContainerId(root);
    if (!root?.isConnected
        || !composer?.isConnected
        || !containerId
        || editComposerUserRoot(composer) !== root) {
      throw new RunnerBlockedError("EDIT_LIVE_BINDING_INVALID", "编辑框不属于已验证的目标用户轮次；扩展不会继续。", false);
    }
    const reboundEvidence = turnEvidence(active.task.targetTurn, evidence?.observed);
    if (evidence?.documentInstanceId !== documentInstanceId
        || JSON.stringify(reboundEvidence.expected) !== JSON.stringify(evidence?.expected)
        || JSON.stringify(reboundEvidence.observed) !== JSON.stringify(evidence?.observed)) {
      throw new RunnerBlockedError("EDIT_LIVE_EVIDENCE_INVALID", "编辑目标的点击前证明发生变化；扩展不会继续。", false);
    }
    const token = Shared.randomId("edit-binding");
    const serializable = {
      token,
      documentInstanceId,
      containerId,
      targetTurnEvidence: JSON.parse(JSON.stringify(reboundEvidence))
    };
    // Exactly one task can own the runner. Clearing prevents stale DOM roots
    // from accumulating or being consulted by a later lease.
    editLiveBindings.clear();
    editLiveBindings.set(editBindingKey(active), {
      token,
      documentInstanceId,
      containerId,
      root,
      composer,
      evidenceSignature: JSON.stringify(serializable.targetTurnEvidence)
    });
    active.editLiveBinding = serializable;
    active.targetTurnEvidence = reboundEvidence;
    await saveActive(active);
    return serializable;
  }

  async function verifyEditLiveBinding(active, { requirePrompt = false } = {}) {
    const serializable = active?.editLiveBinding;
    const live = editLiveBindings.get(editBindingKey(active));
    if (!serializable || !live) return false;
    const evidence = turnEvidence(active.task.targetTurn, serializable.targetTurnEvidence?.observed);
    if (serializable.documentInstanceId !== documentInstanceId
        || serializable.targetTurnEvidence?.documentInstanceId !== documentInstanceId
        || live.documentInstanceId !== documentInstanceId
        || serializable.token !== live.token
        || live.evidenceSignature !== JSON.stringify(serializable.targetTurnEvidence)
        || JSON.stringify(evidence.expected) !== JSON.stringify(serializable.targetTurnEvidence?.expected)
        || JSON.stringify(evidence.observed) !== JSON.stringify(serializable.targetTurnEvidence?.observed)) {
      throw new RunnerBlockedError("EDIT_LIVE_EVIDENCE_CHANGED", "编辑绑定的文档、token、ordinal、hash、长度或 turnKey 已变化；扩展不会提交。", false);
    }

    // Gemini removes the prompt text and often its following model response
    // while Edit is open, so interleaved DOM ordinals are expected to change.
    // Bind the exact clicked root + stable conversation-container id instead.
    for (let stableRead = 0; stableRead < 2; stableRead += 1) {
      const selectedComposer = editComposerSelection();
      if (!live.root?.isConnected
          || !live.composer?.isConnected
          || selectedComposer.count !== 1
          || selectedComposer.element !== live.composer
          || editComposerUserRoot(live.composer) !== live.root
          || !serializable.containerId
          || serializable.containerId !== live.containerId
          || editConversationContainerId(live.root) !== live.containerId) {
        throw new RunnerBlockedError("EDIT_LIVE_BINDING_CHANGED", "编辑目标的根节点、编辑框或语义 ordinal 已变化；扩展不会提交。", false);
      }
      if (requirePrompt && !promptMatches(composerText(live.composer), active.task.prompt)) {
        throw new RunnerBlockedError("EDIT_LIVE_PROMPT_CHANGED", "绑定编辑框中的目标提示词已变化；扩展不会提交。", false);
      }
      if (stableRead === 0) await sleep(80);
    }
    active.targetTurnEvidence = evidence;
    return true;
  }

  function findControlByLabel(patterns, selectors = "button, a") {
    return visibleElements(selectors).find((element) => {
      if (element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled")) return false;
      const label = normalizedText(`${element.getAttribute("aria-label") || ""} ${element.innerText || element.textContent || ""}`);
      return patterns.some((pattern) => pattern.test(label));
    }) || null;
  }

  function newChatDiagnostic(selector, expectedName, matches) {
    return {
      url: pageUrl(), selector, expectedName, matchCount: matches.length,
      candidates: matches.map(element => {
        const ancestors = [];
        for (let node = element; node && ancestors.length < 5; node = node.parentElement) {
          ancestors.push({ tag: node.tagName, role: node.getAttribute("role"), testId: node.getAttribute("data-test-id") });
        }
        return { name: accessibleName(element), ancestors };
      })
    };
  }

  function newChatControl() {
    const selector = 'gem-nav-list-item[data-test-id="new-chat-button"] a';
    const matches = visibleElements(selector);
    if (matches.length !== 1 || accessibleName(matches[0]) !== "New chat"
        || matches[0].getAttribute("aria-disabled") === "true" || matches[0].hasAttribute("disabled")) {
      throw new RunnerBlockedError("NEW_CHAT_CONTROL_NOT_UNIQUE",
        `新对话导航控件无法唯一验证；未点击。${JSON.stringify(newChatDiagnostic(selector, "New chat", matches))}`, false);
    }
    return matches[0];
  }

  async function activateNewChatTab(active) {
    await requireRunnerOwnership(active);
    const expectedUrl = conversationUrlFrom() || (pageUrl() === "https://gemini.google.com/app" ? pageUrl() : "");
    if (!expectedUrl) {
      throw new RunnerBlockedError("NEW_CHAT_ACTIVATION_URL_INVALID", `无法验证新对话标签页地址：${pageUrl()}；未点击。`, false);
    }
    const request = async type => {
      try {
        return await Shared.runtimeMessage({ type, expectedUrl, newChat: true });
      } catch (error) {
        // Chrome may close the original message port while activating its tab.
        // Only a subsequent exact-URL confirmation may turn this into success.
        if (/(?:port|channel).*closed|closed.*(?:port|channel)/i.test(String(error?.message || error))) {
          return { ok: true, activationPending: true };
        }
        throw error;
      }
    };
    let result = await request("NW_ACTIVATE_RUNNER_TAB");
    const deadline = Date.now() + 10000;
    while (result?.ok && result.activationPending === true && Date.now() < deadline) {
      await sleep(100);
      result = await request("NW_CONFIRM_RUNNER_TAB_ACTIVATION");
    }
    if (!result?.ok || result.activationPending === true || result.conversationUrl !== expectedUrl) {
      throw new RunnerBlockedError("NEW_CHAT_TAB_ACTIVATION_FAILED",
        result?.error || `无法激活已持有任务的 Gemini 标签页：${expectedUrl}；未点击。`, false);
    }
    await requireRunnerOwnership(active);
    if ((conversationUrlFrom() || pageUrl()) !== expectedUrl) {
      throw new RunnerBlockedError("NEW_CHAT_ACTIVATION_URL_CHANGED", `激活后标签页地址变化：${pageUrl()}；未点击。`, false);
    }
  }

  async function waitForNewChatReady() {
    const composerSelector = '[data-test-id="textarea-wrapper"] rich-textarea [contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]';
    const modelSelector = 'button[data-test-id="bard-mode-menu-button"]';
    const deadline = Date.now() + 15000;
    let previous = null;
    let diagnostics;
    while (Date.now() < deadline) {
      const composers = visibleElements(composerSelector);
      const models = visibleElements(modelSelector);
      diagnostics = {
        composer: newChatDiagnostic(composerSelector, "Enter a prompt for Gemini", composers),
        model: newChatDiagnostic(modelSelector, "Open mode picker, currently <model>", models)
      };
      if (composers.length > 1 || models.length > 1) {
        throw new RunnerBlockedError("NEW_CHAT_SURFACE_AMBIGUOUS",
          `新对话输入框或模式控件不唯一；未发送。${JSON.stringify(diagnostics)}`, false);
      }
      const composer = composers[0];
      const model = models[0];
      const modelLabel = model ? accessibleName(model) : "";
      const ready = (location.pathname === "/app" || location.pathname === "/app/")
        && !conversationUrlFrom() && responseElements().length === 0
        && composer && composer.getAttribute("aria-disabled") !== "true" && !composerText(composer).trim()
        && model && !model.disabled && model.getAttribute("aria-disabled") !== "true"
        && /^Open mode picker, currently \S/.test(modelLabel);
      // URL/composer may arrive before the mode picker during Gem -> /app
      // navigation. Require the same complete surface on consecutive reads.
      if (ready && previous?.composer === composer && previous?.model === model
          && previous.modelLabel === modelLabel) return;
      previous = ready ? { composer, model, modelLabel } : null;
      await sleep(150);
    }
    throw new RunnerBlockedError("NEW_CHAT_NOT_READY",
      `新对话尚未出现稳定的空白输入框和可验证模式；未发送。${JSON.stringify(diagnostics)}`, false);
  }

  function sendControl() {
    const selectors = [
      'button[aria-label*="发送消息"]',
      'button[aria-label^="发送"]',
      'button[aria-label*="Send message" i]',
      'button[aria-label="Send" i]',
      'button[data-test-id*="send"]',
      'button[class*="send-button"]'
    ];
    for (const selector of selectors) {
      const button = visibleElements(selector).find((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true");
      if (button) return button;
    }
    return findControlByLabel([/^发送(消息)?$/, /^send( message)?$/i]);
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    if (lastError) throw lastError;
    return null;
  }

  async function setComposerText(element, prompt) {
    const started = performance.now();
    const expected = promptCanonical(prompt);
    const readNormalized = () => promptCanonical(composerText(element));
    const settleComposer = async () => {
      let last = "";
      let stableReads = 0;
      const deadline = performance.now() + 1000;
      while (performance.now() < deadline) {
        await sleep(120);
        const current = readNormalized();
        if (current === last) stableReads += 1;
        else stableReads = 0;
        last = current;
        if (stableReads >= 2) return current;
      }
      return readNormalized();
    };
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, "");
      else element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      if (setter) setter.call(element, prompt);
      else element.value = prompt;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    } else {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete", false);
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, prompt);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        element.textContent = prompt;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      }
    }
    await settleComposer();

    // Chromium's deprecated execCommand can report success while a rich
    // textarea accepts only the first paragraph of a multiline insertion.
    // Repair the DOM in one bounded operation, notify the editor through its
    // normal input event, and keep the exact full-text fence below. This avoids
    // slow simulated typing without ever clicking on a partial prompt.
    if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)
        && readNormalized() !== expected) {
      const fragment = document.createDocumentFragment();
      const lines = String(prompt).replace(/\r\n/g, "\n").split("\n");
      lines.forEach((line) => {
        const paragraph = document.createElement("p");
        if (line) paragraph.append(document.createTextNode(line));
        else paragraph.append(document.createElement("br"));
        fragment.append(paragraph);
      });
      element.replaceChildren(fragment);
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: null
      }));
      await settleComposer();
    }

    if (readNormalized() !== expected) {
      throw new RunnerBlockedError("COMPOSER_WRITE_FAILED", "无法可靠地把完整提示词写入 Gemini 输入框；未点击发送。", false);
    }
    return {
      durationMs: roundedMs(performance.now() - started),
      characters: String(prompt).length,
      utf8Bytes: new TextEncoder().encode(String(prompt)).byteLength
    };
  }

  async function setStatus(state, detail = "", extra = {}) {
    const status = {
      state,
      detail,
      pageUrl: pageUrl(),
      modelLabel: currentModelLabel(),
      updatedAt: new Date().toISOString(),
      ...extra
    };
    const signature = JSON.stringify({ state: status.state, detail: status.detail, taskId: status.taskId, modelLabel: status.modelLabel });
    if (signature === lastStatusSignature) return;
    lastStatusSignature = signature;
    await chrome.storage.local.set({ [STATUS_KEY]: status });
  }

  async function activeTask() {
    const stored = await chrome.storage.local.get({ [ACTIVE_TASK_KEY]: null });
    return stored[ACTIVE_TASK_KEY];
  }

  async function saveActive(active) {
    await chrome.storage.local.set({ [ACTIVE_TASK_KEY]: active });
  }

  async function clearActive() {
    await chrome.storage.local.remove(ACTIVE_TASK_KEY);
  }

  function scheduleNextQueueCheck() {
    // Completion can unlock the next workflow unit. Do not make a contiguous
    // Edit → Redo branch wait for the ordinary 2.5s idle polling interval.
    setTimeout(() => tick().catch(() => {}), 0);
  }

  async function runConversationMap() {
    const stored = await chrome.storage.local.get({ [RUN_CONVERSATIONS_KEY]: {} });
    return stored[RUN_CONVERSATIONS_KEY] && typeof stored[RUN_CONVERSATIONS_KEY] === "object"
      ? stored[RUN_CONVERSATIONS_KEY]
      : {};
  }

  async function rememberConversation(runId, url) {
    const normalized = conversationUrlFrom(url);
    if (!runId || !normalized) return;
    const map = await runConversationMap();
    map[runId] = normalized;
    await chrome.storage.local.set({ [RUN_CONVERSATIONS_KEY]: map });
  }

  async function forgetConversation(runId) {
    if (!runId) return;
    const map = await runConversationMap();
    delete map[runId];
    await chrome.storage.local.set({ [RUN_CONVERSATIONS_KEY]: map });
  }

  async function readOutbox() {
    const stored = await chrome.storage.local.get({ [OUTBOX_KEY]: [] });
    return Array.isArray(stored[OUTBOX_KEY]) ? stored[OUTBOX_KEY] : [];
  }

  function isPostDispatchStage(stage) {
    return ["dispatching-fenced", "submitted-local", "submitted", "completing"].includes(stage);
  }

  function safeCurrentGeminiUrl() {
    const conversation = conversationUrlFrom();
    if (conversation) return conversation;
    if (/^\/app\/?$/.test(location.pathname)) return `${location.origin}${location.pathname}`;
    return undefined;
  }

  function eventConversationUrl(active, postDispatch) {
    if (postDispatch) return expectedConversationUrl(active) || undefined;
    if (Shared.isRedoTask(active?.task)) {
      const required = Shared.normalizeGeminiConversationUrl(active.task.conversationUrl);
      return Shared.provenanceMatches(required, conversationUrlFrom()) ? required : undefined;
    }
    return safeCurrentGeminiUrl();
  }

  async function persistRecoverySnapshot(active, reason) {
    if (!isPostDispatchStage(active?.stage)) return null;
    const expected = expectedConversationUrl(active);
    if (!expected) return null;
    const usingStoredSnapshot = Boolean(active.completionSnapshot);
    if (!usingStoredSnapshot && !Shared.provenanceMatches(expected, conversationUrlFrom())) return null;
    const snapshot = active.completionSnapshot || lastResponseSnapshot();
    if (!Shared.provenanceMatches(expected, snapshot?.sourceConversationUrl)) return null;
    const baseline = active.baseline || { count: 0, text: "" };
    const isNew = snapshot?.text && (Shared.isRedoTask(active.task)
      ? (Boolean(Shared.redoCompletionEvidence(active.redoEvidence))
        || Shared.responseSnapshotChanged(baseline, snapshot)
        || Shared.responseRootReplaced(baseline, snapshot))
      : (Number(snapshot.count || 0) > Number(baseline.count || 0)
        || snapshot.text !== String(baseline.text || "")));
    if (!isNew) return null;

    const savedHtml = boundedHtml(snapshot.html);
    const recovery = {
      id: `${active.task.id}:${active.task.leaseId}`,
      taskId: active.task.id,
      runId: active.task.runId,
      leaseId: active.task.leaseId,
      responsePartial: snapshot.text,
      responseHtml: savedHtml.html,
      responseHtmlTruncated: savedHtml.truncated,
      conversationUrl: expected,
      modelLabel: active.submittedModelLabel || active.completionMeta?.modelLabel || "",
      capturedAt: new Date().toISOString(),
      reason: reason?.code || reason?.name || "POST_DISPATCH_RECOVERY",
      message: String(reason?.message || reason || "Post-dispatch recovery snapshot")
    };
    const stored = await chrome.storage.local.get({ [RECOVERY_KEY]: [] });
    const recoveries = Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY] : [];
    const next = recoveries.filter((item) => item.id !== recovery.id);
    next.push(recovery);
    await chrome.storage.local.set({ [RECOVERY_KEY]: next });
    return recovery;
  }

  async function runnerLock(action = "acquire") {
    return Shared.runtimeMessage({ type: "NW_RUNNER_LOCK", action });
  }

  async function requireRunnerOwnership(active) {
    const lock = await runnerLock("renew");
    if (!lock?.acquired || (active?.ownerKey && active.ownerKey !== lock.ownerKey)) {
      throw new OwnershipLostError();
    }
    return lock;
  }

  async function enqueueEvent(active, type, fields = {}) {
    const settings = await Shared.getSettings();
    const connection = active.connection || settings;
    active.eventIds ||= {};
    if (!active.eventIds[type]) {
      const leasePart = active.task.leaseId || active.task.attempt || active.claimedAt || "claim";
      active.eventIds[type] = `${connection.workerId}:${active.task.id}:${type}:${leasePart}`;
      await saveActive(active);
    }
    const eventId = active.eventIds[type];
    const queued = await Shared.runtimeMessage({
      type: "NW_ENQUEUE_OUTBOX",
      entry: {
        id: eventId,
        eventId,
        taskId: active.task.id,
        serverUrl: connection.serverUrl,
        body: {
          workerId: connection.workerId,
          leaseId: active.task.leaseId,
          eventId,
          type,
          ...fields
        },
        createdAt: new Date().toISOString(),
        attempts: 0
      }
    });
    if (!queued?.ok) {
      throw new Error(queued?.error || "无法把事件写入扩展本地待发箱。");
    }
    const result = await Shared.runtimeMessage({ type: "NW_FLUSH_OUTBOX" });
    return Boolean(result?.deliveredIds?.includes(eventId));
  }

  async function postFenceEvent(active, fields = {}) {
    const settings = await Shared.getSettings();
    const connection = active.connection || settings;
    active.eventIds ||= {};
    if (!active.eventIds.dispatching) {
      const leasePart = active.task.leaseId || active.task.attempt || active.claimedAt || Shared.randomId("claim");
      active.eventIds.dispatching = `${connection.workerId}:${active.task.id}:dispatching:${leasePart}`;
      await saveActive(active);
    }
    const result = await Shared.apiRequest(
      `/api/automation/worker/tasks/${encodeURIComponent(active.task.id)}/events`,
      {
        method: "POST",
        timeoutMs: 30000,
        body: {
          workerId: connection.workerId,
          leaseId: active.task.leaseId,
          eventId: active.eventIds.dispatching,
          type: "dispatching",
          ...fields
        },
        serverUrl: connection.serverUrl
      }
    );
    return result;
  }

  function validateNativePasteTelemetry(value, task) {
    const expectedUrl = safeGeminiConversationUrl(task.conversationUrl);
    const expectedMode = task.conversationAction === "edit" ? "replace-open-edit" : "fill-empty";
    const expectedCharacters = String(task.prompt).length;
    const expectedBytes = new TextEncoder().encode(String(task.prompt)).byteLength;
    const hash = (candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
    if (!value
        || value.schemaVersion !== 1
        || !["windows-native-clipboard", "windows-native-uia-value"].includes(value.transport)
        || value.pasteMode !== expectedMode
        || value.targetUrl !== expectedUrl
        || value.promptCharacters !== expectedCharacters
        || value.promptUtf8Bytes !== expectedBytes
        || value.clipboardRestored !== true
        || typeof value.idempotent !== "boolean"
        || typeof value.clipboardTouched !== "boolean"
        || (value.transport === "windows-native-clipboard"
          ? value.clipboardTouched === value.idempotent
          : value.clipboardTouched !== false)
        || !hash(value.promptSha256)
        || !hash(value.promptCanonicalSha256)
        || !hash(value.readbackSha256)
        || value.readbackCanonicalSha256 !== value.promptCanonicalSha256
        || (["fill-empty", "replace-open-edit"].includes(expectedMode)
          && (value.sourceVerified !== false || value.sourceCanonicalSha256 !== null))) {
      throw new RunnerBlockedError(
        "NATIVE_PASTE_TELEMETRY_INVALID",
        "本机输入没有返回完整的地址、传输和全文校验证据；扩展不会发送。",
        false
      );
    }
    return value;
  }

  async function requestNativePaste(active) {
    await requireRunnerOwnership(active);
    const settings = await Shared.getSettings();
    const connection = active.connection || settings;
    const expectedUrl = safeGeminiConversationUrl(active.task.conversationUrl);
    const isTransientActivationPortError = (error) => {
      const message = String(error?.message || error || "");
      return /(?:message\s+)?(?:port|channel).*closed|closed.*(?:message\s+)?(?:port|channel)/i.test(message);
    };
    let activated;
    try {
      activated = await Shared.runtimeMessage({
        type: "NW_ACTIVATE_RUNNER_TAB",
        expectedUrl
      });
    } catch (error) {
      if (!isTransientActivationPortError(error)) throw error;
      // The background may already have scheduled the idempotent tab switch
      // even if Chromium discarded this one response during the UI change.
      // Confirmation below is read-only and can safely reconstruct the job.
      activated = { ok: true, activationPending: true };
    }
    const activationDeadline = Date.now() + 10000;
    while (activated?.ok && activated.activationPending === true && Date.now() < activationDeadline) {
      await sleep(100);
      try {
        activated = await Shared.runtimeMessage({
          type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION",
          expectedUrl
        });
      } catch (error) {
        if (!isTransientActivationPortError(error)) throw error;
        activated = { ok: true, activationPending: true };
      }
    }
    if (activated?.activationPending === true) {
      activated = { ok: false, error: "激活 Gemini 标签页超时；扩展不会调用本机粘贴。" };
    }
    if (!activated?.ok || activated.conversationUrl !== expectedUrl) {
      throw new RunnerBlockedError(
        "NATIVE_PASTE_TAB_ACTIVATION_FAILED",
        activated?.error || "无法把本机粘贴绑定到当前 Gemini 对话标签页；扩展不会发送。",
        false
      );
    }
    await requireRunnerOwnership(active);
    if (!Shared.provenanceMatches(expectedUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("CONVERSATION_CHANGED_BEFORE_NATIVE_PASTE", "激活标签页后对话地址发生变化；未粘贴。", false);
    }
    const started = performance.now();
    const result = await Shared.apiRequest(
      `/api/automation/worker/tasks/${encodeURIComponent(active.task.id)}/native-paste`,
      {
        method: "POST",
        timeoutMs: 30000,
        body: {
          workerId: connection.workerId,
          leaseId: active.task.leaseId
        },
        serverUrl: connection.serverUrl
      }
    );
    if (!result.ok) {
      const code = typeof result.data?.code === "string" ? result.data.code : "NATIVE_PASTE_FAILED";
      const message = result.error || "本机粘贴失败；扩展没有发送。";
      if (result.status >= 400 && result.status < 500) {
        throw new RunnerBlockedError(code, message, false);
      }
      const error = new Error(message);
      error.code = code;
      error.retryable = true;
      throw error;
    }
    await requireRunnerOwnership(active);
    const telemetry = validateNativePasteTelemetry(result.data?.telemetry, active.task);
    if (!Shared.provenanceMatches(expectedUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("CONVERSATION_CHANGED_AFTER_NATIVE_PASTE", "本机粘贴后页面离开了任务对话；扩展不会发送。", false);
    }
    const exactDomTextRequired = active.task.conversationAction === "edit";
    let lastMatchedComposer = null;
    let lastMatchedText = "";
    let stableNativeReads = 0;
    const composer = await waitFor(() => {
      const candidate = active.task.conversationAction === "edit"
        ? editComposerSelection().element
        : composerElement();
      if (!candidate) return null;
      const currentText = composerText(candidate);
      if (!promptCanonical(currentText)
          || (exactDomTextRequired && !promptMatches(currentText, active.task.prompt))) {
        lastMatchedComposer = null;
        lastMatchedText = "";
        stableNativeReads = 0;
        return null;
      }
      if (candidate === lastMatchedComposer && currentText === lastMatchedText) stableNativeReads += 1;
      else {
        lastMatchedComposer = candidate;
        lastMatchedText = currentText;
        stableNativeReads = 1;
      }
      return stableNativeReads >= 2 ? candidate : null;
    }, 3000, 120);
    if (!composer) {
      throw new RunnerBlockedError(
        "NATIVE_PASTE_DOM_READBACK_MISMATCH",
        "Windows 本机输入成功，但 Gemini Quill DOM 在稳定等待后仍未通过全文复核；扩展不会发送。",
        false
      );
    }
    const domReadbackText = composerText(composer);
    const domReadbackSha256 = await sha256Text(domReadbackText);
    active.nativeComposerEvidence = {
      documentInstanceId,
      domReadbackText,
      domReadbackSha256,
      domReadbackCharacters: domReadbackText.length,
      exactPromptCanonicalMatch: promptMatches(domReadbackText, active.task.prompt)
    };
    return {
      ...telemetry,
      domReadbackSha256,
      domReadbackCharacters: domReadbackText.length,
      exactPromptCanonicalMatch: promptMatches(domReadbackText, active.task.prompt),
      extensionRoundTripMs: roundedMs(performance.now() - started)
    };
  }

  function composerStillMatchesPreparedInput(active, element) {
    if (!element) return false;
    if (active.task?.conversationAction !== "continue" || !active.nativeComposerEvidence) {
      return promptMatches(composerText(element), active.task?.prompt);
    }
    const evidence = active.nativeComposerEvidence;
    if (evidence.documentInstanceId !== documentInstanceId) return false;
    const currentText = composerText(element);
    if (!promptCanonical(currentText)
        || currentText.length !== evidence.domReadbackCharacters) return false;
    return currentText === evidence.domReadbackText;
  }

  function actionEvidenceFields(active) {
    const fields = {};
    if (active.task?.conversationAction === "edit" && active.targetTurnEvidence) {
      fields.targetTurnEvidence = active.targetTurnEvidence;
    }
    if (Shared.isRedoTask(active.task)
        && !redoUsesCurrentLastResponse(active.task)
        && active.sourceTurnEvidence) {
      fields.sourceTurnEvidence = active.sourceTurnEvidence;
    }
    return fields;
  }

  async function verifyTaskUserTurn(task, target, { requireLast = false } = {}) {
    const expected = Shared.normalizeTurnTarget(target);
    if (!expected) {
      throw new RunnerBlockedError("TURN_TARGET_INVALID", "任务缺少完整的用户轮次快照；扩展不会修改页面。", false);
    }
    const turns = await stableConversationTurns();
    const users = turns.filter((turn) => turn.role === "user");
    const selected = turns.find((turn) => turn.ordinal === expected.ordinal && turn.role === "user");
    if (!selected) {
      throw new RunnerBlockedError("TURN_TARGET_MISSING", "指定的 Gemini 用户轮次已不在当前对话 DOM 中；扩展不会操作。", false);
    }
    const observed = observedUserTurn(selected);
    const evidence = turnEvidence(expected, observed);
    if (requireLast && users.at(-1) !== selected) {
      throw new RunnerBlockedError("REDO_SOURCE_NOT_LAST", "Redo 对应的提示词不再是当前对话最后一个用户轮次；扩展不会点击。", false);
    }
    return { selected, observed, evidence, turns };
  }

  async function prepareNativeContinueTask(active, settings) {
    const requiredUrl = safeGeminiConversationUrl(active.task.conversationUrl);
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("CONVERSATION_CHANGED", "本机粘贴前页面不在任务指定对话；未粘贴。", false);
    }
    const composer = composerElement();
    if (!composer) throw new RunnerBlockedError("COMPOSER_MISSING", "找不到 Gemini 输入框；页面结构可能已变化。", false);
    const existing = promptCanonical(composerText(composer));
    const expected = promptCanonical(active.task.prompt);
    if (existing && existing !== expected) {
      throw new RunnerBlockedError("COMPOSER_NOT_EMPTY", "Gemini 输入框已有其他未发送内容；扩展不会覆盖。", false);
    }
    await ensureTaskPrewarm(active, settings);
    // The runner stays in a background Chrome window.  Driving the Windows
    // foreground through PowerShell made ordinary sends depend on an unrelated
    // address-bar/composer UIA lookup.  Write through Gemini's own composer
    // instead; setComposerText verifies the complete text before Send is used.
    return setComposerText(composer, active.task.prompt);
    active.submittedConversationUrl = requiredUrl;
  }

  async function prepareEditTask(active, settings) {
    const task = active.task;
    const requiredUrl = safeGeminiConversationUrl(task.conversationUrl);
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("CONVERSATION_CHANGED", "编辑前页面不在任务指定对话；未修改。", false);
    }
    let editComposer = editComposerSelection().element;
    let provenRoot = null;
    if (editComposer) {
      // While Gemini Edit is open, user-query no longer exposes the source text
      // used by snapshot provenance. Never infer an ordinal/hash from textarea
      // value or reuse an arbitrary same-text editor. Close it, restore the
      // normal turn DOM, then verify and reopen the exact snapshotted target.
      const cancel = editCancelControlSelection(editComposer);
      if (cancel.count !== 1 || !cancel.button) {
        throw new RunnerBlockedError(
          "EDIT_RECOVERY_TARGET_UNCONFIRMED",
          "已打开的编辑框无法安全恢复，且找不到唯一的取消按钮；扩展不会覆盖或提交。",
          false
        );
      }
      cancel.button.click();
      const closed = await waitFor(() => editComposerSelection().count === 0, 5000, 100);
      if (!closed) {
        throw new RunnerBlockedError("EDIT_RECOVERY_CANCEL_FAILED", "无法确认旧编辑框已取消；扩展不会继续。", false);
      }
      editComposer = null;
    }
    if (!editComposer) {
      const verified = await verifyTaskUserTurn(task, task.targetTurn);
      const selection = editPromptControlSelection(verified.selected.root);
      if (selection.count !== 1 || !selection.button) {
        throw new RunnerBlockedError("EDIT_CONTROL_AMBIGUOUS", "指定用户轮次没有唯一可用的“编辑提示词”按钮；未修改。", false);
      }
      active.targetTurnEvidence = verified.evidence;
      await saveActive(active);
      selection.button.scrollIntoView({ block: "center", inline: "nearest" });
      selection.button.click();
      editComposer = await waitFor(() => editComposerSelection().element, 10000, 100);
      if (!editComposer) {
        throw new RunnerBlockedError("EDIT_COMPOSER_MISSING", "点击编辑后没有出现唯一的 Gemini 编辑框；未提交。", false);
      }
      // The first synchronous observation after the edit textarea appears must
      // still be inside the exact DOM root whose Edit control we clicked.  An
      // identical prompt in another turn is not interchangeable provenance.
      if (editComposerUserRoot(editComposer) !== verified.selected.root) {
        throw new RunnerBlockedError(
          "EDIT_COMPOSER_TARGET_CHANGED",
          "编辑框出现时已不属于刚验证的目标用户轮次；扩展不会修改或提交。",
          false
        );
      }
      provenRoot = verified.selected.root;
      // Gemini's edit textbox reflows whitespace and omits collapsed content.
      // The target was already bound to this exact root before opening Edit;
      // keep that evidence instead of treating the editor's presentation text
      // as a different historical message.
      active.targetTurnEvidence = verified.evidence;
      await saveActive(active);
    }

    // Runtime DOM identities cannot safely survive a reload. Persist only a
    // random token/document/evidence tuple and retain the exact root + textarea
    // identity in this document's private map. Every later dispatch boundary
    // must prove both halves still agree.
    await establishEditLiveBinding(active, provenRoot, editComposer, active.targetTurnEvidence);
    if (!await verifyEditLiveBinding(active)) {
      throw new RunnerBlockedError("EDIT_LIVE_BINDING_MISSING", "无法建立编辑目标的实时绑定；扩展不会继续。", false);
    }

    // Opening edit mode is local UI work.  The first network action is this
    // explicit prewarm, followed by one native replacement and one fenced
    // update click.
    await ensureTaskPrewarm(active, settings);
    if (!await verifyEditLiveBinding(active)) {
      throw new RunnerBlockedError("EDIT_LIVE_BINDING_MISSING", "网络预热后编辑目标的实时绑定丢失；扩展不会粘贴或提交。", false);
    }
    const write = await setComposerText(editComposer, task.prompt);
    if (!await verifyEditLiveBinding(active, { requirePrompt: true })) {
      throw new RunnerBlockedError("EDIT_LIVE_BINDING_MISSING", "编辑内容写入后目标绑定丢失；扩展不会提交。", false);
    }
    const afterPaste = editComposerSelection().element;
    if (afterPaste !== editComposer || !promptMatches(composerText(afterPaste), task.prompt)) {
      throw new RunnerBlockedError("EDIT_READBACK_MISMATCH", "编辑框全文复核失败；扩展不会提交。", false);
    }
    active.telemetry.composer = { transport: "page-composer", ...write };
  }

  async function captureResultSourceTurn(active) {
    const expectedText = promptCanonical(active.task.prompt);
    const expectedSha256 = await sha256Text(expectedText);
    const result = await waitFor(async () => {
      const turns = await conversationTurnsWithRoots();
      const candidate = turns.filter((turn) => turn.role === "user").at(-1);
      const exact = candidate?.textSha256 === expectedSha256 && candidate.textLength === expectedText.length;
      const rendered = candidate && active.task.conversationAction === "edit"
        && renderedPromptMatches(candidate.text, expectedText);
      // Gemini can normalize the just-edited historical prompt (including a
      // trailing whitespace-only edit) before rendering it back into the DOM.
      // Editing creates a new conversation branch, so its surviving final
      // user turn is the only source that the following native Redo may use.
      const editedBranchSource = candidate && active.task.conversationAction === "edit";
      return (exact || rendered || editedBranchSource)
        ? observedUserTurn(candidate)
        : null;
    }, 15000, 200).catch(() => null);
    if (!result) {
      throw new RunnerBlockedError(
        "SUBMITTED_SOURCE_TURN_UNCONFIRMED",
        "提交后无法把新用户轮次绑定到本次提示词；扩展不会让后续 Redo 猜测来源。",
        false
      );
    }
    active.resultSourceTurn = result;
    await saveActive(active);
    return result;
  }

  async function flushOutbox() {
    const result = await Shared.runtimeMessage({ type: "NW_FLUSH_OUTBOX" });
    if (!result) return { ok: false, pending: -1, lastError: "后台服务无响应。" };
    return result;
  }

  async function postHeartbeat(active, fields = {}) {
    const settings = await Shared.getSettings();
    const connection = active?.connection || settings;
    if (active) await requireRunnerOwnership(active);
    return Shared.apiRequest("/api/automation/worker/heartbeat", {
      method: "POST",
      timeoutMs: 12000,
      body: {
        workerId: connection.workerId,
        taskId: active?.task?.id || null,
        leaseId: active?.task?.leaseId || null,
        pageUrl: pageUrl(),
        modelLabel: currentModelLabel(),
        ...fields
      },
      serverUrl: connection.serverUrl
    });
  }

  async function postIdleHeartbeatIfDue(phase) {
    const now = Date.now();
    if (!Shared.idleHeartbeatDue(lastIdleHeartbeatAt, now, IDLE_HEARTBEAT_MS)) return false;
    lastIdleHeartbeatAt = now;
    const result = await postHeartbeat(null, { phase }).catch(() => null);
    return Boolean(result?.ok);
  }

  async function emitBlocked(active, blocker) {
    const recovery = await persistRecoverySnapshot(active, blocker);
    const serverPartial = recovery ? boundedHtml(recovery.responsePartial).html : undefined;
    const postDispatch = isPostDispatchStage(active?.stage);
    const checkUrl = eventConversationUrl(active, postDispatch);
    const eventModelLabel = postDispatch ? (active.submittedModelLabel || "") : currentModelLabel();
    await setStatus("blocked", blocker.message, { taskId: active?.task?.id, code: blocker.code });
    await enqueueEvent(active, "blocked", {
      code: blocker.code || "BLOCKED",
      message: blocker.message || String(blocker),
      retryable: Boolean(blocker.retryable),
      pageUrl: pageUrl(),
      modelLabel: eventModelLabel,
      telemetry: active.telemetry || undefined,
      ...(checkUrl ? { conversationUrl: checkUrl } : {}),
      ...(recovery ? {
        responsePartial: serverPartial,
        responseHtml: recovery.responseHtml,
        clientAt: recovery.capturedAt,
        recoveryCapturedAt: recovery.capturedAt,
        recoveryReason: recovery.reason
      } : {})
    });
    await clearActive();
  }

  async function emitFailed(active, error) {
    const message = String(error?.message || error || "Unknown runner failure");
    const recovery = await persistRecoverySnapshot(active, error);
    const serverPartial = recovery ? boundedHtml(recovery.responsePartial).html : undefined;
    const postDispatch = isPostDispatchStage(active?.stage);
    const checkUrl = eventConversationUrl(active, postDispatch);
    const eventModelLabel = postDispatch ? (active.submittedModelLabel || "") : currentModelLabel();
    await setStatus("failed", message, { taskId: active?.task?.id });
    await enqueueEvent(active, "failed", {
      code: error?.code || "RUNNER_ERROR",
      message,
      retryable: error?.retryable !== false,
      pageUrl: pageUrl(),
      modelLabel: eventModelLabel,
      telemetry: active.telemetry || undefined,
      ...(checkUrl ? { conversationUrl: checkUrl } : {}),
      ...(recovery ? {
        responsePartial: serverPartial,
        responseHtml: recovery.responseHtml,
        clientAt: recovery.capturedAt,
        recoveryCapturedAt: recovery.capturedAt,
        recoveryReason: recovery.reason
      } : {})
    });
    await clearActive();
  }

  async function prepareConversation(active) {
    const task = active.task;
    if (Shared.isRedoTask(task)) {
      const requiredUrl = safeGeminiConversationUrl(task.conversationUrl);
      if (conversationUrlFrom() !== requiredUrl) {
        active.navigationTarget = requiredUrl;
        active.stage = "leased";
        await saveActive(active);
        location.assign(requiredUrl);
        throw new NavigationRequested();
      }
      const ready = await waitFor(() => {
        const root = responseElements().at(-1) || null;
        const body = Shared.responseContentSnapshot(root);
        return root && body.text ? root : null;
      }, 15000);
      if (!ready) {
        throw new RunnerBlockedError(
          "REDO_RESPONSE_MISSING",
          "目标会话已打开，但找不到可验证的最后一条 Gemini 回答；扩展不会点击任何控件。",
          false
        );
      }
      active.submittedConversationUrl = requiredUrl;
      return;
    }
    if (task.conversationAction === "new") {
      // Hidden background tabs may render an input before hydrating the mode
      // picker. Focus only the owned tab before requesting the new-chat route.
      await activateNewChatTab(active);
      await forgetConversation(task.runId);
      const beforeUrl = conversationUrlFrom();
      active.newConversationPreviousUrl = beforeUrl;
      // An already empty /app is a new conversation. Verify its full surface
      // without clicking navigation that may be absent in a collapsed sidebar.
      if (!beforeUrl && pageUrl() === "https://gemini.google.com/app") {
        await waitForNewChatReady();
        return;
      }
      const control = newChatControl();
      control.click();
      await waitForNewChatReady();
      return;
    }

    if (!["continue", "edit"].includes(task.conversationAction)) {
      throw new RunnerBlockedError("UNKNOWN_CONVERSATION_ACTION", `未知会话动作：${task.conversationAction || "(empty)"}`, false);
    }

    const map = await runConversationMap();
    const requiredUrl = task.conversationUrl
      ? safeGeminiConversationUrl(task.conversationUrl)
      : (map[task.runId] ? conversationUrlFrom(map[task.runId]) : "");
    if (!requiredUrl) {
      throw new RunnerBlockedError("CONVERSATION_UNCONFIRMED", "续写任务没有可确认的 Gemini 会话地址；为避免发到错误线程，扩展已停止。", false);
    }
    const currentUrl = conversationUrlFrom();
    if (currentUrl !== requiredUrl) {
      active.navigationTarget = requiredUrl;
      active.stage = "leased";
      await saveActive(active);
      location.assign(requiredUrl);
      throw new NavigationRequested();
    }
    const ready = await waitFor(() => composerElement(), 15000);
    if (!ready) {
      throw new RunnerBlockedError("COMPOSER_MISSING", "目标会话已打开，但找不到 Gemini 输入框。", false);
    }
  }

  async function ensureSubmittedConversation(active) {
    let expected = expectedConversationUrl(active);
    if (!expected && ["continue", "edit", "redo"].includes(active.task.conversationAction) && active.task.conversationUrl) {
      expected = safeGeminiConversationUrl(active.task.conversationUrl);
      active.submittedConversationUrl = expected;
      await saveActive(active);
    }
    if (!expected) {
      throw new RunnerBlockedError(
        "SUBMITTED_CONVERSATION_UNCONFIRMED",
        "发送后的 Gemini 会话来源没有持久化；扩展不会从当前或其他线程采集回答。",
        false
      );
    }
    const current = conversationUrlFrom();
    if (expected && current !== expected) {
      active.navigationTarget = expected;
      await saveActive(active);
      location.assign(expected);
      throw new NavigationRequested();
    }
    return expected;
  }

  async function waitForSubmission(active, baseline) {
    const deadline = Date.now() + SUBMISSION_TIMEOUT_MS;
    let sent = false;
    const edit = active.task?.conversationAction === "edit";
    while (Date.now() < deadline) {
      const now = lastResponseSnapshot();
      const composerEmpty = !edit && !composerText().trim();
      const editModeClosed = edit && editComposerSelection().count === 0;
      const responseChanged = now.count > baseline.count
        || (now.text && now.text !== baseline.text)
        || Shared.responseRootReplaced(baseline, now);
      const stopSeen = stopButtonVisible();
      if (stopSeen && !active.stopWasSeen) {
        active.stopWasSeen = true;
        await saveActive(active);
      }
      if (stopSeen || responseChanged || composerEmpty || editModeClosed) {
        if (active.telemetry?.clickPerformanceNow != null
            && active.telemetry.documentInstanceId === documentInstanceId
            && !active.telemetry.submissionEvidence) {
          active.telemetry.submissionEvidence = {
            afterClickMs: roundedMs(performance.now() - active.telemetry.clickPerformanceNow),
            stopSeen,
            responseChanged,
            composerEmpty,
            editModeClosed
          };
        }
        recordSubmissionAcceptance(active, {
          stopSeen,
          responseChanged,
          composerEmpty,
          editModeClosed
        });
        sent = true;
        break;
      }
      await sleep(200);
    }
    if (!sent) {
      throw new RunnerBlockedError("SEND_NOT_CONFIRMED", "已点击发送，但无法确认 Gemini 接收了提示词；为避免重复发送，任务转为人工检查。", false);
    }
  }

  async function recordRedoEvidence(active, changes = {}) {
    active.redoEvidence ||= {};
    let changed = false;
    for (const [key, value] of Object.entries(changes)) {
      if (value && active.redoEvidence[key] !== value) {
        active.redoEvidence[key] = value;
        changed = true;
      }
    }
    if (changed) {
      active.redoEvidence.observedAt ||= new Date().toISOString();
      await saveActive(active);
    }
  }

  async function waitForRedoSubmission(active, tracker) {
    const expected = expectedConversationUrl(active);
    const baseline = active.baseline || {};
    const deadline = Date.now() + SUBMISSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!Shared.provenanceMatches(expected, conversationUrlFrom())) {
        active.navigationTarget = expected;
        await saveActive(active);
        location.assign(expected);
        throw new NavigationRequested();
      }
      const stopSeen = stopButtonVisible();
      const snapshot = lastResponseSnapshot();
      const currentControl = redoControlSelection();
      // A replaced button that is already available is not proof that Redo was
      // ever unavailable. Only an actually absent/disabled/ambiguous exact
      // control starts the conservative action lifecycle fallback.
      const actionUnavailable = currentControl.count !== 1
        || Boolean(tracker?.actionUnavailableSeen());
      if (actionUnavailable) {
        await recordRedoEvidence(active, {
          actionUnavailableSeen: true,
          actionUnavailableDocumentId: documentInstanceId
        });
      }
      const changed = Shared.responseSnapshotChanged(baseline, snapshot)
        || Shared.responseRootReplaced(baseline, snapshot)
        || Boolean(tracker?.poll());
      if (stopSeen) {
        active.stopWasSeen = true;
        await recordRedoEvidence(active, {
          stopSeen: true,
          stopSeenDocumentId: documentInstanceId
        });
      }
      if (changed) {
        await recordRedoEvidence(active, {
          domMutationSeen: true,
          domMutationDocumentId: documentInstanceId
        });
      }
      if (stopSeen || changed || actionUnavailable) {
        recordSubmissionAcceptance(active, {
          stopSeen,
          responseChanged: changed,
          redoActionUnavailable: actionUnavailable
        });
        return;
      }
      await sleep(100);
    }
    throw new RunnerBlockedError(
      "REDO_NOT_CONFIRMED",
      "已点击 Redo，但 20 秒内没有观察到本轮停止按钮、正文变更或回答节点替换；为避免把旧回答当成新结果，任务转为人工核对。",
      false
    );
  }

  async function waitForCompletion(active) {
    const expectedUrl = await ensureSubmittedConversation(active);
    const baseline = active.baseline || { count: 0, text: "", html: "" };
    const redo = Shared.isRedoTask(active.task);
    const startedAt = Date.parse(active.submittedAt || active.claimedAt || new Date().toISOString());
    const sameSubmittedDocument = !redo || Shared.evidenceDocumentMatches(active.submittedDocumentId, documentInstanceId);
    const deadline = Math.max(Date.now() + 1000, startedAt + GENERATION_TIMEOUT_MS);
    let stopWasSeen = Boolean(active.stopWasSeen);
    if (redo && !Shared.evidenceDocumentMatches(active.redoEvidence?.stopSeenDocumentId, documentInstanceId)) {
      stopWasSeen = false;
    }
    let stableSnapshot = null;
    let stableSince = 0;
    let stopDisappearedAt = 0;
    let nextHeartbeatAt = 0;

    await setStatus(
      active.leaseLost ? "lease-lost-monitoring" : "generating",
      active.leaseLost
        ? "NovelWeb 租约已失效；扩展停止续租和新发送，仅继续只读监视并保存本轮回答。"
        : "Gemini 正在生成，完成后会立即落盘。",
      { taskId: active.task.id }
    );
    while (Date.now() < deadline) {
      if (!Shared.provenanceMatches(expectedUrl, conversationUrlFrom())) {
        active.navigationTarget = expectedUrl;
        await saveActive(active);
        location.assign(expectedUrl);
        throw new NavigationRequested();
      }
      const blocker = detectPageBlocker();
      if (blocker) throw new RunnerBlockedError(blocker.code, blocker.message, blocker.retryable);

      const stopNow = stopButtonVisible();
      if (stopNow && !stopWasSeen) {
        stopWasSeen = true;
        active.stopWasSeen = true;
        if (redo) {
          await recordRedoEvidence(active, {
            stopSeen: true,
            stopSeenDocumentId: documentInstanceId
          });
        } else {
          await saveActive(active);
        }
      }
      if (stopNow) stopDisappearedAt = 0;
      else if (stopWasSeen
          && !stopDisappearedAt
          && (!redo || Shared.evidenceDocumentMatches(active.redoEvidence?.stopSeenDocumentId, documentInstanceId))) {
        stopDisappearedAt = Date.now();
        if (redo && !active.redoEvidence?.stopCycleCompleted) {
          await recordRedoEvidence(active, {
            stopCycleCompleted: true,
            stopCycleCompletedAt: new Date().toISOString()
          });
        }
      }

      const snapshot = lastResponseSnapshot();
      let redoActionAvailable = false;
      if (redo && sameSubmittedDocument) {
        const currentControl = redoControlSelection();
        redoActionAvailable = currentControl.count === 1 && Boolean(currentControl.button);
        const unavailableInThisDocument = Shared.evidenceDocumentMatches(
          active.redoEvidence?.actionUnavailableDocumentId,
          documentInstanceId
        );
        const stopSeenInThisDocument = Shared.evidenceDocumentMatches(
          active.redoEvidence?.stopSeenDocumentId,
          documentInstanceId
        );
        if (!redoActionAvailable && (!active.redoEvidence?.actionUnavailableSeen || !unavailableInThisDocument)) {
          await recordRedoEvidence(active, {
            actionUnavailableSeen: true,
            actionUnavailableDocumentId: documentInstanceId
          });
        } else if (redoActionAvailable
            && (unavailableInThisDocument || stopSeenInThisDocument)
            && !active.redoEvidence?.actionCycleCompleted) {
          await recordRedoEvidence(active, {
            actionCycleCompleted: true,
            actionCycleCompletedAt: new Date().toISOString()
          });
        }
      }
      const snapshotChanged = Shared.responseSnapshotChanged(baseline, snapshot)
        || Shared.responseRootReplaced(baseline, snapshot);
      if (redo && sameSubmittedDocument && snapshotChanged && !active.redoEvidence?.domMutationSeen) {
        await recordRedoEvidence(active, {
          domMutationSeen: true,
          domMutationDocumentId: documentInstanceId
        });
      }
      const redoObserved = redo && Shared.redoGenerationObserved({
        baseline,
        current: snapshot,
        stopCycleCompleted: Boolean(active.redoEvidence?.stopCycleCompleted),
        domMutationSeen: Boolean(active.redoEvidence?.domMutationSeen),
        actionCycleCompleted: Boolean(active.redoEvidence?.actionCycleCompleted)
      });
      const isNewResponse = snapshot.text && (redo
        ? redoObserved
        : (snapshot.count > Number(baseline.count || 0)
          || snapshot.text !== String(baseline.text || "")
          || Shared.responseRootReplaced(baseline, snapshot)));
      // Completion may accept an identical Redo after a proven stop/action
      // cycle. First-visible timing is stricter: lifecycle mutation, stop-cycle,
      // or root replacement alone can expose an older answer and are never a
      // first-token proxy.
      const firstResponseBodyEvidence = redo
        ? Shared.redoFirstVisibleBodyEvidence({
          baseline,
          current: snapshot,
          sameDocument: sameSubmittedDocument
        })
        : responseBodyAfterSubmittedUser(active)?.kind || "";
      if (firstResponseBodyEvidence && active.telemetry && !active.telemetry.firstResponseVisibleAt) {
        active.telemetry.firstResponseVisibleAt = new Date().toISOString();
        if (active.telemetry.documentInstanceId === documentInstanceId
            && active.telemetry.clickPerformanceNow != null) {
          active.telemetry.clickToFirstResponseMs = roundedMs(
            performance.now() - active.telemetry.clickPerformanceNow
          );
        } else {
          active.telemetry.firstResponseObservationUpperBound = true;
        }
        active.telemetry.firstResponseTimingQuality = "verified-body-change";
        active.telemetry.firstResponseEvidence = {
          kind: firstResponseBodyEvidence,
          documentInstanceId
        };
        await saveActive(active);
      }
      const sameStableSnapshot = stableSnapshot
        && snapshot.text === stableSnapshot.text
        && snapshot.html === stableSnapshot.html
        && Number(snapshot.count || 0) === Number(stableSnapshot.count || 0)
        && snapshot.responseElementId === stableSnapshot.responseElementId;
      if (isNewResponse && sameStableSnapshot) {
        if (!stableSince) stableSince = Date.now();
      } else {
        stableSnapshot = snapshot;
        stableSince = isNewResponse ? Date.now() : 0;
      }

      // Exact live-DOM lifecycle: after generation starts, the last response's
      // Redo control disappears. Its return is Gemini's completion signal.
      // The new text may legitimately be identical to the previous version.
      if (redo
          && !stopNow
          && redoActionAvailable
          && active.redoEvidence?.actionCycleCompleted
          && snapshot.text) {
        return {
          ...snapshot,
          sourceConversationUrl: expectedUrl,
          redoGenerationEvidence: "redo-action-cycle"
        };
      }
      const generationEnded = !redo && stopWasSeen && !stopNow && stopDisappearedAt;
      // Gemini can finish a short Pro response before the page ever exposes a
      // Stop control to our polling loop. A stable, genuinely new response is
      // sufficient for normal send/edit work; waiting for a missed transient
      // control would strand an otherwise completed workflow forever.
      const stableNewResponseWithoutStop = !redo
        && !stopNow
        && isNewResponse
        && stableSince
        && Date.now() - stableSince >= RESPONSE_STABLE_MS;
      if ((generationEnded || stableNewResponseWithoutStop)
          && isNewResponse
          && stableSince
          && Date.now() - Math.max(stableSince, stopDisappearedAt || 0) >= RESPONSE_STABLE_MS) {
        return {
          ...snapshot,
          sourceConversationUrl: expectedUrl
        };
      }

      if (!redo
          && !stopWasSeen
          && isNewResponse
          && stableSince
          && Date.now() - stableSince >= RESPONSE_STABLE_MS
          && Date.now() - startedAt >= STOP_SIGNAL_GRACE_MS) {
        throw new RunnerBlockedError(
          "STOP_SIGNAL_NOT_OBSERVED",
          "回答文本已经出现，但 60 秒内从未观察到“停止生成”按钮；扩展不会猜测完成，请人工核对。",
          false
        );
      }
      if (Date.now() >= nextHeartbeatAt) {
        nextHeartbeatAt = Date.now() + HEARTBEAT_MS;
        try {
          // The extension-level tab lock remains live even after the server
          // lease is lost, so a second Gemini tab can never take over this send.
          await requireRunnerOwnership(active);
          if (!active.leaseLost) {
            const heartbeat = await postHeartbeat(active, { phase: redo ? "redo-generating" : "generating", stopWasSeen });
            if (Shared.heartbeatDisposition(heartbeat?.status) === "read-only") {
              active.leaseLost = true;
              active.leaseLostAt = new Date().toISOString();
              active.leaseLostStatus = heartbeat.status;
              await saveActive(active);
              await persistRecoverySnapshot(active, {
                code: "LEASE_LOST_READ_ONLY",
                message: `Server lease heartbeat returned HTTP ${heartbeat.status}; continuing read-only answer capture.`
              });
              await setStatus(
                "lease-lost-monitoring",
                `NovelWeb 租约已失效（HTTP ${heartbeat.status}）；不再续租或发送新提示，仅继续只读监视并保存本轮回答。`,
                { taskId: active.task.id }
              );
            }
          }
        } catch (error) {
          if (error instanceof RunnerBlockedError || error instanceof OwnershipLostError) throw error;
        }
      }
      await sleep(500);
    }

    throw new RunnerBlockedError(
      "GENERATION_TIMEOUT",
      stopWasSeen
        ? "Gemini 生成在 45 分钟内没有稳定结束；任务需要人工检查。"
        : (redo
          ? "45 分钟内没有足够的 Redo 新一轮生成证据；无法安全判定完成。"
          : "45 分钟内从未观察到 Gemini 的停止生成按钮；无法安全判定完成。"),
      false
    );
  }

  async function finishCompleted(active, snapshot) {
    const expected = expectedConversationUrl(active);
    if (!expected || !Shared.provenanceMatches(expected, snapshot?.sourceConversationUrl)) {
      throw new RunnerBlockedError(
        "COMPLETION_PROVENANCE_MISMATCH",
        "完成快照缺少发送线程来源，或来源与任务线程不一致；扩展拒绝把它保存为本任务回答。",
        false
      );
    }
    if (Shared.isRedoTask(active.task)
        && !["stop-cycle", "redo-action-cycle", "stable-body-change"].includes(snapshot?.redoGenerationEvidence)) {
      throw new RunnerBlockedError(
        "REDO_COMPLETION_EVIDENCE_MISSING",
        "Redo 完成快照没有本轮生成证据；扩展拒绝把旧回答保存为新的重复结果。",
        false
      );
    }
    if (!active.completionPayload) {
      const modelLabel = active.submittedModelLabel || active.completionMeta?.modelLabel || "";
      const completedAt = new Date().toISOString();
      if (active.telemetry) {
        active.telemetry.completedAt = completedAt;
        if (active.telemetry.documentInstanceId === documentInstanceId
            && active.telemetry.clickPerformanceNow != null) {
          active.telemetry.clickToCompletionMs = roundedMs(
            performance.now() - active.telemetry.clickPerformanceNow
          );
          active.telemetry.networkResources = summarizeNetworkResources(
            active.telemetry.clickPerformanceNow
          );
        }
      }
      const thinkingText = visibleThinkingText(responseElements().at(-1));
      const visibleThinkingSummary = thinkingText ? {
        kind: "visible_ui_summary",
        text: thinkingText,
        textSha256: await sha256Text(thinkingText),
        capturedAt: completedAt
      } : null;
      const clientSubmittedAt = active.telemetry?.clickedAt || active.submittedAt || completedAt;
      // Only the new body-evidence path may populate first-visible timing. Old
      // persisted telemetry from a previous extension version is intentionally
      // ignored because it may have treated a Redo DOM lifecycle as first token.
      const hasFirstResponseEvidence = Boolean(active.telemetry?.firstResponseEvidence?.kind);
      const firstResponseVisibleAt = hasFirstResponseEvidence
        ? (active.telemetry?.firstResponseVisibleAt || null)
        : null;
      const measuredClickToFirst = active.telemetry?.clickToFirstResponseMs;
      const clickToFirstResponseMs = firstResponseVisibleAt
        ? (Number.isFinite(measuredClickToFirst)
          ? measuredClickToFirst
          : Math.max(0, Date.parse(firstResponseVisibleAt) - Date.parse(clientSubmittedAt)))
        : null;
      const firstResponseTimingQuality = firstResponseVisibleAt
        ? "verified-body-change"
        : "unobserved";
      if (active.telemetry) {
        active.telemetry.firstResponseTimingQuality = firstResponseTimingQuality;
        if (!firstResponseVisibleAt) {
          delete active.telemetry.firstResponseVisibleAt;
          delete active.telemetry.clickToFirstResponseMs;
          delete active.telemetry.firstResponseObservationUpperBound;
        }
      }
      const savedHtml = boundedHtml(snapshot.html);
      active.completionMeta = { modelLabel, conversationUrl: expected };
      active.completionSnapshot = snapshot;
      // Freeze the complete event body before the first storage/network await.
      // A reload, owner handoff, or a different currently visible conversation
      // may only replay these bytes; it must never re-read thinking/timing/DOM.
      active.completionPayload = JSON.parse(JSON.stringify({
        response: snapshot.text,
        responseHtml: savedHtml.html,
        responseHtmlTruncated: savedHtml.truncated,
        conversationUrl: expected,
        modelLabel,
        visibleThinkingSummary,
        timing: {
          clientSubmittedAt,
          firstResponseVisibleAt,
          completedAt,
          clickToFirstResponseMs,
          firstResponseTimingQuality
        },
        ...(active.resultSourceTurn ? { resultSourceTurn: active.resultSourceTurn } : {}),
        ...actionEvidenceFields(active),
        ...(active.telemetry ? { telemetry: active.telemetry } : {}),
        ...redoEventFields(active.task)
      }));
      active.stage = "completing";
      await saveActive(active);
    }
    if (!Shared.provenanceMatches(expected, active.completionPayload.conversationUrl)
        || active.completionPayload.response !== snapshot.text) {
      throw new RunnerBlockedError(
        "COMPLETION_PAYLOAD_MISMATCH",
        "本地冻结的完成事件与回答快照不一致；扩展拒绝从当前页面重建。",
        false
      );
    }
    await rememberConversation(active.task.runId, active.completionPayload.conversationUrl);
    await setStatus("saving", "回答已生成，正在写入 NovelWeb。", { taskId: active.task.id });

    let delivered;
    try {
      delivered = await enqueueEvent(active, "completed", active.completionPayload);
    } catch (error) {
      await persistRecoverySnapshot(active, error);
      throw new CompletionSavePendingError(error);
    }
    try {
      if (active.task?.conversationAction === "edit") dropEditLiveBinding(active);
      await clearActive();
    } catch (error) {
      await setStatus("saving-offline", `回答已入本地待发箱，但清理任务标记失败：${error?.message || error}`, { lastTaskId: active.task.id }).catch(() => {});
      return;
    }
    if (delivered) {
      await setStatus("idle", "本轮回答已保存。", { lastTaskId: active.task.id }).catch(() => {});
      scheduleNextQueueCheck();
    } else {
      await setStatus("saving-offline", "回答已保存在扩展待发箱；NovelWeb 恢复连接后会优先重传。", { lastTaskId: active.task.id }).catch(() => {});
    }
  }

  async function dispatchRedoTask(active) {
    const task = active.task;
    const requiredUrl = safeGeminiConversationUrl(task.conversationUrl);
    const blocker = detectPageBlocker();
    if (blocker) throw new RunnerBlockedError(blocker.code, blocker.message, blocker.retryable);
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("REDO_CONVERSATION_CHANGED", "Redo 前页面已离开任务指定的会话；扩展没有点击。", false);
    }
    if (stopButtonVisible()) {
      throw new RunnerBlockedError("REDO_GENERATION_ALREADY_ACTIVE", "目标会话仍有一轮回答正在生成；扩展不会同时点击 Redo。", true);
    }

    const modelLabel = currentModelLabel();
    if (task.requiredModel && !modelLabel) {
      throw new RunnerBlockedError("MODEL_UNKNOWN", "无法读取 Gemini 当前模式，不能验证 Redo 任务要求；未点击。", false);
    }
    if (!modelMatches(task.requiredModel, modelLabel)) {
      throw new RunnerBlockedError("MODEL_MISMATCH", `当前模式“${modelLabel}”不符合 Redo 任务要求；扩展不会自动切换模式。`, false);
    }
    const sourceTurn = redoUsesCurrentLastResponse(task)
      ? null
      : task.sourceTurn || task.targetTurn || null;
    if (!sourceTurn && redoUsesCurrentLastResponse(task) && active.sourceTurnEvidence) {
      delete active.sourceTurnEvidence;
      await saveActive(active);
    }
    if (sourceTurn) {
      active.sourceTurnEvidence = (await verifyTaskUserTurn(task, sourceTurn, { requireLast: true })).evidence;
      await saveActive(active);
    }

    const baseline = active.baseline || {};
    const beforeFenceSnapshot = lastResponseSnapshot();
    if (!baseline.text || !Shared.responseSnapshotEquivalent(baseline, beforeFenceSnapshot)) {
      throw new RunnerBlockedError(
        "REDO_BASELINE_CHANGED",
        "最后一条回答在 Redo fence 前发生变化；为避免重做错误回答，扩展没有点击。",
        false
      );
    }
    const selection = redoControlSelection();
    if (!selection.root) {
      throw new RunnerBlockedError("REDO_RESPONSE_MISSING", "找不到最后一条模型回答；扩展不会点击页面上的其他控件。", false);
    }
    if (selection.count !== 1 || !selection.button) {
      throw new RunnerBlockedError(
        selection.count > 1 ? "REDO_CONTROL_AMBIGUOUS" : "REDO_CONTROL_MISSING",
        selection.count > 1
          ? "最后一条回答内出现多个精确 Redo 控件；扩展拒绝猜测。"
          : "最后一条回答内找不到可验证的 Redo / 重做按钮。",
        false
      );
    }
    if (responseElementId(selection.root) !== baseline.responseElementId) {
      throw new RunnerBlockedError("REDO_TARGET_CHANGED", "Redo 控件不再属于已记录的最后一条回答；扩展没有点击。", false);
    }

    await requireRunnerOwnership(active);
    const beforeFenceSettings = await Shared.getSettings();
    if (!beforeFenceSettings.enabled) {
      const stopped = new Error("用户在 Redo dispatching 前关闭了执行器；未点击。");
      stopped.code = "DISABLED_BEFORE_DISPATCH";
      stopped.retryable = true;
      throw stopped;
    }
    await ensureTaskPrewarm(active, beforeFenceSettings);
    await requireRunnerOwnership(active);
    const afterPrewarmSettings = await Shared.getSettings();
    if (!afterPrewarmSettings.enabled) {
      const stopped = new Error("用户在 Redo 网络预热后、dispatching 前关闭了执行器；未点击。");
      stopped.code = "DISABLED_AFTER_PREWARM";
      stopped.retryable = true;
      throw stopped;
    }
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("REDO_CONVERSATION_CHANGED_AFTER_PREWARM", "网络预热后页面离开目标会话；扩展没有点击。", false);
    }
    if (sourceTurn) {
      active.sourceTurnEvidence = (await verifyTaskUserTurn(task, sourceTurn, { requireLast: true })).evidence;
      await saveActive(active);
    }
    const afterPrewarmModel = currentModelLabel();
    if (!modelMatches(task.requiredModel, afterPrewarmModel)
        || normalizedText(afterPrewarmModel) !== normalizedText(modelLabel)) {
      throw new RunnerBlockedError("REDO_MODEL_CHANGED_AFTER_PREWARM", "网络预热后 Gemini 模式发生变化；扩展没有点击。", false);
    }
    if (stopButtonVisible()) {
      throw new RunnerBlockedError("REDO_GENERATION_STARTED_AFTER_PREWARM", "网络预热后页面出现了其他生成任务；扩展没有点击。", false);
    }
    const afterPrewarmSnapshot = lastResponseSnapshot();
    if (!Shared.responseSnapshotEquivalent(baseline, afterPrewarmSnapshot)) {
      throw new RunnerBlockedError("REDO_TARGET_CHANGED_AFTER_PREWARM", "网络预热后最后一条回答发生变化；扩展没有点击。", false);
    }
    const afterPrewarmSelection = redoControlSelection();
    if (afterPrewarmSelection.count !== 1
        || afterPrewarmSelection.button !== selection.button
        || afterPrewarmSelection.root !== selection.root
        || !selection.button.isConnected
        || !isVisible(selection.button)
        || selection.button.disabled
        || selection.button.getAttribute("aria-disabled") === "true") {
      throw new RunnerBlockedError("REDO_CONTROL_CHANGED_AFTER_PREWARM", "网络预热后目标 Redo 控件发生变化；扩展没有点击。", false);
    }
    active.submittedConversationUrl = requiredUrl;
    active.submittedModelLabel = modelLabel;
    await saveActive(active);

    // Write-ahead fence. The exact conversation URL is part of the server-side
    // redo contract and must be acknowledged before this single click.
    const fenceStarted = performance.now();
    const fence = await postFenceEvent(active, {
      pageUrl: pageUrl(),
      conversationUrl: requiredUrl,
      modelLabel,
      telemetry: active.telemetry || undefined,
      ...actionEvidenceFields(active),
      ...redoEventFields(task)
    });
    if (!fence.ok) {
      if ([404, 409, 410].includes(fence.status)) {
        await clearActive();
        await setStatus(
          "stopped",
          `NovelWeb 已撤销 Redo 任务或拒绝当前 lease（HTTP ${fence.status}）；dispatching 未获确认，因此没有点击。`,
          { taskId: task.id }
        );
        return;
      }
      const detail = fence.status === 401 || fence.status === 403
        ? "配对令牌被拒绝；Redo 未点击。"
        : `NovelWeb 未确认 Redo dispatching 记录；未点击（${fence.error || `HTTP ${fence.status}`}）。`;
      await setStatus("offline", detail, { taskId: task.id });
      return;
    }
    active.telemetry ||= {};
    active.telemetry.fenceRoundTripMs = roundedMs(performance.now() - fenceStarted);

    active.stage = "dispatching-fenced";
    active.dispatchingAt = new Date().toISOString();
    await saveActive(active);

    await requireRunnerOwnership(active);
    const afterFenceSettings = await Shared.getSettings();
    if (!afterFenceSettings.enabled) {
      throw new RunnerBlockedError(
        "DISABLED_AFTER_DISPATCH_FENCE",
        "用户在 Redo dispatching 已确认后关闭了执行器；扩展没有点击，任务转为人工核对。",
        false
      );
    }
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("REDO_CONVERSATION_CHANGED_AFTER_FENCE", "Redo fence 确认后页面离开目标会话；扩展没有点击。", false);
    }
    if (sourceTurn) {
      active.sourceTurnEvidence = (await verifyTaskUserTurn(task, sourceTurn, { requireLast: true })).evidence;
      await saveActive(active);
    }
    const afterFenceModel = currentModelLabel();
    if (!modelMatches(task.requiredModel, afterFenceModel)
        || normalizedText(afterFenceModel) !== normalizedText(modelLabel)) {
      throw new RunnerBlockedError("REDO_MODEL_CHANGED_AFTER_FENCE", "Redo fence 确认后 Gemini 模式发生变化；扩展没有点击。", false);
    }
    if (stopButtonVisible()) {
      throw new RunnerBlockedError("REDO_GENERATION_STARTED_AFTER_FENCE", "Redo fence 确认后页面出现了其他生成任务；扩展没有点击。", false);
    }
    const afterFenceSnapshot = lastResponseSnapshot();
    if (!Shared.responseSnapshotEquivalent(baseline, afterFenceSnapshot)) {
      throw new RunnerBlockedError("REDO_TARGET_CHANGED_AFTER_FENCE", "Redo fence 确认后最后一条回答发生变化；扩展没有点击。", false);
    }
    const verifiedSelection = redoControlSelection();
    if (verifiedSelection.count !== 1
        || verifiedSelection.button !== selection.button
        || verifiedSelection.root !== selection.root
        || !selection.button.isConnected
        || !isVisible(selection.button)
        || selection.button.disabled
        || selection.button.getAttribute("aria-disabled") === "true") {
      throw new RunnerBlockedError("REDO_CONTROL_CHANGED_AFTER_FENCE", "Redo fence 确认后目标按钮或所属回答发生变化；扩展没有点击。", false);
    }

    const tracker = createRedoMutationTracker(selection.root);
    try {
      try {
        active.telemetry.documentInstanceId = documentInstanceId;
        active.telemetry.clickPerformanceNow = performance.now();
        active.telemetry.clickedAt = new Date().toISOString();
        const menusBeforeClick = redoMenuScopes();
        selection.button.click();
        // First use starts immediately. Later uses open a real gem-menu; click
        // only the task's exact requested menuitem in that new menu.
        const menuChoiceClicked = await chooseRedoMenuAction({
          menusBeforeClick,
          baseline,
          tracker,
          redoOption: task.redoOption
        });
        if (menuChoiceClicked) {
          await recordRedoEvidence(active, {
            menuChoiceClicked: true,
            menuChoice: task.redoOption,
            menuChoiceClickedAt: new Date().toISOString(),
            menuChoiceClickedDocumentId: documentInstanceId
          });
        }
      } catch (error) {
        if (error instanceof RunnerBlockedError) throw error;
        throw new RunnerBlockedError("REDO_CLICK_FAILED", `Redo 按钮点击失败：${error?.message || error}`, false);
      }
      active.stage = "submitted-local";
      active.submittedAt = new Date().toISOString();
      active.submittedDocumentId = documentInstanceId;
      await saveActive(active);
      await waitForRedoSubmission(active, tracker);
    } finally {
      tracker.disconnect();
    }

    await rememberConversation(task.runId, requiredUrl);
    await enqueueEvent(active, "submitted", {
      conversationUrl: requiredUrl,
      modelLabel: active.submittedModelLabel,
      telemetry: active.telemetry || undefined,
      ...actionEvidenceFields(active),
      ...redoEventFields(task)
    });
    active.stage = "submitted";
    await saveActive(active);

    const snapshot = await waitForCompletion(active);
    await finishCompleted(active, snapshot);
  }

  async function reprepareEditBeforeFence(active) {
    // A serialized prompt-filled state cannot restore DOM object identity. If
    // the in-document half of the binding is absent, go all the way back to a
    // leased task and repeat exact-turn discovery + native replacement. Never
    // degrade to matching only the (possibly identical) textarea text.
    dropEditLiveBinding(active);
    active.stage = "leased";
    delete active.baseline;
    delete active.targetTurnEvidence;
    delete active.preparedLocation;
    delete active.submittedConversationUrl;
    delete active.submittedModelLabel;
    delete active.submittedDocumentId;
    delete active.navigationTarget;
    await saveActive(active);
    await processLeasedTask(active);
  }

  async function dispatchFilledTask(active) {
    const task = active.task;
    const edit = task.conversationAction === "edit";
    const exactConversation = task.conversationAction === "continue" || edit;
    // Check 1/3: dispatch may only begin with the exact runtime root/textarea
    // pair prepared in this document. A reload/handoff has only the serialized
    // token, so it must safely re-prepare before any fence.
    if (edit && !await verifyEditLiveBinding(active, { requirePrompt: true })) {
      await reprepareEditBeforeFence(active);
      return;
    }
    const blocker = detectPageBlocker();
    if (blocker) throw new RunnerBlockedError(blocker.code, blocker.message, blocker.retryable);
    const modelLabel = currentModelLabel();
    if (task.requiredModel && !modelLabel) {
      throw new RunnerBlockedError("MODEL_UNKNOWN", "无法读取 Gemini 当前模式，不能验证任务要求；未发送。", false);
    }
    if (!modelMatches(task.requiredModel, modelLabel)) {
      throw new RunnerBlockedError("MODEL_MISMATCH", `当前模式“${modelLabel}”不再符合任务要求；未发送。`, false);
    }
    if (exactConversation) {
      const map = await runConversationMap();
      const requiredUrl = task.conversationUrl
        ? safeGeminiConversationUrl(task.conversationUrl)
        : (map[task.runId] ? conversationUrlFrom(map[task.runId]) : "");
      if (!requiredUrl || conversationUrlFrom() !== requiredUrl) {
        throw new RunnerBlockedError("CONVERSATION_CHANGED", "发送前会话地址发生变化；为避免发到错误线程，任务已停止。", false);
      }
      active.submittedConversationUrl = requiredUrl;
    } else if (task.conversationAction === "new" && active.preparedLocation) {
      const marker = active.preparedLocation;
      if (location.pathname !== marker.pathname
          || conversationUrlFrom() !== marker.conversationUrl
          || responseElements().length !== marker.responseCount) {
        throw new RunnerBlockedError("NEW_CHAT_CHANGED", "发送前空白新会话发生变化；未点击发送。", false);
      }
    }
    const composer = edit ? editComposerSelection().element : composerElement();
    if (!composerStillMatchesPreparedInput(active, composer)) {
      throw new RunnerBlockedError("COMPOSER_CHANGED", "发送前输入框内容发生变化；未点击发送。", false);
    }
    const button = await waitFor(
      () => edit ? editSubmitControlSelection().button : sendControl(),
      10000
    );
    if (!button) {
      throw new RunnerBlockedError("SEND_CONTROL_MISSING", "提示词已填入，但找不到可用的发送按钮；未发送。", false);
    }

    await requireRunnerOwnership(active);
    const beforeFenceSettings = await Shared.getSettings();
    if (!beforeFenceSettings.enabled) {
      const stopped = new Error("用户在 dispatching 前关闭了执行器；提示词未发送。");
      stopped.code = "DISABLED_BEFORE_DISPATCH";
      stopped.retryable = true;
      throw stopped;
    }
    await ensureTaskPrewarm(active, beforeFenceSettings);
    await requireRunnerOwnership(active);
    const afterPrewarmSettings = await Shared.getSettings();
    if (!afterPrewarmSettings.enabled) {
      const stopped = new Error("用户在网络预热后、dispatching 前关闭了执行器；提示词未发送。");
      stopped.code = "DISABLED_AFTER_PREWARM";
      stopped.retryable = true;
      throw stopped;
    }
    const afterPrewarmModel = currentModelLabel();
    if (!modelMatches(task.requiredModel, afterPrewarmModel)
        || normalizedText(afterPrewarmModel) !== normalizedText(modelLabel)) {
      throw new RunnerBlockedError("MODEL_CHANGED_AFTER_PREWARM", "网络预热后 Gemini 模式发生变化；提示词未发送。", false);
    }
    if (exactConversation
        && !Shared.provenanceMatches(active.submittedConversationUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("CONVERSATION_CHANGED_AFTER_PREWARM", "网络预热后页面离开了已验证线程；提示词未发送。", false);
    }
    if (task.conversationAction === "new" && active.preparedLocation) {
      const marker = active.preparedLocation;
      if (location.pathname !== marker.pathname
          || conversationUrlFrom() !== marker.conversationUrl
          || responseElements().length !== marker.responseCount) {
        throw new RunnerBlockedError("NEW_CHAT_CHANGED_AFTER_PREWARM", "网络预热后空白新会话发生变化；提示词未发送。", false);
      }
    }
    const afterPrewarmComposer = edit ? editComposerSelection().element : composerElement();
    if (!composerStillMatchesPreparedInput(active, afterPrewarmComposer)) {
      throw new RunnerBlockedError("COMPOSER_CHANGED_AFTER_PREWARM", "网络预热后输入框内容发生变化；提示词未发送。", false);
    }
    const afterPrewarmControl = edit ? editSubmitControlSelection().button : sendControl();
    if (!button.isConnected || afterPrewarmControl !== button || !isVisible(button)
        || button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw new RunnerBlockedError("SEND_CONTROL_CHANGED_AFTER_PREWARM", "网络预热后发送按钮发生变化；提示词未发送。", false);
    }
    active.submittedModelLabel = modelLabel;
    await saveActive(active);

    // Check 2/3: ensureTaskPrewarm and the ownership/settings storage calls are
    // await boundaries where the user could cancel one editor and open another
    // with identical text. Re-scan stable semantic roots immediately before the fence.
    if (edit && !await verifyEditLiveBinding(active, { requirePrompt: true })) {
      await reprepareEditBeforeFence(active);
      return;
    }

    // Write-ahead fence: it is posted immediately before the click and must be
    // durably acknowledged. A lost response is retried with the same eventId.
    const fenceStarted = performance.now();
    const fence = await postFenceEvent(active, {
      pageUrl: pageUrl(),
      conversationUrl: active.submittedConversationUrl || undefined,
      modelLabel,
      userText: String(task.prompt),
      ...actionEvidenceFields(active),
      telemetry: active.telemetry || undefined
    });
    if (!fence.ok) {
      if ([404, 409, 410].includes(fence.status)) {
        await clearActive();
        await setStatus(
          "stopped",
          `NovelWeb 已撤销任务或拒绝当前 lease（HTTP ${fence.status}）；dispatching 未获确认，因此没有点击发送。`,
          { taskId: task.id }
        );
        return;
      }
      const detail = fence.status === 401 || fence.status === 403
        ? "配对令牌被拒绝；提示词未发送。"
        : `NovelWeb 未确认 dispatching 记录；提示词未发送（${fence.error || `HTTP ${fence.status}`}）。`;
      await setStatus("offline", detail, { taskId: task.id });
      return;
    }
    active.telemetry ||= {};
    active.telemetry.fenceRoundTripMs = roundedMs(performance.now() - fenceStarted);

    active.stage = "dispatching-fenced";
    active.dispatchingAt = new Date().toISOString();
    await saveActive(active);

    // Re-check after the network round trip. If another tab acquired the lock or
    // the user disabled execution, the fence means "possibly sent": never click.
    await requireRunnerOwnership(active);
    const afterFenceSettings = await Shared.getSettings();
    if (!afterFenceSettings.enabled) {
      throw new RunnerBlockedError(
        "DISABLED_AFTER_DISPATCH_FENCE",
        "用户在 dispatching 已确认后关闭了执行器；扩展没有点击发送，任务转为人工核对。",
        false
      );
    }
    if (exactConversation
        && !Shared.provenanceMatches(active.submittedConversationUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError(
        "CONVERSATION_CHANGED_AFTER_FENCE",
        "dispatching 确认后页面离开了已验证线程；扩展没有点击发送。",
        false
      );
    }
    if (task.conversationAction === "new" && active.preparedLocation) {
      const marker = active.preparedLocation;
      if (location.pathname !== marker.pathname
          || conversationUrlFrom() !== marker.conversationUrl
          || responseElements().length !== marker.responseCount) {
        throw new RunnerBlockedError(
          "NEW_CHAT_CHANGED_AFTER_FENCE",
          "dispatching 确认后空白新会话发生变化；扩展没有点击发送。",
          false
        );
      }
    }
    const afterFenceModel = currentModelLabel();
    if (!modelMatches(task.requiredModel, afterFenceModel)
        || normalizedText(afterFenceModel) !== normalizedText(modelLabel)) {
      throw new RunnerBlockedError("MODEL_CHANGED_AFTER_FENCE", "dispatching 确认后 Gemini 模式发生变化；扩展没有点击发送。", false);
    }
    // Check 3/3: the fence round trip and durable stage save are the final await
    // boundaries. A missing or changed binding is now uncertain and must block;
    // a fenced task can never roll back and create a second dispatch record.
    if (edit && !await verifyEditLiveBinding(active, { requirePrompt: true })) {
      throw new RunnerBlockedError(
        "EDIT_LIVE_BINDING_MISSING_AFTER_FENCE",
        "dispatching 确认后编辑目标的实时绑定丢失；扩展没有点击提交。",
        false
      );
    }
    const afterFenceComposer = edit ? editComposerSelection().element : composerElement();
    if (!composerStillMatchesPreparedInput(active, afterFenceComposer)) {
      throw new RunnerBlockedError("COMPOSER_CHANGED_AFTER_FENCE", "dispatching 确认后输入框内容发生变化；扩展没有点击发送。", false);
    }
    const afterFenceControl = edit ? editSubmitControlSelection().button : sendControl();
    if (!button.isConnected || afterFenceControl !== button || !isVisible(button)
        || button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw new RunnerBlockedError("SEND_CONTROL_CHANGED_AFTER_FENCE", "dispatching 确认后发送按钮失效；扩展没有点击。", false);
    }

    try {
      active.telemetry.documentInstanceId = documentInstanceId;
      active.telemetry.clickPerformanceNow = performance.now();
      active.telemetry.clickedAt = new Date().toISOString();
      button.click();
    } catch (error) {
      throw new RunnerBlockedError("SEND_CLICK_FAILED", `发送按钮点击失败：${error?.message || error}`, false);
    }
    active.stage = "submitted-local";
    active.submittedAt = new Date().toISOString();
    await saveActive(active);

    let conversationUrl = expectedConversationUrl(active);
    if (!conversationUrl && task.conversationAction === "new") {
      let boundUserPrompt = "";
      conversationUrl = await waitFor(() => {
        const candidate = conversationUrlFrom();
        const observedUserPrompt = lastUserPromptText();
        const canBind = Shared.canBindNewConversation({
          candidate,
          previous: active.newConversationPreviousUrl,
          stopVisible: stopButtonVisible(),
          observedUserPrompt,
          expectedPrompt: task.prompt
        });
        if (canBind) boundUserPrompt = observedUserPrompt;
        return canBind ? candidate : "";
      }, 15000).catch(() => "") || "";
      if (!conversationUrl) {
        throw new RunnerBlockedError(
          "NEW_CONVERSATION_URL_MISSING",
          "新对话发送后无法同时确认新 /app/<id>、停止生成按钮和本次用户提示；扩展不会采集当前 DOM，以免把其他线程回答归入本任务。",
          false
        );
      }
      active.submittedConversationUrl = conversationUrl;
      active.submittedBindingEvidence = {
        stopObserved: true,
        userPromptMatched: true,
        observedUserPrompt: boundUserPrompt,
        boundAt: new Date().toISOString()
      };
      active.stopWasSeen = true;
      await saveActive(active);
    }
    if (!Shared.provenanceMatches(active.submittedConversationUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("SUBMITTED_CONVERSATION_CHANGED", "发送后的会话地址发生变化；扩展不会采集当前页面。", false);
    }
    await rememberConversation(task.runId, active.submittedConversationUrl);
    await waitForSubmission(active, active.baseline);
    await captureResultSourceTurn(active);

    await enqueueEvent(active, "submitted", {
      conversationUrl: active.submittedConversationUrl,
      userText: String(task.prompt),
      modelLabel: active.submittedModelLabel,
      resultSourceTurn: active.resultSourceTurn,
      ...actionEvidenceFields(active),
      telemetry: active.telemetry || undefined
    });
    active.stage = "submitted";
    await saveActive(active);

    const snapshot = await waitForCompletion(active);
    await finishCompleted(active, snapshot);
  }

  async function processLeasedTask(active) {
    const task = active.task;
    if (task.jobType === "conversation_snapshot") {
      await processConversationSnapshot(active);
      return;
    }
    const redo = Shared.isRedoTask(task);
    const initialBlocker = detectPageBlocker();
    if (initialBlocker) throw new RunnerBlockedError(initialBlocker.code, initialBlocker.message, initialBlocker.retryable);
    if (!redo && !String(task.prompt || "").trim()) {
      throw new RunnerBlockedError("EMPTY_PROMPT", "任务提示词为空；未发送。", false);
    }

    active.telemetry ||= {
      schemaVersion: 1,
      documentInstanceId,
      claimedAt: new Date().toISOString(),
      conversationUrl: task.conversationUrl || "",
      promptCharacters: String(task.prompt || "").length,
      promptUtf8Bytes: new TextEncoder().encode(String(task.prompt || "")).byteLength
    };
    const prepareStarted = performance.now();
    await setStatus(
      "preparing",
      redo ? "正在核对 Redo 目标会话、模式和最后一条回答。" : "正在核对会话、模式和输入框。",
      { taskId: task.id }
    );
    await prepareConversation(active);
    active.telemetry.prepareConversationMs = roundedMs(performance.now() - prepareStarted);
    active.preparedLocation = {
      pathname: location.pathname,
      conversationUrl: conversationUrlFrom(),
      responseCount: responseElements().length
    };

    const modelLabel = currentModelLabel();
    if (task.requiredModel && !modelLabel) {
      throw new RunnerBlockedError("MODEL_UNKNOWN", "无法读取 Gemini 当前模式，不能验证任务要求；未发送。", false);
    }
    if (!modelMatches(task.requiredModel, modelLabel)) {
      throw new RunnerBlockedError(
        "MODEL_MISMATCH",
        `当前模式“${modelLabel}”不符合任务要求“${Array.isArray(task.requiredModel) ? task.requiredModel.join(" | ") : task.requiredModel}”；扩展不会自动切换模式。`,
        false
      );
    }

    if (redo) {
      const requiredUrl = safeGeminiConversationUrl(task.conversationUrl);
      const baseline = lastResponseSnapshot();
      if (!Shared.provenanceMatches(requiredUrl, baseline.sourceConversationUrl)
          || !baseline.text
          || !baseline.responseElementId) {
        throw new RunnerBlockedError(
          "REDO_BASELINE_UNCONFIRMED",
          "无法把最后一条模型回答绑定到 Redo 任务指定的会话；扩展不会点击。",
          false
        );
      }
      active.baseline = baseline;
      active.submittedConversationUrl = requiredUrl;
      active.submittedModelLabel = modelLabel;
      active.redoEvidence = {};
      active.stage = "redo-ready";
      await saveActive(active);
      await dispatchRedoTask(active);
      return;
    }

    const settings = await Shared.getSettings();
    if (task.conversationAction === "edit") {
      await prepareEditTask(active, settings);
    } else if (task.conversationAction === "continue" && task.conversationUrl) {
      const write = await prepareNativeContinueTask(active, settings);
      active.telemetry.composer = {
        transport: "page-composer",
        ...write
      };
    } else {
      const composer = composerElement();
      if (!composer) {
        throw new RunnerBlockedError("COMPOSER_MISSING", "找不到 Gemini 输入框；页面结构可能已变化。", false);
      }
      active.telemetry.composer = await setComposerText(composer, String(task.prompt));
    }
    active.baseline = lastResponseSnapshot();
    active.stage = "prompt-filled";
    await saveActive(active);
    await dispatchFilledTask(active);
  }

  async function resumeTask(active) {
    if (active?.task?.jobType === "conversation_snapshot") {
      await processConversationSnapshot(active);
      return;
    }
    if (!active?.task?.id) {
      await clearActive();
      return;
    }
    if (active.stage === "leased") {
      await processLeasedTask(active);
      return;
    }
    if (active.stage === "prompt-filled") {
      // Never turn a pre-fence DOM observation directly into a later click.
      // Roll back to leased and repeat navigation, target verification,
      // prewarm, and native paste (which is explicitly idempotent).
      if (active.task?.conversationAction === "edit") dropEditLiveBinding(active);
      active.stage = "leased";
      delete active.baseline;
      delete active.preparedLocation;
      delete active.submittedModelLabel;
      delete active.submittedDocumentId;
      delete active.navigationTarget;
      await saveActive(active);
      await processLeasedTask(active);
      return;
    }
    if (active.stage === "redo-ready") {
      // As with a filled prompt, a pre-fence Redo baseline is not reusable
      // across an interruption. Rebuild the exact conversation, source turn,
      // last response root, control, model, and prewarm before any fence/click.
      active.stage = "leased";
      delete active.baseline;
      delete active.redoEvidence;
      delete active.preparedLocation;
      delete active.submittedModelLabel;
      delete active.submittedDocumentId;
      delete active.navigationTarget;
      await saveActive(active);
      await processLeasedTask(active);
      return;
    }
    if (active.stage === "dispatching-fenced") {
      throw new RunnerBlockedError(
        "DISPATCH_STATE_UNCERTAIN",
        "页面在 dispatching 写入后、发送确认前中断。扩展不会自动重发，请人工核对会话。",
        false
      );
    }
    if (["submitted-local", "submitted"].includes(active.stage)) {
      const submittedUrl = await ensureSubmittedConversation(active);
      const redo = Shared.isRedoTask(active.task);
      if (active.stage === "submitted-local") {
        if (!redo && !active.resultSourceTurn) await captureResultSourceTurn(active);
        const submittedFields = {
          conversationUrl: submittedUrl,
          modelLabel: active.submittedModelLabel || "",
          ...(active.resultSourceTurn ? { resultSourceTurn: active.resultSourceTurn } : {}),
          ...actionEvidenceFields(active),
          ...redoEventFields(active.task)
        };
        if (!redo) submittedFields.userText = String(active.task.prompt || "");
        submittedFields.telemetry = active.telemetry || undefined;
        await enqueueEvent(active, "submitted", submittedFields);
        active.stage = "submitted";
        await saveActive(active);
      }
      if (redo) {
        const sameSubmittedDocument = Shared.evidenceDocumentMatches(active.submittedDocumentId, documentInstanceId);
        if (sameSubmittedDocument) {
          const current = lastResponseSnapshot();
          if (Shared.responseSnapshotChanged(active.baseline || {}, current)
              || Shared.responseRootReplaced(active.baseline || {}, current)) {
            await recordRedoEvidence(active, {
              domMutationSeen: true,
              domMutationDocumentId: documentInstanceId
            });
          }
          const currentControl = redoControlSelection();
          if (currentControl.count !== 1 || !currentControl.button) {
            await recordRedoEvidence(active, {
              actionUnavailableSeen: true,
              actionUnavailableDocumentId: documentInstanceId
            });
          }
        }
      }
      if (!redo
          && !active.stopWasSeen
          && !stopButtonVisible()
      ) {
        throw new RunnerBlockedError(
          "SUBMITTED_STATE_UNCERTAIN",
          "页面在发送后重载，且没有保留下“停止生成”已出现的证据；为避免误判或重发，请人工核对。",
          false
        );
      }
      const snapshot = await waitForCompletion(active);
      await finishCompleted(active, snapshot);
      return;
    }
    if (active.stage === "completing") {
      if (!active.completionSnapshot?.text || !active.completionPayload) {
        throw new RunnerBlockedError("COMPLETION_STATE_DAMAGED", "本地完成记录不完整；请人工核对后恢复。", false);
      }
      await finishCompleted(active, active.completionSnapshot);
      return;
    }
    throw new RunnerBlockedError("UNKNOWN_LOCAL_STATE", `无法识别本地任务阶段：${active.stage || "(empty)"}`, false);
  }

  async function postConversationSnapshotEvent(active, type, fields = {}) {
    const settings = await Shared.getSettings();
    const connection = active.connection || settings;
    active.eventIds ||= {};
    active.eventIds[type] ||= `${connection.workerId}:${active.task.inspectionId}:${type}:${active.task.leaseId}`;
    await saveActive(active);
    return Shared.apiRequest(
      `/api/automation/worker/conversation-snapshots/${encodeURIComponent(active.task.inspectionId)}/events`,
      {
        method: "POST",
        timeoutMs: 30000,
        body: {
          workerId: connection.workerId,
          leaseId: active.task.leaseId,
          eventId: active.eventIds[type],
          type,
          ...fields
        },
        serverUrl: connection.serverUrl
      }
    );
  }

  async function activateConversationForReading(active, expectedUrl) {
    let result = await Shared.runtimeMessage({
      type: "NW_ACTIVATE_RUNNER_TAB",
      expectedUrl
    });
    const deadline = Date.now() + 10000;
    while (result?.ok && result.activationPending === true && Date.now() < deadline) {
      await sleep(100);
      result = await Shared.runtimeMessage({
        type: "NW_CONFIRM_RUNNER_TAB_ACTIVATION",
        expectedUrl
      });
    }
    if (!result?.ok || result.activationPending === true || result.conversationUrl !== expectedUrl) {
      throw new RunnerBlockedError(
        "SNAPSHOT_TAB_ACTIVATION_FAILED",
        result?.error || "无法打开指定 Gemini 对话页面；没有读取或发送内容。",
        false
      );
    }
    if (!Shared.provenanceMatches(expectedUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError(
        "SNAPSHOT_CONVERSATION_CHANGED",
        "切换到指定对话后地址发生变化；没有读取或发送内容。",
        false
      );
    }
  }

  async function processConversationSnapshot(active) {
    const task = active.task;
    const requiredUrl = safeGeminiConversationUrl(task.conversationUrl);
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      active.stage = "inspection-navigation";
      active.navigationTarget = requiredUrl;
      await saveActive(active);
      location.assign(requiredUrl);
      throw new NavigationRequested();
    }
    await requireRunnerOwnership(active);
    await activateConversationForReading(active, requiredUrl);
    const settings = await Shared.getSettings();
    const connection = active.connection || settings;
    const heartbeat = await Shared.apiRequest(
      `/api/automation/worker/conversation-snapshots/${encodeURIComponent(task.inspectionId)}/heartbeat`,
      {
        method: "POST",
        timeoutMs: 15000,
        body: {
          workerId: connection.workerId,
          leaseId: task.leaseId
        },
        serverUrl: connection.serverUrl
      }
    );
    if (!heartbeat.ok) {
      throw new RunnerBlockedError(
        "SNAPSHOT_LEASE_LOST",
        `对话快照租约无法续期（HTTP ${heartbeat.status || 0}）；没有发送或编辑内容。`,
        false
      );
    }
    await setStatus("inspecting", "正在读取指定 Gemini 对话的可见用户/模型轮次。", { inspectionId: task.inspectionId });
    active.stage = "inspection-reading";
    await saveActive(active);
    const turns = await stableConversationTurns();
    if (!turns.some((turn) => turn.role === "user")) {
      throw new RunnerBlockedError("CONVERSATION_TURNS_MISSING", "指定对话没有可验证的用户轮次 DOM；未保存快照。", true);
    }
    if (!Shared.provenanceMatches(requiredUrl, conversationUrlFrom())) {
      throw new RunnerBlockedError("INSPECTION_CONVERSATION_CHANGED", "读取期间页面离开了指定 Gemini 对话；快照被丢弃。", false);
    }
    const capturedAt = new Date().toISOString();
    const rawTitle = String(document.title || "").replace(/\s*[-–—]\s*Gemini\s*$/i, "").trim();
    const result = await postConversationSnapshotEvent(active, "completed", {
      conversationUrl: requiredUrl,
      title: rawTitle.slice(0, 500) || "",
      capturedAt,
      documentInstanceId,
      turns: turns.map(publicConversationTurn)
    });
    if (!result.ok) {
      if ([404, 409, 410].includes(result.status)) {
        await clearActive();
        await setStatus("stopped", `对话快照租约已失效（HTTP ${result.status}）；没有发送或编辑内容。`);
        return;
      }
      throw new Error(result.error || `保存 Gemini 对话快照失败（HTTP ${result.status}）。`);
    }
    await clearActive();
    await setStatus("idle", "指定 Gemini 对话已读取并保存到本地。", { lastInspectionId: task.inspectionId });
  }

  async function emitConversationSnapshotFailure(active, error) {
    const result = await postConversationSnapshotEvent(active, "failed", {
      error: String(error?.message || error).slice(0, 5000),
      code: error?.code || error?.name || "CONVERSATION_SNAPSHOT_FAILED",
      // The lease is bound to this canonical URL even when navigation itself
      // failed. Omitting it would turn a reportable failure into a 409.
      conversationUrl: active.task.conversationUrl
    }).catch(() => null);
    if (result?.ok || [404, 409, 410].includes(result?.status)) await clearActive();
    await setStatus(
      result?.ok ? "blocked" : "offline",
      result?.ok ? String(error?.message || error) : "对话快照失败记录尚未写回 NovelWeb；将自动重试。",
      { inspectionId: active.task.inspectionId, code: error?.code || error?.name }
    );
  }

  function validateClaimedTask(task) {
    if (!task || typeof task !== "object") throw new Error("NovelWeb returned an invalid task.");
    if (task.jobType === "conversation_snapshot" || task.action === "snapshot") {
      const inspectionId = String(task.inspectionId || task.id || "");
      const conversationUrl = Shared.normalizeGeminiConversationUrl(task.conversationUrl || task.url);
      if (!inspectionId || !task.leaseId || !conversationUrl
          || conversationUrl !== String(task.conversationUrl || task.url)) {
        throw new Error("NovelWeb conversation inspection requires inspectionId, leaseId, and an exact Gemini conversation URL.");
      }
      return {
        ...task,
        id: inspectionId,
        inspectionId,
        jobType: "conversation_snapshot",
        action: "snapshot",
        conversationUrl
      };
    }
    const id = task.id || task.taskId;
    if (!id || !task.runId || !task.leaseId) {
      throw new Error("NovelWeb task is missing taskId, runId, or leaseId.");
    }
    const action = task.conversationAction || (task.runKind === "redo" ? "redo" : "continue");
    const redo = action === "redo" || task.runKind === "redo";
    if (redo) {
      if ((task.conversationAction && task.conversationAction !== "redo")
          || (task.runKind && !["redo", "workflow"].includes(task.runKind))) {
        throw new Error("NovelWeb returned conflicting redo task discriminators.");
      }
      const conversationUrl = Shared.normalizeGeminiConversationUrl(task.conversationUrl);
      if (!conversationUrl || String(task.conversationUrl) !== conversationUrl || task.prompt !== null) {
        throw new Error("NovelWeb redo task requires prompt:null and an exact canonical Gemini /app/<id> URL.");
      }
      const redoIndex = task.redoIndex ?? task.repeatIndex ?? task.resultOrdinal;
      const repeatIndex = task.repeatIndex ?? redoIndex;
      const repeatCount = task.repeatCount ?? redoIndex;
      const redoOption = Shared.normalizeRedoOption(task.redoOption);
      if (!Number.isInteger(redoIndex) || redoIndex < 1
          || !Number.isInteger(repeatIndex) || repeatIndex !== redoIndex
          || !Number.isInteger(repeatCount) || repeatCount < redoIndex
          || !redoOption || task.redoOption !== redoOption) {
        throw new Error("NovelWeb redo task has invalid redoIndex/repeatIndex/repeatCount/redoOption metadata.");
      }
      const sourceTurn = task.sourceTurn == null ? null : Shared.normalizeTurnTarget(task.sourceTurn);
      if (task.runKind === "workflow"
          && task.redoSource !== "current_last_response"
          && !sourceTurn) {
        throw new Error("NovelWeb workflow Redo task is missing its source user-turn provenance.");
      }
      return {
        ...task,
        id,
        taskId: task.taskId || id,
        runKind: task.runKind || "redo",
        conversationAction: "redo",
        conversationUrl,
        redoIndex,
        repeatIndex,
        repeatCount,
        redoOption,
        ...(sourceTurn ? { sourceTurn } : {})
      };
    }
    if (typeof task.prompt !== "string") {
      throw new Error("NovelWeb prompt task is missing its prompt string.");
    }
    if (!["continue", "new", "edit"].includes(action)) {
      throw new Error("NovelWeb prompt task has an unsupported conversation action.");
    }
    const conversationUrl = task.conversationUrl == null
      ? null
      : Shared.normalizeGeminiConversationUrl(task.conversationUrl);
    if (task.conversationUrl != null && conversationUrl !== String(task.conversationUrl)) {
      throw new Error("NovelWeb prompt task has an invalid exact Gemini conversation URL.");
    }
    const targetTurn = task.targetTurn == null ? null : Shared.normalizeTurnTarget(task.targetTurn);
    if (action === "edit" && (!conversationUrl || !targetTurn)) {
      throw new Error("NovelWeb edit task requires an exact conversation and complete target-turn provenance.");
    }
    return {
      ...task,
      id,
      taskId: task.taskId || id,
      conversationAction: action,
      conversationUrl,
      ...(targetTurn ? { targetTurn } : {})
    };
  }

  async function claimNextTask() {
    const settings = await Shared.getSettings();
    const query = new URLSearchParams({
      workerId: settings.workerId,
      pageUrl: pageUrl(),
      modelLabel: currentModelLabel()
    });
    const result = await Shared.apiRequest(`/api/automation/worker/next?${query.toString()}`, { timeoutMs: 15000 });
    if (result.status === 204) return null;
    if (!result.ok) {
      throw new Error(result.error || `NovelWeb worker API returned HTTP ${result.status}.`);
    }
    return validateClaimedTask(result.data?.task || result.data);
  }

  async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const settings = await Shared.getSettings();
      const existing = await activeTask();
      if (!settings.enabled && !existing) {
        let pending = 0;
        if (settings.pairingToken) {
          const flush = await flushOutbox().catch(() => ({ pending: -1 }));
          pending = Number(flush?.pending || 0);
          await postIdleHeartbeatIfDue("disabled-idle");
        }
        await runnerLock("release").catch(() => {});
        await setStatus(
          "disabled",
          pending > 0
            ? `扩展已关闭；仍在安全重传 ${pending} 条本地结果，不会领取新任务。`
            : (pending < 0 ? "扩展已关闭；本地结果重传状态暂不可用，不会领取新任务。" : "扩展已关闭，不会领取或发送任务。")
        );
        return;
      }
      if (!settings.pairingToken) {
        await runnerLock("release").catch(() => {});
        await setStatus("needs-setup", "尚未填写 NovelWeb 配对令牌。");
        return;
      }

      const lock = await runnerLock("acquire");
      if (!lock?.acquired) {
        await setStatus("standby-tab", "另一个 Gemini 标签页持有唯一执行权；本页不会领取或发送任务。");
        return;
      }

      const outboxResult = await flushOutbox();
      const outboxPending = !outboxResult.ok || Number(outboxResult.pending || 0) > 0;
      // Keep unsent results for later retry, but never let an old conflicting
      // result freeze an otherwise idle writer queue.
      if (outboxPending && existing
          && existing.task?.jobType !== "conversation_snapshot"
          && !isPostDispatchStage(existing.stage)) {
        await setStatus("saving-offline", `本地待发结果尚未写回 NovelWeb：${outboxResult.lastError || outboxResult.error || "等待重试"}`);
        return;
      }

      if (existing) {
        if (existing.ownerKey && existing.ownerKey !== lock.ownerKey) {
          if (existing.task?.jobType === "conversation_snapshot") {
            // Inspection jobs are read-only and have their own lease/event
            // endpoint. A new sole-owner tab can safely restart the inspection,
            // but must never route it through generation blocked/outbox logic.
            existing.ownerKey = lock.ownerKey;
            existing.stage = "leased";
            delete existing.navigationTarget;
            await saveActive(existing);
          } else if (["leased", "prompt-filled", "redo-ready"].includes(existing.stage)) {
            // Neither state has clicked. Reset to leased and re-check the entire
            // page in the new sole-owner tab before doing anything else.
            if (existing.task?.conversationAction === "edit") dropEditLiveBinding(existing);
            existing.ownerKey = lock.ownerKey;
            existing.stage = "leased";
            delete existing.baseline;
            delete existing.redoEvidence;
            delete existing.preparedLocation;
            delete existing.submittedModelLabel;
            delete existing.submittedDocumentId;
            delete existing.navigationTarget;
            await saveActive(existing);
          } else if (existing.stage === "completing"
              && existing.completionSnapshot?.text
              && existing.completionPayload) {
            existing.ownerKey = lock.ownerKey;
            await saveActive(existing);
            const expected = expectedConversationUrl(existing);
            if (!expected || !Shared.provenanceMatches(expected, existing.completionSnapshot.sourceConversationUrl)) {
              await emitBlocked(existing, new RunnerBlockedError(
                "COMPLETING_PROVENANCE_MISMATCH",
                "接管到的完成快照无法证明来自任务线程；扩展拒绝回传该快照。",
                false
              ));
            } else {
              try {
                await finishCompleted(existing, existing.completionSnapshot);
              } catch (error) {
                await setStatus("saving-offline", `已生成的回答仍安全保存在本地：${error?.message || error}`, { taskId: existing.task?.id });
              }
            }
            return;
          } else if (existing.stage === "completing") {
            existing.ownerKey = lock.ownerKey;
            await saveActive(existing);
            await emitBlocked(existing, new RunnerBlockedError(
              "COMPLETION_PAYLOAD_MISSING",
              "接管到的完成状态缺少首次观察时冻结的完整事件；扩展不会从当前页面重建。",
              false
            ));
            return;
          } else if (isPostDispatchStage(existing.stage) && expectedConversationUrl(existing)) {
            existing.ownerKey = lock.ownerKey;
            await saveActive(existing);
            const expected = expectedConversationUrl(existing);
            if (!Shared.provenanceMatches(expected, conversationUrlFrom())) {
              existing.navigationTarget = expected;
              await saveActive(existing);
              location.assign(expected);
              return;
            }
          } else {
            existing.ownerKey = lock.ownerKey;
            await saveActive(existing);
            await emitBlocked(existing, new RunnerBlockedError(
              "OWNER_TAB_LOST_AFTER_DISPATCH",
              "原执行标签页在 dispatching 之后失去所有权；扩展不会重发或猜测完成，任务转为人工核对。",
              false
            ));
            return;
          }
        }
        if (!existing.ownerKey) {
          existing.ownerKey = lock.ownerKey;
          await saveActive(existing);
        }
        try {
          await resumeTask(existing);
        } catch (error) {
          if (error instanceof NavigationRequested) return;
          if (error instanceof OwnershipLostError) {
            await setStatus("standby-tab", "本页已失去唯一执行权；不会发送或修改该任务。", { taskId: existing.task?.id });
            return;
          }
          if (error instanceof CompletionSavePendingError || existing.stage === "completing") {
            await persistRecoverySnapshot(existing, error).catch(() => {});
            await setStatus("saving-offline", "回答快照已保存在本地恢复区，等待写入 NovelWeb。", { taskId: existing.task?.id }).catch(() => {});
            return;
          }
          if (existing.task?.jobType === "conversation_snapshot") {
            await emitConversationSnapshotFailure(existing, error);
          } else if (error instanceof RunnerBlockedError) await emitBlocked(existing, error);
          else await emitFailed(existing, error);
        }
        return;
      }

      const blocker = detectPageBlocker();
      if (blocker) {
        await runnerLock("release").catch(() => {});
        await setStatus("blocked", blocker.message, { code: blocker.code });
        return;
      }
      // A conversation read is deliberately read-only and does not need the
      // bottom composer. Claim it first so old/long Gemini pages can still be
      // inspected; generation tasks keep their normal composer checks later.
      const composerReady = Boolean(composerElement());
      if (!composerReady) {
        await setStatus("waiting-page", "Gemini 页面已打开，输入框仍在加载；先检查只读任务。", { workerId: settings.workerId });
      } else {
        await setStatus("polling", "Gemini 已就绪，正在等待 NovelWeb 队列。", { workerId: settings.workerId });
      }
      const task = await claimNextTask();
      if (!task) {
        await setStatus("idle", "Gemini 已就绪，队列当前为空。", { workerId: settings.workerId });
        await postIdleHeartbeatIfDue("idle");
        return;
      }

      const active = {
        task,
        stage: "leased",
        claimedAt: new Date().toISOString(),
        ownerKey: lock.ownerKey,
        connection: {
          serverUrl: settings.serverUrl,
          workerId: settings.workerId
        },
        eventIds: {},
        stopWasSeen: false
      };
      await saveActive(active);
      if (!composerReady && task.jobType !== "conversation_snapshot") {
        await setStatus("waiting-page", "任务已排好，等待 Gemini 输入框加载后再发送。", { taskId: task.id });
        return;
      }
      try {
        await processLeasedTask(active);
      } catch (error) {
        if (error instanceof NavigationRequested) return;
        if (error instanceof OwnershipLostError) {
          await setStatus("standby-tab", "本页已失去唯一执行权；不会发送或修改该任务。", { taskId: active.task?.id });
          return;
        }
        if (error instanceof CompletionSavePendingError || active.stage === "completing") {
          await persistRecoverySnapshot(active, error).catch(() => {});
          await setStatus("saving-offline", "回答快照已保存在本地恢复区，等待写入 NovelWeb。", { taskId: active.task?.id }).catch(() => {});
          return;
        }
        if (active.task?.jobType === "conversation_snapshot") {
          await emitConversationSnapshotFailure(active, error);
        } else if (error instanceof RunnerBlockedError) await emitBlocked(active, error);
        else await emitFailed(active, error);
      }
    } catch (error) {
      await setStatus("offline", `无法连接 NovelWeb：${error?.message || error}`);
    } finally {
      tickRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "NW_CONTENT_STATUS") return false;
    Promise.all([
      chrome.storage.local.get({ [STATUS_KEY]: null, [OUTBOX_KEY]: [], [RECOVERY_KEY]: [] }),
      activeTask()
    ]).then(([stored, active]) => sendResponse({
      ok: true,
      status: stored[STATUS_KEY],
      outboxCount: Array.isArray(stored[OUTBOX_KEY]) ? stored[OUTBOX_KEY].length : 0,
      recoveryCount: Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY].length : 0,
      activeTaskId: active?.task?.id || null,
      pageUrl: pageUrl(),
      modelLabel: currentModelLabel(),
      blocker: detectPageBlocker()
    })).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.enabled || changes.serverUrl || changes.pairingToken || changes.workerId)) {
      tick().catch(() => {});
    }
  });

  timer = setInterval(() => tick().catch(() => {}), POLL_MS);
  addEventListener("pagehide", () => {
    if (timer) clearInterval(timer);
  }, { once: true });
  tick().catch(() => {});
})();
