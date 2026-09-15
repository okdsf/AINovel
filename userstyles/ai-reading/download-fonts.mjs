import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ensureFontAssets} from '../../scripts/font-downloads.mjs';

export async function ensureReadingFonts({destination, ...options} = {}) {
  const manifest = JSON.parse(await readFile(new URL('./fonts.json', import.meta.url), 'utf8'));
  if (!destination && !process.env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is unavailable. Choose a download directory with --out.');
  }
  destination = path.resolve(destination || path.join(process.env.LOCALAPPDATA, manifest.downloadSubdirectory));
  const assets = manifest.fonts.flatMap(font => [
    {filename: font.filename, sha256: font.sha256, urls: [font.sourceUrl]},
    {filename: font.licensePath, sha256: font.licenseSha256, urls: [font.licenseUrl]},
  ]);
  const result = await ensureFontAssets({destination, assets, ...options});
  if (!options.checkOnly) await writeFile(path.join(destination, 'fonts.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const checkOnly = process.argv.includes('--check');
  const args = process.argv.slice(2).filter(arg => arg !== '--check');
  if (args.length && (args.length !== 2 || args[0] !== '--out')) {
    console.error('Usage: node userstyles/ai-reading/download-fonts.mjs [--out DIRECTORY] [--check]');
    process.exitCode = 1;
  } else {
    await ensureReadingFonts({destination: args[1], checkOnly}).catch(error => {
      console.error(`Reading fonts: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
