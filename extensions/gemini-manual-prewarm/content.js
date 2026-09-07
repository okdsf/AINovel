(() => {
  "use strict";

  const Core = globalThis.GeminiManualPrewarmCore;
  const ENABLED_KEY = "geminiManualPrewarmEnabled";
  const STATUS_KEY = "geminiManualPrewarmLastStatus";
  const gate = Core.createSingleFlightGate();
  let enabled = null;
  let replayControl = null;

  const SEND_SELECTORS = [
    'button[aria-label*="发送消息"]',
    'button[aria-label^="发送"]',
    'button[aria-label*="Send message" i]',
    'button[aria-label="Send" i]',
    'button[data-test-id*="send" i]',
    'button[class*="send-button" i]',
    '[role="button"][aria-label*="发送消息"]',
    '[role="button"][aria-label*="Send message" i]'
  ];

  const STOP_SELECTORS = [
    'button[aria-label*="停止生成"]',
    'button[aria-label*="停止回答"]',
    'button[aria-label*="停止回复"]',
    'button[aria-label*="Stop response" i]',
    'button[aria-label*="Stop generating" i]',
    'button[data-test-id*="stop" i]'
  ];

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    return new Promise((resolve) => chrome.storage.local.set(value, resolve));
  }

  function descriptor(element) {
    return {
      ariaLabel: element?.getAttribute?.("aria-label") || "",
      ariaDisabled: element?.getAttribute?.("aria-disabled") || "",
      title: element?.getAttribute?.("title") || "",
      dataTestId: element?.getAttribute?.("data-test-id") || "",
      className: typeof element?.className === "string" ? element.className : "",
      text: element?.textContent || "",
      disabled: Boolean(element?.disabled)
    };
  }

  function isVisible(element) {
    return Boolean(element?.isConnected && element.getClientRects().length > 0);
  }

  function isUsableSendControl(element) {
    return isVisible(element) && Core.isSendControlDescriptor(descriptor(element));
  }

  function isUsableRedoControl(element) {
    return isVisible(element) && Core.isRedoControlDescriptor(descriptor(element));
  }

  function editContainer(element) {
    return element?.closest?.(".edit-mode") || null;
  }

  function isEditComposer(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const label = String(element.getAttribute("aria-label") || "").normalize("NFKC").trim().toLowerCase();
    return editContainer(element) !== null
      && element.matches("textarea,[contenteditable=true],[role=textbox]")
      && new Set(["edit prompt", "编辑提示词", "编辑提示", "修改提示词"]).has(label);
  }

  function isUsableEditSubmitControl(element) {
    return isVisible(element)
      && editContainer(element) !== null
      && Core.isEditSubmitControlDescriptor(descriptor(element));
  }

  function findSendControl() {
    for (const selector of SEND_SELECTORS) {
      const match = Array.from(document.querySelectorAll(selector)).find(isUsableSendControl);
      if (match) return match;
    }
    return null;
  }

  function actionFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      const control = node.matches?.("button,[role=button]") ? node : node.closest?.("button,[role=button]");
      if (isUsableSendControl(control)) return { trigger: "click", control };
      if (isUsableRedoControl(control)) return { trigger: "redo", control };
      if (isUsableEditSubmitControl(control)) return { trigger: "edit-click", control };
    }
    return null;
  }

  function stopControlVisible() {
    return STOP_SELECTORS.some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisible));
  }

  function isComposerTarget(target) {
    if (!(target instanceof Element)) return false;
    const editable = target.closest('textarea,[contenteditable="true"],[role="textbox"]');
    if (!editable) return false;
    if (editable.closest("rich-textarea")) return true;
    if (editable.matches('.ql-editor[contenteditable="true"]')) return true;
    const ariaLabel = String(editable.getAttribute("aria-label") || "");
    return /gemini|prompt|message|ask|输入|提问|消息/i.test(ariaLabel);
  }

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  function replayEditEnter(element) {
    if (!isEditComposer(element)) return false;
    const replay = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    });
    element.dispatchEvent(replay);
    element.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    return true;
  }

  async function editSubmissionObserved(element, timeoutMs = 3000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (!element?.isConnected || stopControlVisible()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !element?.isConnected || stopControlVisible();
  }

  function statusBase(trigger, phase) {
    return {
      phase,
      trigger,
      at: new Date().toISOString(),
      outcome: phase === "warming" ? "pending" : "unknown",
      durationMs: null,
      httpStatus: null,
      sent: false,
      sendResult: "pending"
    };
  }

  async function interceptAndSend(trigger, initialControl, expectedPageUrl) {
    const token = gate.enter();
    if (token === null) return;

    await storageSet({ [STATUS_KEY]: statusBase(trigger, "warming") });
    let prewarm;
    try {
      prewarm = await Core.runPrewarm({
        fetchImpl: (url, options) => fetch(url, options),
        timeoutMs: Core.DEFAULT_TIMEOUT_MS,
        now: () => performance.now()
      });

      let sent = false;
      let sendResult = "control-missing";
      if (location.href !== expectedPageUrl) {
        sendResult = "page-changed";
      } else if (stopControlVisible()) {
        sendResult = "blocked-generating";
      } else {
        const editEnter = trigger === "edit-enter";
        const control = trigger === "redo"
          ? (isUsableRedoControl(initialControl) ? initialControl : null)
          : trigger === "edit-click"
            ? (isUsableEditSubmitControl(initialControl) ? initialControl : null)
            : editEnter
              ? null
              : (isUsableSendControl(initialControl) ? initialControl : findSendControl());
        if (editEnter && replayEditEnter(initialControl)) {
          sent = await editSubmissionObserved(initialControl);
          sendResult = sent ? "edit-enter-replayed-once" : "edit-replay-unconfirmed";
        } else if (control) {
          replayControl = control;
          try {
            control.click();
            sent = true;
            sendResult = "clicked-once";
          } finally {
            replayControl = null;
          }
        }
      }

      await storageSet({
        [STATUS_KEY]: {
          phase: "complete",
          trigger,
          at: new Date().toISOString(),
          outcome: prewarm.outcome,
          durationMs: prewarm.durationMs,
          httpStatus: prewarm.httpStatus,
          errorCode: prewarm.errorCode || null,
          sent,
          sendResult
        }
      });
    } finally {
      gate.leave(token);
    }
  }

  function handleClick(event) {
    // Only delay a real user gesture. Programmatic clicks from NovelWeb Runner or
    // other extensions must pass through untouched.
    if (!Core.isTrustedManualEvent(event)) return;
    const action = actionFromEvent(event);
    if (!action || action.control === replayControl || enabled !== true) return;
    if (stopControlVisible()) return;
    swallow(event);
    if (!gate.isActive()) void interceptAndSend(action.trigger, action.control, location.href);
  }

  function handleKeydown(event) {
    if (!Core.isTrustedManualEvent(event) || enabled !== true || !Core.isEligibleEnter(event)) return;
    if (stopControlVisible()) return;
    if (isEditComposer(event.target)) {
      swallow(event);
      if (!gate.isActive()) void interceptAndSend("edit-enter", event.target, location.href);
      return;
    }
    if (!isComposerTarget(event.target)) return;
    const control = findSendControl();
    if (!control) return;
    swallow(event);
    if (!gate.isActive()) void interceptAndSend("enter", control, location.href);
  }

  window.addEventListener("click", handleClick, true);
  window.addEventListener("keydown", handleKeydown, true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[ENABLED_KEY]) {
      enabled = changes[ENABLED_KEY].newValue !== false;
    }
  });

  void storageGet([ENABLED_KEY]).then((stored) => {
    enabled = stored[ENABLED_KEY] !== false;
  });
})();
