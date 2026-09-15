import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectBrowser, evaluate} from './reading-cdp.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const selector = 'extensions-manager >>> extensions-toolbar >>> #devMode[role="button"]';

function expression(performClick = false) {
  return `(() => {
    const performClick = ${performClick};
    const managers = [...document.querySelectorAll('extensions-manager')];
    const toolbars = managers.length === 1 ? [...(managers[0].shadowRoot?.querySelectorAll('extensions-toolbar') || [])] : [];
    const controls = toolbars.length === 1 ? [...(toolbars[0].shadowRoot?.querySelectorAll('#devMode[role="button"]') || [])] : [];
    const control = controls.length === 1 ? controls[0] : null;
    const describe = element => element ? element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') : null;
    const ancestors = [];
    for (let element = control || toolbars[0] || managers[0]; element && ancestors.length < 10; element = element.parentElement || element.getRootNode()?.host) ancestors.push(describe(element));
    const result = {url: location.href, counts: {managers: managers.length, toolbars: toolbars.length, controls: controls.length},
      ancestry: ancestors, pressed: control?.getAttribute('aria-pressed') ?? null,
      disabled: control?.getAttribute('aria-disabled') ?? null};
    if (performClick) {
      if (location.protocol !== 'chrome:' || location.hostname !== 'extensions' || managers.length !== 1 || toolbars.length !== 1 || controls.length !== 1 || result.pressed !== 'false' || result.disabled !== 'false') {
        return {...result, clicked: false};
      }
      control.click();
      return {...result, clicked: true};
    }
    return result;
  })()`;
}

function detail(state) {
  return JSON.stringify({url:state?.url || 'chrome://extensions/', selector,
    counts:state?.counts || null, ancestry:state?.ancestry || [],
    pressed:state?.pressed ?? null, disabled:state?.disabled ?? null});
}

/** Only the cold-start launcher calls this. Chrome itself saves its protected settings. */
export async function ensureRunnerDeveloperMode({endpoint='http://127.0.0.1:9223', timeoutMs=45000,
  connect=connectBrowser, sleep=delay, now=Date.now}={}) {
  const address = new URL(endpoint);
  if (address.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(address.hostname) || address.username || address.password) {
    throw new Error('Developer mode setup requires the dedicated Runner local HTTP CDP endpoint.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Developer mode setup timeout must be positive.');
  const deadline=now()+timeoutMs;
  const remaining=()=>Math.max(1,deadline-now());
  let client, targetId, sessionId, state, failure, connectionError;
  let changed=false;
  try {
    while (!client && now()<deadline) {
      try { client=await connect(endpoint,{timeoutMs:Math.min(5000,remaining())}); }
      catch (error) {
        connectionError=error;
        if (now()<deadline) await sleep(Math.min(250,remaining()));
      }
    }
    if (!client) throw new Error('Runner CDP did not become ready: '+(connectionError?.message || 'timeout'));
    const target=await client.call('Target.createTarget',{url:'chrome://extensions/',background:true},{timeoutMs:remaining()});
    targetId=target.targetId;
    if (typeof targetId !== 'string' || !targetId) throw new Error('Chrome did not create the developer mode setup page.');
    ({sessionId}=await client.call('Target.attachToTarget',{targetId,flatten:true},{timeoutMs:remaining()}));
    await client.call('Runtime.enable',{},{sessionId,timeoutMs:remaining()});
    while (now()<deadline) {
      try { state=await evaluate(client,expression(),{sessionId,timeoutMs:remaining()}); }
      catch (error) {
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
        await sleep(Math.min(200,remaining()));
        continue;
      }
      if (Object.values(state?.counts || {}).some(count=>count>1)) throw new Error('Developer mode control is not unique: '+detail(state));
      const ready=state?.counts?.managers===1 && state.counts.toolbars===1 && state.counts.controls===1;
      if (ready) {
        const current=new URL(state.url);
        if (current.protocol !== 'chrome:' || current.hostname !== 'extensions') throw new Error('Unexpected developer mode page: '+detail(state));
        if (state.pressed==='true') return {developerMode:true,changed,verified:true};
        if (state.pressed!=='false' || state.disabled!=='false') throw new Error('Developer mode control is unavailable or disabled: '+detail(state));
        if (!changed) {
          const accepted=await evaluate(client,expression(true),{sessionId,timeoutMs:remaining()});
          if (!accepted?.clicked) throw new Error('Developer mode control changed before activation: '+detail(accepted));
          changed=true;
        }
      }
      await sleep(Math.min(200,remaining()));
    }
    throw new Error((changed ? 'Chrome did not confirm developer mode activation: ' : 'Developer mode control was not found before timeout: ')+detail(state));
  } catch (error) { failure=error; throw error; }
  finally {
    if (client) {
      try {
        if (targetId) await client.call('Target.closeTarget',{targetId},{timeoutMs:2000});
      } catch (error) {
        if (!failure) throw new Error('Developer mode was verified, but closing its setup page failed: '+error.message);
      } finally { client.close(); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options={};
    const args=process.argv.slice(2);
    for (let index=0;index<args.length;index+=2) {
      if (!['--endpoint','--timeout'].includes(args[index]) || !args[index+1]) throw new Error('Usage: node --experimental-websocket scripts/ensure-runner-developer-mode.mjs [--endpoint URL] [--timeout SECONDS]');
      if (args[index]==='--endpoint') options.endpoint=args[index+1];
      else options.timeoutMs=Number(args[index+1])*1000;
    }
    console.log(JSON.stringify(await ensureRunnerDeveloperMode(options)));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
