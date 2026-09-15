(() => {
  async function sourceTab() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    return tab && /^https?:/.test(tab.url || '') ? tab : null;
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('#novelweb-reading-open');
    if (!button) return;
    event.preventDefault();
    button.disabled = true;
    try {
      const tab = await sourceTab();
      const result = await chrome.runtime.sendMessage({data: {method: 'invokeAPI', path: 'novelwebReading.open', args: tab ? [tab.url] : []}});
      if (result?.error) throw new Error(result.error.message);
      window.close();
    } catch (error) {
      button.textContent = `无法打开：${error.message}`;
      button.disabled = false;
    }
  });
  async function label() {
    const note = document.getElementById('novelweb-reading-source');
    if (!note || note.dataset.ready) return;
    note.dataset.ready = 'true';
    const tab = await sourceTab();
    note.textContent = tab ? `当前网站：${new URL(tab.url).hostname}` : '已安装样式 · 按网站管理';
    if (tab) {
      try {
        const result = await chrome.runtime.sendMessage({data: {method:'invokeAPI',path:'novelwebReading.snapshot',args:[tab.url,tab.id]}});
        if (result?.error) throw new Error(result.error.message);
        note.textContent += ` · ${result.data.mode === 'stack' ? '叠加' : '单选'} · 本站启用 ${result.data.activeCount}`;
      } catch { note.textContent += ' · 点击上方查看启用状态'; }
    }
  }
  const observer = new MutationObserver(() => {
    if (document.getElementById('novelweb-reading-source')) { observer.disconnect(); void label(); }
  });
  observer.observe(document.body, {childList: true, subtree: true});
  void label();
})();
