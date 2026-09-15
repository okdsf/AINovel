// Small CDP transport for the dedicated Runner; never reads conversation pages.
export async function connectCdp(webSocketUrl, {timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket} = {}) {
  if (!WebSocketImpl) throw new Error('当前 Node.js 没有 WebSocket；请使用 --experimental-websocket 或更新 Node.js。');
  const socket = new WebSocketImpl(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const rejectPending = message => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    let response;
    try { response = JSON.parse(event.data); } catch { return; }
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    clearTimeout(item.timer);
    if (response.error) item.reject(new Error(`CDP ${item.method} 失败：${response.error.message || '未知错误'}`));
    else item.resolve(response.result);
  });
  socket.addEventListener('close', () => rejectPending('Runner CDP 连接已关闭。'));
  socket.addEventListener('error', () => rejectPending('Runner CDP 连接失败。'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('连接 Runner CDP 超时。'));
    }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 Runner CDP。')); }, {once: true});
    socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Runner CDP 在连接完成前关闭。')); }, {once: true});
  });
  return {
    call(method, params = {}, {sessionId, timeoutMs: callTimeout = timeoutMs} = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} 超时。`));
        }, Math.max(1, callTimeout));
        pending.set(id, {method, resolve, reject, timer});
        try { socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})); }
        catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`CDP ${method} 发送失败。`));
        }
      });
    },
    close() { rejectPending('Runner CDP 检查连接已结束。'); socket.close(); },
  };
}

export async function connectBrowser(endpoint = 'http://127.0.0.1:9223', {timeoutMs = 5000, fetchImpl = fetch, ...options} = {}) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Runner CDP 地址必须是不带认证信息的 HTTP 地址。');
  }
  url.pathname = '/json/version';
  url.search = '';
  url.hash = '';
  let response;
  try { response = await fetchImpl(url, {signal: AbortSignal.timeout(Math.max(1, timeoutMs))}); }
  catch { throw new Error('无法读取 Runner CDP 状态。'); }
  if (!response.ok) throw new Error(`Runner CDP 状态请求失败（${response.status}）。`);
  const info = await response.json();
  if (typeof info.webSocketDebuggerUrl !== 'string') throw new Error('Runner CDP 未返回浏览器连接地址。');
  return connectCdp(info.webSocketDebuggerUrl, {timeoutMs, ...options});
}

export async function evaluate(client, expression, options = {}) {
  const response = await client.call('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, options);
  if (response.exceptionDetails) throw new Error('阅读样式检查页执行失败：' + response.exceptionDetails.text);
  return response.result?.value;
}
