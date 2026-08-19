/**
 * TWI Research Center API — /api/twi/*
 *
 * Cloudflare Pages routes /api/twi/* here rather than to the sibling
 * /api/[[route]].ts because this nested catch-all is more specific, the same way
 * /api/fredagsfett/* is split out. Nothing in the parent dispatches TWI routes,
 * and the parent's own `requireAuth` gate therefore does not apply to them: the
 * gate for this file is the `requireOwnerSession` call below, and it is the only
 * thing making these routes private.
 *
 * REACHING THE GATE IS THE SECURITY MODEL. Everything that answers below the
 * gate requires the owner's site session; anything that answers without reaching
 * it is public. A branch that drifts above the gate becomes a public endpoint and
 * NOTHING FAILS — it simply answers. scripts/twi-contract-check.mjs pins that,
 * mirroring the `api.indexOf('Protected')` assertions that guard the parent
 * router in scripts/landing-layout-check.mjs.
 *
 * Exactly what it pins, so this comment does not have to be trusted. It PARSES
 * this file (scripts/lib/twi-route-structure.mjs) rather than scanning it, and it
 * compares the functions/ tree against a declared registry
 * (scripts/lib/functions-registry.mjs). It asserts:
 *
 *   - the gate is ONE awaited statement, a DIRECT statement of this handler's
 *     single `try`, and its only enclosing constructs are that try and this body.
 *     No `if`, no loop, no `switch`, no callback, no inner try, and no bare
 *     `{ }` — so it cannot be made conditional while still reading as present and
 *     early, and the region above it cannot be made to look empty;
 *   - the identifier called IS the named import of `requireOwnerSession` from
 *     src/twi/server/auth, and that name is not redeclared anywhere in this file —
 *     so a module-scope wrapper of the same name is not mistaken for the gate;
 *   - that try is the LAST statement here, its `catch` ends in a return, and what
 *     the catch may answer with is an error envelope only: it awaits nothing and
 *     may borrow only `json` and `HttpError` from this file's imports. The catch
 *     runs on the gate's own 401, so a catch that serves data is the gate
 *     inverted;
 *   - the region above the gate EQUALS a declared preamble, statement for
 *     statement, compared as canonically printed AST — plus ONE structurally
 *     verified CORS preflight whose body is `null`, whose status is 204 and whose
 *     headers are exactly `cors()`. Adding anything up there fails, whatever it
 *     does and however it is spelled; four rounds of enumerating privileged
 *     reaches (`env`, `ctx.env`, `ctx['env']`, `ctx[key]`, a renamed
 *     destructuring) did not converge, and an equality does not have to;
 *   - every `return` below the gate inside the try is `await …` or `json(…)`, at
 *     any nesting depth;
 *   - `onRequest` is the only Pages handler exported here, compared as a DECODED
 *     identifier, and `export * from` is refused as opaque because the star can
 *     carry a handler the check cannot see;
 *   - EVERY file under functions/ is declared in that registry and the tree and
 *     the registry agree exactly — so a sibling at any depth, a parent-level
 *     `twi.*` of any extension, and a `_middleware.*` at any level all fail until
 *     declared. `functions/_middleware.ts` and the /api/* catch-all, which do run
 *     for these paths, are pinned to mention no TWI path at all;
 *   - no `_worker.js` at the build output root, no `_routes.json` exclusion and no
 *     _redirects rule matching an /api/ path — three ways to answer this URL
 *     without this Function running.
 *
 * And the analysis behind all of that is itself tested: `npm run
 * test:twi:structure` drives both modules against the mutant manifest's own
 * payloads, because a permissive rewrite of the analysis previously left the whole
 * suite green with the check count unchanged.
 *
 * What it does NOT guarantee, stated so this comment does not become the next
 * overclaim:
 *
 *   - how Cloudflare dispatches. Which export Pages prefers when several exist,
 *     whether a re-exported handler answers, and whether a _redirects rule or a
 *     _routes.json entry outranks a Function are deploy-time facts. The guard
 *     refuses those ambiguities instead of resolving them;
 *   - what `requireOwnerSession` and `assertSameOriginMutation` DO. The guard pins
 *     which function is called and where; their bodies are pinned only by regexes
 *     over src/twi/server/auth.ts and http.ts, which is weaker than everything
 *     above and is the next thing to harden;
 *   - anything about a file a deploy adds that is not in this repository;
 *   - a file declared `twi: 'public'` in the registry is public BY DECISION. The
 *     check forces that decision to be written down twice, in two files, with a
 *     reason. It does not prevent it.
 *
 * The file stays a route table. Validation, database access and response shaping
 * live in src/twi/server/*, which is unit-tested without a Workers runtime
 * (src/twi/server/route-dispatch.test.ts drives this table itself).
 *
 * EXACTLY ONE npm PACKAGE IN THIS GRAPH, AND IT IS `zod`. Pages builds this
 * project with no build command (wrangler.toml: pages_build_output_dir = "."), so
 * a bare-module import resolves fine under vitest and is a deploy-time failure —
 * which is why, until Task 7, no Pages Function here imported a package at all.
 * Task 7 changed that, and the change is bounded rather than blessed:
 *
 *   - the reach is real and one hop deep in the graph, not in this file. This
 *     module imports src/twi/server/jobs.ts, which parses through
 *     src/twi/domain/schemas.ts, which imports `zod`. That schema is the single
 *     validator for a creation specification and the only place the branded
 *     `NormalizedGenerationSpec` can be minted, so a server-side substitute would
 *     be a SECOND validator able to disagree with the wizard's on the money path;
 *   - the set is closed. scripts/lib/twi-contract-jobs.mjs WALKS the graph from
 *     this file and fails on any package outside `ADMITTED_PACKAGES` (`['zod']`),
 *     and on any package that is not a runtime dependency;
 *   - the version is pinned exactly in package.json AND package-lock.json, and a
 *     check compares the two — a caret on a graph edge would let the next
 *     `npm install` move the version inside the Function unobserved;
 *   - the modules enumerated by section 6 of the contract check — this file,
 *     http, auth, capabilities, projects, assets, r2-types, env — must still
 *     import NO package. That is a narrower claim than the walk and a stronger
 *     one about those files: a bare `zod` import written directly HERE would pass
 *     the walk, which admits `zod`, and fail section 6.
 *
 * Whether Cloudflare Pages resolves that package at deploy with no build command
 * is a deploy-time fact this repository cannot settle. It is recorded as open,
 * not assumed.
 */

import { uploadImageReference } from '../../../src/twi/server/assets';
import { requireOwnerSession } from '../../../src/twi/server/auth';
import { creationCoreCapabilities } from '../../../src/twi/server/capabilities';
import type { TwiEnv } from '../../../src/twi/server/env';
import { assertSameOriginMutation, cors, HttpError, json } from '../../../src/twi/server/http';
import { estimateJob, getJob, listJobs, submitJob } from '../../../src/twi/server/jobs';
import { cancelJob, retryJob } from '../../../src/twi/server/jobs-cancel-retry';
import { createProject, getProject, listProjects } from '../../../src/twi/server/projects';
import { D1TwiRepository } from '../../../src/twi/server/repository';

/**
 * The slice of Pages' `EventContext` this route uses.
 *
 * Spelled out rather than typed as `PagesFunction<TwiEnv>` on purpose: that
 * global comes from @cloudflare/workers-types, whose globals shadow the DOM's and
 * are deliberately kept out of the TWI tsconfig (see tsconfig.sp1epacker.json).
 * A local structural type means this file is covered by `npm run typecheck:twi`
 * and can be imported by a test, instead of being the one unchecked file in the
 * feature. Pages only requires that `onRequest` be exported and callable.
 */
export interface TwiRouteContext {
  request: Request;
  env: TwiEnv;
  params: { route?: string | string[] };
}

export const onRequest = async (ctx: TwiRouteContext): Promise<Response> => {
  const { request, env } = ctx;
  const method = request.method.toUpperCase();
  const segments = Array.isArray(ctx.params.route)
    ? ctx.params.route
    : ctx.params.route
      ? [ctx.params.route]
      : [];
  const [resource = '', id = '', sub = ''] = segments;

  // MUST stay above the requireOwnerSession gate below: a CORS preflight carries
  // no cookies, so gating it would answer 401 to the browser's own probe and the
  // real request would never be sent. It returns headers and no body, so it
  // discloses nothing.
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

  try {
    // ── Owner-only (EVERY route below this line requires the site session) ────
    // Add new TWI routes BELOW this gate. See the header.
    await requireOwnerSession(request, env);
    assertSameOriginMutation(request);

    const repo = new D1TwiRepository(env);

    // `return await` is load-bearing, not noise: `return somePromise` inside a
    // try block resolves AFTER the block is left, so a rejection would escape
    // this catch entirely and Pages would answer with its own 500 — carrying the
    // repository's message, which quotes SQL. The awaits are what keep every
    // failure inside the mapping below, and the contract check asserts that every
    // handler returned here is awaited, so a later `return listJobs(repo)` fails
    // the suite instead of reopening the leak.
    if (resource === 'bootstrap' && !id && method === 'GET') return json({ capabilities: creationCoreCapabilities });
    if (resource === 'projects' && !id && method === 'GET') return await listProjects(repo);
    if (resource === 'projects' && !id && method === 'POST') return await createProject(request, repo);
    if (resource === 'projects' && id && !sub && method === 'GET') return await getProject(id, repo);
    // The R2 binding is passed as an argument and never further: nothing below puts
    // it, its bucket name or any part of it into a response. `segments.length === 3`
    // keeps /projects/:id/assets/anything a 404 rather than a fourth-segment alias
    // for this route.
    if (resource === 'projects' && id && sub === 'assets' && segments.length === 3 && method === 'POST') {
      return await uploadImageReference(request, id, { bucket: env.FILES, repo });
    }

    // The money path. The service binding is passed as an argument and never further:
    // nothing below puts it, its name or any part of it into a response, exactly as the
    // R2 binding is handled above. `TWI_LYRIA_ESTIMATE_USD` travels as the raw string
    // because src/twi/server/estimates.ts owns parsing it — an unparseable value must
    // refuse the quote rather than silently become zero.
    const jobs = {
      repo,
      orchestrator: env.TWI_ORCHESTRATOR,
      providerEstimateUsd: env.TWI_LYRIA_ESTIMATE_USD ?? null,
    };
    if (resource === 'jobs' && id === 'estimate' && !sub && method === 'POST') {
      return await estimateJob(request, jobs);
    }
    if (resource === 'jobs' && !id && method === 'POST') return await submitJob(request, jobs);
    if (resource === 'jobs' && !id && method === 'GET') return await listJobs(request, repo);
    if (resource === 'jobs' && id && !sub && method === 'GET') return await getJob(id, repo);
    if (resource === 'jobs' && id && sub === 'cancel' && segments.length === 3 && method === 'POST') {
      return await cancelJob(id, jobs);
    }
    if (resource === 'jobs' && id && sub === 'retry' && segments.length === 3 && method === 'POST') {
      return await retryJob(id, jobs);
    }

    return json({ error: 'not found', code: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);

    // Everything else is a fault, not a verdict. The owner gets a correlation id
    // to quote; the log gets the route and the error's class. Neither gets the
    // message: repository errors quote SQL, bindings and driver detail.
    const correlationId = crypto.randomUUID();
    console.error('[twi] unhandled API error', {
      correlationId,
      method,
      resource,
      hasId: Boolean(id),
      error: error instanceof Error ? error.name : typeof error,
    });
    return json({ error: 'internal error', code: 'internal_error', correlationId }, 500);
  }
};
