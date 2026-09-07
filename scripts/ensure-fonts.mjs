import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  console.log(`\n${missing.length} optional reading font(s) missing. Using system fonts.`)
  console.log('Run "npm run fonts" to download the reading fonts when convenient.\n')
}
