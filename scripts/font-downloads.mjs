import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function assetPath(destination, filename) {
  const resolved = path.resolve(destination, filename);
  const relative = path.relative(path.resolve(destination), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe font asset path: ${filename}`);
  }
  return resolved;
}

// A verified cache never contacts the network. Downloads only replace a file
// after its complete contents pass the pinned checksum.
export async function ensureFontAssets({destination, assets, force = false, checkOnly = false,
  fetchImpl = globalThis.fetch, attempts = 3, retryDelayMs = 1_000, log = console.log}) {
  const results = [];
  const entries = assets.map((asset) => {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Missing SHA-256 for ${asset.filename}`);
    if (!Array.isArray(asset.urls) || !asset.urls.length) throw new Error(`Missing URL for ${asset.filename}`);
    return {...asset, file: assetPath(destination, asset.filename)};
  });
  async function ensure(asset) {
    if (!force) {
      try {
        if (sha256(await readFile(asset.file)) === asset.sha256) return {filename: asset.filename, status: 'verified'};
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (checkOnly) throw new Error(`Missing or damaged font asset: ${asset.filename}`);
    await mkdir(path.dirname(asset.file), {recursive: true});
    const temporary = `${asset.file}.partial-${randomUUID()}`;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      for (const url of asset.urls) {
        try {
          const response = await fetchImpl(url, {signal: AbortSignal.timeout(120_000)});
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
          const data = Buffer.from(await response.arrayBuffer());
          if (sha256(data) !== asset.sha256) throw new Error(`SHA-256 mismatch: ${asset.filename}`);
          await writeFile(temporary, data);
          await rename(temporary, asset.file);
          log(`Downloaded ${asset.filename}`);
          return {filename: asset.filename, status: 'downloaded'};
        } catch (error) {
          lastError = error;
          await rm(temporary, {force: true});
        }
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw new Error(`Could not prepare ${asset.filename}: ${lastError?.message || 'no download attempts'}`, {cause: lastError});
  }
  for (let index = 0; index < entries.length; index += 4) {
    // Wait for every in-flight asset before reporting a failure to the launcher.
    const batch = await Promise.allSettled(entries.slice(index, index + 4).map(ensure));
    const failures = batch.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), failures.map(result => result.reason.message).join('\n'));
    results.push(...batch.map(result => result.value));
  }
  log(`Fonts ready: ${results.filter(result => result.status === 'verified').length} verified, ${results.filter(result => result.status === 'downloaded').length} downloaded (${path.resolve(destination)})`);
  return results;
}
