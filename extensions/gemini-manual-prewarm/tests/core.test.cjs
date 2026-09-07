const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { AbortController, clearTimeout, setTimeout };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8"),
  sandbox,
  { filename: "core.js" }
);
const Core = sandbox.GeminiManualPrewarmCore;

test("eligible Enter excludes modifiers, IME, repeats, and non-Enter keys", () => {
  const base = {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
    repeat: false
  };
  assert.equal(Core.isEligibleEnter(base), true);
  for (const patch of [
    { key: "a" },
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true }
  ]) {
    assert.equal(Core.isEligibleEnter({ ...base, ...patch }), false);
  }
});

test("only browser-trusted events are classified as manual", () => {
  assert.equal(Core.isTrustedManualEvent({ isTrusted: true }), true);
  assert.equal(Core.isTrustedManualEvent({ isTrusted: false }), false);
  assert.equal(Core.isTrustedManualEvent({}), false);
  assert.equal(Core.isTrustedManualEvent(null), false);
});

test("send descriptors accept localized send controls but reject disabled and Stop", () => {
  assert.equal(Core.isSendControlDescriptor({ ariaLabel: "Send message" }), true);
  assert.equal(Core.isSendControlDescriptor({ ariaLabel: "发送消息" }), true);
  assert.equal(Core.isSendControlDescriptor({ className: "mat-mdc-button send-button" }), true);
  assert.equal(Core.isSendControlDescriptor({ ariaLabel: "Send message", disabled: true }), false);
  assert.equal(Core.isSendControlDescriptor({ ariaLabel: "Stop response" }), false);
  assert.equal(Core.isStopControlDescriptor({ ariaLabel: "停止生成" }), true);
});

test("redo descriptors require an exact localized accessible name", () => {
  for (const ariaLabel of ["Redo", "重做", "重新生成", "重新生成回答", "重新生成回复"]) {
    assert.equal(Core.isRedoControlDescriptor({ ariaLabel }), true);
  }
  assert.equal(Core.isRedoControlDescriptor({ ariaLabel: "Retry connection" }), false);
  assert.equal(Core.isRedoControlDescriptor({ ariaLabel: "Redo", disabled: true }), false);
  assert.equal(Core.isRedoControlDescriptor({ ariaLabel: "Stop response" }), false);
});

test("edited-prompt submit descriptors are exact and reject unrelated controls", () => {
  for (const descriptor of [
    { ariaLabel: "Update" },
    { title: "Submit" },
    { text: "Save" },
    { ariaLabel: "更新" },
    { text: "提交" }
  ]) {
    assert.equal(Core.isEditSubmitControlDescriptor(descriptor), true);
  }
  assert.equal(Core.isEditSubmitControlDescriptor({ text: "Save conversation" }), false);
  assert.equal(Core.isEditSubmitControlDescriptor({ text: "Cancel" }), false);
});

test("single-flight gate admits one operation and requires the matching token", () => {
  const gate = Core.createSingleFlightGate();
  const first = gate.enter();
  assert.equal(typeof first, "number");
  assert.equal(gate.isActive(), true);
  assert.equal(gate.enter(), null);
  assert.equal(gate.leave(first + 1), false);
  assert.equal(gate.isActive(), true);
  assert.equal(gate.leave(first), true);
  assert.equal(gate.isActive(), false);
  assert.notEqual(gate.enter(), null);
});

test("successful prewarm uses the fixed same-origin HEAD request", async () => {
  let request;
  let clock = 100;
  const result = await Core.runPrewarm({
    fetchImpl: async (url, options) => {
      request = { url, options };
      clock = 142;
      return { ok: true, status: 204 };
    },
    now: () => clock,
    timeoutMs: 100
  });
  assert.equal(request.url, "/app");
  assert.equal(request.options.method, "HEAD");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.cache, "no-store");
  assert.equal(result.outcome, "success");
  assert.equal(result.httpStatus, 204);
  assert.equal(result.durationMs, 42);
});

test("HTTP and network failures are classified without retaining error messages", async () => {
  const http = await Core.runPrewarm({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    timeoutMs: 100
  });
  assert.equal(http.outcome, "http-error");
  assert.equal(http.httpStatus, 503);

  const network = await Core.runPrewarm({
    fetchImpl: async () => {
      const error = new TypeError("secret prompt must not be retained");
      throw error;
    },
    timeoutMs: 100
  });
  assert.equal(network.outcome, "network-error");
  assert.equal(network.errorCode, "typeerror");
  assert.equal(JSON.stringify(network).includes("secret prompt"), false);
});

test("prewarm times out and aborts a stalled fetch", async () => {
  let aborted = false;
  const controller = {
    signal: {},
    abort() {
      aborted = true;
    }
  };
  const result = await Core.runPrewarm({
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 5,
    makeAbortController: () => controller
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(aborted, true);
  assert.ok(result.durationMs >= 0);
});
