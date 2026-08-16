/**
 * twi-bundle-check.mjs — the committed /twi/ bundle must match src/twi/.
 *
 * Why this exists. Same hazard as scripts/sp1epacker-bundle-check.mjs, one
 * subproject over. Cloudflare Pages runs no build command for this project
 * (wrangler.toml sets pages_build_output_dir = "." and no build step is
 * configured), so production serves the TRACKED files as they are. twi/index.html
 * and twi/assets/* are committed for exactly that reason.
 *
 * That buys the same hazard the sp1epacker check was written for: editing
 * src/twi/ without rebuilding ships a stale bundle, and nothing would say so —
 * /twi/ keeps loading while drifting away from its source. CI's post-build
 * `git status --porcelain` assertion catches it on a pull request; this catches
 * it in the local loop, which is where the mistake actually gets made.
 *
 * Two wrinkles that the sp1epacker check does not have:
 *
 *   1. Vite emits CONTENT-HASHED filenames (twi/assets/index-DHF0GnNS.js), so
 *      there is no fixed artefact list to compare against. Instead this compares
 *      the whole output DIRECTORY — every relative path, in both directions,
 *      plus bytes. Stale source therefore shows up twice over: the fresh build
 *      produces a hash that is missing from twi/, and twi/ carries a hash the
 *      fresh build no longer produces.
 *
 *   2. The build must go to a directory at the SAME DEPTH as twi/, i.e. a direct
 *      child of the repo root. The committed sourcemap stores its sources as
 *      paths relative to itself ("../../node_modules/react/..."), so building one
 *      level deeper rewrites them to "../../../node_modules/react/..." and the
 *      .map bytes differ for a reason that has nothing to do with drift. That is
 *      why this does not use the OS temp directory the way the sp1epacker check
 *      does.
 *
 * Run: node scripts/twi-bundle-check.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED = join(root, 'twi')

let failed = 0
const fail = (msg) => { failed++; console.error(`  FAIL  ${msg}`) }
const pass = (msg) => console.log(`  ok    ${msg}`)

/** Every file under `dir`, as repo-relative POSIX paths, sorted. */
const walk = (dir) => {
  const out = []
  const recurse = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) recurse(full)
      else out.push(relative(dir, full).split(sep).join(posix.sep))
    }
  }
  recurse(dir)
  return out
}

// The output must exist at all — the whole point is that git carries it to
// production.
if (existsSync(join(COMMITTED, 'index.html'))) {
  pass('twi/index.html is present')
} else {
  fail('twi/index.html is MISSING — production would serve the landing page for /twi/')
}

// Every asset index.html points at must be on disk. A hashed filename that is
// committed but not referenced is dead weight; one that is referenced but not
// committed makes the page load and sit inert.
if (failed === 0) {
  const html = readFileSync(join(COMMITTED, 'index.html'), 'utf8')
  const referenced = [...html.matchAll(/(?:src|href)="\/twi\/([^"]+)"/g)].map((m) => m[1])

  if (referenced.length === 0) {
    fail('twi/index.html references no /twi/ assets — the build output looks wrong')
  }
  for (const ref of referenced) {
    if (existsSync(join(COMMITTED, ref))) pass(`twi/index.html → twi/${ref} is present`)
    else fail(`twi/index.html references twi/${ref}, which is not committed and absent in production`)
  }

  // Unlike sp1epacker, the twi sourcemaps ARE committed (vite.twi.config.ts sets
  // sourcemap: true and .gitignore does not exclude them), so a sourceMappingURL
  // is fine — as long as the map it names is actually there.
  for (const ref of referenced.filter((r) => r.endsWith('.js'))) {
    const js = readFileSync(join(COMMITTED, ref), 'utf8')
    const map = /\/\/# sourceMappingURL=(.+)\s*$/.exec(js)
    if (!map) continue
    const mapPath = join(dirname(join(COMMITTED, ref)), map[1].trim())
    if (existsSync(mapPath)) pass(`twi/${ref} sourcemap is committed alongside it`)
    else fail(`twi/${ref} references sourcemap ${map[1].trim()}, which is not committed`)
  }
}

if (failed === 0) {
  // Direct child of the repo root — see wrinkle 2 in the header. Not the OS temp
  // directory: the depth is load-bearing.
  const out = mkdtempSync(join(root, '.twi-bundle-check-'))
  try {
    // These flags must stay in step with package.json's build:twi.
    execFileSync(process.execPath, [
      join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      'build', '--config', join(root, 'vite.twi.config.ts'), '--outDir', out,
    ], { cwd: root, stdio: 'pipe' })

    const committedFiles = walk(COMMITTED)
    const freshFiles = walk(out)

    const stale = freshFiles.filter((f) => !committedFiles.includes(f))
    const orphaned = committedFiles.filter((f) => !freshFiles.includes(f))

    for (const f of stale) {
      fail(
        `twi/${f} is MISSING — a fresh build of src/twi/ produces it but it is not ` +
        `committed. The committed bundle is STALE. Run \`npm run build\` and commit the result.`
      )
    }
    for (const f of orphaned) {
      fail(
        `twi/${f} is STALE — a fresh build of src/twi/ no longer produces it. ` +
        `Run \`npm run build\` and commit the result.`
      )
    }

    for (const f of freshFiles.filter((f) => committedFiles.includes(f))) {
      const committed = readFileSync(join(COMMITTED, f))
      const fresh = readFileSync(join(out, f))
      if (committed.equals(fresh)) {
        pass(`twi/${f} matches a fresh build of src/twi/ (${committed.length} bytes)`)
      } else {
        // Sizes are context, not the finding — index.html in particular can differ
        // only in the hashed asset names it points at and come out the same length.
        fail(
          `twi/${f} is STALE — its contents differ from a fresh build of src/twi/ ` +
          `(committed ${committed.length} bytes, fresh ${fresh.length}). ` +
          `Run \`npm run build\` and commit the result.`
        )
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (failed) {
  console.error(`\nTWI bundle check FAILED (${failed} problem${failed === 1 ? '' : 's'}).`)
  console.error('The committed /twi/ output no longer reproduces from src/twi/. Production')
  console.error('serves the committed files as-is, so this means /twi/ is serving stale code.')
  process.exit(1)
}
console.log('TWI bundle checks passed.')
