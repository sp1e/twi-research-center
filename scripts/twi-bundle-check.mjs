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
 * "Committed" here means TRACKED BY GIT, never "present on disk". The two are not
 * the same and the difference is load-bearing: Pages serves what git carries, so
 * an untracked artefact under twi/ is absent in production however convincingly it
 * sits in the directory — a gitignored map file emitted by a local debugging build
 * is exactly that — and a tracked path deleted from disk is still served from git
 * until the deletion is committed. So the committed set comes from `git ls-files`,
 * and the two ways git and disk can disagree are each their own failure.
 *
 * Three wrinkles the sp1epacker check does not have:
 *
 *   1. Vite emits CONTENT-HASHED filenames (twi/assets/index-D77bP6e0.js), so
 *      there is no fixed artefact list to compare against. Instead this compares
 *      the whole output DIRECTORY — every relative path, in both directions,
 *      plus bytes. Stale source therefore shows up twice over: the fresh build
 *      produces a hash that is missing from twi/, and twi/ carries a hash the
 *      fresh build no longer produces.
 *
 *   2. Sourcemaps are OFF for twi and must stay off. vite.twi.config.ts sets
 *      `sourcemap: false` and .gitignore excludes map files under twi/, because a
 *      committed map is a public URL serving sourcesContent — src/twi/** published
 *      verbatim, which defeats the `/src/* -> 301` rule in _redirects. This checks
 *      that policy from three sides: no map is tracked, no committed script names
 *      one, and the build config does not emit one.
 *
 *   3. The scratch build goes to a directory at the SAME DEPTH as twi/, i.e. a
 *      direct child of the repo root, not the OS temp directory the sp1epacker
 *      check uses. That was originally forced by the committed sourcemap, which
 *      stored its sources relative to itself ("../../node_modules/react/..."), so
 *      building one level deeper rewrote them and the bytes never matched. No map
 *      is committed any more, so the constraint is dormant rather than dead — it
 *      costs nothing and it keeps this guard correct if a map is ever emitted
 *      again. .gitignore says the same thing about the same directory.
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

/** Every file under `dir`, as paths relative to it in POSIX form, sorted. */
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

/**
 * Every file git tracks under twi/, relative to twi/. This — not the directory
 * listing — is what production gets, so it is what every conclusion below is
 * drawn from. A missing git is fatal rather than a silent pass: a guard that
 * asserts what git carries cannot answer that question without git.
 */
const trackedUnderTwi = () => {
  let stdout
  try {
    stdout = execFileSync('git', ['ls-files', '-z', '--', 'twi'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    console.error(`  FAIL  cannot ask git which files under twi/ are tracked: ${error.message}`)
    console.error('\nTWI bundle check FAILED (1 problem).')
    console.error('This guard asserts what git carries to production, so it cannot run without git.')
    process.exit(1)
  }
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((p) => p.startsWith('twi/') ? p.slice('twi/'.length) : p)
    .sort()
}

const trackedFiles = trackedUnderTwi()
const diskFiles = existsSync(COMMITTED) ? walk(COMMITTED) : []

// The output must be in git at all — the whole point is that git carries it to
// production. Presence on disk proves nothing about that.
if (trackedFiles.includes('index.html')) {
  pass('twi/index.html is tracked by git')
} else {
  fail('twi/index.html is not tracked by git — production would serve the landing page for /twi/')
}

// The two directions in which git and disk can disagree. Each is a real, distinct
// failure, and neither is visible to a directory walk on its own.
for (const f of trackedFiles.filter((f) => !diskFiles.includes(f))) {
  fail(
    `twi/${f} is tracked by git but MISSING from disk — git still serves it to production, ` +
    `and nothing here can check it against src/twi/. Restore it with \`npm run build\`, or ` +
    `commit the deletion.`
  )
}
for (const f of diskFiles.filter((f) => !trackedFiles.includes(f))) {
  fail(
    `twi/${f} is on disk but NOT tracked by git — production serves only tracked files, so ` +
    `this one is absent there and a request for it falls through to the landing page with a ` +
    `200. Commit it, or delete it if it is a local build artefact.`
  )
}

// No sourcemap may be committed under twi/. Committing one publishes
// sourcesContent — src/twi/** verbatim at a stable URL — which is exactly what the
// `/src/* -> 301` rule in _redirects exists to prevent.
const trackedMaps = trackedFiles.filter((f) => f.endsWith('.map'))
for (const f of trackedMaps) {
  fail(
    `twi/${f} is a sourcemap tracked by git — it would be served publicly with sourcesContent, ` +
    `republishing src/twi/ verbatim and defeating the /src/* -> 301 rule in _redirects. ` +
    `Keep vite.twi.config.ts on \`sourcemap: false\` and \`git rm --cached\` the map.`
  )
}
if (trackedMaps.length === 0) pass('no sourcemap is tracked under twi/')

if (failed === 0) {
  const html = readFileSync(join(COMMITTED, 'index.html'), 'utf8')
  const referenced = [...html.matchAll(/(?:src|href)="\/twi\/([^"]+)"/g)].map((m) => m[1])

  if (referenced.length === 0) {
    fail('twi/index.html references no /twi/ assets — the build output looks wrong')
  }
  // Every asset index.html points at must be in git. A hashed filename that is
  // tracked but not referenced is dead weight; one that is referenced but not
  // tracked makes the page load and sit inert.
  for (const ref of referenced) {
    if (trackedFiles.includes(ref)) pass(`twi/index.html → twi/${ref} is tracked by git`)
    else fail(`twi/index.html references twi/${ref}, which git does not track and production does not have`)
  }

  // The other half of the sourcemap policy: a `sourceMappingURL` in a committed
  // script names a file that .gitignore keeps out of git, so on a Pages project
  // with no build step it resolves to the landing page HTML with a 200. This reads
  // the working tree deliberately — it is the pre-commit state that needs telling.
  for (const ref of trackedFiles.filter((f) => f.endsWith('.js'))) {
    if (readFileSync(join(COMMITTED, ref), 'utf8').includes('sourceMappingURL')) {
      fail(
        `twi/${ref} references a sourcemap, which is gitignored and absent in production. ` +
        `Rebuild with vite.twi.config.ts's \`sourcemap: false\` before committing.`
      )
    } else {
      pass(`twi/${ref} has no dangling sourcemap reference`)
    }
  }
}

/**
 * The argv for a fresh build, read out of package.json's build:twi rather than
 * hand-copied from it, so the two cannot drift. Only a plain `vite build ...`
 * invocation can be replayed this way; anything shell-shaped is refused loudly
 * instead of being compared against a differently-configured build.
 */
const freshBuildArgv = (out) => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const script = pkg.scripts?.['build:twi'] ?? ''
  const tokens = script.trim().split(/\s+/).filter(Boolean)
  if (/[&|;<>"'`$()]/.test(script) || tokens[0] !== 'vite' || tokens[1] !== 'build') {
    fail(
      `package.json's build:twi is ${JSON.stringify(script)}, which this guard cannot replay — ` +
      `it expects a plain \`vite build ...\` invocation and appends --outDir. Update ` +
      `scripts/twi-bundle-check.mjs to match the new build, or the comparison would run ` +
      `against a differently-configured build.`
    )
    return null
  }
  return [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ...tokens.slice(1), '--outDir', out]
}

if (failed === 0) {
  // Direct child of the repo root — see wrinkle 3 in the header. Not the OS temp
  // directory: the depth is kept deliberately.
  const out = mkdtempSync(join(root, '.twi-bundle-check-'))
  try {
    const argv = freshBuildArgv(out)
    if (argv) {
      execFileSync(process.execPath, argv, { cwd: root, stdio: 'pipe' })

      const freshFiles = walk(out)

      // Third side of the sourcemap policy, and the one that catches the cause
      // rather than the symptom: if the build emits a map at all, the config has
      // been flipped. Reported here instead of as "missing from twi/", which would
      // read as an instruction to commit it.
      const freshMaps = freshFiles.filter((f) => f.endsWith('.map'))
      for (const f of freshMaps) {
        fail(
          `a fresh build of src/twi/ emits ${f} — vite.twi.config.ts must keep \`sourcemap: false\`. ` +
          `A committed map serves src/twi/ verbatim via sourcesContent; do not commit the result of ` +
          `a local debugging build.`
        )
      }
      const freshOutput = freshFiles.filter((f) => !f.endsWith('.map'))

      const stale = freshOutput.filter((f) => !trackedFiles.includes(f))
      const orphaned = trackedFiles.filter((f) => !freshOutput.includes(f))

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

      for (const f of freshOutput.filter((f) => trackedFiles.includes(f))) {
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
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (failed) {
  console.error(`\nTWI bundle check FAILED (${failed} problem${failed === 1 ? '' : 's'}).`)
  console.error('Cloudflare Pages runs no build for this project — it serves the files git carries,')
  console.error('exactly as committed. Every FAIL above is therefore something /twi/ would serve')
  console.error('wrong in production, not a local-only annoyance; each FAIL line says what to do')
  console.error('about it. The commonest cause is editing src/twi/ without rebuilding.')
  process.exit(1)
}
console.log('TWI bundle checks passed.')
