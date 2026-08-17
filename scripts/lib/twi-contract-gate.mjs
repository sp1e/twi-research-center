/**
 * twi-contract-gate.mjs — sections 1, 2, 4, 4b and 4c of the TWI contract check: WHETHER A
 * ROUTE CAN ANSWER WITHOUT THE OWNER GATE, and WHICH FILE ANSWERS AT ALL.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs, which was 799 lines against the
 * 800-line ceiling and could not take Task 7's six routes. The prose that records WHY each
 * assertion has the shape it has travelled with it, unedited: it is the record of four
 * adversarial rounds and it is the reason none of these may be "simplified".
 *
 * Order of registration is part of the contract — the guard prints its checks in the order
 * they are pushed, and the mutant manifest cites them by name. The orchestrator calls
 * checkRoutePlacement, then the redirects module, then checkGateStructure.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  FUNCTIONS_REGISTRY,
  ROUTES_MANIFEST_NAME,
  classifyFunctionsTree,
} from './functions-registry.mjs';
import { analyseTwiRouteFile, comparePreamble } from './twi-route-structure.mjs';

/** Sections 1 and 2: the route file exists where Pages resolves it, and the gate is named. */
export const checkRoutePlacement = (context, check) => {
  const { root, route } = context;

  // ── 1. The route exists at the nested path Pages resolves for /api/twi/* ──────
  check('nested TWI route exists', fs.existsSync(path.join(root, 'functions/api/twi/[[route]].ts')));

  // ── 2. Owner gate ────────────────────────────────────────────────────────────
  check('all owner routes call requireOwnerSession', /await requireOwnerSession\(request, env\)/.test(route));
  check('bootstrap route is GET only', /resource === 'bootstrap'[\s\S]{0,100}method === 'GET'/.test(route));
  check('project create route is POST only', /resource === 'projects'[\s\S]{0,180}method === 'POST'/.test(route));
};

/**
 * Sections 4, 4b and 4c: the positional gate lock, the same fact read off a parsed AST, and
 * the closed set of files that can answer — plus the CORS preflight, the same-origin
 * mutation check and the two source pins under them.
 *
 * `gateIndex` is computed by the orchestrator rather than here because section 12 needs the
 * same offset; the expression is unchanged.
 */
export const checkGateStructure = (context, check) => {
  const { root, read, route, http, auth, gateIndex } = context;

  // ── 4. Positional gate lock ──────────────────────────────────────────────────
  // Index ordering, not existence: the gate is one line and a route below it is
  // authenticated only because of where it sits.
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
};
