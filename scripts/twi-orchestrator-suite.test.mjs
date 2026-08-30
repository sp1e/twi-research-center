/**
 * The guard's own guard. Each case drives `preconditions` through an INJECTED file
 * system, so the assertion is about what the guard refuses -- not about whichever
 * machine happens to be running it. A guard tested only against a correctly-installed
 * tree proves nothing: it would pass while returning the empty array unconditionally.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { preconditions } from './twi-orchestrator-suite.mjs'

const DIR = '/pkg'
const ok = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  'node_modules': '',
  'vitest.config.ts': '',
}

/** A file system built from a plain map of relative paths. */
const SEPARATOR = String.fromCharCode(92); //  a literal backslash, written without one
const slash = (p) => p.split(SEPARATOR).join('/');

const fsOf = (files) => ({
  exists: (p) => Object.keys(files).some((name) => slash(p) === `${DIR}/${name}`),
  readFile: (p) => {
    const key = Object.keys(files).find((name) => slash(p) === `${DIR}/${name}`)
    if (key === undefined) throw new Error(`ENOENT ${p}`)
    return files[key]
  },
})

const without = (key) => Object.fromEntries(Object.entries(ok).filter(([name]) => name !== key))

test('a correctly installed package raises nothing', () => {
  assert.deepEqual(preconditions(DIR, fsOf(ok)), [])
})

test('a missing nested install FAILS rather than skipping', () => {
  const failures = preconditions(DIR, fsOf(without('node_modules')))
  assert.equal(failures.length, 1)
  assert.match(failures[0], /node_modules is missing/)
  assert.match(failures[0], /npm ci --prefix twi-orchestrator/)
})

test('a package with no vitest config of its own is refused', () => {
  // Without this the suite silently runs under the repository root's config.
  const failures = preconditions(DIR, fsOf(without('vitest.config.ts')))
  assert.equal(failures.length, 1)
  assert.match(failures[0], /no vitest config of its own/)
})

test('--passWithNoTests is refused by name', () => {
  const files = { ...ok, 'package.json': JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }) }
  const failures = preconditions(DIR, fsOf(files))
  assert.equal(failures.length, 1)
  assert.match(failures[0], /--passWithNoTests/)
})

test('a package with no test script is refused', () => {
  const files = { ...ok, 'package.json': JSON.stringify({ scripts: {} }) }
  assert.match(preconditions(DIR, fsOf(files))[0], /declares no "test" script/)
})

test('an absent package is reported as absent, not as five separate faults', () => {
  const failures = preconditions(DIR, fsOf({}))
  assert.equal(failures.length, 1)
  assert.match(failures[0], /is missing/)
})

test('unreadable JSON is reported rather than thrown', () => {
  const files = { ...ok, 'package.json': '{ not json' }
  assert.match(preconditions(DIR, fsOf(files))[0], /not readable JSON/)
})

test('several faults are reported together, not one at a time', () => {
  const files = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }) }
  const failures = preconditions(DIR, fsOf(files))
  assert.equal(failures.length, 3)
})
