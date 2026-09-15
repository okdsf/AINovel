import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {extensionIdForKey} from '../userstyles/ai-reading/install-manager.mjs';
import {connectBrowser, evaluate} from './reading-cdp.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const buildMismatch = message => Object.assign(new Error(message), {code: 'READING_BUILD_MISMATCH'});
const targetGone = error => /No target with given id|No target with given targetId|Target closed|Session closed|Session with given id not found/.test(error.message);

export async function readExpectedRuntime(runtime) {
  if (!runtime) throw new Error('缺少 --runtime 扩展安装目录。');
  const [manifest, build] = await Promise.all([
    readFile(path.join(runtime, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(runtime, 'manager/build-info.json'), 'utf8').then(JSON.parse),
  ]);
  if (typeof build.version !== 'string' || !/^[a-f\d]{64}$/i.test(build.sourceHash || '')) {
    throw new Error('扩展安装目录缺少有效的版本校验信息，请重新运行 START.bat。');
  }
  return {extensionId: extensionIdForKey(manifest.key), version: build.version, sourceHash: build.sourceHash};
}

export function assertHealth(health, expected) {
  if (!health || typeof health !== 'object') throw new Error('阅读样式后台未返回有效状态。');
  if (health.version !== expected.version) {
    throw buildMismatch(`Runner 阅读管理器版本不一致：已加载 ${health.version || '未知'}，需要 ${expected.version}。`);
  }
  if (health.sourceHash !== expected.sourceHash) throw buildMismatch('Runner 仍在运行旧版阅读管理器，已加载源码与安装目录不一致。');
  if (health.loadedBuild?.backgroundHash !== expected.sourceHash || health.loadedBuild?.workerHash !== expected.sourceHash) {
    throw buildMismatch('Runner 尚未同时加载当前阅读后台与服务工作线程；磁盘版本信息不能证明实际代码已更新。');
  }
  if (health.error) throw new Error('阅读样式后台初始化失败：' + health.error);
  if (health.defaults?.status !== 'complete') {
    throw new Error('默认阅读样式尚未完成初始化：' + (health.defaults?.error || health.defaults?.status || '状态未知'));
  }
  // Installed count may be zero when the user deliberately deleted defaults.
  // The durable bootstrap status, not the current inventory, determines readiness.
  return health;
}

export async function checkReadingStyle({expected, endpoint = 'http://127.0.0.1:9223', timeoutMs = 45000,
  coldStart = false, connect = connectBrowser, sleep = delay, now = Date.now} = {}) {
  if (!(timeoutMs > 0)) throw new Error('检查超时必须为正数。');
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - now());
  let client;
  let targetId;
  let lastConnectionError;
  let failure;
  let reloaded = false;
  const healthUrl = `chrome-extension://${expected.extensionId}/manager/health.html`;
  async function closeCheckPage() {
    if (!targetId) return;
    try { await client.call('Target.closeTarget', {targetId}, {timeoutMs: 2000}); }
    catch (error) { if (!targetGone(error)) throw error; }
    targetId = undefined;
  }
  try {
    while (!client && now() < deadline) {
      try { client = await connect(endpoint, {timeoutMs: Math.min(5000, remaining())}); }
      catch (error) {
        lastConnectionError = error;
        if (now() < deadline) await sleep(Math.min(250, remaining()));
      }
    }
    if (!client) throw new Error(`等待 Runner CDP 就绪超时：${lastConnectionError?.message || '浏览器未启动'}`);
    while (now() < deadline) {
      const target = await client.call('Target.createTarget', {url: healthUrl, background: true}, {timeoutMs: remaining()});
      targetId = target.targetId;
      if (typeof targetId !== 'string' || !targetId) throw new Error('Runner 没有创建阅读样式检查页。');
      let sessionId;
      try {
        ({sessionId} = await client.call('Target.attachToTarget', {targetId, flatten: true}, {timeoutMs: remaining()}));
        await client.call('Runtime.enable', {}, {sessionId, timeoutMs: remaining()});
      } catch (error) {
        if (!targetGone(error)) throw error;
        await closeCheckPage();
        await sleep(Math.min(50, remaining()));
        continue;
      }
      while (now() < deadline) {
        let page;
        try {
          page = await evaluate(client, '({href: location.href, readyState: document.readyState, health: globalThis.novelwebReadingHealth || null})',
            {sessionId, timeoutMs: Math.min(5000, remaining())});
        } catch (error) {
          // The initial extension-page navigation can replace the execution context.
          if (targetGone(error)) {
            await closeCheckPage();
            await sleep(Math.min(50, remaining()));
            break;
          }
          if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
        }
        if (page?.readyState === 'complete' && page.href?.startsWith('chrome-error://')) {
          throw new Error('Chrome 拒绝加载阅读样式扩展检查页。请检查专用 Runner 的扩展是否启用、开发者模式及安装目录。');
        }
        if (page?.readyState === 'complete' && ![healthUrl, 'about:blank'].includes(page.href)) {
          throw new Error('阅读样式检查页地址已改变，无法验证扩展状态。');
        }
        const result = page?.href === healthUrl ? page.health : null;
        if (result?.status === 'error' || result?.status === 'complete') {
          try {
            if (result.status === 'error') {
              // The pre-health 1.1 manager exposes this precise API error. Other
              // connection or initialization errors are not evidence of an old build.
              if (result.error === 'Unknown API.novelwebReading.getHealth') {
                throw buildMismatch('Runner 正在运行旧版阅读管理器，尚未提供启动检查接口。');
              }
              throw new Error('阅读样式检查页无法读取后台：' + result.error);
            }
            return assertHealth(result.data, expected);
          }
          catch (error) {
            if (!coldStart || reloaded || error.code !== 'READING_BUILD_MISMATCH') throw error;
            // Chrome can restore a cached service worker even after a full browser
            // exit. Only the freshly launched branch may reload this extension once.
            reloaded = true;
            const expression = `(() => {
              if (location.href !== ${JSON.stringify(healthUrl)} || chrome.runtime.id !== ${JSON.stringify(expected.extensionId)}) {
                throw new Error('阅读样式重新加载来源不匹配。');
              }
              setTimeout(() => chrome.runtime.reload(), 50);
              return true;
            })()`;
            try {
              if (await evaluate(client, expression, {sessionId, timeoutMs: Math.min(5000, remaining())}) !== true) {
                throw new Error('阅读样式检查页没有接受扩展重新加载。');
              }
            } catch (reloadError) {
              if (!targetGone(reloadError) && !/Execution context was destroyed|Cannot find context/.test(reloadError.message)) throw reloadError;
            }
            await sleep(Math.min(250, remaining()));
            await closeCheckPage();
            break;
          }
        }
        await sleep(Math.min(200, remaining()));
      }
    }
    throw new Error('等待阅读样式后台就绪超时，检查页未收到初始化结果。');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (client) {
      try {
        await closeCheckPage();
      } catch (error) {
        if (!failure) throw new Error('阅读样式检查成功，但关闭检查页失败：' + error.message);
      } finally { client.close(); }
    }
  }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--cold-start') { options.coldStart = true; continue; }
    if (!['--runtime', '--endpoint', '--timeout'].includes(key) || !args[index + 1]) throw new Error('用法：node --experimental-websocket scripts/verify-reading-style.mjs --runtime DIR [--endpoint URL] [--timeout 秒] [--cold-start]');
    options[key.slice(2)] = args[++index];
  }
  const timeoutMs = options.timeout == null ? 45000 : Number(options.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout 必须为正数秒。');
  const expected = await readExpectedRuntime(options.runtime);
  const health = await checkReadingStyle({expected, endpoint: options.endpoint, timeoutMs, coldStart: options.coldStart});
  console.log(JSON.stringify({ok: true, version: health.version, sourceHash: health.sourceHash, defaults: health.defaults.status}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error('[阅读样式启动检查] ' + error.message);
    console.error('请关闭专用 Runner 浏览器后重新运行 START.bat；检查不会自动关闭浏览器或更改字体选择。');
    process.exitCode = 1;
  });
}
