import {ensurePublicFonts} from './fetch-fonts.mjs';

await ensurePublicFonts().catch(error => {
  console.error(`Could not prepare NovelWeb reading fonts: ${error.message}`);
  console.error('Check your network and run START.bat again; verified files will be reused.');
  process.exitCode = 1;
});
