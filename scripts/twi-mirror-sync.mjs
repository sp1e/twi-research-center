#!/usr/bin/env node
/**
 * twi-mirror-sync.mjs — publish this repo's TWI subset to the TWI Research Center mirror.
 *
 * Why this exists. The TWI work lives in two places on purpose: it ships from
 * sp1e.se (which owns the build, the eight-suite runner, and every gate) and it is
 * ALSO published as its own repository, the TWI Research Center mirror, as a
 * history-preserving extraction. Two repositories that must agree is a standing
 * invariant, and standing invariants maintained by hand drift. This script is the
 * hand-work, executed.
 *
 * How the extraction stays reproducible. git-filter-repo is deterministic: the
 * same history filtered through the same path list yields byte-identical commit
 * SHAs. That is not folklore here, it is measured — re-filtering the source at
 * 1e5d4c3 through scripts/twi-mirror-paths.txt reproduced all 60 mirror commits
 * and landed on the same tip, 48cdb9a. Determinism is what makes a sync an
 * ordinary fast-forward rather than a republish of history someone already has.
 *
 * The one wrinkle, and why this MERGES instead of replacing. The mirror carries a
 * README.md that exists only there — it explains that the repo has no package.json
 * and that work happens in sp1e.se, without which an absent package.json reads as
 * a broken checkout. That commit sits ABOVE the filtered lineage, so the mirror
 * tip is not reachable from any re-filter and a plain push would be rejected as
 * non-fast-forward. The fix is not to force it. Every sync merges the freshly
 * filtered tip INTO the mirror, which is conflict-free in perpetuity for a reason
 * worth stating: README.md is the only mirror-only path and NO source path can
 * ever filter to it, so the two sides can never touch the same file. Nothing is
 * ever rewritten, every push is a fast-forward, and the merge commits are honest
 * provenance — each one records which sp1e.se commit the mirror was synced to.
 *
 * What this refuses to do:
 *
 *   1. Publish anything not already on the source origin. The mirror claims to be
 *      an extraction of a published repository; extracting unpushed local commits
 *      would make that claim false, and the difference is invisible from inside
 *      the mirror.
 *
 *   2. Force-push, ever. If the computed commit does not have the mirror's current
 *      tip as an ancestor, that is a bug here or a hand-edit there, and either way
 *      the answer is a human, not --force.
 *
 *   3. Trust the path list to be complete. scripts/twi-mirror-paths.txt is an
 *      enumeration, and enumerations decay: this project has already shipped a
 *      contract check that passed only because its hardcoded file list had not
 *      grown with the code. So coverage is re-derived from the source tree on
 *      every run — every tracked path naming twi must come out the far side of
 *      the filter, or this fails and names the ones that did not.
 *
 * Usage:  node scripts/twi-mirror-sync.mjs [--mirror <path>] [--branch <name>] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SPEC_PATH = 'scripts/twi-mirror-paths.txt'
const DEFAULT_SOURCE_BRANCH = 'codex/twi-research-center-design'
const MIRROR_REMOTE_BRANCH = 'main'
const MIRROR_SLUG = 'twi-research-center'

/**
 * Paths the mirror carries that do NOT name twi. Each is a shared library or
 * document the extraction would be incomplete without; they are listed here so
 * the leakage check below can tell "carried on purpose" from "dragged in".
 */
const SUPPORT_PATHS = new Set([
  'scripts/lib/functions-registry.mjs',
  'scripts/lib/ts-ast.mjs',
  'docs/superpowers/HANDOVER.md',
  'docs/superpowers/mutants/README.md',
  // Task 8's handoff. Same category as HANDOVER.md above: a TWI document whose NAME
  // carries no 'twi', so the coverage check cannot derive it and the leak check would
  // otherwise refuse it. It is listed in the extraction contract on purpose -- the
  // mirror is meant to be readable on its own, and this file is where Task 8's state
  // and its measured failures are written down.
  'docs/superpowers/TASK8-CLAUDE-CODE-HANDOFF.md',
])

/**
 * Tracked paths that name twi but must NOT be mirrored. Empty, and the emptiness
 * is the point: a path lands here only with a reason attached, so the decision is
 * visible in a diff instead of dissolving into a silently narrowed glob.
 */
const EXCLUSIONS = new Map([])

/** Paths that exist only in the mirror. See the merge rationale above. */
const MIRROR_ONLY = new Set(['README.md'])

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const argValue = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}

const SOURCE_BRANCH = argValue('--branch') ?? DEFAULT_SOURCE_BRANCH
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(scriptDir, '..')
const mirror = path.resolve(argValue('--mirror') ?? path.join(source, '..', MIRROR_SLUG))

const posix = (p) => p.split(path.sep).join('/')
const log = (msg) => console.log(msg)
const die = (msg, detail) => {
  console.error(`\ntwi-mirror-sync FAILED: ${msg}`)
  if (detail) console.error(detail)
  process.exit(1)
}

const git = (dir, ...rest) =>
  execFileSync('git', ['-C', dir, ...rest], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()
const gitOk = (dir, ...rest) => {
  try {
    execFileSync('git', ['-C', dir, ...rest], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
/**
 * ls-tree with -z, because functions/api/twi/[[route]].ts is exactly the kind of
 * path git would quote and a naive newline split would then compare wrongly.
 */
const treePaths = (dir, ref) =>
  git(dir, 'ls-tree', '-r', '-z', '--name-only', ref).split('\0').filter(Boolean)
const treeBlobs = (dir, ref) => {
  const out = new Map()
  for (const entry of git(dir, 'ls-tree', '-r', '-z', ref).split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t')
    out.set(file, meta.split(' ')[2])
  }
  return out
}
const isAncestor = (dir, a, b) => gitOk(dir, 'merge-base', '--is-ancestor', a, b)

// -- Phase 0 -- preconditions -------------------------------------------------
log('-- preconditions')
if (!gitOk(source, 'rev-parse', '--git-dir')) die(`${source} is not a git repository`)
if (!gitOk(mirror, 'rev-parse', '--git-dir')) {
  die(`no mirror clone at ${mirror}`, 'Pass --mirror <path>, or clone the mirror there first.')
}

const mirrorUrl = git(mirror, 'remote', 'get-url', 'origin')
if (!mirrorUrl.includes(MIRROR_SLUG)) {
  die(`${mirror} does not look like the mirror`, `its origin is ${mirrorUrl}`)
}
const mirrorBranch = git(mirror, 'rev-parse', '--abbrev-ref', 'HEAD')
const mirrorDirty = git(mirror, 'status', '--porcelain')
if (mirrorDirty) {
  die(
    'the mirror clone has local modifications',
    `${mirrorDirty}\n\nThe mirror is generated; nothing should be edited there.`
  )
}

// The mirror must extract PUBLISHED source. Fetch so the comparison is against
// the real remote rather than a remote-tracking ref that may be hours stale.
try {
  execFileSync('git', ['-C', source, 'fetch', '--quiet', 'origin', SOURCE_BRANCH], { stdio: 'pipe' })
} catch (error) {
  die(`could not fetch origin/${SOURCE_BRANCH} from the source repo`, String(error.stderr ?? error))
}
const sourceTip = git(source, 'rev-parse', SOURCE_BRANCH)
const sourcePushed = git(source, 'rev-parse', `origin/${SOURCE_BRANCH}`)
if (sourceTip !== sourcePushed) {
  die(
    `${SOURCE_BRANCH} is not pushed (local ${sourceTip.slice(0, 7)}, origin ${sourcePushed.slice(0, 7)})`,
    'The mirror publishes what the source has published. Push the branch first, then sync.'
  )
}
log(`   source ${SOURCE_BRANCH} @ ${sourceTip.slice(0, 7)} (pushed)`)
log(`   mirror ${mirrorBranch} @ ${git(mirror, 'rev-parse', 'HEAD').slice(0, 7)} -> ${mirrorUrl}`)

// -- Phase 1 -- filter --------------------------------------------------------
log('-- filtering source into a scratch clone')
const work = mkdtempSync(path.join(tmpdir(), 'twi-mirror-'))
const filtered = posix(path.join(work, 'filtered'))
// The extraction contract comes from the COMMIT being published, not the working
// tree, so the spec and the code it selects always belong to the same revision.
const specFile = posix(path.join(work, 'paths.txt'))
writeFileSync(specFile, `${git(source, 'show', `${SOURCE_BRANCH}:${SPEC_PATH}`)}\n`)

execFileSync(
  'git',
  ['clone', '--no-local', '--quiet', '--single-branch', '--branch', SOURCE_BRANCH, posix(source), filtered],
  { stdio: 'pipe' }
)
try {
  execFileSync('git', ['filter-repo', '--paths-from-file', specFile, '--force'], {
    cwd: filtered,
    stdio: 'pipe',
  })
} catch (error) {
  die('git filter-repo failed', String(error.stderr ?? error))
}
const filteredTip = git(filtered, 'rev-parse', 'HEAD')
const filteredPaths = treePaths(filtered, 'HEAD')
log(
  `   ${filteredPaths.length} paths, ${git(filtered, 'rev-list', '--count', 'HEAD')} commits, tip ${filteredTip.slice(0, 7)}`
)

// -- Phase 2 -- coverage: no TWI path may be left behind ----------------------
log('-- coverage')
const carried = new Set(filteredPaths)
const sourceTwi = treePaths(source, SOURCE_BRANCH).filter((p) => /twi/i.test(p))
const uncovered = sourceTwi.filter((p) => !carried.has(p) && !EXCLUSIONS.has(p))
if (uncovered.length) {
  die(
    `${uncovered.length} TWI path${uncovered.length === 1 ? '' : 's'} in the source did not survive the filter`,
    `${uncovered.map((p) => `   MISSING  ${p}`).join('\n')}\n\n` +
      `Add them to ${SPEC_PATH}, or record why they are excluded in EXCLUSIONS in this script.\n` +
      'The mirror is incomplete until then, and nothing else would have said so.'
  )
}
log(
  `   all ${sourceTwi.length} TWI-named source paths carried${EXCLUSIONS.size ? ` (${EXCLUSIONS.size} excluded by name)` : ''}`
)

// -- Phase 3 -- leakage: nothing unrelated may ride along ---------------------
const twiOwned = new Set(sourceTwi)
const leaked = filteredPaths.filter((p) => !twiOwned.has(p) && !SUPPORT_PATHS.has(p))
if (leaked.length) {
  die(
    `${leaked.length} non-TWI path${leaked.length === 1 ? '' : 's'} leaked into the extraction`,
    `${leaked.map((p) => `   LEAKED  ${p}`).join('\n')}\n\n` +
      `Narrow ${SPEC_PATH}, or add the path to SUPPORT_PATHS if the mirror needs it.`
  )
}
log(`   no leakage (${SUPPORT_PATHS.size} support paths carried by name)`)

// -- Phase 4 -- merge the filtered tip into the mirror ------------------------
log('-- merge')
git(mirror, 'fetch', '--no-tags', '--quiet', filtered, `+refs/heads/${SOURCE_BRANCH}:refs/twi-sync/incoming`)
const incoming = git(mirror, 'rev-parse', 'refs/twi-sync/incoming')
const mirrorTip = git(mirror, 'rev-parse', 'HEAD')
if (isAncestor(mirror, incoming, mirrorTip)) {
  log(`   already up to date — ${incoming.slice(0, 7)} is an ancestor of the mirror tip`)
  process.exit(0)
}

let mergedTree
try {
  mergedTree = execFileSync('git', ['-C', mirror, 'merge-tree', '--write-tree', mirrorTip, incoming], {
    encoding: 'utf8',
  }).trim()
} catch (error) {
  die(
    'the merge conflicted, which should be impossible',
    `${String(error.stdout ?? '')}\n\nREADME.md is the only mirror-only path and no source path can filter to it,\n` +
      'so a conflict means that assumption has broken. Do not force anything; look first.'
  )
}
const subject = `chore: sync mirror to sp1e.se ${sourceTip.slice(0, 7)}`
const body =
  `Extraction of ${SOURCE_BRANCH} @ ${sourceTip} through ${SPEC_PATH}.\n` +
  `${filteredPaths.length} paths carried; produced by scripts/twi-mirror-sync.mjs.\n`
const merged = git(mirror, 'commit-tree', mergedTree, '-p', mirrorTip, '-p', incoming, '-m', subject, '-m', body)
log(`   ${merged.slice(0, 7)} = merge(${mirrorTip.slice(0, 7)}, ${incoming.slice(0, 7)})`)

// -- Phase 5 -- prove the merge changed nothing it should not -----------------
log('-- proofs')
if (!isAncestor(mirror, mirrorTip, merged)) {
  die('the merge result does not contain the current mirror tip', 'That would be a history rewrite. Refusing.')
}
const mergedBlobs = treeBlobs(mirror, merged)
const incomingBlobs = treeBlobs(mirror, incoming)
const mirrorBlobs = treeBlobs(mirror, mirrorTip)

const expected = new Set([...filteredPaths, ...MIRROR_ONLY])
const surplus = [...mergedBlobs.keys()].filter((p) => !expected.has(p))
const absent = [...expected].filter((p) => !mergedBlobs.has(p))
if (surplus.length || absent.length) {
  die(
    'the merged tree is not the filtered tree plus the mirror-only files',
    [...surplus.map((p) => `   UNEXPECTED  ${p}`), ...absent.map((p) => `   MISSING     ${p}`)].join('\n')
  )
}
const drifted = filteredPaths.filter((p) => mergedBlobs.get(p) !== incomingBlobs.get(p))
if (drifted.length) {
  die('the merge altered file contents', drifted.map((p) => `   ALTERED  ${p}`).join('\n'))
}
const clobbered = [...MIRROR_ONLY].filter((p) => mirrorBlobs.has(p) && mergedBlobs.get(p) !== mirrorBlobs.get(p))
if (clobbered.length) {
  die('the merge changed a mirror-only file', clobbered.map((p) => `   CHANGED  ${p}`).join('\n'))
}
log(`   ${filteredPaths.length} paths byte-identical to the filtered tip`)
log(`   ${MIRROR_ONLY.size} mirror-only path${MIRROR_ONLY.size === 1 ? '' : 's'} preserved unchanged`)
log(`   mirror tip ${mirrorTip.slice(0, 7)} is an ancestor — fast-forward, nothing rewritten`)

// -- Phase 6 -- publish -------------------------------------------------------
if (dryRun) {
  log(`\n--dry-run: NOT pushing. Candidate commit ${merged.slice(0, 7)} is built and verified in ${mirror}.`)
  log(`Re-run without --dry-run to advance ${mirrorBranch} and push it to ${MIRROR_REMOTE_BRANCH}.`)
  process.exit(0)
}
log('-- publishing')
git(mirror, 'merge', '--ff-only', merged)
git(mirror, 'push', 'origin', `${mirrorBranch}:${MIRROR_REMOTE_BRANCH}`)
const published = git(mirror, 'rev-parse', `origin/${MIRROR_REMOTE_BRANCH}`)
if (published !== merged) {
  die(
    `push did not land: origin/${MIRROR_REMOTE_BRANCH} is ${published.slice(0, 7)}, expected ${merged.slice(0, 7)}`
  )
}
log(`   ${mirrorUrl} ${MIRROR_REMOTE_BRANCH} -> ${merged.slice(0, 7)}`)
log(`\nMirror synced to sp1e.se ${sourceTip.slice(0, 7)}.`)
