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
 * WHERE THE SECTIONS LIVE. This file was 799 lines against a documented 800-line ceiling, so
 * the sections were moved into scripts/lib/ along the seams they already had. Nothing was
 * renamed, retimed or rewritten: each module registers the same checks, with the same names, in
 * the same order, and the prose recording WHY each assertion has its shape moved with it.
 *
 *   sections 1, 2, 4, 4b, 4c  → scripts/lib/twi-contract-gate.mjs
 *   sections 3, 9             → scripts/lib/twi-contract-redirects.mjs
 *   sections 5, 5b, 6         → scripts/lib/twi-contract-responses.mjs
 *   sections 7, 8             → scripts/lib/twi-contract-catalog.mjs
 *   sections 10, 11           → scripts/lib/twi-contract-suite-wiring.mjs
 *   section 12                → scripts/lib/twi-contract-assets.mjs
 *   section 13                → scripts/lib/twi-contract-jobs.mjs
 *
 * The call order below IS the printed order, and the mutant manifest cites these checks by
 * name, so neither may drift.
 *
 * Run: node scripts/twi-contract-check.mjs   (npm run test:twi:contracts)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAssetIngestion } from './lib/twi-contract-assets.mjs';
import { checkCatalogAndProjects } from './lib/twi-contract-catalog.mjs';
import { checkGateStructure, checkRoutePlacement } from './lib/twi-contract-gate.mjs';
import { checkJobApi } from './lib/twi-contract-jobs.mjs';
import { checkRedirectOrdering, checkRoutingProtections } from './lib/twi-contract-redirects.mjs';
import { checkResponseShaping } from './lib/twi-contract-responses.mjs';
import { checkSuiteWiring } from './lib/twi-contract-suite-wiring.mjs';

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

// The gate offset, read once. Section 4 reasons about where it sits and section 12 places the
// asset upload branch below it, so it is computed here rather than in either module.
const gateIndex = route.indexOf('await requireOwnerSession(request, env);');

const context = {
  root,
  read,
  route,
  redirects,
  http,
  auth,
  capabilities,
  projects,
  assets,
  r2Types,
  env,
  wrangler,
  packageJson,
  runner,
  gateIndex,
};

checkRoutePlacement(context, check); //        sections 1, 2
checkRoutingProtections(context, check); //    section 3
checkGateStructure(context, check); //         sections 4, 4b, 4c
checkResponseShaping(context, check); //       sections 5, 5b, 6
checkCatalogAndProjects(context, check); //    sections 7, 8
checkRedirectOrdering(context, check); //      section 9
checkSuiteWiring(context, check); //           sections 10, 11
checkAssetIngestion(context, check); //        section 12
checkJobApi(context, check); //                section 13

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}`);

if (failed.length) {
  console.error(`\n${failed.length} TWI contract check(s) failed.`);
  process.exit(1);
}

console.log(`\nTWI contract checks passed (${checks.length}).`);
