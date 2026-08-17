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
 *      and over the DIRECTORY LISTING, because three review rounds showed the two
 *      things a line scan cannot see: a gate that is present and early but
 *      CONDITIONAL, and a sibling file Pages prefers by path specificity.
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

import { analyseTwiRouteFile, classifyRouteInventory } from './lib/twi-route-structure.mjs';

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
const structure = analyseTwiRouteFile(route);

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

check(
  `nothing above the owner gate answers except the CORS preflight${
    structure.preGateOffenders.length
      ? ` — PUBLIC, UNAUTHENTICATED code above the gate: ${structure.preGateOffenders.join(' | ')}`
      : ''
  }`,
  structure.hasOnRequest && structure.gateReasons.length === 0 && structure.preGateOffenders.length === 0,
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
 */
check(
  `onRequest is the only Pages handler in the TWI function, so no verb export can answer beside the gate${
    structure.extraHandlerExports.length ? ` — exports ${structure.extraHandlerExports.join(', ')}` : ''
  }`,
  structure.handlerExports.includes('onRequest') && structure.extraHandlerExports.length === 0,
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
 * other admitted form. The count clause keeps the check from passing vacuously
 * if the region is ever read as empty.
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
    structure.awaitedReturnCount > 0 &&
    structure.unawaitedReturns.length === 0,
);

/**
 * ── 4c. The directory, because Pages routes by path specificity ──────────────
 *
 * Every module under functions/ is an entry point. `functions/api/twi/health.ts`
 * answers /api/twi/health without [[route]].ts — and therefore without the gate —
 * ever being entered, and it beat all 29 of the previous checks plus the whole
 * test suite, because nothing in scripts/ enumerated any directory under
 * functions/. The gate cannot defend a file it is not in, so the inventory is
 * pinned instead.
 *
 * `publicAllowlist` is empty and should stay empty. A later task that genuinely
 * needs a public TWI endpoint turns two visible keys — a name here and the
 * `TWI-PUBLIC-ROUTE:` marker with a reason in the file itself — so making a
 * route public is a reviewable decision rather than a side effect of adding a
 * file. `functions/api/twi.ts` is refused for the same reason one directory up:
 * it would answer the exact path /api/twi.
 */
const twiFunctionDir = 'functions/api/twi';
const listFunctionFiles = (relativeDir) => {
  const full = path.join(root, relativeDir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFunctionFiles(path.posix.join(relativeDir, entry.name)).map((nested) => path.posix.join(entry.name, nested))
      : [entry.name],
  );
};

const inventory = classifyRouteInventory({
  files: listFunctionFiles(twiFunctionDir),
  gatedFile: '[[route]].ts',
  publicAllowlist: {},
  contentsOf: (file) => read(path.posix.join(twiFunctionDir, file)),
});

const siblingAtParent = fs.existsSync(path.join(root, 'functions/api/twi.ts'))
  ? ['functions/api/twi.ts answers /api/twi without entering the gated catch-all']
  : [];

const inventoryOffenders = [...inventory.offenders, ...siblingAtParent];

check(
  `functions/api/twi/ holds only the gated catch-all, so no sibling file can answer beside it${
    inventoryOffenders.length ? ` — ${inventoryOffenders.join(' | ')}` : ''
  }`,
  inventoryOffenders.length === 0,
);

// The CORS preflight is the one thing that may precede the gate, and it must:
// a preflight carries no cookies, so gating it would answer 401 to the browser's
// own probe. It returns no data, so it cannot leak anything either.
const preflightIndex = route.indexOf("method === 'OPTIONS'");
check(
  'the CORS preflight short-circuit is above the gate and returns no body',
  preflightIndex > 0 && preflightIndex < gateIndex && /new Response\(null, \{ status: 204/.test(route),
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

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}`);

if (failed.length) {
  console.error(`\n${failed.length} TWI contract check(s) failed.`);
  process.exit(1);
}

console.log(`\nTWI contract checks passed (${checks.length}).`);
