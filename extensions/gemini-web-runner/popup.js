"use strict";

(() => {
  const enabled = document.querySelector("#enabled");
  const switchTitle = document.querySelector("#switch-title");
  const statusDot = document.querySelector("#status-dot");
  const statusTitle = document.querySelector("#status-title");
  const statusDetail = document.querySelector("#status-detail");
  const modelLabel = document.querySelector("#model-label");
  const outboxCount = document.querySelector("#outbox-count");
  const recoveryCount = document.querySelector("#recovery-count");

  function renderStatus(kind, title, detail) {
    statusDot.className = `dot${kind ? ` ${kind}` : ""}`;
    statusTitle.textContent = title;
    statusDetail.textContent = detail || "";
  }

  function stateKind(state) {
    if (["idle", "polling", "generating", "saving", "preparing"].includes(state)) return "good";
    if (["blocked", "failed", "offline", "needs-setup", "saving-offline"].includes(state)) return "bad";
    return "";
  }

  async function activeTabStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !String(tab.url || "").startsWith("https://gemini.google.com/")) return null;
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "NW_CONTENT_STATUS" }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response || null);
      });
    });
  }

  async function refresh() {
    await globalThis.NWGeminiShared.waitForInitialization();
    const settings = await globalThis.NWGeminiShared.getSettings();
    const background = await globalThis.NWGeminiShared.runtimeMessage({ type: "NW_GET_BACKGROUND_STATUS" });
    enabled.checked = Boolean(settings.enabled);
    switchTitle.textContent = settings.enabled ? "执行器已开启" : "执行器关闭";
    outboxCount.textContent = String(background?.outboxCount || 0);
    recoveryCount.textContent = String(background?.recoveryCount || 0);

    const page = await activeTabStatus();
    if (!page?.ok) {
      modelLabel.textContent = "—";
      renderStatus(settings.enabled ? "bad" : "", "未连接 Gemini 标签页", "打开或刷新 Gemini 页面后再试；未登录时不会领取任务。");
      return;
    }
    const status = page.status || {};
    modelLabel.textContent = page.modelLabel || status.modelLabel || "未识别";
    renderStatus(stateKind(status.state), status.state || "Gemini 页面已连接", status.detail || "等待下一次状态更新。 ");
  }

  enabled.addEventListener("change", async () => {
    await globalThis.NWGeminiShared.waitForInitialization();
    const settings = await globalThis.NWGeminiShared.getSettings();
    if (enabled.checked && !settings.pairingToken) {
      enabled.checked = false;
      await chrome.storage.local.set({ enabled: false });
      renderStatus("bad", "需要先配对", "请在配对设置中填写 NovelWeb 令牌，再手动开启执行器。");
      await chrome.runtime.openOptionsPage();
      return;
    }
    await chrome.storage.local.set({ enabled: enabled.checked });
    switchTitle.textContent = enabled.checked ? "执行器已开启" : "执行器关闭";
    await refresh();
  });

  document.querySelector("#open-gemini").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://gemini.google.com/app" });
  });
  document.querySelector("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  refresh().catch((error) => renderStatus("bad", "读取状态失败", String(error?.message || error)));
})();
