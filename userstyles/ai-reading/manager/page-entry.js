(() => {
  const id = 'novelweb-reading-style-manager';
  if (document.getElementById(id)) return;
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = 'all:initial!important;position:fixed!important;right:18px!important;bottom:112px!important;z-index:2147483646!important;display:block!important;';
  const root = host.attachShadow({mode: 'open'});
  const css = document.createElement('style');
  css.textContent = ':host{color-scheme:light}button{all:initial;display:flex;align-items:center;gap:7px;padding:10px 13px;background:#fffdf7;color:#234f4b;border:1px solid #739b91;font:13px/1.3 "Microsoft YaHei",system-ui,sans-serif;cursor:pointer;border-radius:6px;box-shadow:0 2px 8px #0002}button:hover{background:#e8f2ed}button:focus-visible{outline:3px solid #79b8aa;outline-offset:3px}button:disabled{opacity:.65}span{font-size:17px}';
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', '查看已安装与启用的样式');
  button.title = '查看已安装样式、本站启用项，切换单选或叠加模式';
  const mark = document.createElement('span');
  mark.textContent = 'Aa';
  mark.setAttribute('aria-hidden', 'true');
  button.append(mark, document.createTextNode('样式管理'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      // The background resolves the sender's live tab URL, including SPA changes.
      const result = await chrome.runtime.sendMessage({data: {method: 'invokeAPI', path: 'novelwebReading.open', args: []}});
      if (result?.error) throw new Error(result.error.message);
    } catch (error) {
      button.title = `无法打开：${error.message}。可从 Stylus 扩展打开样式管理。`;
      button.textContent = '打开失败 · 重试';
    } finally { button.disabled = false; }
  });
  root.append(css, button);
  document.documentElement.append(host);
})();
