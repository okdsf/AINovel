// scripts/publish-public.mjs
//
// Snapshot the current engine state to the public AINovel repo.
//
// The public checkout is treated as a build artifact (default: ../AINovel).
// You only ever edit this private NovelWeb directory; this script handles
// cloning, copying, leak-scanning, committing, and pushing.
//
// Usage:
//   npm run publish                  # interactive — asks for commit message, confirms push
//   npm run publish -- -m "message"  # use given commit message
//   npm run publish -- --dry         # do everything except commit / push
//   npm run publish -- --no-push     # commit but don't push
//
// Env vars:
//   AINOVEL_DIR     override target directory (default ../AINovel)

import fs from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execSync } from 'node:child_process'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const __dirname     = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_ROOT   = path.resolve(__dirname, '..')
const PUBLIC_REMOTE = 'https://github.com/okdsf/AINovel.git'
const PUBLIC_DIR    = process.env.AINOVEL_DIR || path.resolve(SOURCE_ROOT, '..', 'AINovel')

// Anything containing patterns from .private/leak-patterns.txt is a private leak.
// We deliberately load these at runtime from a non-shipped file so the published
// script itself does not embed (and therefore expose) the private fingerprints.
const LEAK_PATTERNS_FILE = '.private/leak-patterns.txt'

// What to copy from SOURCE_ROOT into the public checkout.
const COPY_FILES = [
  'CLAUDE.md',
  'README.md',
  'LICENSE',
  'DEMO.md',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.js',
  'start.bat',
]
const COPY_DIRS_RECURSIVE = [
  'src',
  'server',
]
const COPY_SCRIPT_FILES = [
  'scripts/fetch-fonts.mjs',
  'scripts/ensure-fonts.mjs',
  'scripts/publish-public.mjs',
  'scripts/public-gitignore.template.txt',
]
const COPY_DATA_FILES = [
  // taxonomy.json deliberately NOT here — the private NovelWeb taxonomy
  // contains brand-name outlets that must not ship publicly. The public
  // taxonomy lives in scripts/demo-content/data/archive/taxonomy.json and
  // is overlaid onto AINovel by the DEMO_CONTENT_DIR copy step below.
  'data/archive/events/_example.json',
  'data/archive/entities/_example.json',
]
const COPY_DATA_DIRS = [
  'data/archive/pieces/_example',
]
// Demo story (Murloc-at-WhiteHouse + two fictional-outlet pieces). Lives outside data/
// so it stays invisible to the NovelWeb dev app — only ships to AINovel.
const DEMO_CONTENT_DIR = 'scripts/demo-content'
const COPY_PUBLIC_FILES = [
  'public/icons.svg',
]

// ── argv parsing ──────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const argIndex = (...names) => argv.findIndex(a => names.includes(a))
const argValue = (...names) => { const i = argIndex(...names); return i >= 0 ? argv[i + 1] : null }

const dry         = flag('--dry')
const noPush      = flag('--no-push')
const commitMsg0  = argValue('-m', '--message')

// ── Helpers ───────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf-8',
    shell: process.platform === 'win32' && cmd === 'git' ? false : opts.shell,
  })
  if (r.error) throw r.error
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`)
  }
  return opts.capture ? r.stdout : null
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true })
  await fs.copyFile(src, dst)
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name)
    const dp = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyDir(sp, dp)
    else                    await copyFile(sp, dp)
  }
}

function isTextFile(name) {
  return /\.(md|txt|js|mjs|ts|vue|json|html|css|svg|yml|yaml|gitignore|bat|sh)$/i.test(name)
    || name === '.gitignore' || name === 'LICENSE'
}

function loadLeakPatterns() {
  const p = path.join(SOURCE_ROOT, LEAK_PATTERNS_FILE)
  if (!existsSync(p)) {
    throw new Error(
      `Missing ${LEAK_PATTERNS_FILE} — cannot run leak scan without a fingerprint list. ` +
      `Add one line per private string you want to block from public publishes.`
    )
  }
  return readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
}

function scanLeaks(dir, patterns) {
  const hits = []
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (isTextFile(entry.name)) {
        const text = readFileSync(p, 'utf-8')
        for (const pattern of patterns) {
          if (text.includes(pattern)) {
            hits.push({ file: path.relative(dir, p), pattern })
            break
          }
        }
      }
    }
  }
  walk(dir)
  return hits
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`source  : ${SOURCE_ROOT}`)
  console.log(`target  : ${PUBLIC_DIR}`)
  console.log(`remote  : ${PUBLIC_REMOTE}`)
  console.log()

  // 1. Ensure public checkout exists.
  if (!existsSync(PUBLIC_DIR)) {
    console.log(`Cloning ${PUBLIC_REMOTE} into ${PUBLIC_DIR}...`)
    run('git', ['clone', PUBLIC_REMOTE, PUBLIC_DIR])
  } else if (!existsSync(path.join(PUBLIC_DIR, '.git'))) {
    throw new Error(`${PUBLIC_DIR} exists but is not a git repo. Remove it or set AINOVEL_DIR elsewhere.`)
  } else {
    // Sync with remote if possible
    console.log('Refreshing target...')
    run('git', ['fetch', 'origin'], { cwd: PUBLIC_DIR, allowFail: true })
    const hasOriginMain = run('git', ['rev-parse', '--verify', 'origin/main'],
                              { cwd: PUBLIC_DIR, capture: true, allowFail: true })
    if (hasOriginMain) {
      run('git', ['reset', '--hard', 'origin/main'], { cwd: PUBLIC_DIR })
    }
    run('git', ['clean', '-fd'], { cwd: PUBLIC_DIR })
  }

  // 2. Wipe public working tree (preserve .git/ and node_modules/).
  //    node_modules belongs to the user's local install — wiping it would force
  //    a re-install every publish and risks EPERM when files are held by a
  //    running dev server.
  console.log('Wiping target working tree...')
  const PRESERVE = new Set(['.git', 'node_modules'])
  for (const entry of await fs.readdir(PUBLIC_DIR)) {
    if (PRESERVE.has(entry)) continue
    await fs.rm(path.join(PUBLIC_DIR, entry), { recursive: true, force: true })
  }

  // 3. Copy whitelisted content.
  console.log('Copying engine files...')
  for (const f of [...COPY_FILES, ...COPY_SCRIPT_FILES, ...COPY_DATA_FILES, ...COPY_PUBLIC_FILES]) {
    const src = path.join(SOURCE_ROOT, f)
    if (!existsSync(src)) {
      console.warn(`  skip (missing): ${f}`)
      continue
    }
    await copyFile(src, path.join(PUBLIC_DIR, f))
  }
  for (const d of [...COPY_DIRS_RECURSIVE, ...COPY_DATA_DIRS]) {
    const src = path.join(SOURCE_ROOT, d)
    if (!existsSync(src)) continue
    await copyDir(src, path.join(PUBLIC_DIR, d))
  }

  // 3b. Demo content — overlays scripts/demo-content/ onto AINovel root.
  const demoSrc = path.join(SOURCE_ROOT, DEMO_CONTENT_DIR)
  if (existsSync(demoSrc)) {
    console.log('Copying demo content...')
    await copyDir(demoSrc, PUBLIC_DIR)
  }

  // 4. Substitute the public-safe .gitignore.
  const tpl = await fs.readFile(path.join(SOURCE_ROOT, 'scripts', 'public-gitignore.template.txt'), 'utf-8')
  await fs.writeFile(path.join(PUBLIC_DIR, '.gitignore'), tpl)

  // 5. Leak scan.
  console.log('Scanning for private-content leaks...')
  const leakPatterns = loadLeakPatterns()
  const leaks = scanLeaks(PUBLIC_DIR, leakPatterns)
  if (leaks.length > 0) {
    console.error('\n✖ LEAK DETECTED — aborting publish.')
    for (const { file, pattern } of leaks) {
      console.error(`    ${file}  ←  contains "${pattern}"`)
    }
    console.error('\nFix the source files in NovelWeb (or update LEAK_PATTERNS) and re-run.')
    process.exit(1)
  }
  console.log('  ✓ no leaks.')

  // 6. Stage + show diff stats.
  run('git', ['add', '-A'], { cwd: PUBLIC_DIR })
  const status = (run('git', ['status', '--porcelain'], { cwd: PUBLIC_DIR, capture: true }) || '').trim()
  if (!status) {
    console.log('\nAINovel is already in sync — nothing to commit.')
    return
  }
  const stat = run('git', ['diff', '--cached', '--stat'], { cwd: PUBLIC_DIR, capture: true })
  console.log('\n' + (stat || '').trim())

  // 7. Dry run stops here.
  if (dry) {
    console.log(`\n--dry — staged but not committed. Inspect: ${PUBLIC_DIR}`)
    return
  }

  // 8. Commit.
  let msg = commitMsg0
  if (!msg) {
    const rl = readline.createInterface({ input, output })
    msg = await rl.question('\nCommit message: ')
    rl.close()
    if (!msg.trim()) {
      console.log('Empty message — aborting.')
      process.exit(1)
    }
  }
  // Reuse local commit identity from NovelWeb (already set in private repo config)
  // — fall back to a safe default if neither exists.
  try {
    run('git', ['config', 'user.name'], { cwd: PUBLIC_DIR, capture: true })
  } catch {
    run('git', ['config', 'user.name', 'NovelWeb'], { cwd: PUBLIC_DIR })
    run('git', ['config', 'user.email', 'novelweb@local'], { cwd: PUBLIC_DIR })
  }
  run('git', ['commit', '-m', msg], { cwd: PUBLIC_DIR })
  console.log('✓ committed.')

  // 9. Push.
  if (noPush) {
    console.log(`\n--no-push — commit local. Push manually:`)
    console.log(`  git -C "${PUBLIC_DIR}" push -u origin main`)
    return
  }
  console.log('Pushing to remote...')
  try {
    run('git', ['push', '-u', 'origin', 'main'], { cwd: PUBLIC_DIR })
    console.log(`\n✓ Published to ${PUBLIC_REMOTE}`)
  } catch {
    console.error('\n✖ Push failed. The commit is local; resolve credentials and run:')
    console.error(`  git -C "${PUBLIC_DIR}" push -u origin main`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error('\nFatal:', e.message)
  process.exit(1)
})
