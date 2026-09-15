import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const sourceBase = path.dirname(fileURLToPath(import.meta.url));
export const MANAGER_VERSION = '1.2.0';
const hash = value => createHash('sha256').update(value).digest('hex');

export async function readTreeFiles(directory, prefix = '') {
  const files = {};
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in the reading extension: ' + relative);
    if (entry.isDirectory()) Object.assign(files, await readTreeFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files[relative] = await readFile(path.join(directory, entry.name));
    else throw new Error('Unsupported reading extension file: ' + relative);
  }
  return files;
}

export async function getManagerSource(base = sourceBase) {
  const files = {};
  for (const [name, value] of Object.entries(await readTreeFiles(path.join(base, 'manager')))) files['manager/' + name] = value;
  files['manager/defaults.json'] = await readFile(path.join(base, 'ai-reading.stylus.json'));
  const records = Object.entries(files).map(([name, value]) => name + '\0' + hash(value));
  records.push('install-manager.mjs\0' + hash(await readFile(path.join(base, 'install-manager.mjs'))));
  const sourceHash = hash(records.sort().join('\n'));
  return {sourceHash, files};
}

export function extensionIdForKey(key) {
  if (typeof key !== 'string' || !key) throw new Error('The official Stylus extension key is missing.');
  return hash(Buffer.from(key, 'base64')).slice(0,32).replace(/./g, value => String.fromCharCode(97 + parseInt(value,16)));
}

async function writeChanged(file, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try { if ((await readFile(file)).equals(data)) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, data);
  return true;
}

export async function installManager(runtime, {base = sourceBase} = {}) {
  if (!runtime) {
    if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable; pass the Stylus runtime directory.');
    runtime = path.join(process.env.LOCALAPPDATA, 'NovelWeb/ReadingStyle/stylus-v2.4.13');
  }
  runtime = path.resolve(runtime);
  const source = await getManagerSource(base);
const manifestPath = path.join(runtime, 'manifest.json');
const originalManifest = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(originalManifest);
if (manifest.version !== '2.4.13' || manifest.name !== 'Stylus') throw new Error('This integration requires the verified Stylus 2.4.13 package.');

function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Upstream integration anchor is not unique: ' + anchor.slice(0,100));
  return source.replace(anchor, replacement);
}

// Save pristine upstream files once. Reinstalling starts from those originals.
const backup = path.join(runtime, 'novelweb-upstream');
await mkdir(backup, {recursive: true});
async function pristine(name) {
  const saved = path.join(backup, name);
  try { return await readFile(saved, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = await readFile(path.join(runtime, name), 'utf8');
    await mkdir(path.dirname(saved), {recursive: true});
    await writeFile(saved, value);
    return value;
  }
}
const sourceManifest = JSON.parse(await pristine('manifest.json'));
const common = await readFile(path.join(runtime, 'js/common.js'), 'utf8');
if (!common.includes('5619(_, ee, oe) {') || !common.includes('navigator.serviceWorker.onmessage = initRemotePort.bind(COMMANDS)')) throw new Error('Verified Stylus worker bridge is missing.');
let worker = (await pristine('sw.js')).replaceAll('\r\n','\n');
let popup = await pristine('popup.html');
let search = (await pristine('js/popup-search.js')).replaceAll('\r\n','\n');

worker = once(worker, '      reason !== "sync" && putDoc(style);\n      return style;',
  '      reason !== "sync" && putDoc(style);\n      globalThis.novelwebReadingOnSaved?.(style, reason);\n      return style;');
worker = once(worker, '      styleMap.delete(id);',
  '      styleMap.delete(id);\n      globalThis.novelwebReadingOnSaved?.({id}, "remove");');
worker += '\n// NovelWeb: local style manager integration.\n' +
  'globalThis.novelwebReadingWorkerSourceHash = ' + JSON.stringify(source.sourceHash) + ';\n' +
  'importScripts("manager/background.js");\n';

popup = once(popup, '<div id="popup-options">', '<button type="button" id="novelweb-reading-open">已安装 / 已启用样式</button><p id="novelweb-reading-source"></p><div id="popup-options">');
popup = once(popup, '</head>', '<link rel="stylesheet" href="manager/launcher.css"></head>');
popup = once(popup, '</body>', '<script src="manager/popup-entry.js"></script></body>');

// USO's index categorizes Gemini themes under "google". Search the named app,
// without widening to every Google theme when no exact-host category exists.
search = once(search, '      const u = xe.tabUrlSupported && Ie.tryURL(xe.tabUrl);',
  `      const u = xe.tabUrlSupported && Ie.tryURL(xe.tabUrl);
      const app = u?.hostname === "gemini.google.com" ? "gemini" : ["chatgpt.com", "chat.openai.com"].includes(u?.hostname) ? "chatgpt" : null;
      if (app) {
        category = app === "gemini" ? "gemini.google.com" : "chatgpt";
        host3 = "";
        rxCategory = new RegExp(app, "i");
        return category !== old;
      }`);
search = once(search, '      const {c} = res;\n      let bias;',
  `      const {c} = res;
      const host = xe.tabUrlSupported && Ie.tryURL(xe.tabUrl)?.hostname;
      let appMatch;
      if (host === "gemini.google.com") appMatch = ["gemini", "gemini.google.com"].includes(c) || /\\bgemini\\b/i.test(res.n);
      else if (host === "chatgpt.com" || host === "chat.openai.com") appMatch = ["chatgpt", "chatgpt.com", "chat.openai.com"].includes(c) || /\\bchat\\s?gpt\\b/i.test(res.n);
      if (appMatch != null) return appMatch && query.every(isInHaystack, res) && (res._bias = 1);
      let bias;`);
search = once(search, '      const href = where === "uso"', '      let href = where === "uso"');
search = once(search, '      _e.openURLandHide.call({\n        href',
  `      const appHost = xe.tabUrlSupported && Ie.tryURL(xe.tabUrl)?.hostname;
      const appName = appHost === "gemini.google.com" ? "Gemini" : ["chatgpt.com", "chat.openai.com"].includes(appHost) ? "ChatGPT" : "";
      if (appName && ["uso", "usoa", "usw"].includes(where)) {
        const link = new URL(href);
        link.search = "";
        if (where === "uso") link.pathname = "/styles/browse";
        link.searchParams.set(where === "uso" ? "search_terms" : where === "usoa" ? "search" : "q", appName + (q ? " " + decodeURIComponent(q) : ""));
        href = link.href;
      }
      _e.openURLandHide.call({
        href`);

sourceManifest.content_scripts.push({matches: ['https://chatgpt.com/*','https://gemini.google.com/*'], js: ['manager/page-entry.js'], run_at: 'document_idle'});
const outputs = {...source.files,
  // Hash the template once, then stamp both executable outputs. This avoids a
  // circular content hash while proving what each loaded worker actually ran.
  'manager/background.js': Buffer.from(once(source.files['manager/background.js'].toString('utf8'),
    '__NOVELWEB_READING_SOURCE_HASH__', source.sourceHash)),
  'sw.js': Buffer.from(worker),
  'popup.html': Buffer.from(popup),
  'js/popup-search.js': Buffer.from(search),
  'manifest.json': Buffer.from(JSON.stringify(sourceManifest,null,2) + '\n'),
  'manager/build-info.json': Buffer.from(JSON.stringify({version: MANAGER_VERSION, sourceHash: source.sourceHash},null,2) + '\n'),
};
let changed = false;
for (const [name, value] of Object.entries(outputs)) changed = await writeChanged(path.join(runtime,name),value) || changed;
const extensionId = extensionIdForKey(sourceManifest.key);
const report = {version:MANAGER_VERSION,stylusVersion:manifest.version,sourceHash:source.sourceHash,extensionId,
  files:Object.fromEntries(Object.entries(outputs).map(([name,value]) => [name,hash(value)]))};
changed = await writeChanged(path.join(runtime,'novelweb-manager-install.json'),JSON.stringify(report,null,2)+'\n') || changed;
return {installed:true,runtime,version:report.version,extensionId,sourceHash:source.sourceHash,changed,reloadRequired:changed};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node userstyles/ai-reading/install-manager.mjs [RUNTIME]');
    console.log(JSON.stringify(await installManager(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
