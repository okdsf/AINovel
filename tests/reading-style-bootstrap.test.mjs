import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {ensureReadingStyle} from '../scripts/ensure-reading-style.mjs';
import {extensionIdForKey, installManager, readTreeFiles} from '../userstyles/ai-reading/install-manager.mjs';

const bytes = Buffer.from('test-only pinned archive');
const key = Buffer.from('test-only extension public key').toString('base64');
const release = {version:'2.4.13',url:'https://github.com/openstyles/stylus/releases/download/v2.4.13/fixture.zip',
  size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),extensionId:extensionIdForKey(key)};
const fixture = {
  'manifest.json':JSON.stringify({name:'Stylus',version:'2.4.13',key,content_scripts:[]}),
  'sw.js':'      reason !== "sync" && putDoc(style);\n      return style;\n      styleMap.delete(id);',
  'popup.html':'<head></head><body><div id="popup-options"></div></body>',
  'js/common.js':'5619(_, ee, oe) { navigator.serviceWorker.onmessage = initRemotePort.bind(COMMANDS)',
  'js/popup-search.js':[
    '      const u = xe.tabUrlSupported && Ie.tryURL(xe.tabUrl);',
    '      const {c} = res;\n      let bias;',
    '      const href = where === "uso"',
    '      _e.openURLandHide.call({\n        href',
  ].join('\n'),
  'icon/48.png':'unpatched upstream asset',
};

async function context(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'novelweb-stylus-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('novelweb-stylus-test-'));
    await rm(resolved,{recursive:true,force:true});
  });
  const calls = {fetch:0,extract:0};
  const options = {root,release,
    fetch:async()=>{ calls.fetch++; return new Response(bytes); },
    extract:async(_archive,destination)=>{
      calls.extract++;
      for(const [name,value] of Object.entries(fixture)) {
        await mkdir(path.dirname(path.join(destination,name)),{recursive:true});
        await writeFile(path.join(destination,name),value);
      }
    },
  };
  return {root,calls,options};
}

async function modificationTimes(root) {
  return Object.fromEntries(await Promise.all(Object.keys(await readTreeFiles(root)).map(async name =>
    [name,(await stat(path.join(root,name))).mtimeMs])));
}

test('cold setup installs pinned Stylus, both defaults and deterministic build metadata; repeats are offline and unchanged', async t => {
  const {root,calls,options} = await context(t);
  const installed = await ensureReadingStyle(options);
  assert.equal(installed.changed,true);
  assert.equal(installed.downloaded,true);
  assert.equal(installed.extensionId,release.extensionId);
  assert.deepEqual(calls,{fetch:1,extract:1});
  const defaults=JSON.parse(await readFile(path.join(installed.runtime,'manager/defaults.json'),'utf8'));
  assert.equal(defaults.length,2);
  assert.deepEqual(defaults.map(style=>style.usercssData.namespace),['novelweb-ai-reading','novelweb-ai-reading']);
  const build=JSON.parse(await readFile(path.join(installed.runtime,'manager/build-info.json'),'utf8'));
  assert.deepEqual(build,{version:'1.2.0',sourceHash:installed.sourceHash});
  const worker=await readFile(path.join(installed.runtime,'sw.js'),'utf8');
  const background=await readFile(path.join(installed.runtime,'manager/background.js'),'utf8');
  assert.ok(worker.includes('globalThis.novelwebReadingWorkerSourceHash = ' + JSON.stringify(installed.sourceHash)));
  assert.ok(background.includes("const BACKGROUND_SOURCE_HASH = '" + installed.sourceHash + "'"));
  assert.ok(!background.includes('__NOVELWEB_READING_SOURCE_HASH__'));
  const before=await modificationTimes(root);
  assert.equal((await ensureReadingStyle(options)).changed,false);
  assert.equal((await installManager(installed.runtime)).changed,false);
  assert.equal((await ensureReadingStyle({...options,check:true})).checked,true);
  assert.deepEqual(calls,{fetch:1,extract:1});
  assert.deepEqual(await modificationTimes(root),before);
});

test('missing or corrupted unpatched assets are repaired from the verified cache without downloading', async t => {
  const {calls,options}=await context(t);
  const initial=await ensureReadingStyle(options);
  const asset=path.join(initial.runtime,'icon/48.png');
  await rm(asset);
  await assert.rejects(ensureReadingStyle({...options,check:true}),/Close the dedicated Runner/);
  assert.equal((await ensureReadingStyle(options)).changed,true);
  assert.equal(await readFile(asset,'utf8'),fixture['icon/48.png']);
  await writeFile(asset,'broken');
  assert.equal((await ensureReadingStyle(options)).changed,true);
  assert.deepEqual(calls,{fetch:1,extract:3});
});

test('corrupt cache is redownloaded without rewriting a complete runtime', async t => {
  const {root,calls,options}=await context(t);
  const installed=await ensureReadingStyle(options);
  const before=await modificationTimes(installed.runtime);
  await writeFile(path.join(root,'stylus-v2.4.13.zip'),'broken');
  await assert.rejects(ensureReadingStyle({...options,check:true}),/setup is incomplete/);
  const repaired=await ensureReadingStyle(options);
  assert.equal(repaired.downloaded,true);
  assert.equal(repaired.changed,false);
  assert.deepEqual(calls,{fetch:2,extract:1});
  assert.deepEqual(await modificationTimes(installed.runtime),before);
});

test('read-only check never creates directories or requests the network', async t => {
  const {root,calls,options}=await context(t);
  await assert.rejects(ensureReadingStyle({...options,root:path.join(root,'absent'),check:true}),/setup is incomplete/);
  assert.deepEqual(await readdir(root),[]);
  assert.deepEqual(calls,{fetch:0,extract:0});
});

test('bad download is rejected before extraction and leaves no partial installation', async t => {
  const {root,calls,options}=await context(t);
  let downloads=0;
  await assert.rejects(ensureReadingStyle({...options,retryDelayMs:0,fetch:async()=>{downloads++;return new Response('wrong');}}),/SHA-256/);
  assert.equal(downloads,1);
  assert.equal(calls.extract,0);
  assert.deepEqual(await readdir(root),[]);
});

test('temporary connection and response-stream failures are retried up to three times', async t => {
  const {options}=await context(t);
  let downloads=0;
  const result=await ensureReadingStyle({...options,retryDelayMs:0,fetch:async()=>{
    downloads++;
    if(downloads===1)throw new TypeError('fetch failed',{cause:new Error('connection reset')});
    if(downloads===2)return {ok:true,arrayBuffer:async()=>{throw new Error('body disconnected');}};
    return new Response(bytes);
  }});
  assert.equal(downloads,3);
  assert.equal(result.changed,true);
});

test('repeated HTTP failures stop at the requested attempt limit with their cause and no partial files', async t => {
  const {root,calls,options}=await context(t);
  let downloads=0;
  await assert.rejects(ensureReadingStyle({...options,attempts:2,retryDelayMs:0,fetch:async()=>{
    downloads++;return new Response('unavailable',{status:503});
  }}),error=>/after 2 attempt.*HTTP 503/.test(error.message)&&error.cause?.message==='HTTP 503');
  assert.equal(downloads,2);
  assert.equal(calls.extract,0);
  assert.deepEqual(await readdir(root),[]);
});

test('failed staged extraction leaves the previous runtime intact and removes its staging directory', async t => {
  const {root,options}=await context(t);
  const installed=await ensureReadingStyle(options);
  const asset=path.join(installed.runtime,'icon/48.png');
  await writeFile(asset,'needs repair');
  const before=await modificationTimes(installed.runtime);
  await assert.rejects(ensureReadingStyle({...options,extract:async()=>{throw new Error('extract failed');}}),/extract failed/);
  assert.equal(await readFile(asset,'utf8'),'needs repair');
  assert.deepEqual(await modificationTimes(installed.runtime),before);
  assert.deepEqual((await readdir(root)).sort(),['stylus-v2.4.13','stylus-v2.4.13.zip']);
});

test('Windows extractor rejects escaping paths and case-insensitive duplicate entries', {skip:process.platform !== 'win32'}, async t => {
  const {root}=await context(t);
  const create=path.join(root,'create-invalid.ps1');
  await writeFile(create,`param([string]$Root)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($kind in @('escape','duplicate')) {
  $zip=[IO.Compression.ZipFile]::Open((Join-Path $Root ($kind+'.zip')),[IO.Compression.ZipArchiveMode]::Create)
  try {
    if ($kind -eq 'escape') { $null=$zip.CreateEntry('../outside.txt') }
    else { $null=$zip.CreateEntry('same.txt'); $null=$zip.CreateEntry('SAME.txt') }
  } finally { $zip.Dispose() }
}`);
  const run=promisify(execFile);
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',create,'-Root',root],{windowsHide:true});
  const expand=fileURLToPath(new URL('../scripts/expand-reading-style.ps1',import.meta.url));
  for (const kind of ['escape','duplicate']) {
    const destination=path.join(root,kind);
    await mkdir(destination);
    await assert.rejects(run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',expand,
      '-Archive',path.join(root,kind+'.zip'),'-Destination',destination],{windowsHide:true}),/unsafe|duplicate/);
    assert.deepEqual(await readdir(destination),[]);
  }
  assert.ok(!(await readdir(root)).includes('outside.txt'));
});
