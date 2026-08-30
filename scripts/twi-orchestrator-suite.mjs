/**
 * twi-orchestrator-suite.mjs — the ninth suite's entry point, and the reason it is a
 * wrapper rather than a bare `npm test --prefix twi-orchestrator`.
 *
 * THE MEASURED FACT FIRST, because the handoff this replaces asserted the opposite. A
 * bare `npm test --prefix <dir>` against a directory with no node_modules does NOT skip
 * silently: npm exits 1 and prints "'vitest' is not recognized". That was measured four
 * ways -- missing install (exit 1), missing install while the REPO ROOT has vitest on
 * hand (exit 1, the root's binary does not leak onto the child's PATH), missing test
 * script (exit 1), and missing package.json (exit 127). scripts/run-tests.mjs turns any
 * non-zero exit into a suite failure, so the naive wiring already fails closed.
 *
 * This wrapper exists for the two failure modes that are NOT loud:
 *
 *   1. `vitest run --passWithNoTests` exits 0 having executed nothing. Measured. The
 *      floor in run-tests.mjs catches a suite that SHRANK, but a suite reporting no
 *      summary at all is caught only because figuresFor calls an unreadable count RED.
 *      Rather than rely on that, the flag is refused here by name.
 *   2. A nested package with no vitest config of its own runs under the REPOSITORY
 *      ROOT's config. Observed while building this package: the first run printed
 *      `include: test/sp1epacker/**\/*.test.ts` and collected nothing. It failed loudly
 *      only because the parent's pattern happens to match nothing here -- a broader
 *      parent pattern would have collected the ROOT's tests and reported their counts as
 *      this suite's, green, without executing a line of orchestrator code.
 *
 * So this checks the three preconditions that make the nested run MEAN anything, then
 * hands over to the package's own runner and forwards its exit code unchanged.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, 'twi-orchestrator')

/** Each precondition names the file that decides it, so a failure says what to fix. */
export const preconditions = (dir, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) => {
  const failures = []
  const manifestPath = path.join(dir, 'package.json')

  if (!exists(manifestPath)) {
    failures.push(`twi-orchestrator/package.json is missing — the sub-package is not present at all.`)
    return failures
  }

  let manifest
  try {
    manifest = JSON.parse(readFile(manifestPath, 'utf8'))
  } catch (error) {
    failures.push(`twi-orchestrator/package.json is not readable JSON: ${error.message}`)
    return failures
  }

  const testScript = manifest.scripts?.test
  if (typeof testScript !== 'string' || testScript.length === 0) {
    failures.push('twi-orchestrator/package.json declares no "test" script.')
  } else if (/--passWithNoTests\b/.test(testScript)) {
    failures.push(
      'twi-orchestrator\'s test script passes --passWithNoTests, which exits 0 having run nothing. ' +
        'That is the one way this suite can be green while executing no code. Remove the flag.',
    )
  }

  if (!exists(path.join(dir, 'node_modules'))) {
    failures.push(
      'twi-orchestrator/node_modules is missing. Run `npm ci --prefix twi-orchestrator`. ' +
        'node_modules is NOT shared across git worktrees, so a fresh worktree needs its own install.',
    )
  }

  const hasOwnConfig = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js']
    .some((name) => exists(path.join(dir, name)))
  if (!hasOwnConfig) {
    failures.push(
      'twi-orchestrator has no vitest config of its own, so vitest would walk up and run it under ' +
        "the repository root's config. The suite would then report the ROOT's counts as its own.",
    )
  }

  return failures
}

const main = () => {
  const failures = preconditions(pkgDir)
  if (failures.length > 0) {
    console.error('\nThe orchestrator suite cannot run, and a suite that cannot run is not a passing suite.\n')
    for (const failure of failures) console.error(`  ✘ ${failure}`)
    console.error('')
    process.exit(1)
  }

  const npmCli = process.env.npm_execpath
  const child = spawn(
    npmCli ? process.execPath : 'npm',
    npmCli ? [npmCli, 'test', '--prefix', 'twi-orchestrator'] : ['test', '--prefix', 'twi-orchestrator'],
    { cwd: root, stdio: 'inherit', shell: !npmCli },
  )
  child.on('close', (code) => process.exit(code ?? 1))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
