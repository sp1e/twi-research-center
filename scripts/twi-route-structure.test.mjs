/**
 * twi-route-structure.test.mjs — tests for the thing that does the testing.
 *
 * Why this file exists. The owner gate on /api/twi/* is asserted by
 * scripts/twi-contract-check.mjs, which reads its facts off two pure modules:
 * scripts/lib/twi-route-structure.mjs (the AST analysis) and
 * scripts/lib/functions-registry.mjs (which file can answer at all). Until this
 * round nothing tested either of them, and the third adversarial review measured
 * what that was worth: replacing the analysis with a 14-line permissive stub kept
 * `npm test` at 7/7 AND the contract check reporting the same 33 checks. The count
 * — the only number a reviewer might plausibly be tracking — is invariant under
 * the removal of the entire kill signal for API-27 through API-50.
 *
 * So the guard gets a guard, on the pattern the repo already has for
 * scripts/lib/migration-sql.mjs (tested by scripts/migration-safety.test.mjs and
 * wired in as `test:migrations`).
 *
 * The corpus is not invented here. The mutant manifest records 23 mutations of the
 * route file as `substantiation: "exact-from-source"` find/replace pairs, each with
 * the contract-check names it is killed by. Every one of those is applied to the
 * committed source IN MEMORY and the analysis is required to flag it — so each
 * entry's prose `premise` ("the kill signal is a parse, not a scan") becomes an
 * executed assertion. A future round that swaps the parser for a line scan fails
 * HERE, with the mutant id, instead of passing 33/33 in silence.
 *
 * The second corpus is the constructions the three review rounds used against the
 * guard, including the ones that beat it. They are pinned by name so a fix cannot
 * be quietly undone.
 *
 * Run: npm run test:twi:structure   (wired into `npm test` via scripts/run-tests.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PREGATE_PREAMBLE,
  analyseTwiRouteFile,
  comparePreamble,
} from './lib/twi-route-structure.mjs';
import {
  FUNCTIONS_REGISTRY,
  canAnswerTwi,
  classifyDeployTakeover,
  classifyFunctionsTree,
  classifyRoutesManifest,
  markerReason,
} from './lib/functions-registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_FILE = 'functions/api/twi/[[route]].ts';
const readRepo = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const ROUTE_SOURCE = readRepo(ROUTE_FILE);
const HTTP_SOURCE = readRepo('src/twi/server/http.ts');
const MANIFEST = JSON.parse(readRepo('docs/superpowers/mutants/twi-creation-core.mutants.json'));

const analyse = (source) => analyseTwiRouteFile(source, { httpSource: HTTP_SOURCE });

/** Every list the contract check asserts is empty, as one flat list. */
const allOffenders = (analysis) => [
  ...analysis.syntaxErrors,
  ...analysis.gateReasons,
  ...analysis.preGateOffenders,
  ...comparePreamble(analysis.preGateCanonical),
  ...analysis.catchOffenders,
  ...analysis.unawaitedReturns,
  ...analysis.extraHandlerExports,
  ...analysis.opaqueExports,
];

/** Apply a find/replace to the committed source, refusing a non-unique anchor. */
const mutate = (find, replace, { anchorUnique = true } = {}) => {
  const first = ROUTE_SOURCE.indexOf(find);
  assert.notEqual(
    first,
    -1,
    `anchor not present in ${ROUTE_FILE}: ${JSON.stringify(find.slice(0, 80))}. If the route file legitimately changed, update this mutant's mutation.find in docs/superpowers/mutants/twi-creation-core.mutants.json — "exact-from-source" means the manifest tracks this file, and a silently skipped mutant is exactly the erosion this suite exists to stop.`,
  );
  if (anchorUnique) {
    assert.equal(
      ROUTE_SOURCE.indexOf(find, first + find.length),
      -1,
      `anchor recorded as unique but occurs more than once: ${JSON.stringify(find.slice(0, 80))}`,
    );
  }
  return ROUTE_SOURCE.slice(0, first) + replace + ROUTE_SOURCE.slice(first + find.length);
};

// ── 1. The committed file, which must be clean ───────────────────────────────

test('the committed route file analyses clean — nothing here passes vacuously', () => {
  const analysis = analyse(ROUTE_SOURCE);
  assert.deepEqual(analysis.syntaxErrors, []);
  assert.equal(analysis.hasOnRequest, true);
  assert.deepEqual(analysis.gateReasons, []);
  assert.deepEqual(analysis.preGateOffenders, []);
  assert.deepEqual(comparePreamble(analysis.preGateCanonical), []);
  assert.deepEqual(analysis.catchOffenders, []);
  assert.deepEqual(analysis.unawaitedReturns, []);
  assert.deepEqual(analysis.extraHandlerExports, []);
  assert.deepEqual(analysis.opaqueExports, []);
  assert.deepEqual(analysis.handlerExports, ['onRequest']);
  assert.equal(analysis.preflightKind, 'inline');
  assert.ok(analysis.gatedReturnCount > 0, 'the gated region must be non-empty for the await assertion to mean anything');
});

test('the declared preamble is the region above the gate, statement for statement', () => {
  const analysis = analyse(ROUTE_SOURCE);
  assert.deepEqual(analysis.preGateCanonical, EXPECTED_PREGATE_PREAMBLE);
});

// The parse gate reads `sf.parseDiagnostics`, an INTERNAL TypeScript property with
// no public accessor on `ts.createSourceFile`. If a future typescript bump renames
// or hides it, the `?? []` fallback makes the gate report zero syntax errors
// forever — it fails OPEN. This is the sentinel that notices.
test('a malformed source really does produce a syntax error (parseDiagnostics sentinel)', () => {
  const broken = analyse('export const onRequest = async (ctx: { = > };');
  assert.ok(broken.syntaxErrors.length > 0, 'parseDiagnostics reported nothing for source that cannot parse');
});

// ── 2. The manifest's own corpus, executed ───────────────────────────────────

/**
 * Each contract-check name the manifest records, mapped to the analysis fact that
 * has to be non-empty for that check to go red. The check itself ANDs several
 * lists together, and this mirrors that so a mutant killed via `gateReasons`
 * satisfies a `killedBy` entry naming the pre-gate check.
 */
const STRUCTURAL_PREDICATES = {
  'the owner gate is UNCONDITIONAL and reached on every path that can answer': (a) =>
    !a.hasOnRequest || a.gateReasons.length > 0,
  'nothing above the owner gate answers except the CORS preflight': (a) =>
    !a.hasOnRequest ||
    a.gateReasons.length > 0 ||
    a.preGateOffenders.length > 0 ||
    comparePreamble(a.preGateCanonical).length > 0,
  "the catch that maps the gate's 401 answers with an error envelope, never with the resource": (a) =>
    !a.hasOnRequest || a.gateReasons.length > 0 || a.catchOffenders.length > 0,
  'every handler returned inside the gate is awaited, so no rejection escapes the catch': (a) =>
    !a.hasOnRequest || a.gateReasons.length > 0 || a.unawaitedReturns.length > 0 || a.gatedReturnCount === 0,
  'onRequest is the only Pages handler in the TWI function, so no verb export can answer beside the gate': (a) =>
    !a.handlerExports.includes('onRequest') || a.extraHandlerExports.length > 0 || a.opaqueExports.length > 0,
  'the CORS preflight short-circuit is above the gate and returns no body': (a) => a.preflightKind === null,
};

const apiSet = MANIFEST.sets.find((set) => set.id === 'api');
const routeMutants = (apiSet?.mutants ?? []).filter(
  (mutant) =>
    mutant.target?.file === ROUTE_FILE &&
    mutant.mutation?.kind === 'replace' &&
    mutant.substantiation === 'exact-from-source',
);

const parserCovered = routeMutants.filter((mutant) =>
  (mutant.killedBy ?? []).some((kill) => Object.keys(STRUCTURAL_PREDICATES).includes(kill.test)),
);

test('the manifest still supplies a corpus for this suite', () => {
  assert.ok(
    routeMutants.length >= 20,
    `expected the manifest's exact-from-source route mutations, found ${routeMutants.length}`,
  );
  assert.ok(
    parserCovered.length >= 15,
    `expected at least 15 mutants whose kill is a STRUCTURAL fact, found ${parserCovered.length} — either the manifest lost entries or a check was renamed without updating STRUCTURAL_PREDICATES`,
  );
});

for (const mutant of parserCovered) {
  test(`${mutant.id} — the analysis flags it (${mutant.target.construct.slice(0, 90)})`, () => {
    const mutated = mutate(mutant.mutation.find, mutant.mutation.replace, {
      anchorUnique: mutant.mutation.anchorUnique !== false,
    });
    const analysis = analyse(mutated);
    const named = (mutant.killedBy ?? [])
      .map((kill) => kill.test)
      .filter((name) => Object.keys(STRUCTURAL_PREDICATES).includes(name));

    for (const name of named) {
      assert.ok(
        STRUCTURAL_PREDICATES[name](analysis),
        `${mutant.id} is recorded as killed by "${name}" but the analysis reports nothing for it. Offenders seen: ${JSON.stringify(allOffenders(analysis))}`,
      );
    }
  });
}

// ── 3. The constructions the reviews used, pinned by name ────────────────────

const GATE_LINE = '    await requireOwnerSession(request, env);\n';
const PREFLIGHT_LINE = "  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });\n";
const IMPORT_AUTH = "import { requireOwnerSession } from '../../../src/twi/server/auth';\n";
const CATCH_HEAD = '  } catch (error) {\n';

const refuses = (label, source, predicate) => {
  const analysis = analyse(source);
  const offenders = allOffenders(analysis);
  assert.ok(offenders.length > 0, `${label} was NOT refused — the analysis reported nothing`);
  if (predicate) {
    assert.ok(
      predicate(analysis),
      `${label} was refused, but not for the stated reason. Offenders: ${JSON.stringify(offenders)}`,
    );
  }
};

// R1/R1b/R1c/R1d — the round-2 regression. `indexOf(gateStatement)` returned −1 for
// a gate inside a bare block, −1 was read as "the region starts at 0", and the
// statements above the gate were re-classified as GATED where `return json(…)` is
// admitted. Round 1 caught this by name; round 2 reported 33/33.
test('R1 — an ungated answer above a BLOCK-NESTED gate is refused, and the pre-gate region is never emptied', () => {
  const source = mutate(
    GATE_LINE,
    "    if (segments[0] === 'health') return json({ ok: true, public: true });\n    {\n  " + GATE_LINE + '    }\n',
  );
  refuses('R1', source, (a) => a.gateReasons.some((reason) => reason.includes('direct statement')));
  assert.deepEqual(analyse(source).unawaitedReturns, [], 'the ungated answer must not be admitted as a GATED return');
});

test('R1b — the same, two bare blocks deep', () => {
  refuses(
    'R1b',
    mutate(
      GATE_LINE,
      "    if (segments[0] === 'health') return json({ ok: true, public: true });\n    {\n      {\n    " +
        GATE_LINE +
        '      }\n    }\n',
    ),
    (a) => a.gateReasons.length > 0,
  );
});

test('R1c — a throw above a block-nested gate, which answers through the mapping catch', () => {
  refuses(
    'R1c',
    mutate(
      GATE_LINE,
      "    if (segments[0] === 'health') throw new HttpError(200, 'leaked');\n    {\n  " + GATE_LINE + '    }\n',
    ),
    (a) => a.gateReasons.length > 0,
  );
});

// R4/R4b — the gate NAME was checked, never the BINDING, so a module-scope wrapper
// of the same name satisfied every structural assertion truthfully.
test('R4 — a module-scope wrapper that keeps the gate name is refused', () => {
  refuses(
    'R4',
    mutate(
      IMPORT_AUTH,
      "import { requireOwnerSession as ownerSession } from '../../../src/twi/server/auth';\n" +
        'const requireOwnerSession = async (request: Request, env: TwiEnv): Promise<void> => {\n' +
        "  if (new URL(request.url).pathname.startsWith('/api/twi/health')) return;\n" +
        '  await ownerSession(request, env);\n' +
        '};\n',
    ),
    (a) => a.gateReasons.some((reason) => reason.includes('redeclared') || reason.includes('not imported')),
  );
});

test('R4b — a local no-op shadowing the gate is refused', () => {
  refuses(
    'R4b',
    mutate(
      '  const { request, env } = ctx;\n',
      '  const { request, env } = ctx;\n' +
        '  const requireOwnerSession = async (_r: Request, _e: TwiEnv): Promise<void> => {};\n',
    ),
    (a) => a.gateReasons.some((reason) => reason.includes('redeclared')),
  );
});

test('R4c — importing the gate name from a look-alike module is refused', () => {
  refuses(
    'R4c',
    mutate(IMPORT_AUTH, "import { requireOwnerSession } from '../../../src/twi/server/soft-auth';\n"),
    (a) => a.gateReasons.some((reason) => reason.includes('not imported')),
  );
});

// R5/R5c — the catch runs on the gate's own 401, and round 2 never constrained
// what it returns.
test('R5 — a catch that serves the resource on the gate\'s 401 is refused', () => {
  refuses(
    'R5',
    mutate(
      CATCH_HEAD,
      CATCH_HEAD +
        "    if (error instanceof HttpError && error.status === 401 && segments[0] === 'health') {\n" +
        '      return json({ capabilities: creationCoreCapabilities });\n' +
        '    }\n',
    ),
    (a) => a.catchOffenders.length > 0,
  );
});

test('R5c — the same, unscoped', () => {
  refuses(
    'R5c',
    mutate(
      CATCH_HEAD,
      CATCH_HEAD +
        '    if (error instanceof HttpError && error.status === 401) {\n' +
        '      return json({ capabilities: creationCoreCapabilities });\n' +
        '    }\n',
    ),
    (a) => a.catchOffenders.length > 0,
  );
});

test('R5d — a catch that awaits a handler is refused even if it answers an envelope', () => {
  refuses(
    'R5d',
    mutate(
      CATCH_HEAD,
      CATCH_HEAD + '    if (error instanceof HttpError) return json({ error: String(await listProjects(repo)) }, 401);\n',
    ),
    (a) => a.catchOffenders.some((offender) => offender.includes('awaits')),
  );
});

// R2/R2b/R3 and the round-3 additions — `env` above the gate, spelled so the
// identifier rule cannot see it.
test("R2 — an unauthenticated D1 write above the gate via ctx['env'] is refused", () => {
  refuses(
    'R2',
    mutate(GATE_LINE, "    const purge = ctx['env'].DB.prepare('DELETE FROM twi_projects').run();\n" + GATE_LINE),
    (a) => a.preGateOffenders.length > 0 || comparePreamble(a.preGateCanonical).length > 0,
  );
});

test('X2 — the same with the key computed at runtime (ctx[key]) is refused', () => {
  refuses(
    'X2',
    mutate(
      GATE_LINE,
      "    const key = 'e' + 'nv';\n" +
        '    const purge = (ctx as unknown as Record<string, TwiEnv>)[key].DB.prepare(\'DELETE FROM twi_projects\').run();\n' +
        GATE_LINE,
    ),
    (a) => a.preGateOffenders.length > 0 || comparePreamble(a.preGateCanonical).length > 0,
  );
});

test('X1 — env aliased through a renamed destructuring above the gate is refused', () => {
  refuses(
    'X1',
    mutate(GATE_LINE, '    const { env: box } = ctx;\n    const purge = box.DB.prepare(\'DELETE FROM x\').run();\n' + GATE_LINE),
    (a) => a.preGateOffenders.length > 0 || comparePreamble(a.preGateCanonical).length > 0,
  );
});

test("R3 — a secret smuggled out in the preflight's 204 HEADERS is refused", () => {
  const source = mutate(
    PREFLIGHT_LINE,
    "  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(), 'x-leak': String(Object.keys(ctx['env'])) } });\n",
  );
  refuses('R3', source, (a) => a.preflightKind === null);
});

test('C6 — the same leak with the preflight reformatted across three lines is refused', () => {
  const source = mutate(
    PREFLIGHT_LINE,
    "  if (method === 'OPTIONS')\n" +
      '    return new Response(null, {\n' +
      "      status: 204, headers: { ...cors(), 'x-leak': 'secret' },\n" +
      '    });\n',
  );
  refuses('C6', source, (a) => a.preflightKind === null);
});

// R8 — a star re-export can carry a handler this module cannot see.
test('R8 — `export * from` is refused as OPAQUE', () => {
  refuses(
    'R8',
    mutate(IMPORT_AUTH, IMPORT_AUTH + "export * from '../../../src/twi/server/verb-extra';\n"),
    (a) => a.opaqueExports.length > 0,
  );
});

test('P14 — onRequestGet written with a unicode identifier escape is refused by DECODED name', () => {
  const source = `${ROUTE_SOURCE}\nexport const \\u006fnRequestGet = async (): Promise<Response> => json({});\n`;
  refuses('P14', source, (a) => a.extraHandlerExports.includes('onRequestGet'));
});

// Controls the reviews used, kept so a future simplification cannot pass them by
// accident.
test('C1 — a resource-scoped conditional gate is refused', () => {
  refuses('C1', mutate(GATE_LINE, "    if (segments[0] !== 'health') await requireOwnerSession(request, env);\n"), (a) =>
    a.gateReasons.some((reason) => reason.includes('CONDITIONAL')),
  );
});

test('N1 — a gate that is present but not awaited is refused', () => {
  refuses('N1', mutate(GATE_LINE, '    requireOwnerSession(request, env);\n'), (a) =>
    a.gateReasons.some((reason) => reason.includes('not awaited')),
  );
});

test('P12 — an unawaited handler return inside the gate is refused', () => {
  refuses(
    'P12',
    mutate(
      "    return json({ error: 'not found', code: 'not_found' }, 404);\n",
      "    if (resource === 'recent') return listProjects(repo);\n    return json({ error: 'not found', code: 'not_found' }, 404);\n",
    ),
    (a) => a.unawaitedReturns.length > 0,
  );
});

// ── 4. Legitimate code must still pass ───────────────────────────────────────

test('L1 — a route table nested one bare block deeper BELOW the gate is admitted', () => {
  const source = mutate(
    "    if (resource === 'bootstrap' && !id && method === 'GET') return json({ capabilities: creationCoreCapabilities });\n",
    "    {\n      if (resource === 'bootstrap' && !id && method === 'GET') return json({ capabilities: creationCoreCapabilities });\n    }\n",
  );
  assert.deepEqual(allOffenders(analyse(source)), []);
});

test('L2 — a streaming handler dispatched as `return await` is admitted (Task 6)', () => {
  const source = mutate(
    "    return json({ error: 'not found', code: 'not_found' }, 404);\n",
    "    if (resource === 'assets' && id && !sub && method === 'GET') return await downloadAsset(id);\n" +
      "    return json({ error: 'not found', code: 'not_found' }, 404);\n",
  );
  assert.deepEqual(allOffenders(analyse(source)), []);
});

// The round-2 review flagged this as a LATENT false positive for Tasks 6–15: the
// vacuity clause asked the gated region to contain an `await`, so a read-only
// sub-router returning only `json(…)` failed with a message naming no offender.
test('L3 — an all-json() gated route table is admitted, and is not vacuous', () => {
  // Every awaited dispatch replaced, so the region contains no `await` at all —
  // whatever routes the file grows in Tasks 6–15.
  const source = ROUTE_SOURCE.replace(/return await \w+\([^)]*\)/g, 'return json({ ok: true })');
  const analysis = analyse(source);
  assert.deepEqual(allOffenders(analysis), []);
  assert.equal(analysis.awaitedReturnCount, 0, 'this is exactly the shape that used to fail');
  assert.ok(analysis.gatedReturnCount > 0, 'the region is still non-empty, which is what the clause is for');
});

// Also flagged as latent: the preflight could not be factored out at all. It can
// now, and the helper it delegates to is resolved and verified in http.ts rather
// than trusted.
test('L4 — a preflight factored out into a verified http helper is admitted', () => {
  const http = `${HTTP_SOURCE}\nexport const preflight = (): Response => new Response(null, { status: 204, headers: cors() });\n`;
  const source = mutate(PREFLIGHT_LINE, "  if (method === 'OPTIONS') return preflight();\n").replace(
    "import { assertSameOriginMutation, cors, HttpError, json } from '../../../src/twi/server/http';",
    "import { assertSameOriginMutation, cors, HttpError, json, preflight } from '../../../src/twi/server/http';",
  );
  const analysis = analyseTwiRouteFile(source, { httpSource: http });
  assert.deepEqual(allOffenders(analysis), []);
  assert.equal(analysis.preflightKind, 'factored');
});

test('L4b — a factored preflight whose helper does NOT return the verified response is refused', () => {
  const http = `${HTTP_SOURCE}\nexport const preflight = (): Response => new Response('leak', { status: 200, headers: cors() });\n`;
  const source = mutate(PREFLIGHT_LINE, "  if (method === 'OPTIONS') return preflight();\n").replace(
    "import { assertSameOriginMutation, cors, HttpError, json } from '../../../src/twi/server/http';",
    "import { assertSameOriginMutation, cors, HttpError, json, preflight } from '../../../src/twi/server/http';",
  );
  const analysis = analyseTwiRouteFile(source, { httpSource: http });
  assert.equal(analysis.preflightKind, null);
  assert.ok(allOffenders(analysis).length > 0);
});

// ── 5. The registry: which FILE can answer ───────────────────────────────────

const TREE = ['functions/_middleware.ts', ...Object.keys(FUNCTIONS_REGISTRY).filter((f) => f !== 'functions/_middleware.ts')];
const contentsFor = (overrides = {}) => (file) => overrides[file] ?? '';

test('the committed functions/ tree and FUNCTIONS_REGISTRY agree exactly', () => {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk('functions');

  const verdict = classifyFunctionsTree({
    files,
    contentsOf: (file) => readRepo(file),
    rootEntries: fs.readdirSync(REPO_ROOT),
    routesManifest: null,
  });
  assert.deepEqual(verdict.offenders, [], 'the registry has drifted from the tree, or an entry breaks its own rule');
});

test('R6 — the existing functions/_middleware.ts answering a TWI path is refused', () => {
  const verdict = classifyFunctionsTree({
    files: TREE,
    contentsOf: contentsFor({
      'functions/_middleware.ts': "if (path === '/api/twi/projects') return new Response('leak');",
    }),
  });
  assert.ok(
    verdict.offenders.some((offender) => offender.includes('_middleware.ts') && offender.includes('/api/twi')),
    `expected the content pin to fire, got ${JSON.stringify(verdict.offenders)}`,
  );
});

test('R6b/R7/X5/X7 — any undeclared file under functions/ is refused, at any depth and extension', () => {
  for (const file of [
    'functions/api/_middleware.ts',
    'functions/api/twi.js',
    'functions/api/twi/[[route]].js',
    'functions/api/twi/v2/health/[[path]].ts',
    'functions/api/twi/notes.md',
  ]) {
    const verdict = classifyFunctionsTree({ files: [...TREE, file], contentsOf: contentsFor() });
    assert.ok(
      verdict.offenders.some((offender) => offender.startsWith(file)),
      `${file} was not refused: ${JSON.stringify(verdict.offenders)}`,
    );
  }
});

test('X3 — a _middleware can never be declared public, whatever marker it carries', () => {
  const file = 'functions/api/twi/_middleware.ts';
  const registry = {
    ...FUNCTIONS_REGISTRY,
    [file]: { role: 'middleware', twi: 'public', why: 'health probe' },
  };
  const verdict = classifyFunctionsTree({
    files: [...TREE, file],
    registry,
    contentsOf: contentsFor({ [file]: '// TWI-PUBLIC-ROUTE: health probe for uptime checks' }),
  });
  assert.ok(
    verdict.offenders.some((offender) => offender.includes('cannot be declared public')),
    `expected the middleware blast-radius refusal, got ${JSON.stringify(verdict.offenders)}`,
  );
});

test('I-5 — a public declaration needs a marker WITH A REASON, not a bare marker', () => {
  const file = 'functions/api/twi/health.ts';
  const registry = { ...FUNCTIONS_REGISTRY, [file]: { role: 'route', twi: 'public', why: 'uptime probe' } };

  const bare = classifyFunctionsTree({
    files: [...TREE, file],
    registry,
    contentsOf: contentsFor({ [file]: '// TWI-PUBLIC-ROUTE:\nexport const onRequest = async () => new Response();' }),
  });
  assert.ok(
    bare.offenders.some((offender) => offender.includes('WITH A REASON')),
    `a bare marker was accepted: ${JSON.stringify(bare.offenders)}`,
  );

  const withReason = classifyFunctionsTree({
    files: [...TREE, file],
    registry,
    contentsOf: contentsFor({
      [file]: '// TWI-PUBLIC-ROUTE: uptime probe, discloses nothing\nexport const onRequest = async () => new Response();',
    }),
  });
  assert.deepEqual(withReason.offenders, [], 'a properly declared public route must be admitted');
});

test('a registry entry that lies about being unreachable is refused', () => {
  const file = 'functions/api/twi/health.ts';
  const registry = { ...FUNCTIONS_REGISTRY, [file]: { role: 'route', twi: 'unreachable', why: 'no' } };
  const verdict = classifyFunctionsTree({ files: [...TREE, file], registry, contentsOf: contentsFor() });
  assert.ok(verdict.offenders.some((offender) => offender.includes("declared twi: 'unreachable' but its path CAN answer")));
});

test('X9 — a _worker.js at the build output root is refused (Pages advanced mode ignores functions/)', () => {
  for (const name of ['_worker.js', '_worker.ts', '_worker.mjs', '_worker']) {
    const verdict = classifyFunctionsTree({
      files: TREE,
      contentsOf: contentsFor(),
      rootEntries: ['index.html', name],
    });
    assert.ok(
      verdict.deployOffenders.some((offender) => offender.startsWith(name)),
      `${name} at the build output root was not refused: ${JSON.stringify(verdict.deployOffenders)}`,
    );
  }
  assert.deepEqual(
    classifyDeployTakeover({ rootEntries: ['index.html', 'functions'], routesManifest: null }),
    [],
    'the committed root must be clean',
  );
});

test('X11 — a _routes.json that excludes an /api/ path is refused', () => {
  assert.ok(
    classifyRoutesManifest('{"version":1,"include":["/*"],"exclude":["/api/twi/*"]}').some((offender) =>
      offender.includes('excludes'),
    ),
  );
  assert.ok(
    classifyRoutesManifest('{"version":1,"include":["/fredagsfett/*"]}').some((offender) =>
      offender.includes('nothing covering /api/'),
    ),
  );
  assert.ok(classifyRoutesManifest('not json').some((offender) => offender.includes('does not parse')));
  assert.deepEqual(classifyRoutesManifest('{"version":1,"include":["/api/*"],"exclude":["/assets/*"]}'), []);
});

test('canAnswerTwi models every level and extension, and nothing else', () => {
  for (const file of [
    'functions/api/twi/[[route]].ts',
    'functions/api/twi/deep/nested/thing.mjs',
    'functions/api/twi.js',
    'functions/api/twi.tsx',
    'functions/_middleware.ts',
    'functions/api/_middleware.js',
    'functions/api/twi/_middleware.ts',
  ]) {
    assert.ok(canAnswerTwi(file), `${file} can answer /api/twi/* and was not modelled`);
  }
  for (const file of [
    'functions/api/fredagsfett/[[route]].ts',
    'functions/api/tar/[[path]].ts',
    'functions/api/twiddle/thing.ts',
    'functions/api/fredagsfett/_middleware.ts',
  ]) {
    assert.equal(canAnswerTwi(file), false, `${file} was modelled as TWI-reachable and is not`);
  }
});

test('markerReason requires text after the marker on the same line', () => {
  assert.equal(markerReason('// TWI-PUBLIC-ROUTE:'), null);
  assert.equal(markerReason('// TWI-PUBLIC-ROUTE:   '), null);
  assert.equal(markerReason('// TWI-PUBLIC-ROUTE:\nuptime probe'), null);
  assert.equal(markerReason('// TWI-PUBLIC-ROUTE: uptime probe'), 'uptime probe');
});
