import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {extensionIdForKey, getManagerSource, installManager, readTreeFiles} from '../userstyles/ai-reading/install-manager.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const releaseFile = new URL('../userstyles/ai-reading/stylus-release.json', import.meta.url);
const RECORD = 'novelweb-stylus-install.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);

function inside(root, candidate) {
  const result = path.resolve(candidate);
  const relative = path.relative(root, result);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Refusing a reading runtime path outside its configured root: ' + result);
  }
  return result;
}

async function rejectLink(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Reading runtime paths must not be symbolic links: ' + file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function safeRemove(root, file) {
  const target = inside(root, file);
  await rejectLink(target);
  await rm(target, {recursive: true, force: true});
}

const fileHashes = files => Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)]));
const sameHashes = (left, right) => left && Object.keys(left).length === Object.keys(right).length &&
  Object.entries(right).every(([name, value]) => left[name] === value);

async function archiveValid(file, release) {
  try {
    await rejectLink(file);
    const bytes = await readFile(file);
    return bytes.length === release.size && hash(bytes) === release.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function installedValid(runtime, release, sourceHash) {
  try {
    await rejectLink(runtime);
    const files = await readTreeFiles(runtime);
    const record = JSON.parse(files[RECORD]?.toString() || 'null');
    const manifest = JSON.parse(files['manifest.json']?.toString() || 'null');
    const manager = JSON.parse(files['novelweb-manager-install.json']?.toString() || 'null');
    delete files[RECORD];
    if (record?.schemaVersion !== 1 || record.releaseSha256 !== release.sha256 ||
        record.sourceHash !== sourceHash || !record.upstreamFiles ||
        manifest?.version !== release.version || manifest?.name !== 'Stylus' || !manifest.key ||
        extensionIdForKey(manifest.key) !== release.extensionId ||
        manager?.sourceHash !== sourceHash || manager?.extensionId !== release.extensionId ||
        !sameHashes(record.deployedFiles, fileHashes(files))) return false;
    // Every original upstream file remains accounted for, including unpatched assets.
    for (const [name, digest] of Object.entries(record.upstreamFiles)) {
      if (!files[name] || !/^[a-f0-9]{64}$/.test(digest)) return false;
      const original = files['novelweb-upstream/' + name] || files[name];
      if (hash(original) !== digest) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof TypeError) return false;
    throw error;
  }
}

async function defaultExtract(archive, destination) {
  if (process.platform !== 'win32') throw new Error('Automatic Stylus extraction currently requires Windows PowerShell.');
  const env = {...process.env};
  // Windows PowerShell must construct its own module path, even when invoked by PowerShell 7.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(scriptDirectory, 'expand-reading-style.ps1'), '-Archive', archive, '-Destination', destination],
  {env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024});
}

async function fetchArchive(release, options) {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3 ||
      !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error('Stylus download requires 1–3 attempts and a retry delay between 0 and 30000 ms.');
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    let bytes;
    try {
      const response = await (options.fetch || globalThis.fetch)(release.url, {signal: AbortSignal.timeout(120_000)});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt + 1 === attempts) {
        const detail = [error.message, error.cause?.code, error.cause?.message].filter(Boolean).join(': ');
        throw new Error(`Could not download pinned Stylus after ${attempts} attempt(s): ${detail}`, {cause: error});
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      continue;
    }
    // Integrity failures are final; repeating a mismatched upstream payload cannot repair it.
    if (bytes.length !== release.size || hash(bytes) !== release.sha256) {
      throw new Error('Stylus download did not match the pinned official SHA-256 and size.');
    }
    return bytes;
  }
}

/** Prepare an unpacked Stylus runtime; injected fetch/extract/release enable isolated tests. */
export async function ensureReadingStyle(options = {}) {
  const release = options.release || JSON.parse(await readFile(releaseFile, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256) ||
      !Number.isSafeInteger(release.size) || release.size <= 0 || !/^[a-p]{32}$/.test(release.extensionId)) {
    throw new Error('The pinned Stylus release metadata is invalid.');
  }
  if (!options.root && !process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable; pass --root DIRECTORY.');
  const root = path.resolve(options.root || path.join(process.env.LOCALAPPDATA, 'NovelWeb/ReadingStyle'));
  const runtime = inside(root, path.join(root, 'stylus-v' + release.version));
  const archive = inside(root, path.join(root, 'stylus-v' + release.version + '.zip'));
  const {sourceHash} = await getManagerSource();
  await rejectLink(root);
  const cached = await archiveValid(archive, release);
  const installed = await installedValid(runtime, release, sourceHash);
  const result = {runtime, extensionId: release.extensionId, sourceHash, stylusVersion: release.version,
    changed: false, downloaded: false, verified: true};
  if (options.check) {
    if (!cached || !installed) throw new Error('Reading style setup is incomplete or changed. Close the dedicated Runner browser, then run START.BAT to prepare its fonts and Stylus extension.');
    return {...result, checked: true};
  }
  if (cached && installed) return result;
  await mkdir(root, {recursive: true});
  if (!cached) {
    const temporary = inside(root, archive + '.partial-' + randomUUID());
    try {
      const bytes = await fetchArchive(release, options);
      await writeFile(temporary, bytes, {flag: 'wx'});
      await rejectLink(archive);
      await rename(temporary, inside(root, archive));
      result.downloaded = true;
    } finally { await safeRemove(root, temporary); }
  }
  if (installed) return result;

  const stage = inside(root, path.join(root, '.stylus-stage-' + randomUUID()));
  const backup = inside(root, path.join(root, '.stylus-previous-' + randomUUID()));
  await mkdir(stage);
  let previous = false;
  try {
    await (options.extract || defaultExtract)(archive, stage);
    const upstreamFiles = fileHashes(await readTreeFiles(stage));
    const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
    if (manifest.version !== release.version || manifest.name !== 'Stylus' || extensionIdForKey(manifest.key) !== release.extensionId) {
      throw new Error('The extracted package is not the pinned official Stylus extension.');
    }
    const manager = await installManager(stage);
    if (manager.sourceHash !== sourceHash) throw new Error('Reading manager source changed during setup; run START.BAT again.');
    const record = {schemaVersion: 1, releaseSha256: release.sha256, sourceHash, upstreamFiles,
      deployedFiles: fileHashes(await readTreeFiles(stage))};
    await writeFile(path.join(stage, RECORD), JSON.stringify(record, null, 2) + '\n');
    if (!await installedValid(stage, release, sourceHash)) throw new Error('Staged Stylus integrity verification failed.');
    await rejectLink(runtime);
    try { await rename(inside(root, runtime), inside(root, backup)); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(inside(root, stage), inside(root, runtime)); }
    catch (error) {
      if (previous) { await rename(inside(root, backup), inside(root, runtime)); previous = false; }
      throw error;
    }
    result.changed = true;
    if (previous) { await safeRemove(root, backup); previous = false; }
    return result;
  } finally { await safeRemove(root, stage); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const argument = args.shift();
      if (argument === '--check' && !options.check) options.check = true;
      else if (argument === '--root' && !options.root && args[0] && !args[0].startsWith('--')) options.root = args.shift();
      else throw new Error('Usage: node scripts/ensure-reading-style.mjs [--root DIRECTORY] [--check]');
    }
    console.log(JSON.stringify(await ensureReadingStyle(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
