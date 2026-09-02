/**
 * The guard's own guard. Each case drives `preconditions` through an INJECTED file
 * system, so the assertion is about what the guard refuses -- not about whichever
 * machine happens to be running it. A guard tested only against a correctly-installed
 * tree proves nothing: it would pass while returning the empty array unconditionally.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { canaryRefusals, keyPaths, wavFormat } from './twi-lyria-canary.mjs'
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

/* -------------------------------------------------------------------------------------------
 * The Lyria canary's GATE.
 *
 * scripts/twi-lyria-canary.mjs is a manual, billable probe that is deliberately NOT wired into
 * `npm test`. Its refusal is therefore the only part of it that ever executes here — and a
 * refusal that has never executed is not a refusal. These cases drive it through an injected
 * environment, so they assert what it REFUSES rather than what this machine happens to export.
 * ---------------------------------------------------------------------------------------- */

const CONFIRMED = { TWI_CANARY_CONFIRM: 'I-ACCEPT-A-BILLABLE-CALL', GEMINI_API_KEY: 'k' }

test('the Lyria canary runs only when the key and the exact confirmation are both present', () => {
  assert.deepEqual(canaryRefusals(CONFIRMED), [])
})

test('the Lyria canary refuses without an API key', () => {
  const refusals = canaryRefusals({ ...CONFIRMED, GEMINI_API_KEY: '   ' })
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /GEMINI_API_KEY/)
})

test('the Lyria canary refuses unless the confirmation is typed exactly', () => {
  for (const value of [undefined, '', 'yes', 'i-accept-a-billable-call', 'I-ACCEPT-A-BILLABLE-CALL ']) {
    const refusals = canaryRefusals({ ...CONFIRMED, TWI_CANARY_CONFIRM: value })
    assert.equal(refusals.length, 1, `accepted the confirmation ${JSON.stringify(value)}`)
    assert.match(refusals[0], /TWI_CANARY_CONFIRM/)
  }
})

test('the Lyria canary never runs under CI, however well confirmed it is', () => {
  const refusals = canaryRefusals({ ...CONFIRMED, CI: 'true' })
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /CI is set/)
})

test('the canary reads a WAV sample rate out of the file rather than assuming 44.1 or 48 kHz', () => {
  // Google's own pages disagree about the rate, so the canary must MEASURE it. A header
  // declaring 48 kHz must be read as 48 kHz and nothing else.
  const bytes = new Uint8Array(44 + 16)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => [...text].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0) })
  ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 2, true); view.setUint32(24, 48_000, true)
  view.setUint32(28, 48_000 * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, 16, true)

  assert.deepEqual(wavFormat(bytes), {
    channels: 2, sampleRate: 48_000, bitsPerSample: 16, dataBytes: 16, durationSeconds: 16 / 4 / 48_000,
  })
  assert.equal(wavFormat(new Uint8Array(8)), null)
})

test('the canary reports the envelope it actually received rather than the one it hoped for', () => {
  const paths = keyPaths({ predictions: [{ bytesBase64Encoded: 'x'.repeat(100), mimeType: 'audio/wav' }] })
  assert.deepEqual(paths, [
    'predictions[0].bytesBase64Encoded <string, 100 chars>',
    'predictions[0].mimeType',
  ])
  assert.deepEqual(keyPaths({ predictions: [] }), ['predictions[] (empty)'])
})
