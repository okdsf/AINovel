import assert from 'node:assert/strict';
import test from 'node:test';
import {ensureRunnerDeveloperMode} from '../scripts/ensure-runner-developer-mode.mjs';

const state=(pressed='false',extra={})=>({url:'chrome://extensions/',counts:{managers:1,toolbars:1,controls:1},
  ancestry:['cr-toggle#devMode','extensions-toolbar','extensions-manager'],pressed,disabled:'false',...extra});

function context(states,{confirmClick=true}={}) {
  const calls=[];
  let time=0,reads=0,clicks=0,closed=false;
  const client={
    async call(method,params) {
      calls.push({method,params});
      if(method==='Target.createTarget')return {targetId:'own-setup-page'};
      if(method==='Target.attachToTarget')return {sessionId:'own-session'};
      if(method==='Runtime.evaluate') {
        if(params.expression.includes('const performClick = true')) {
          clicks++;return {result:{value:{...state(),clicked:confirmClick}}};
        }
        return {result:{value:states[Math.min(reads++,states.length-1)]}};
      }
      return {};
    },
    close(){closed=true;},
  };
  return {calls,get clicks(){return clicks;},get closed(){return closed;},
    options:{connect:async()=>client,timeoutMs:1000,now:()=>time,sleep:async ms=>{time+=ms;}}};
}

function cleaned(ctx) {
  assert.deepEqual(ctx.calls.filter(call=>call.method==='Target.closeTarget'),[{method:'Target.closeTarget',params:{targetId:'own-setup-page'}}]);
  assert.equal(ctx.closed,true);
}

test('cold Chrome developer mode changes from false to confirmed true, clicking once and closing only its own page',async()=>{
  const ctx=context([state(),state(),state('true')]);
  assert.deepEqual(await ensureRunnerDeveloperMode(ctx.options),{developerMode:true,changed:true,verified:true});
  assert.equal(ctx.clicks,1);
  assert.deepEqual(ctx.calls[0],{method:'Target.createTarget',params:{url:'chrome://extensions/',background:true}});
  cleaned(ctx);
});

test('already enabled developer mode is read without clicking or toggling it off',async()=>{
  const ctx=context([state('true')]);
  assert.equal((await ensureRunnerDeveloperMode(ctx.options)).changed,false);
  assert.equal(ctx.clicks,0);
  cleaned(ctx);
});

test('missing, ambiguous and policy-disabled controls fail with exact location evidence',async()=>{
  for(const input of [state(null,{counts:{managers:1,toolbars:1,controls:0}}),
    state(null,{counts:{managers:1,toolbars:1,controls:2}}),state('false',{disabled:'true'})]) {
    const ctx=context([input]);
    await assert.rejects(ensureRunnerDeveloperMode(ctx.options),error=>error.message.includes('chrome://extensions/')&&error.message.includes('counts')&&error.message.includes('ancestry'));
    assert.equal(ctx.clicks,0);
    cleaned(ctx);
  }
});

test('a click without Chrome accepting the new state is an error, not a successful setup',async()=>{
  const ctx=context([state()]);
  await assert.rejects(ensureRunnerDeveloperMode(ctx.options),/did not confirm developer mode activation/);
  assert.equal(ctx.clicks,1);
  cleaned(ctx);
});

test('changed controls are rechecked before clicking and refused safely',async()=>{
  const ctx=context([state()],{confirmClick:false});
  await assert.rejects(ensureRunnerDeveloperMode(ctx.options),/changed before activation/);
  cleaned(ctx);
});

test('remote CDP endpoints are rejected before touching any browser',async()=>{
  await assert.rejects(ensureRunnerDeveloperMode({endpoint:'https://example.com:9223'}),/local HTTP/);
});
