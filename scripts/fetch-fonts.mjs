// scripts/fetch-fonts.mjs
//
// Downloads reading fonts to public/fonts/ with auto network-environment detection.
//
// Fonts are NOT committed to the repo (see .gitignore). This script is the
// canonical source of truth for what fonts the app uses and where they come
// from. Run on any new clone / new machine.
//
// Usage:
//   npm run fonts            normal: probe mirrors, download what's missing
//   npm run fonts -- --force re-download everything (ignore existing files)
//
// Design:
//   1. Probe several CDN mirrors with cheap HEAD requests (parallel, short timeout)
//   2. Pick the fastest responder per category (npm packages vs raw github)
//   3. Idempotent downloads — skip files that already exist
//   4. Logs which mirror won, so you can see what your network picked

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_DIR  = path.join(__dirname, '..', 'public', 'fonts')

const PROBE_TIMEOUT_MS    = 4000
const DOWNLOAD_TIMEOUT_MS = 60_000
const UA = 'Mozilla/5.0 (compatible; novelweb-font-fetcher)'
const FORCE = process.argv.includes('--force')

// ── Mirror catalogs ──────────────────────────────────────────────────────
// Each mirror has: name, base URL (with trailing slash), probeUrl (a small
// real file used for HEAD test — must exist on the mirror).
const NPM_MIRRORS = [
  { name: 'jsdelivr',        base: 'https://cdn.jsdelivr.net/npm/',
    probeUrl: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/package.json' },
  { name: 'jsdelivr-fastly', base: 'https://fastly.jsdelivr.net/npm/',
    probeUrl: 'https://fastly.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/package.json' },
  { name: 'jsdelivr-gcore',  base: 'https://gcore.jsdelivr.net/npm/',
    probeUrl: 'https://gcore.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/package.json' },
  { name: 'unpkg',           base: 'https://unpkg.com/',
    probeUrl: 'https://unpkg.com/lxgw-wenkai-screen-webfont@1.7.0/package.json' },
]

// gh mirrors: each stores the "google/fonts repo root" — paths under ofl/...
// jsdelivr needs explicit @main since the repo's default branch isn't master.
const GH_MIRRORS = [
  { name: 'jsdelivr-gh',        fontsRoot: 'https://cdn.jsdelivr.net/gh/google/fonts@main/',
    probeUrl: 'https://cdn.jsdelivr.net/gh/google/fonts@main/README.md' },
  { name: 'jsdelivr-fastly-gh', fontsRoot: 'https://fastly.jsdelivr.net/gh/google/fonts@main/',
    probeUrl: 'https://fastly.jsdelivr.net/gh/google/fonts@main/README.md' },
  { name: 'jsdelivr-gcore-gh',  fontsRoot: 'https://gcore.jsdelivr.net/gh/google/fonts@main/',
    probeUrl: 'https://gcore.jsdelivr.net/gh/google/fonts@main/README.md' },
  { name: 'github-raw',         fontsRoot: 'https://raw.githubusercontent.com/google/fonts/main/',
    probeUrl: 'https://raw.githubusercontent.com/google/fonts/main/README.md' },
]

// ── HTTP helpers ─────────────────────────────────────────────────────────
async function probe(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': UA } })
    return { ok: res.ok, status: res.status, latency: Date.now() - start }
  } catch {
    return { ok: false, latency: timeoutMs + 1 }
  } finally {
    clearTimeout(t)
  }
}

async function pickMirror(label, mirrors) {
  const results = await Promise.all(
    mirrors.map(m => probe(m.probeUrl).then(r => ({ ...m, ...r })))
  )
  const working = results.filter(r => r.ok).sort((a, b) => a.latency - b.latency)
  if (working.length === 0) {
    const detail = results.map(r => `${r.name}:${r.status ?? 'timeout'}`).join(' ')
    console.error(`  ✖ [${label}] no working mirror found  (${detail})`)
    return null
  }
  console.log(`  ✓ [${label}] using ${working[0].name} (${working[0].latency}ms)`)
  return working[0]
}

async function downloadFile(url, outPath) {
  const name = path.basename(outPath)
  if (!FORCE && existsSync(outPath)) {
    return { skipped: true, name }
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
    if (!res.ok) return { ok: false, name, error: `HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(outPath, buf)
    return { ok: true, name, size: buf.length }
  } catch (e) {
    return { ok: false, name, error: e.message }
  } finally {
    clearTimeout(t)
  }
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

function fmtKB(n) { return (n / 1024).toFixed(1) + ' KB' }
function fmtMB(n) { return (n / 1024 / 1024).toFixed(1) + ' MB' }

async function dirStats(dir) {
  let size = 0, count = 0
  async function walk(d) {
    if (!existsSync(d)) return
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else { size += (await fs.stat(p)).size; count++ }
    }
  }
  await walk(dir)
  return { size, count }
}

// ── Font catalog ─────────────────────────────────────────────────────────
const GOOGLE_FONTS = [
  { family: 'ZCOOL XiaoWei',         dir: 'zcoolxiaowei',         file: 'ZCOOLXiaoWei-Regular' },
  { family: 'Ma Shan Zheng',         dir: 'mashanzheng',          file: 'MaShanZheng-Regular' },
  { family: 'Long Cang',             dir: 'longcang',             file: 'LongCang-Regular' },
  { family: 'Liu Jian Mao Cao',      dir: 'liujianmaocao',        file: 'LiuJianMaoCao-Regular' },
  { family: 'Zhi Mang Xing',         dir: 'zhimangxing',          file: 'ZhiMangXing-Regular' },
  { family: 'ZCOOL KuaiLe',          dir: 'zcoolkuaile',          file: 'ZCOOLKuaiLe-Regular' },
  { family: 'ZCOOL QingKe HuangYou', dir: 'zcoolqingkehuangyou',  file: 'ZCOOLQingKeHuangYou-Regular' },
  // Blackletter for the NYT-style home wordmark
  { family: 'UnifrakturMaguntia',    dir: 'unifrakturmaguntia',   file: 'UnifrakturMaguntia-Book' },
]

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Font fetcher → ${FONT_DIR}${FORCE ? '  [--force]' : ''}`)
  await fs.mkdir(FONT_DIR, { recursive: true })

  console.log('\nProbing mirrors…')
  const [npm, gh] = await Promise.all([
    pickMirror('npm', NPM_MIRRORS),
    pickMirror('gh',  GH_MIRRORS),
  ])
  if (!npm || !gh) {
    console.error('\n✖ Could not reach any CDN mirror. Check your network and retry.')
    process.exit(1)
  }

  let ok = 0, skip = 0, fail = 0
  const tally = r => { if (r.ok) ok++; else if (r.skipped) skip++; else fail++ }

  // ── LXGW WenKai Screen ──
  console.log('\n[LXGW WenKai Screen]')
  const lxgwDir = path.join(FONT_DIR, 'lxgw-wenkai-screen')
  await fs.mkdir(lxgwDir, { recursive: true })
  const lxgwBase = `${npm.base}lxgw-wenkai-screen-webfont@1.7.0/`
  const lxgwCss = await getText(lxgwBase + 'lxgwwenkaiscreen.css')
  await fs.writeFile(path.join(lxgwDir, 'lxgwwenkaiscreen.css'), lxgwCss)

  const urls = [...lxgwCss.matchAll(/url\(['"]?([^'"\)]+\.woff2)['"]?\)/g)].map(m => m[1])
  console.log(`  ${urls.length} subset files`)
  let dot = 0
  for (const rel of urls) {
    // Preserve the relative path under lxgwDir so it matches the @font-face refs
    // in the CSS (e.g. './files/lxgwwenkaiscreen-subset-4.woff2').
    const cleanRel = rel.replace(/^\.\//, '')
    const url  = rel.startsWith('http') ? rel : lxgwBase + cleanRel
    const out  = path.join(lxgwDir, cleanRel)
    await fs.mkdir(path.dirname(out), { recursive: true })
    const r = await downloadFile(url, out)
    tally(r)
    if (r.ok) { process.stdout.write('.'); if (++dot % 60 === 0) process.stdout.write('\n  ') }
    else if (!r.skipped) console.log(`\n  ✖ ${r.name}: ${r.error}`)
  }
  console.log('')

  // ── Smiley Sans ──
  console.log('\n[Smiley Sans]')
  const r = await downloadFile(
    `${npm.base}@fontpkg/smiley-sans@2.0.4/SmileySans-Oblique.ttf.woff2`,
    path.join(FONT_DIR, 'SmileySans-Oblique.ttf.woff2')
  )
  tally(r); report(r, '  ')

  // ── Google Fonts (single TTF per family from upstream google/fonts) ──
  console.log('\n[Google Fonts]')
  for (const f of GOOGLE_FONTS) {
    const url = `${gh.fontsRoot}ofl/${f.dir}/${f.file}.ttf`
    const out = path.join(FONT_DIR, `${f.file}.ttf`)
    const r2 = await downloadFile(url, out)
    tally(r2); report(r2, `  ${f.family}: `)
  }

  // ── Summary ──
  const s = await dirStats(FONT_DIR)
  console.log(`\n${ok} new · ${skip} skipped · ${fail} failed`)
  console.log(`public/fonts/  →  ${fmtMB(s.size)} in ${s.count} files`)
  if (fail > 0) process.exit(1)
}

function report(r, prefix) {
  if (r.skipped) console.log(`${prefix}· ${r.name} (skip)`)
  else if (r.ok) console.log(`${prefix}+ ${r.name} (${fmtKB(r.size)})`)
  else           console.log(`${prefix}✖ ${r.name}: ${r.error}`)
}

main().catch(e => {
  console.error('\nFatal:', e.message)
  process.exit(1)
})
