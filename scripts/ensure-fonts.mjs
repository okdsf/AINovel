import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fontsDir = join(root, 'public', 'fonts')

const markers = [
  'lxgw-wenkai-screen/lxgwwenkaiscreen.css',
  'SmileySans-Oblique.ttf.woff2',
  'ZCOOLXiaoWei-Regular.ttf',
  'UnifrakturMaguntia-Book.ttf',
]

const missing = markers.filter(f => !existsSync(join(fontsDir, f)))

if (missing.length > 0) {
  console.log(`\n⚠ ${missing.length} font(s) missing — downloading …\n`)
  try {
    execSync('node scripts/fetch-fonts.mjs', { cwd: root, stdio: 'inherit' })
  } catch {
    console.warn('  ⚠ Font download failed (no network?). Will retry on next startup.\n')
  }
}
