/**
 * twi-lyria-canary.mjs — the ONE manual, secret-gated, BILLABLE probe of the real Lyria call.
 *
 * WHY IT EXISTS. Task 9's `twi-orchestrator/src/providers/lyria.ts` was written against
 * primary sources for the endpoint and the model id, and against NOTHING for the response
 * envelope: no public source pins the `model_output` / `audio` block shape. The adapter
 * therefore walks every step, treats zero audio blocks as invalid and two as ambiguous rather
 * than guessing — which is the right posture for an unverified integration and is also, by
 * construction, a posture that has never been confronted with a real response.
 *
 * Five things only a real call can settle, and each is REPORTED rather than asserted, because
 * the point is to learn what is true and then encode it:
 *
 *   1. THE ENVELOPE. The exact key path from the HTTP body to the audio bytes.
 *   2. THE SAMPLE RATE. Google's own pages conflict between 44.1 kHz and 48 kHz. The canary
 *      reads it out of the returned WAV's `fmt ` chunk instead of believing either.
 *   3. DURATION ADHERENCE. Whether the returned audio is the length that was asked for.
 *   4. THE SAFETY-REFUSAL MARKER. What a refused prompt actually looks like on the wire, so
 *      the adapter can distinguish "refused" from "broken".
 *   5. CHARGE AND RETENTION. Whether a refused or errored call is billed, and how long the
 *      response is retained — both of which decide whether a retry can ever be safe.
 *
 * IT IS NOT WIRED INTO `npm test`, AND MUST NOT BE. It spends real money on a real project.
 * `scripts/run-tests.mjs` does not list it; the only way to run it is to hold the API key and
 * to type the confirmation below by hand.
 *
 *   GEMINI_API_KEY=...  TWI_CANARY_CONFIRM=I-ACCEPT-A-BILLABLE-CALL  node scripts/twi-lyria-canary.mjs
 *
 * Its GATE is tested (scripts/twi-orchestrator-suite.test.mjs) even though the canary itself
 * is not run: a refusal that has never executed is not a refusal. What is proven is that it
 * refuses without the key, without the confirmation, and under CI. What the canary REPORTS has
 * been proven by nobody, which is the entire reason it exists.
 *
 * WHEN IT HAS BEEN RUN: paste its output into docs/superpowers/HANDOVER.md, then encode what
 * it found in `lyria.ts` and delete the "UNVERIFIED" language there. Until then, treat
 * `lyria.ts`'s envelope handling as a hypothesis.
 */

/**
 * Why this run may NOT proceed, as a list. Empty means "go".
 *
 * Injected rather than read from `process` so the gate is testable without setting real
 * environment variables in a test runner — the mistake this project has made before is
 * writing a refusal nothing ever executes.
 */
export const canaryRefusals = (env = process.env) => {
  const refusals = []
  if (env.CI) {
    refusals.push('CI is set. This canary spends money on a real project and never runs unattended.')
  }
  if (env.TWI_CANARY_CONFIRM !== 'I-ACCEPT-A-BILLABLE-CALL') {
    refusals.push('TWI_CANARY_CONFIRM is not exactly "I-ACCEPT-A-BILLABLE-CALL". Type it deliberately.')
  }
  if (typeof env.GEMINI_API_KEY !== 'string' || env.GEMINI_API_KEY.trim().length === 0) {
    refusals.push('GEMINI_API_KEY is absent. There is nothing to authenticate with.')
  }
  return refusals
}

/** Reads the sample rate and channel count out of a RIFF/WAVE payload by walking its chunks. */
export const wavFormat = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (from) => new TextDecoder().decode(bytes.slice(from, from + 4))
  if (bytes.byteLength < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return null

  let offset = 12
  let format = null
  let dataBytes = null
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && size >= 16) {
      format = {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      }
    } else if (id === 'data') {
      dataBytes = size
    }
    offset += 8 + size + (size % 2)
  }
  if (!format || dataBytes === null) return null
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8)
  return { ...format, dataBytes, durationSeconds: dataBytes / bytesPerFrame / format.sampleRate }
}

/** Every key path in a JSON value, so the real envelope can be READ rather than guessed. */
export const keyPaths = (value, prefix = '', depth = 0) => {
  if (depth > 6 || value === null || typeof value !== 'object') return [prefix || '<root>']
  if (Array.isArray(value)) {
    return value.length === 0 ? [`${prefix}[] (empty)`] : keyPaths(value[0], `${prefix}[0]`, depth + 1)
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string' && child.length > 64) return [`${path} <string, ${child.length} chars>`]
    return keyPaths(child, path, depth + 1)
  })
}

const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/lyria-002:predict'

/* The three prompts, in the order that answers the most for the fewest calls. */
const PROBES = [
  { name: 'ordinary', prompt: 'A short instrumental study for solo piano, calm, no vocals.', seconds: 30 },
  { name: 'duration', prompt: 'A short instrumental study for solo piano, calm, no vocals.', seconds: 8 },
  { name: 'refusal', prompt: 'A song that reproduces the exact lyrics and melody of a well-known copyrighted hit.', seconds: 30 },
]

const probe = async (apiKey, { name, prompt, seconds }) => {
  const startedAt = Date.now()
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sample_count: 1, duration_seconds: seconds } }),
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* reported as unparsed below */
  }

  console.log(`\n── probe: ${name} (${seconds}s requested) ${'─'.repeat(30)}`)
  console.log(`HTTP ${response.status} in ${Date.now() - startedAt} ms`)
  console.log('response headers that might bear on charge or retention:')
  for (const [key, value] of response.headers) {
    if (/quota|billing|retention|request-id|trace|ratelimit/i.test(key)) console.log(`  ${key}: ${value}`)
  }
  if (body === null) {
    console.log(`body was NOT JSON (${text.length} chars):`)
    console.log(text.slice(0, 800))
    return
  }
  console.log('envelope key paths:')
  for (const path of keyPaths(body)) console.log(`  ${path}`)

  const base64 =
    body?.predictions?.[0]?.bytesBase64Encoded ??
    body?.predictions?.[0]?.audioContent ??
    body?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ??
    null
  if (typeof base64 !== 'string') {
    console.log('NO audio block found at any of the three shapes lyria.ts currently walks.')
    console.log('THIS IS THE ANSWER THE CANARY EXISTS FOR — record the real path above in lyria.ts.')
    return
  }
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  console.log(`audio: ${bytes.byteLength} bytes`)
  const format = wavFormat(bytes)
  console.log(
    format
      ? `WAV fmt: ${format.sampleRate} Hz, ${format.channels} ch, ${format.bitsPerSample}-bit, ${format.durationSeconds.toFixed(3)} s (asked for ${seconds})`
      : 'payload is NOT a RIFF/WAVE container — record what it actually is.',
  )
}

const main = async () => {
  const refusals = canaryRefusals()
  if (refusals.length > 0) {
    console.error('\nThe Lyria canary will not run:\n')
    for (const refusal of refusals) console.error(`  ✘ ${refusal}`)
    console.error(
      '\nThis is a MANUAL, BILLABLE probe of a paid API. It is deliberately hard to start.\n',
    )
    process.exit(1)
  }

  console.log('Running the Lyria canary. THIS SPENDS MONEY. Three calls follow.')
  for (const spec of PROBES) {
    try {
      await probe(process.env.GEMINI_API_KEY, spec)
    } catch (error) {
      console.error(`probe ${spec.name} threw: ${error?.message ?? error}`)
    }
  }
  console.log(
    '\nDone. Paste this output into docs/superpowers/HANDOVER.md and then encode what it says' +
      '\nin twi-orchestrator/src/providers/lyria.ts. Until that happens the envelope is still a guess.',
  )
}

if (process.argv[1] && process.argv[1].endsWith('twi-lyria-canary.mjs')) {
  await main()
}
