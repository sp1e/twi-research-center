/**
 * twi-contract-check.mjs — the TWI API's shape, in the places text alone decides it.
 *
 * Three classes of fact live here, and none of them can be proven by a unit test:
 *
 *   1. ROUTE REACHABILITY WITHOUT THE GATE. functions/api/twi/[[route]].ts gates
 *      every route with one `await requireOwnerSession(request, env)`. A branch
 *      that answers without reaching it becomes a publicly reachable endpoint on
 *      a private studio, and nothing fails: the handler simply answers. The same
 *      hazard in the sibling /api/[[route]].ts is pinned the same way — see the
 *      `api.indexOf('Protected')` assertions in scripts/landing-layout-check.mjs.
 *      Section 4 asserts this on a PARSED AST (scripts/lib/twi-route-structure.mjs)
 *      and over a DECLARED REGISTRY of every file under functions/
 *      (scripts/lib/functions-registry.mjs), because three review rounds showed
 *      the things a line scan over one directory cannot see: a gate that is
 *      present and early but CONDITIONAL, a sibling file Pages prefers by path
 *      specificity, and an ancestor `_middleware` that answers before either.
 *
 *      Round 3 changed the SHAPE of two of these assertions, and the reason is
 *      the record rather than taste. The region above the gate and the set of
 *      files that can answer were both pinned by enumerating what must not appear
 *      there, and both enumerations were beaten by the next round's spelling —
 *      three times running. Both are now EQUALITIES against something declared:
 *      the pre-gate region must equal `EXPECTED_PREGATE_PREAMBLE`, and the
 *      functions/ tree must equal `FUNCTIONS_REGISTRY`. A smaller claim that
 *      holds beats a larger one that keeps being falsified, and an equality
 *      cannot be evaded by a form nobody has thought of yet.
 *
 *      Section 11 asserts that the modules behind all of this are themselves
 *      tested. They were not, and a permissive 14-line stub of the analysis kept
 *      `npm test` green with this script's check count unchanged.
 *
 *   2. DEPLOY REACHABILITY. Cloudflare Pages builds this project with NO build
 *      command (wrangler.toml sets pages_build_output_dir = "."), and no Pages
 *      Function in this repo has ever imported an npm package. The TWI function
 *      graph therefore stays free of bare-module imports; a stray `import { z }
 *      from 'zod'` would resolve locally under vitest and fail at deploy.
 *
 *   3. _redirects ORDERING. Cloudflare's rule is that "redirects are always
 *      followed, regardless of whether or not an asset matches the incoming
 *      request", and only the FIRST matching rule applies. So the SPA rewrite
 *      `/twi/* -> /twi/index.html` shadows the hashed bundle under /twi/assets/
 *      unless a passthrough rule for the assets comes FIRST. Get that order wrong
 *      and /twi/ serves HTML where the browser asked for JavaScript: a blank
 *      studio, no server-side error, nothing in any test but this one.
 *
 * Run: node scripts/twi-contract-check.mjs   (npm run test:twi:contracts)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FUNCTIONS_REGISTRY,
  ROUTES_MANIFEST_NAME,
  classifyFunctionsTree,
} from './lib/functions-registry.mjs';
import { canonicalStatement, parseTypeScript } from './lib/ts-ast.mjs';
import { analyseTwiRouteFile, comparePreamble } from './lib/twi-route-structure.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => {
  const full = path.join(root, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
};

const route = read('functions/api/twi/[[route]].ts');
const redirects = read('_redirects');
const http = read('src/twi/server/http.ts');
const auth = read('src/twi/server/auth.ts');
const capabilities = read('src/twi/server/capabilities.ts');
const projects = read('src/twi/server/projects.ts');
const assets = read('src/twi/server/assets.ts');
const r2Types = read('src/twi/server/r2-types.ts');
const env = read('src/twi/server/env.ts');
const wrangler = read('wrangler.toml');
const packageJson = read('package.json');
const runner = read('scripts/run-tests.mjs');

const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

// ── 1. The route exists at the nested path Pages resolves for /api/twi/* ──────
check('nested TWI route exists', fs.existsSync(path.join(root, 'functions/api/twi/[[route]].ts')));

// ── 2. Owner gate ────────────────────────────────────────────────────────────
check('all owner routes call requireOwnerSession', /await requireOwnerSession\(request, env\)/.test(route));
check('bootstrap route is GET only', /resource === 'bootstrap'[\s\S]{0,100}method === 'GET'/.test(route));
check('project create route is POST only', /resource === 'projects'[\s\S]{0,180}method === 'POST'/.test(route));

// ── 3. Routing and source protections ────────────────────────────────────────
check('TWI app has an SPA rewrite', /^\/twi\/\*\s+\/twi\/index\.html\s+200$/m.test(redirects));
check('orchestrator source is blocked', /^\/twi-orchestrator\/\*\s+\/\s+301$/m.test(redirects));

// ── 4. Positional gate lock ──────────────────────────────────────────────────
// Index ordering, not existence: the gate is one line and a route below it is
// authenticated only because of where it sits.
const gateIndex = route.indexOf('await requireOwnerSession(request, env);');
const resourceBranches = [...route.matchAll(/resource === '[a-z-]+'/g)].map((match) => match.index);

check(
  'every TWI resource branch sits BELOW the requireOwnerSession gate',
  gateIndex > 0 && resourceBranches.length >= 2 && resourceBranches.every((index) => index > gateIndex),
);

/**
 * ── 4b. The same fact as STRUCTURE, which is the one that has to hold ─────────
 *
 * Everything above this point reasons about WHERE text appears, and three review
 * rounds proved that is the wrong shape for the fact. The ordering check sees
 * only `resource === '<lowercase-or-hyphen>'` in single quotes, so `'jobsV2'` or
 * `segments[0] === 'debug'` is invisible to it. Its two successors were line
 * scans, and they lost to: a leading block comment on the offending line; a
 * decoy `await requireOwnerSession(request, env);` inside a comment, which moved
 * the `indexOf` anchor and shrank the scanned region to the part already clean;
 * a nested `} catch (error) {`, which truncated it; `onRequestGet`; a
 * `throw` that answers without the token `return`; a preflight exemption widened
 * by one `||`; and — needing no trickery whatever —
 * `if (segments[0] !== 'health') await requireOwnerSession(request, env);`,
 * a gate that is present, early, byte-identical to the anchor, and CONDITIONAL.
 *
 * So the facts below are read off a parsed AST instead
 * (scripts/lib/twi-route-structure.mjs), and the region above the gate is pinned
 * by what it may CONTAIN — declarations and one structurally verified preflight,
 * no other statement of any kind — rather than by counting `return` tokens. The
 * two text checks above are KEPT as secondary signals: they name the offending
 * branch precisely when the idiom does match, and they cost nothing.
 *
 * Comments are not part of the AST, so no comment can flip any of these, in
 * either direction. That also retires two false positives the line scans had:
 * a trailing comment containing the word "return", and `return (await h(…));`,
 * which is the admitted form with parentheses.
 */
const structure = analyseTwiRouteFile(route, { httpSource: http });

check(
  `the TWI route file parses as TypeScript, so the structural assertions below mean something${
    structure.syntaxErrors.length ? ` — ${structure.syntaxErrors.join(' | ')}` : ''
  }`,
  route.length > 0 && structure.syntaxErrors.length === 0,
);

/**
 * UNCONDITIONAL, not merely early. The gate must be one awaited call, reached on
 * every path that can answer: no enclosing `if`, loop, `switch` or callback, and
 * no inner `try` whose `catch` could turn its 401 into "carry on". The catch that
 * DOES enclose it must be the route table's own, a direct statement of the
 * handler body, and it must end in `return` or `throw` so a rejected gate always
 * becomes a response.
 */
check(
  `the owner gate is UNCONDITIONAL and reached on every path that can answer${
    structure.gateReasons.length ? ` — ${structure.gateReasons.join(' | ')}` : ''
  }`,
  structure.hasOnRequest && structure.gateReasons.length === 0,
);

/**
 * The region above the gate is the only part of this function that runs
 * unauthenticated, and round 3 pins it by EQUALITY against a declared preamble
 * (`EXPECTED_PREGATE_PREAMBLE`) as well as by the offender rules.
 *
 * The reason is the record. Round 2 asserted "declarations and one preflight,
 * nothing else, and nothing that reaches `env`" — and was beaten five ways at
 * once: the region could be emptied by wrapping the gate in a bare `{ }` (the
 * `indexOf` returned −1 and −1 was read as "region starts at 0"), and `env` could
 * be reached as `ctx['env']`, as `ctx[key]`, or through a renamed destructuring,
 * none of which is the identifier `env`. Enumerating privileged reaches has now
 * failed in three consecutive rounds. An equality cannot be beaten by a spelling:
 * anything added above the gate fails, whatever it does and however it is written.
 *
 * The offender rules are kept underneath, unchanged and extended, because they
 * name what is wrong ("`env` is reachable above the gate: …") where the equality
 * only says the region drifted.
 */
const preambleDifferences = comparePreamble(structure.preGateCanonical);

check(
  `nothing above the owner gate answers except the CORS preflight${
    structure.preGateOffenders.length
      ? ` — PUBLIC, UNAUTHENTICATED code above the gate: ${structure.preGateOffenders.join(' | ')}`
      : ''
  }${
    preambleDifferences.length
      ? ` — the region above the gate is NOT the declared preamble (EXPECTED_PREGATE_PREAMBLE in scripts/lib/twi-route-structure.mjs): ${preambleDifferences.join(' | ')}`
      : ''
  }`,
  structure.hasOnRequest &&
    structure.gateReasons.length === 0 &&
    structure.preGateOffenders.length === 0 &&
    preambleDifferences.length === 0,
);

/**
 * The mapping `catch` runs on the gate's OWN 401, so what it may answer with is a
 * gate question, not an error-handling one. Round 2 required it to bind, read and
 * end in a return; it never constrained the payload, so
 * `if (error.status === 401 && segments[0] === 'health') return json({ capabilities: … })`
 * served the resource to an unauthenticated caller with contract, typecheck and
 * the unit suite all green. Here every return must be an error envelope, nothing
 * may be awaited, and the catch may borrow only `json` and `HttpError` from this
 * file's imports — so there is no handler to call and no payload to build.
 */
check(
  `the catch that maps the gate's 401 answers with an error envelope, never with the resource${
    structure.catchOffenders.length ? ` — ${structure.catchOffenders.join(' | ')}` : ''
  }`,
  structure.hasOnRequest && structure.gateReasons.length === 0 && structure.catchOffenders.length === 0,
);

/**
 * Cloudflare Pages dispatches verb-specific exports (`onRequestGet`,
 * `onRequestPost`, …) as well as `onRequest`. One of those added to this file
 * would sit BESIDE the gate rather than above or below it, so positional
 * reasoning cannot see it at all. Which export Pages prefers when both exist is
 * not something this repo can prove without a deploy, so the guard refuses the
 * ambiguity: this function has exactly one entry point, and every route
 * reachable through it passes the gate.
 *
 * Compared as DECODED identifiers, so `onRequestGet` — which declares
 * `onRequestGet` and matched no regex — is the same name to this check as
 * `onRequestGet`.
 *
 * A star re-export (`export * from './x'`) is refused as OPAQUE rather than read:
 * the names it carries live in another module, so `export * from` a file exporting
 * `onRequestPost` put a second handler in this module's namespace with nothing
 * here to compare. Whether Pages dispatches a re-exported handler is a deploy-time
 * fact, so the guard refuses the ambiguity, as it does for _redirects precedence.
 */
check(
  `onRequest is the only Pages handler in the TWI function, so no verb export can answer beside the gate${
    structure.extraHandlerExports.length ? ` — exports ${structure.extraHandlerExports.join(', ')}` : ''
  }${structure.opaqueExports.length ? ` — OPAQUE: ${structure.opaqueExports.join(' | ')}` : ''}`,
  structure.handlerExports.includes('onRequest') &&
    structure.extraHandlerExports.length === 0 &&
    structure.opaqueExports.length === 0,
);

/**
 * `return await` in the route table is load-bearing, not noise: `return
 * somePromise` inside a `try` settles after the block is left, so the `catch`
 * below never sees the rejection and Pages answers with its own 500 carrying
 * the repository's message — which quotes SQL. That was proven by mutation
 * (Task 5 M5 / API-05), and nothing asserted it. A new branch written
 * `return listJobs(repo)` would reopen the leak with every test green.
 *
 * `return json(...)` is synchronous and correctly unawaited, so it is the one
 * other admitted form. The count clause keeps the check from passing vacuously if
 * the region is ever read as empty — and it counts RETURNS, not awaits. Round 2
 * required `awaitedReturnCount > 0`, which asks the region to contain an `await`,
 * so a read-only sub-router whose gated returns were all `json(…)` — entirely
 * legitimate, and likely in Tasks 6–15 — would have failed this check with a
 * message listing no offenders at all.
 *
 * Two admitted forms and no others is the point, so this also rejects
 * `return new Response(…)` inside the gate — deliberately. A task that needs to
 * stream a body (an asset download, say) writes the handler in
 * src/twi/server/* like every other one and `return await`s it, which is where
 * the response shaping belongs and what keeps this file a route table. A
 * `ReadableStream` body survives that unchanged: awaiting the async factory
 * settles the Response object, not the stream.
 *
 * Every return below the gate is examined at every nesting depth, so a nested
 * block, `switch` or inner `try` hides nothing.
 */
check(
  `every handler returned inside the gate is awaited, so no rejection escapes the catch${
    structure.unawaitedReturns.length ? ` — UNAWAITED: ${structure.unawaitedReturns.join(' | ')}` : ''
  }`,
  structure.hasOnRequest &&
    structure.gateReasons.length === 0 &&
    structure.gatedReturnCount > 0 &&
    structure.unawaitedReturns.length === 0,
);

/**
 * ── 4c. WHICH FILE ANSWERS — a closed set, not a search ──────────────────────
 *
 * Round 2 pinned the listing of `functions/api/twi/` and refused
 * `functions/api/twi.ts` by name. Round 3 beat that three ways without touching
 * either: the EXISTING `functions/_middleware.ts` answering a TWI path instead of
 * calling `next()`; a new `functions/api/_middleware.ts`; and
 * `functions/api/twi.js`, because the parent-level refusal named one exact path
 * with one extension. Probing those turned up two more, both one committed file
 * away: `_worker.js`, which makes Pages ignore the whole functions/ directory, and
 * `_routes.json`, which can exclude /api/twi/* from invoking a Function at all.
 *
 * Enumerating entry points has now been wrong in three consecutive rounds, so the
 * shape of the assertion changes: EVERY file under functions/ must be declared in
 * `FUNCTIONS_REGISTRY` (scripts/lib/functions-registry.mjs), and the check asserts
 * the filesystem and the registry agree exactly, in both directions. Adding a file
 * of any name, extension or depth fails until it is declared with what it may do
 * with the TWI URL space — and the two files that CAN run for a TWI path
 * legitimately (`functions/_middleware.ts`, the `/api/*` catch-all) are pinned by
 * content to mention no TWI path at all.
 *
 * A later task that genuinely needs a public TWI endpoint still turns two visible
 * keys: `twi: 'public'` with a `why` in the registry, and the
 * `TWI-PUBLIC-ROUTE:` marker WITH A REASON in the file. A `_middleware` can never
 * be one, because a middleware exemption is not one route, it is all of them.
 */
const listFilesUnder = (relativeDir) => {
  const full = path.join(root, relativeDir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relativeDir, entry.name);
    return entry.isDirectory() ? listFilesUnder(child) : [child];
  });
};

const routesManifestPath = path.join(root, ROUTES_MANIFEST_NAME);
const registryVerdict = classifyFunctionsTree({
  files: listFilesUnder('functions'),
  registry: FUNCTIONS_REGISTRY,
  contentsOf: (file) => read(file),
  rootEntries: fs.readdirSync(root),
  routesManifest: fs.existsSync(routesManifestPath) ? fs.readFileSync(routesManifestPath, 'utf8') : null,
});

// The name is kept verbatim from round 2 so every `killedBy` entry that cites it
// stays literally accurate. What it now covers is every file that can answer a TWI
// path at ANY level — the gated directory at any depth and extension, a
// parent-level `twi.*` sibling, and a `_middleware.*` at three levels — plus the
// content pin on the two files that legitimately run for those paths.
check(
  `functions/api/twi/ holds only the gated catch-all, so no sibling file can answer beside it${
    registryVerdict.twiOffenders.length ? ` — ${registryVerdict.twiOffenders.join(' | ')}` : ''
  }`,
  registryVerdict.twiOffenders.length === 0,
);

// The set equality itself, over the WHOLE tree rather than the TWI subset. Asserted
// under its own name because it is a stronger and different fact: a new file
// anywhere under functions/ is a new entry point for something, and the registry is
// where that decision is recorded.
check(
  `every file under functions/ is declared in FUNCTIONS_REGISTRY, so no entry point appears unreviewed${
    registryVerdict.treeOffenders.length ? ` — ${registryVerdict.treeOffenders.join(' | ')}` : ''
  }`,
  registryVerdict.treeOffenders.length === 0,
);

/**
 * And the two ways to answer /api/twi/* with no file under functions/ at all.
 *
 * `_worker.js` at the build output root puts Pages in advanced mode, which ignores
 * the entire functions/ directory — every assertion above included. `_routes.json`
 * decides which paths invoke a Function, so an `exclude` covering /api/twi/* serves
 * those paths from static assets and the gate never runs. Neither file exists here;
 * both are one commit away, and neither was modelled by any of the three previous
 * rounds. Same reasoning as the `/api/` `_redirects` rule below: this is deploy
 * configuration that outranks the code.
 */
check(
  `no deploy-level takeover answers /api/twi/* instead of the gated Function (_worker.js, _routes.json)${
    registryVerdict.deployOffenders.length ? ` — ${registryVerdict.deployOffenders.join(' | ')}` : ''
  }`,
  registryVerdict.deployOffenders.length === 0,
);

/**
 * The CORS preflight is the one thing that may precede the gate, and it must: a
 * preflight carries no cookies, so gating it would answer 401 to the browser's own
 * probe. It returns no data, so it cannot leak anything either.
 *
 * The "returns no body" half was `/new Response\(null, \{ status: 204/` over the
 * file text. That is replaced by the STRUCTURAL verdict, which is strictly
 * stronger on the inline form — the regex accepted
 * `{ status: 204, headers: { ...cors(), 'x-leak': String(Object.keys(ctx['env'])) } }`,
 * and the shape check pins the option object to exactly `status: 204` and
 * `headers: cors()` — and which additionally admits the ONE form round 2 refused
 * for lack of visibility: `return preflight()`, resolved in src/twi/server/http.ts
 * and required to have exactly that body there. The index comparison is kept as
 * the secondary positional signal it always was.
 */
const preflightIndex = route.indexOf("method === 'OPTIONS'");
check(
  `the CORS preflight short-circuit is above the gate and returns no body${
    structure.preflightKind ? '' : ' — no structurally verified preflight was found above the gate'
  }`,
  preflightIndex > 0 && preflightIndex < gateIndex && structure.preflightKind !== null,
);

check(
  'same-origin mutation validation runs before the route table',
  (() => {
    const originIndex = route.indexOf('assertSameOriginMutation(request);');
    return originIndex > gateIndex && resourceBranches.every((index) => index > originIndex);
  })(),
);

check(
  'assertSameOriginMutation compares Origin against the request origin and fails closed',
  /new URL\(request\.url\)\.origin/.test(http) &&
    /origin mismatch/.test(http) &&
    /'GET'|'HEAD'/.test(http),
);

check(
  'requireOwnerSession reuses the site session cookie and the sessions table',
  /getCookie\(request, 'session'\)/.test(auth) &&
    /FROM sessions WHERE token = \? AND datetime\(expires_at\) > datetime\('now'\)/.test(auth) &&
    /new HttpError\(401, 'Unauthorized'\)/.test(auth),
);

// ── 5. Responses go through the shared helper ────────────────────────────────
// json() attaches cors(); a hand-rolled Response drops those headers silently.
check(
  'the route file returns JSON only through the shared json() helper',
  /import \{[^}]*\bjson\b[^}]*\} from/.test(route) && !/new Response\(JSON\.stringify/.test(route),
);

check(
  'errors map to { error, code } and unexpected ones leak neither stack nor cause',
  /error instanceof HttpError/.test(route) &&
    /code: 'internal_error'/.test(route) &&
    /correlationId/.test(route) &&
    !/\.stack/.test(route),
);

check(
  'unknown TWI paths answer not_found rather than falling through',
  /code: 'not_found' \}, 404\)/.test(route),
);

// ── 5b. The route file is inside the typecheck program ───────────────────────
// It is the only Pages Function on this site under tsc, and only because
// tsconfig.twi.json names its directory. Dropping the entry leaves the file
// compiling by accident, as a dependency of whichever test still imports it.
check(
  'tsconfig.twi.json covers the TWI Pages Function directory',
  /"functions\/api\/twi\/\*\*\/\*\.ts"/.test(read('tsconfig.twi.json')),
);

// ── 6. Deploy reachability: no bare-module imports in the function graph ─────
const bareImports = (source) =>
  [...source.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/gm)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));

const graph = {
  'functions/api/twi/[[route]].ts': route,
  'src/twi/server/http.ts': http,
  'src/twi/server/auth.ts': auth,
  'src/twi/server/capabilities.ts': capabilities,
  'src/twi/server/projects.ts': projects,
  // Task 6's additions. Listed here rather than trusted to be like the others: the
  // whole point of this check is that a bare-module import resolves under vitest and
  // fails at deploy, and a new file in the graph is exactly where that would appear.
  'src/twi/server/assets.ts': assets,
  'src/twi/server/r2-types.ts': r2Types,
  'src/twi/server/env.ts': env,
};
const offenders = Object.entries(graph).flatMap(([file, source]) =>
  source.length === 0
    ? [`${file} is missing`]
    : bareImports(source).map((specifier) => `${file} imports ${specifier}`),
);
check(
  `the TWI Pages Function graph exists and imports no npm package${offenders.length ? ` (${offenders.join(', ')})` : ''}`,
  offenders.length === 0,
);

// ── 7. Capability catalog: the wizard reads these to decide what to offer ────
check(
  'capability catalog reports the Creation Core provider and its limits',
  /provider: 'lyria-3-pro'/.test(capabilities) &&
    /fullSong: true/.test(capabilities) &&
    /customLyrics: true/.test(capabilities) &&
    /imageReference: true/.test(capabilities) &&
    /maxImageReferences: 10/.test(capabilities) &&
    /outputFormats: \['audio\/wav'\]/.test(capabilities),
);
check(
  'capability catalog reports the Phase 1 unavailable inputs as unavailable',
  /audioReference: false/.test(capabilities) &&
    /midiReference: false/.test(capabilities) &&
    /deterministicSeed: false/.test(capabilities),
);

// ── 8. Project names ─────────────────────────────────────────────────────────
check(
  'project names are bounded at 120 characters and required',
  /MAX_PROJECT_NAME_LENGTH = 120/.test(projects) && /toSingleLineText/.test(projects),
);
check(
  'project creation mints its own id and ISO timestamp rather than asking SQL',
  /crypto\.randomUUID\(\)/.test(projects) &&
    /new Date\(\)\.toISOString\(\)/.test(projects) &&
    !/datetime\('now'\)/.test(projects),
);

// ── 9. _redirects ordering: the SPA rewrite must not shadow the bundle ───────
/**
 * The committed file parsed into the rules Cloudflare would actually apply, in
 * order. Parsed rather than substring-searched: the ordering assertion below used
 * to compare `redirects.indexOf('/twi/*')` against `indexOf('/twi/assets/*')`,
 * which reads comment prose as a rule — the explanatory comment above these very
 * lines mentions `/twi/*`, and that alone was enough to fail the check while the
 * file was correct. A check that a comment can flip is not a check.
 */
const redirectRules = redirects
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [from, to, status = '200'] = line.split(/\s+/);
    return from && to ? { from, to, status } : null;
  })
  .filter((rule) => rule !== null);

const ruleIndex = (from) => redirectRules.findIndex((rule) => rule.from === from);

check(
  'the /twi/assets passthrough precedes the SPA rewrite',
  (() => {
    const assetGuard = ruleIndex('/twi/assets/*');
    const spa = ruleIndex('/twi/*');
    return assetGuard !== -1 && spa !== -1 && assetGuard < spa;
  })(),
);

/**
 * Cloudflare's documented semantics, applied to the committed file: rules are
 * tried in order, the first match wins, and a matching rule beats a real asset.
 * Resolving three concrete paths through that model is what makes the ordering
 * check above mean something rather than merely comparing two offsets.
 */
const resolveRedirect = (requestPath) => {
  for (const { from, to, status } of redirectRules) {
    if (from.endsWith('/*')) {
      const prefix = from.slice(0, -1);
      if (requestPath.startsWith(prefix)) {
        return { to: to.replace(':splat', requestPath.slice(prefix.length)), status };
      }
    } else if (from === requestPath) {
      return { to, status };
    }
  }
  return null;
};

/**
 * No _redirects rule may match an /api/ path — the third way a route answers
 * without the gate, found while probing section 4c.
 *
 * `/api/twi/health  /twi/index.html  200` is a rewrite, and it needs no new file
 * and no edit to the route table. Which layer wins when a rule and a Function
 * both match the same path is NOT something this repo can settle without a
 * deploy, so the assertion is written so the answer does not matter: if the
 * rewrite wins, an /api/twi/* path serves a static asset to anyone; if the
 * Function wins, the rule is dead configuration that tells the next reader the
 * opposite of what happens. Both are defects, so neither is allowed.
 */
check(
  'no _redirects rule matches an /api/ path, so nothing can answer an API route without its Function',
  (() => {
    const apiRules = redirectRules.filter((rule) =>
      rule.from.startsWith('/api/') || rule.from === '/api' || rule.from === '/*',
    );
    return apiRules.length === 0;
  })(),
);

check(
  'a hashed /twi/assets/ bundle request still resolves to itself, not to index.html',
  (() => {
    const resolved = resolveRedirect('/twi/assets/index-DHF0GnNS.js');
    return resolved?.to === '/twi/assets/index-DHF0GnNS.js' && resolved.status === '200';
  })(),
);
check(
  'a deep /twi/ app path resolves to the SPA entry',
  (() => {
    const resolved = resolveRedirect('/twi/library/anything');
    return resolved?.to === '/twi/index.html' && resolved.status === '200';
  })(),
);
check(
  'the orchestrator worker source is not fetchable',
  (() => {
    const resolved = resolveRedirect('/twi-orchestrator/src/index.ts');
    return resolved?.to === '/' && resolved.status === '301';
  })(),
);

// ── 10. The suite is wired into the run ──────────────────────────────────────
// A check nobody runs is a comment. Three facts have to hold together, and each
// one is checked against the file that actually decides it rather than against
// the plan's prose: the script exists, `npm test` really is the suite runner, and
// the runner's SUITES list names this script. Asserting only the first would pass
// with the check orphaned; asserting a chained `&&` string in package.json — as an
// earlier draft of this file did — describes a root `test` command this repo no
// longer has.
const suitesBlock = /const SUITES = \[([\s\S]*?)\n\]/.exec(runner)?.[1] ?? '';

check(
  'test:twi:contracts is declared in package.json',
  /"test:twi:contracts":\s*"node scripts\/twi-contract-check\.mjs"/.test(packageJson),
);
check(
  'npm test is the suite runner, and the runner lists test:twi:contracts',
  /"test":\s*"node scripts\/run-tests\.mjs"/.test(packageJson) && /'test:twi:contracts'/.test(suitesBlock),
);

/**
 * ── 11. THE GUARD'S OWN GUARD ────────────────────────────────────────────────
 *
 * Everything in section 4 is read off two pure modules, and until this round
 * nothing tested them. The re-review measured what that is worth: a 14-line
 * permissive stub of scripts/lib/twi-route-structure.mjs kept `npm test` at 7/7
 * AND this script reporting 33 — the count is invariant under the removal of the
 * entire kill signal for API-27 through API-50, so the one number a reviewer might
 * plausibly be tracking does not move.
 *
 * scripts/twi-route-structure.test.mjs closes that: it drives both modules
 * directly, and its corpus is the mutant manifest's own exact-from-source
 * find/replace pairs, so each entry's prose `premise` becomes an executed
 * assertion. These two checks assert the suite is DECLARED and RUN — a test nobody
 * runs is a comment, which is the same argument section 10 makes for this script.
 */
check(
  'test:twi:structure is declared in package.json',
  /"test:twi:structure":\s*"node --test scripts\/twi-route-structure\.test\.mjs"/.test(packageJson),
);
check(
  'the runner lists test:twi:structure, so the gate analysis is itself tested',
  /'test:twi:structure'/.test(suitesBlock) && fs.existsSync(path.join(root, 'scripts/twi-route-structure.test.mjs')),
);

/**
 * ── 12. IMAGE-REFERENCE INGESTION (Task 6) ───────────────────────────────────
 *
 * Two of the facts below are ORDERS, not values, and that is why they are here
 * rather than only in `src/twi/server/assets.test.ts`. A unit test can prove that a
 * 10 MiB + 1 upload is refused; it cannot prove the refusal is CHEAP unless it also
 * owns an instrument that witnesses the read (that suite does, with a file that
 * throws on access). This section pins the same orders in the source, so a later
 * edit that moves the cap below the read fails by name:
 *
 *   - the size cap precedes the byte read inside `validateImageReference`;
 *   - the declared-length refusal precedes `request.formData()` inside
 *     `uploadImageReference`.
 *
 * A cap that fires after the expensive work is not a guard, it is a CPU and memory
 * amplifier — this project has already fixed that shape twice (`RAW_LENGTH_SLACK`
 * and `RAW_ENTRY_SLACK` in src/twi/domain/schemas.ts, both of which bound raw input
 * before zod walks it).
 *
 * The order checks read a COMMENT-FREE canonical rendering of each function, printed
 * from the AST, for the reason section 9 records for _redirects: a check a comment can
 * flip is not a check. The prose above mentions `formData` and the cap in the opposite
 * order to the code, which under a substring scan of the raw file would be enough to
 * invert both.
 */
const canonicalStatements = (source, fileName) => {
  if (source.length === 0) return [];
  const sf = parseTypeScript(source, fileName);
  return sf.statements.map((statement) => canonicalStatement(sf, statement));
};

const assetStatements = canonicalStatements(assets, 'assets.ts');
const assetsCanonical = assetStatements.join('\n');
const assetFunction = (name) =>
  assetStatements.find((text) => new RegExp(`^export (?:async )?function ${name}\\b`).test(text)) ?? '';

/** Is `first` present and does it come before `second` in `text`? Fails closed if either is absent. */
const precedes = (text, first, second) => {
  const at = text.indexOf(first);
  const then = text.indexOf(second);
  return at !== -1 && then !== -1 && at < then;
};

check(
  'the asset upload route is POST /projects/:id/assets and sits BELOW the owner gate',
  (() => {
    const uploadIndex = route.indexOf("sub === 'assets'");
    return (
      uploadIndex > gateIndex &&
      /if \(resource === 'projects' && id && sub === 'assets' && segments\.length === 3 && method === 'POST'\)/.test(route)
    );
  })(),
);

check(
  'the upload is dispatched to src/twi/server/assets, so the route file stays a route table',
  /import \{ uploadImageReference \} from '\.\.\/\.\.\/\.\.\/src\/twi\/server\/assets'/.test(route) &&
    /return await uploadImageReference\(request, id, \{ bucket: env\.FILES, repo \}\)/.test(route),
);

check(
  'an image reference is identified by its BYTES: a magic-byte table, not a filename or a declared type',
  /export async function validateImageReference/.test(assets) &&
    /0x89, 0x50, 0x4e, 0x47/.test(assetsCanonical) &&
    /0xff, 0xd8, 0xff/.test(assetsCanonical) &&
    /0x52, 0x49, 0x46, 0x46/.test(assetsCanonical) &&
    /0x57, 0x45, 0x42, 0x50/.test(assetsCanonical) &&
    /contentType: signature\.contentType/.test(assetsCanonical) &&
    /await validateImageReference\(input\.file\)/.test(assetsCanonical),
);

check(
  'image reference uploads are capped at 10 * 1024 * 1024 bytes',
  /export const MAX_IMAGE_REFERENCE_BYTES = 10 \* 1024 \* 1024/.test(assets),
);

check(
  'the size cap is applied BEFORE any byte of the upload is read',
  precedes(assetFunction('validateImageReference'), 'size > MAX_IMAGE_REFERENCE_BYTES', 'arrayBuffer()'),
);

check(
  'the format probe reads at most MAGIC_BYTE_PROBE_BYTES, never the whole file',
  /export const MAGIC_BYTE_PROBE_BYTES = 16/.test(assets) &&
    /file\.slice\(0, MAGIC_BYTE_PROBE_BYTES\)/.test(assetsCanonical) &&
    !/await file\.arrayBuffer\(\)/.test(assetFunction('validateImageReference')),
);

check(
  'the upload route refuses an oversize declared body BEFORE parsing the multipart form',
  precedes(assetFunction('uploadImageReference'), 'MAX_MULTIPART_BODY_BYTES', 'request.formData()') &&
    /export const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_REFERENCE_BYTES \+ MULTIPART_ENVELOPE_SLACK_BYTES/.test(assets),
);

check(
  'image reference objects are written under the twi/ R2 prefix, namespaced by project and asset',
  /export const R2_TWI_PREFIX = 'twi\/'/.test(assets) &&
    /\$\{R2_TWI_PREFIX\}\$\{projectId\}\/assets\/\$\{assetId\}\/source\.\$\{extension\}/.test(assets),
);

check(
  'the R2 object is written first, the row second, and the object is DELETED if the row is refused',
  (() => {
    const create = assetFunction('createImageAsset');
    return (
      precedes(create, 'bucket.put(', 'repo.registerAsset(') &&
      precedes(create, 'repo.registerAsset(', 'bucket.delete(') &&
      precedes(create, 'bucket.delete(', 'throw error')
    );
  })(),
);

check(
  "registerAsset's outcome is read, so a replay is never reported as a fresh creation",
  /const \{ asset, outcome \} = await repo\.registerAsset\(/.test(assetsCanonical) &&
    /outcome === 'inserted' \? 201 : 200/.test(assetsCanonical),
);

/**
 * The binding must not travel. `env.FILES` is passed to the handler as an argument
 * and appears nowhere else; the ingestion module never names it at all, so there is
 * nothing there to serialise. Checked against the comment-free rendering, because
 * this file's own prose names the binding several times.
 */
check(
  'the asset API returns no binding, bucket name or credential — FILES is an argument, never a payload',
  !/\bFILES\b/.test(assetsCanonical) &&
    (route.match(/env\.FILES/g) ?? []).length === 1 &&
    !/sp1e-files/.test(assets + route) &&
    !/accessKeyId|secretAccessKey|cloudflarestorage|R2_ACCESS/.test(assets + route),
);

check(
  'TwiEnv declares the EXISTING FILES bucket wrangler.toml defines, rather than inventing one',
  /FILES: R2BucketLike/.test(env) &&
    /^\s*binding\s*=\s*"FILES"\s*$/m.test(wrangler) &&
    /^\s*bucket_name\s*=\s*"sp1e-files"\s*$/m.test(wrangler),
);

check(
  'the ten-references-per-specification limit IS the capability catalog number, not a second copy',
  /export const MAX_IMAGE_REFERENCES_PER_SPEC = creationCoreCapabilities\.maxImageReferences/.test(assets) &&
    /export function assertImageReferenceSelection/.test(assets),
);

/**
 * Both halves read the comment-free rendering, and the negative half has to.
 * `assets.ts` explains in prose WHY `datetime('now')` is refused — SQLite emits no
 * milliseconds and a space separator, which `twi_assets_created_at_iso` rejects — and
 * a substring scan of the raw file counts that explanation as the offence. This check
 * failed exactly that way on first run.
 */
check(
  'asset rows carry a JS-generated ISO timestamp, never SQL’s clock',
  /createdAt: clock\.now\(\)/.test(assetsCanonical) && !/datetime\('now'\)/.test(assetsCanonical),
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}`);

if (failed.length) {
  console.error(`\n${failed.length} TWI contract check(s) failed.`);
  process.exit(1);
}

console.log(`\nTWI contract checks passed (${checks.length}).`);
