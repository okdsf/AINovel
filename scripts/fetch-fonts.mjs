import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ensureFontAssets} from './font-downloads.mjs';

export const publicFontsDirectory = fileURLToPath(new URL('../public/fonts/', import.meta.url));

// Every CSS file, font subset and TTF is pinned. No CDN probing is needed when
// this complete asset list passes its checksum verification.
export async function ensurePublicFonts({destination = publicFontsDirectory, ...options} = {}) {
  const manifest = JSON.parse(await readFile(new URL('./web-fonts.json', import.meta.url), 'utf8'));
  const assets = manifest.assets.map(asset => ({
    filename: asset.filename,
    sha256: asset.sha256,
    urls: manifest.sources[asset.source].map(base => new URL(asset.path, base).href),
  }));
  return ensureFontAssets({destination, assets, ...options});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const checkOnly = args.includes('--check');
  const rest = args.filter(arg => arg !== '--force' && arg !== '--check');
  if ((force && checkOnly) || (rest.length && (rest.length !== 2 || rest[0] !== '--out'))) {
    console.error('Usage: node scripts/fetch-fonts.mjs [--out DIRECTORY] [--force | --check]');
    process.exitCode = 1;
  } else {
    await ensurePublicFonts({destination: rest[1], force, checkOnly}).catch(error => {
      console.error(`Web fonts: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
