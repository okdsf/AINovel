const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

test("manual interception is trusted-only, capture-phase, and page-bound", () => {
  assert.match(source, /Core\.isTrustedManualEvent\(event\)/);
  assert.match(source, /location\.href !== expectedPageUrl/);
  assert.match(source, /interceptAndSend\(action\.trigger, action\.control, location\.href\)/);
  assert.match(source, /interceptAndSend\("enter", control, location\.href\)/);
  assert.match(source, /trigger: "redo"/);
  assert.match(source, /Core\.isRedoControlDescriptor/);
  assert.match(source, /interceptAndSend\("edit-enter", event\.target, location\.href\)/);
  assert.match(source, /Core\.isEditSubmitControlDescriptor/);
  assert.match(source, /new KeyboardEvent\("keydown"/);
  assert.match(source, /window\.addEventListener\("click", handleClick, true\)/);
  assert.match(source, /window\.addEventListener\("keydown", handleKeydown, true\)/);
});

test("the replay is one programmatic click guarded by single-flight", () => {
  assert.match(source, /const token = gate\.enter\(\)/);
  assert.match(source, /if \(token === null\) return/);
  assert.equal((source.match(/control\.click\(\)/g) || []).length, 1);
});
