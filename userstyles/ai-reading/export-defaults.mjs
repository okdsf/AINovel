// Maintainer command: compile repository UserCSS with Stylus, without importing
// or updating any installed styles or copying a browser profile's preferences.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {extensionIdForKey} from './install-manager.mjs';
import {connectBrowser, evaluate} from '../../scripts/reading-cdp.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const sources = [
  {file: 'chatgpt-reading.user.css', name: 'ChatGPT · 中文阅读', host: 'chatgpt.com'},
  {file: 'gemini-reading.user.css', name: 'Gemini · 中文阅读', host: 'gemini.google.com'},
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function cleanCompiledDefault(style, sourceCode, {name, host}) {
  if (style?.name !== name || style.usercssData?.name !== name ||
      style.usercssData?.namespace !== 'novelweb-ai-reading' ||
      style.sourceCode !== sourceCode.replace(/\r\n?/g, '\n') ||
      !Array.isArray(style.sections) || !style.sections.length ||
      style.sections.some(section => typeof section.code !== 'string' || !section.code.trim() ||
        JSON.stringify(section.domains) !== JSON.stringify([host]) ||
        ['urls', 'urlPrefixes', 'regexps'].some(key => section[key]?.length))) {
    throw new Error(`${name} 编译结果的名称、源码或网站范围不符合默认样式要求。`);
  }
  if (!style.usercssData.vars || Object.values(style.usercssData.vars).some(variable => variable.value != null)) {
    throw new Error(`${name} 编译结果包含已选择的字体参数，不能作为全新安装默认值。`);
  }
  const usercssData = {};
  for (const key of ['name', 'namespace', 'version', 'description', 'license', 'preprocessor', 'vars']) {
    if (style.usercssData[key] !== undefined) usercssData[key] = style.usercssData[key];
  }
  return {name, enabled: true, sections: style.sections.map(({code, start, domains}) => ({
    code, ...(typeof start === 'number' ? {start} : {}), domains,
  })), sourceCode: style.sourceCode, usercssData};
}

export async function exportDefaults({runtime, endpoint = 'http://127.0.0.1:9223', timeoutMs = 60000,
  output = path.join(base, 'ai-reading.stylus.json')} = {}) {
  if (!runtime) throw new Error('缺少 --runtime Stylus 安装目录。');
  const manifest = JSON.parse(await readFile(path.join(runtime, 'manifest.json'), 'utf8'));
  if (manifest.name !== 'Stylus' || manifest.version !== '2.4.13') throw new Error('默认样式导出需要项目指定的 Stylus 2.4.13。');
  const id = extensionIdForKey(manifest.key);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const client = await connectBrowser(endpoint, {timeoutMs: Math.min(5000, remaining())});
  let targetId;
  let failure;
  try {
    ({targetId} = await client.call('Target.createTarget', {url: `chrome-extension://${id}/manage.html`, background: true}, {timeoutMs: remaining()}));
    const {sessionId} = await client.call('Target.attachToTarget', {targetId, flatten: true}, {timeoutMs: remaining()});
    await client.call('Runtime.enable', {}, {sessionId, timeoutMs: remaining()});
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = await evaluate(client, `document.readyState === 'complete' && document.body?.id === 'stylus-manage' && Boolean(globalThis.chrome?.runtime?.sendMessage)`, {sessionId, timeoutMs: remaining()});
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      if (ready) break;
      await delay(Math.min(100, remaining()));
    }
    if (!ready) throw new Error('等待 Stylus 原生管理页和编译器就绪超时。');
    const defaults = [];
    for (const source of sources) {
      if (Date.now() >= deadline) throw new Error('编译默认阅读样式超时。');
      const sourceCode = await readFile(path.join(base, source.file), 'utf8');
      const request = {data: {method: 'invokeAPI', path: 'usercss.build', args: [sourceCode, {vars: false, dup: false}]}};
      const response = await evaluate(client, `new Promise(resolve => chrome.runtime.sendMessage(${JSON.stringify(request)}, response => {
        const error = chrome.runtime.lastError;
        resolve(error ? {error: {message: error.message}} : response);
      }))`, {sessionId, timeoutMs: remaining()});
      if (response?.error) throw new Error(`${source.name} 编译失败：${response.error.message || String(response.error)}`);
      defaults.push(cleanCompiledDefault(response?.data?.style, sourceCode, source));
    }
    await writeFile(output, JSON.stringify(defaults, null, 2) + '\n');
    return {output: path.resolve(output), styles: defaults.map(style => ({name: style.name, version: style.usercssData.version}))};
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (targetId) await client.call('Target.closeTarget', {targetId}, {timeoutMs: 2000});
    } catch (error) {
      if (!failure) throw new Error('默认样式已导出，但关闭编译页失败：' + error.message);
    } finally { client.close(); }
  }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--runtime', '--endpoint', '--timeout', '--output'].includes(args[index]) || !args[index + 1]) {
      throw new Error('用法：node --experimental-websocket userstyles/ai-reading/export-defaults.mjs --runtime DIR [--endpoint URL] [--timeout 秒] [--output FILE]');
    }
    options[args[index].slice(2)] = args[index + 1];
  }
  options.timeoutMs = options.timeout == null ? 60000 : Number(options.timeout) * 1000;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout 必须为正数秒。');
  console.log(JSON.stringify(await exportDefaults(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('[默认阅读样式导出] ' + error.message);
    process.exitCode = 1;
  });
}
