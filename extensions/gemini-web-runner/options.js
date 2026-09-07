"use strict";

(() => {
  const Shared = globalThis.NWGeminiShared;
  const form = document.querySelector("#settings-form");
  const serverUrl = document.querySelector("#server-url");
  const pairingToken = document.querySelector("#pairing-token");
  const workerId = document.querySelector("#worker-id");
  const enabled = document.querySelector("#enabled");
  const prewarmEnabled = document.querySelector("#prewarm-enabled");
  const revealToken = document.querySelector("#reveal-token");
  const testButton = document.querySelector("#test-connection");
  const statusDot = document.querySelector("#status-dot");
  const statusTitle = document.querySelector("#status-title");
  const statusDetail = document.querySelector("#status-detail");
  const outboxStatus = document.querySelector("#outbox-status");

  function showStatus(kind, title, detail) {
    statusDot.className = `status-dot${kind ? ` ${kind}` : ""}`;
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
  }

  async function refreshOutboxCount() {
    const response = await Shared.runtimeMessage({ type: "NW_GET_BACKGROUND_STATUS" });
    const count = Number(response?.outboxCount || 0);
    const recoveryCount = Number(response?.recoveryCount || 0);
    const outboxText = count > 0
      ? `本地待发箱有 ${count} 条记录，恢复连接后会优先重传。`
      : "本地待发箱为空。";
    const recoveryText = recoveryCount > 0
      ? `另有 ${recoveryCount} 条未确认回答快照保存在本地恢复区。`
      : "本地恢复区为空。";
    outboxStatus.textContent = `${outboxText} ${recoveryText} 不要卸载扩展或清除扩展数据。`;
  }

  function valuesFromForm() {
    const normalizedUrl = Shared.normalizeServerUrl(serverUrl.value);
    const nextWorkerId = workerId.value.trim() || Shared.randomId("nw-gemini");
    const nextToken = pairingToken.value.trim();
    if (enabled.checked && !nextToken) throw new Error("开启执行前必须填写配对令牌。");
    return {
      enabled: enabled.checked,
      prewarmEnabled: prewarmEnabled.checked,
      serverUrl: normalizedUrl,
      pairingToken: nextToken,
      workerId: nextWorkerId
    };
  }

  async function assertConnectionChangeIsSafe(values) {
    const current = await Shared.getSettings();
    const runtime = await chrome.storage.local.get({
      nwGeminiRunnerActiveTask: null,
      nwGeminiRunnerOutbox: []
    });
    const busy = Boolean(runtime.nwGeminiRunnerActiveTask)
      || (Array.isArray(runtime.nwGeminiRunnerOutbox) && runtime.nwGeminiRunnerOutbox.length > 0);
    const connectionChanged = current.serverUrl !== values.serverUrl
      || current.workerId !== values.workerId
      || current.pairingToken !== values.pairingToken;
    if (busy && connectionChanged) {
      throw new Error("仍有未完成任务或待回传结果，不能修改服务器、Worker ID 或配对令牌。你仍可关闭执行器。");
    }
  }

  async function save() {
    const values = valuesFromForm();
    await assertConnectionChangeIsSafe(values);
    await chrome.storage.local.set(values);
    workerId.value = values.workerId;
    serverUrl.value = values.serverUrl;
    const runnerState = values.enabled
      ? "执行器已开启。请保持已登录的 Gemini 标签页打开。"
      : "执行器保持关闭，不会领取任务。";
    const prewarmState = values.prewarmEnabled ? "发送前网络预热已开启。" : "发送前网络预热已关闭。";
    showStatus("good", "设置已保存", `${runnerState} ${prewarmState}`);
    return values;
  }

  async function load() {
    await Shared.waitForInitialization();
    const settings = await Shared.getSettings();
    serverUrl.value = settings.serverUrl;
    pairingToken.value = settings.pairingToken;
    workerId.value = settings.workerId;
    enabled.checked = Boolean(settings.enabled);
    prewarmEnabled.checked = settings.prewarmEnabled !== false;
    await refreshOutboxCount();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await save();
    } catch (error) {
      showStatus("bad", "无法保存", String(error?.message || error));
    }
  });

  revealToken.addEventListener("click", () => {
    const reveal = pairingToken.type === "password";
    pairingToken.type = reveal ? "text" : "password";
    revealToken.textContent = reveal ? "隐藏" : "显示";
  });

  testButton.addEventListener("click", async () => {
    testButton.disabled = true;
    try {
      const current = await Shared.getSettings();
      if (current.enabled || enabled.checked) {
        throw new Error("测试连接不会开启执行器。请先取消勾选、保存为关闭，然后再测试。");
      }
      const settings = valuesFromForm();
      settings.enabled = false;
      await assertConnectionChangeIsSafe(settings);
      await chrome.storage.local.set({
        serverUrl: settings.serverUrl,
        pairingToken: settings.pairingToken,
        workerId: settings.workerId
      });
      const query = new URLSearchParams({ workerId: settings.workerId });
      const result = await Shared.apiRequest(`/api/automation/worker/ping?${query.toString()}`, { timeoutMs: 12000 });
      if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`);
      showStatus("good", "连接和配对成功", "NovelWeb worker API 已响应。测试没有领取任务。");
    } catch (error) {
      showStatus("bad", "连接失败", String(error?.message || error));
    } finally {
      testButton.disabled = false;
      await refreshOutboxCount().catch(() => {});
    }
  });

  load().catch((error) => showStatus("bad", "读取设置失败", String(error?.message || error)));
})();
