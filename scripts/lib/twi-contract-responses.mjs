/**
 * twi-contract-responses.mjs — sections 5, 5b and 6 of the TWI contract check: how the route
 * file is allowed to ANSWER, that it is inside the typecheck program, and that its whole import
 * graph still deploys.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs.
 */

/**
 * Sections 5, 5b and 6. Section 6 is the second of the three classes of fact the
 * orchestrator's header names: Cloudflare Pages runs no build command for this project, so a
 * bare-module import resolves under vitest and fails at deploy.
 */
export const checkResponseShaping = (context, check) => {
  const { read, route, http, auth, capabilities, projects, assets, r2Types, env } = context;

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
};
