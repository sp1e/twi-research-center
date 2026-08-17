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
 * ROUTE PLACEMENT IS THE SECURITY MODEL. Everything textually below the gate
 * requires the owner's site session; anything above it is public. A branch that
 * drifts above the gate becomes a public endpoint and NOTHING FAILS — it simply
 * answers. scripts/twi-contract-check.mjs asserts the index ordering so a later
 * edit cannot move a route silently, mirroring the `api.indexOf('Protected')`
 * assertions that guard the parent router in scripts/landing-layout-check.mjs.
 *
 * That ordering assertion recognises one spelling of a route, so it is backed by
 * a denylist that does not: above the gate there may be exactly ONE `return` in
 * this file and it must be the CORS preflight, and `onRequest` must be the only
 * Pages handler exported here. A new route therefore cannot answer without the
 * gate whatever it is called, whichever variable it dispatches on, and whether
 * it sits above the gate or beside it as an `onRequestGet`.
 *
 * The file stays a route table. Validation, database access and response shaping
 * live in src/twi/server/*, which is unit-tested without a Workers runtime
 * (src/twi/server/route-dispatch.test.ts drives this table itself).
 *
 * NO npm IMPORTS in this graph. Pages builds this project with no build command
 * (wrangler.toml: pages_build_output_dir = "."), and no Pages Function here has
 * ever imported a package. A bare-module import resolves fine under vitest and is
 * a deploy-time failure. The contract check asserts that too.
 */

import { requireOwnerSession } from '../../../src/twi/server/auth';
import { creationCoreCapabilities } from '../../../src/twi/server/capabilities';
import type { TwiEnv } from '../../../src/twi/server/env';
import { assertSameOriginMutation, cors, HttpError, json } from '../../../src/twi/server/http';
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
