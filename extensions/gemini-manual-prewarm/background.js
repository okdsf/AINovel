"use strict";

const ENABLED_KEY = "geminiManualPrewarmEnabled";

function setBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? "#226b3a" : "#777777" });
  chrome.action.setTitle({ title: enabled ? "Gemini Manual Prewarm：已启用" : "Gemini Manual Prewarm：已停用" });
}

function initialize() {
  chrome.storage.local.get([ENABLED_KEY], (stored) => {
    const enabled = stored[ENABLED_KEY] !== false;
    if (stored[ENABLED_KEY] === undefined) chrome.storage.local.set({ [ENABLED_KEY]: true });
    setBadge(enabled);
  });
}

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[ENABLED_KEY]) setBadge(changes[ENABLED_KEY].newValue !== false);
});

initialize();
