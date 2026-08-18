/**
 * twi-contract-responses.mjs — sections 5, 5b and 6 of the TWI contract check: how the route
 * file is allowed to ANSWER, that it is inside the typecheck program, and that the modules it
 * enumerates carry no npm import of their own.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs. Section 6's CHECK NAME was corrected
 * in Task 7 fix round 1 — see the comment above the enumeration for why the old name became
 * false and why the check itself is still load-bearing. The predicate is unchanged.
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

  // ── 6. Deploy reachability: no bare-module imports in the ENUMERATED modules ──
  //
  // WHAT THIS DOES AND DOES NOT SAY, because two checks in one run used to disagree.
  // `graph` below is an ENUMERATED list, and since Task 7 it is a strict SUBSET of the real
  // Pages Function graph: `functions/api/twi/[[route]].ts` reaches src/twi/server/jobs.ts,
  // which reaches src/twi/domain/schemas.ts, which imports `zod`. So this check's name used
  // to claim "the TWI Pages Function graph … imports no npm package" while section 13's
  // walked check reported `npm packages zod` in the same output — the weaker claim printing
  // first, and false. The name now says which modules it covers.
  //
  // It is NOT redundant with the walk and must not be removed. The walk BOUNDS the packages
  // it finds against `ADMITTED_PACKAGES`, which contains `zod`, so a bare `import { z } from
  // 'zod'` placed directly in the route file passes the walk. This check refuses ANY npm
  // import in these modules, and it is the sole kill signal recorded for mutant API-20 —
  // exactly that import, in exactly that file. The two checks answer different questions:
  // this one "may these files reach a package at all" (no), the walk "which packages does
  // the whole graph reach, and are they admitted and pinned".
  const bareImports = (source) =>
    [...source.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/gm)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));

  const enumerated = {
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
  const offenders = Object.entries(enumerated).flatMap(([file, source]) =>
    source.length === 0
      ? [`${file} is missing`]
      : bareImports(source).map((specifier) => `${file} imports ${specifier}`),
  );
  check(
    `the ${Object.keys(enumerated).length} enumerated TWI Pages Function modules exist and import no npm package${
      offenders.length ? ` (${offenders.join(', ')})` : ''
    }`,
    offenders.length === 0,
  );
};
