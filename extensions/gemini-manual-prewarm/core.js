(function exposeGeminiManualPrewarmCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GeminiManualPrewarmCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createCore() {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 3500;

  function normalized(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isEligibleEnter(event) {
    return Boolean(event)
      && event.key === "Enter"
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.isComposing
      && event.keyCode !== 229
      && !event.repeat;
  }

  function isTrustedManualEvent(event) {
    return event?.isTrusted === true;
  }

  function isStopControlDescriptor(descriptor) {
    const label = normalized(`${descriptor?.ariaLabel || ""} ${descriptor?.title || ""} ${descriptor?.dataTestId || ""}`);
    return /stop (response|generating)|停止(生成|回答|回复)|终止(生成|回答|回复)/i.test(label);
  }

  function isSendControlDescriptor(descriptor) {
    if (!descriptor || descriptor.disabled || String(descriptor.ariaDisabled) === "true") return false;
    if (isStopControlDescriptor(descriptor)) return false;
    const label = normalized(`${descriptor.ariaLabel || ""} ${descriptor.title || ""} ${descriptor.dataTestId || ""} ${descriptor.className || ""}`);
    return /(^|\s)(send|send message)(\s|$)|发送(消息)?|send-button|send_button/i.test(label);
  }

  function isRedoControlDescriptor(descriptor) {
    if (!descriptor || descriptor.disabled || String(descriptor.ariaDisabled) === "true") return false;
    if (isStopControlDescriptor(descriptor)) return false;
    const label = normalized(`${descriptor.ariaLabel || ""} ${descriptor.title || ""}`);
    return new Set([
      "redo",
      "重做",
      "重新生成",
      "重新生成回答",
      "重新生成回复"
    ]).has(label);
  }

  function isEditSubmitControlDescriptor(descriptor) {
    if (!descriptor || descriptor.disabled || String(descriptor.ariaDisabled) === "true") return false;
    if (isStopControlDescriptor(descriptor)) return false;
    const label = normalized(`${descriptor.ariaLabel || ""} ${descriptor.title || ""} ${descriptor.text || ""}`);
    return new Set([
      "update",
      "submit",
      "save",
      "send edited prompt",
      "更新",
      "提交",
      "保存",
      "发送修改"
    ]).has(label);
  }

  function createSingleFlightGate() {
    let activeToken = null;
    let sequence = 0;
    return {
      enter() {
        if (activeToken !== null) return null;
        activeToken = ++sequence;
        return activeToken;
      },
      leave(token) {
        if (token !== activeToken) return false;
        activeToken = null;
        return true;
      },
      isActive() {
        return activeToken !== null;
      }
    };
  }

  function safeErrorCode(error) {
    const name = normalized(error?.name).replace(/[^a-z0-9_-]/g, "");
    return name || "error";
  }

  async function runPrewarm(options = {}) {
    const fetchImpl = options.fetchImpl;
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Number(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const makeAbortController = options.makeAbortController || (() => new AbortController());
    const controller = makeAbortController();
    const started = now();
    let timer = null;

    const fetchResult = Promise.resolve()
      .then(() => fetchImpl("/app", {
        method: "HEAD",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal
      }))
      .then((response) => ({
        outcome: response?.ok ? "success" : "http-error",
        httpStatus: Number.isFinite(response?.status) ? Number(response.status) : null
      }))
      .catch((error) => ({
        outcome: error?.name === "AbortError" ? "timeout" : "network-error",
        httpStatus: null,
        errorCode: safeErrorCode(error)
      }));

    const timeoutResult = new Promise((resolve) => {
      timer = setTimer(() => {
        try {
          controller.abort();
        } catch {
          // Timeout is still authoritative even if this platform cannot abort fetch.
        }
        resolve({ outcome: "timeout", httpStatus: null, errorCode: "timeout" });
      }, timeoutMs);
    });

    const result = await Promise.race([fetchResult, timeoutResult]);
    if (timer !== null) clearTimer(timer);
    return {
      ...result,
      ok: result.outcome === "success",
      durationMs: Math.max(0, Math.round(now() - started))
    };
  }

  return {
    DEFAULT_TIMEOUT_MS,
    createSingleFlightGate,
    isEligibleEnter,
    isTrustedManualEvent,
    isSendControlDescriptor,
    isRedoControlDescriptor,
    isEditSubmitControlDescriptor,
    isStopControlDescriptor,
    runPrewarm
  };
});
