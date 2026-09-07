"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function harness({ navCount = 1, modelDelay = 0, modelCount = 1, composerCount = 1, actualModel = "Pro Extended", activationFails = false, initialPath = "/gem/old/conversation" } = {}) {
  let now = 0;
  let sleeps = 0;
  let clicks = 0;
  let writes = 0;
  let dispatches = 0;
  let activated = false;
  const location = { pathname: initialPath };
  const node = (tagName, attrs, parentElement = null) => ({
    tagName, parentElement, disabled: false,
    getAttribute: key => attrs[key] ?? null,
    hasAttribute: key => Object.hasOwn(attrs, key),
  });
  const navRoot = node("GEM-NAV-LIST-ITEM", { "data-test-id": "new-chat-button" });
  const nav = node("A", { "aria-label": "New chat", "href": "/app" }, navRoot);
  nav.click = () => { assert.equal(activated, true, "activation must finish before navigation"); clicks++; location.pathname = "/app"; };
  const composer = node("DIV", { "role": "textbox", "aria-label": "Enter a prompt for Gemini" });
  const model = node("BUTTON", { "data-test-id": "bard-mode-menu-button", "aria-label": `Open mode picker, currently ${actualModel}` });
  const selectors = {
    nav: 'gem-nav-list-item[data-test-id="new-chat-button"] a',
    composer: '[data-test-id="textarea-wrapper"] rich-textarea [contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]',
    model: 'button[data-test-id="bard-mode-menu-button"]',
  };
  const context = vm.createContext({
    location, Date: { now: () => now }, TextEncoder, performance: { now: () => now },
    documentInstanceId: "test-document", roundedMs: value => value,
    RunnerBlockedError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    Shared: {
      isRedoTask: () => false, getSettings: async () => ({}),
      runtimeMessage: async message => {
        assert.equal(message.type, "NW_ACTIVATE_RUNNER_TAB");
        assert.equal(message.expectedUrl, `https://gemini.google.com${initialPath}`);
        assert.equal(message.newChat, true);
        if (activationFails) return { ok: false, error: "Owner lock lost" };
        activated = true;
        return { ok: true, activationPending: false, conversationUrl: message.expectedUrl };
      },
    },
    requireRunnerOwnership: async () => {},
    sleep: async ms => { now += ms; sleeps++; },
    pageUrl: () => `https://gemini.google.com${location.pathname}`,
    accessibleName: element => element.getAttribute("aria-label") || "",
    normalizedText: value => String(value).trim().toLowerCase(),
    visibleElements: selector => {
      if (selector === selectors.nav) return Array(navCount).fill(nav);
      if (selector === selectors.composer) return Array(composerCount).fill(composer);
      if (selector === selectors.model) return sleeps < modelDelay ? [] : Array(modelCount).fill(model);
      throw new Error(`Unexpected selector: ${selector}`);
    },
    composerElement: () => composer, composerText: () => "",
    currentModelLabel: () => sleeps < modelDelay ? "" : model.getAttribute("aria-label"),
    responseElements: () => [],
    conversationUrlFrom: () => location.pathname === "/app" ? "" : `https://gemini.google.com${location.pathname}`,
    forgetConversation: async () => {}, detectPageBlocker: () => null, setStatus: async () => {}, saveActive: async () => {},
    setComposerText: async () => { writes++; return {}; },
    lastResponseSnapshot: () => ({}), dispatchFilledTask: async () => { dispatches++; },
  });
  vm.runInContext([
    section("function newChatDiagnostic(", "function sendControl()"),
    section("function modelMatches(", "function textOfVisibleAlerts()"),
    section("async function prepareConversation(", "async function ensureSubmittedConversation("),
    section("async function processLeasedTask(", "async function resumeTask("),
  ].join("\n"), context);
  return {
    state: () => ({ sleeps, clicks, writes, dispatches }),
    run: () => context.processLeasedTask({ task: { id: "new-chat", runId: "run", conversationAction: "new", prompt: "Tiny smoke", requiredModel: "Pro Extended" }, telemetry: {} }),
  };
}

test("new-chat preparation waits for the actual mode picker after URL and composer arrive", async () => {
  const app = harness({ modelDelay: 3 });
  await app.run();
  assert.deepEqual(app.state(), { sleeps: 4, clicks: 1, writes: 1, dispatches: 1 });
});

test("an already blank app waits for its mode without requiring sidebar navigation", async () => {
  const app = harness({ initialPath: "/app", navCount: 0, modelDelay: 3 });
  await app.run();
  assert.deepEqual(app.state(), { sleeps: 4, clicks: 0, writes: 1, dispatches: 1 });
});

test("new-chat preparation times out without writing when the mode picker never arrives", async () => {
  const app = harness({ modelDelay: Infinity });
  await assert.rejects(app.run(), error => error.code === "NEW_CHAT_NOT_READY"
    && error.message.includes("bard-mode-menu-button") && error.message.includes('"matchCount":0'));
  assert.deepEqual(app.state(), { sleeps: 100, clicks: 1, writes: 0, dispatches: 0 });
});

test("new-chat navigation requires one exact scoped link before clicking", async () => {
  for (const navCount of [0, 2]) {
    const app = harness({ navCount });
    await assert.rejects(app.run(), error => error.code === "NEW_CHAT_CONTROL_NOT_UNIQUE"
      && error.message.includes(`"matchCount":${navCount}`)
      && error.message.includes("new-chat-button") && error.message.includes("https://gemini.google.com/"));
    assert.deepEqual(app.state(), { sleeps: 0, clicks: 0, writes: 0, dispatches: 0 });
  }
});

test("ambiguous new-chat model or composer fails immediately without filling or dispatching", async () => {
  for (const options of [{ modelCount: 2 }, { composerCount: 2 }]) {
    const app = harness(options);
    await assert.rejects(app.run(), error => error.code === "NEW_CHAT_SURFACE_AMBIGUOUS"
      && error.message.includes('"matchCount":2') && error.message.includes('"ancestors"'));
    assert.deepEqual(app.state(), { sleeps: 0, clicks: 1, writes: 0, dispatches: 0 });
  }
});

test("a stable readable mode mismatch still refuses before filling or dispatching", async () => {
  const app = harness({ actualModel: "Fast" });
  await assert.rejects(app.run(), error => error.code === "MODEL_MISMATCH");
  assert.deepEqual(app.state(), { sleeps: 1, clicks: 1, writes: 0, dispatches: 0 });
});

test("failed owned-tab activation refuses before new-chat navigation or writing", async () => {
  const app = harness({ activationFails: true });
  await assert.rejects(app.run(), error => error.code === "NEW_CHAT_TAB_ACTIVATION_FAILED");
  assert.deepEqual(app.state(), { sleeps: 0, clicks: 0, writes: 0, dispatches: 0 });
});
