"use strict";

const ENABLED_KEY = "geminiManualPrewarmEnabled";
const STATUS_KEY = "geminiManualPrewarmLastStatus";
const enabledInput = document.querySelector("#enabled");
const stateElement = document.querySelector("#state");
const triggerElement = document.querySelector("#trigger");
const durationElement = document.querySelector("#duration");
const sendResultElement = document.querySelector("#send-result");
const timeElement = document.querySelector("#time");

const OUTCOME_LABELS = {
  pending: "预热中",
  success: "预热成功",
  "http-error": "HTTP 返回异常",
  timeout: "预热超时（已放行）",
  "network-error": "网络失败（已放行）"
};

const SEND_LABELS = {
  pending: "等待预热",
  "clicked-once": "已发送一次",
  "edit-enter-replayed-once": "已提交一次编辑",
  "edit-replay-unconfirmed": "编辑提交未确认",
  "blocked-generating": "生成中，未发送",
  "page-changed": "页面已切换，未发送",
  "control-missing": "发送控件已消失"
};

const TRIGGER_LABELS = {
  click: "点击发送",
  enter: "按 Enter 发送",
  redo: "点击 Redo",
  "edit-click": "点击提交编辑",
  "edit-enter": "编辑后按 Enter"
};

function renderStatus(status) {
  if (!status) {
    stateElement.textContent = "尚未预热";
    triggerElement.textContent = "—";
    durationElement.textContent = "—";
    sendResultElement.textContent = "—";
    timeElement.textContent = "—";
    return;
  }
  triggerElement.textContent = TRIGGER_LABELS[status.trigger] || status.trigger || "—";
  const http = Number.isFinite(status.httpStatus) ? ` · HTTP ${status.httpStatus}` : "";
  if (status.phase === "warming") {
    stateElement.textContent = "预热中，尚未发送";
  } else if (status.sent && status.outcome === "success") {
    stateElement.textContent = `已预热并发送${http}`;
  } else if (status.sent) {
    stateElement.textContent = `预热失败但已放行 · ${OUTCOME_LABELS[status.outcome] || status.outcome || "未知"}${http}`;
  } else {
    stateElement.textContent = `未发送 · ${SEND_LABELS[status.sendResult] || status.sendResult || "未知"}`;
  }
  durationElement.textContent = Number.isFinite(status.durationMs) ? `${status.durationMs} ms` : "—";
  sendResultElement.textContent = SEND_LABELS[status.sendResult] || status.sendResult || "—";
  const date = new Date(status.at);
  timeElement.textContent = Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

chrome.storage.local.get([ENABLED_KEY, STATUS_KEY], (stored) => {
  enabledInput.checked = stored[ENABLED_KEY] !== false;
  renderStatus(stored[STATUS_KEY]);
});

enabledInput.addEventListener("change", () => {
  chrome.storage.local.set({ [ENABLED_KEY]: enabledInput.checked });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[ENABLED_KEY]) enabledInput.checked = changes[ENABLED_KEY].newValue !== false;
  if (changes[STATUS_KEY]) renderStatus(changes[STATUS_KEY].newValue);
});
