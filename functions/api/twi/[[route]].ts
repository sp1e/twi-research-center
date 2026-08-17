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
 * this file (scripts/lib/twi-route-structure.mjs) rather than scanning it, and
 * asserts:
 *
 *   - the gate is ONE awaited statement whose only enclosing constructs are
 *     blocks and this handler's single `try`. No `if`, no loop, no `switch`, no
 *     callback, no inner try — so it cannot be made conditional on a method or a
 *     resource while still reading as present and early;
 *   - that try is the LAST statement here and its `catch` ends in a return, so
 *     every path that answers passes the gate and every rejection is mapped
 *     below rather than escaping to Pages;
 *   - above the gate there may be variable declarations and ONE structurally
 *     verified CORS preflight, and no other statement of any kind. So nothing up
 *     there answers by `return` OR by `throw`, the preflight's condition cannot
 *     be widened by an `||`, and `env` — D1, the bindings, every secret — is not
 *     reachable at all;
 *   - `onRequest` is the only Pages handler exported here, compared as a DECODED
 *     identifier, so a unicode escape spells the same name the check sees;
 *   - functions/api/twi/ contains only this file, because Pages routes by path
 *     specificity: a sibling module would answer /api/twi/* without this file
 *     ever being entered, and the gate cannot defend a file it is not in;
 *   - no _redirects rule matches an /api/ path.
 *
 * What it does NOT guarantee, because nothing in this repo can settle it: how
 * Cloudflare dispatches. Which export Pages prefers when several exist, and
 * whether a _redirects rule outranks a Function, are deploy-time facts. The
 * guard refuses both ambiguities instead of resolving them. And a file named in
 * the check's `publicAllowlist` is public BY DECISION — the check makes that
 * decision visible, it does not prevent it.
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
