import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const marker = join(root, 'public', 'fonts', 'lxgw-wenkai-screen', 'lxgwwenkaiscreen.css')

if (!existsSync(marker)) {
  console.log('\n⚠ public/fonts/ not found — running npm run fonts …\n')
  execSync('node scripts/fetch-fonts.mjs', { cwd: root, stdio: 'inherit' })
}
