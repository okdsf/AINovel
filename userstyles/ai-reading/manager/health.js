'use strict';

globalThis.novelwebReadingHealth = {status: 'pending'};
chrome.runtime.sendMessage({
  data: {method: 'invokeAPI', path: 'novelwebReading.getHealth', args: []},
}, response => {
  const error = chrome.runtime.lastError?.message || response?.error?.message || response?.error;
  if (error || !response || !Object.prototype.hasOwnProperty.call(response, 'data')) {
    globalThis.novelwebReadingHealth = {status: 'error', error: String(error || '阅读样式后台没有返回状态。')};
    document.getElementById('status').textContent = '阅读样式后台检查失败。';
  } else {
    globalThis.novelwebReadingHealth = {status: 'complete', data: response.data};
    document.getElementById('status').textContent = '阅读样式后台检查完成。';
  }
});
