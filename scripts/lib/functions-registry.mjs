/**
 * functions-registry.mjs — every file that can answer a request, DECLARED.
 *
 * This standalone repository contains only the TWI Pages Function. The registry
 * remains an exact set equality so adding middleware, a sibling route, or another
 * entry point fails closed until its relationship to the owner gate is reviewed.
 *
 * Why a registry and not more analysis. The question "can any path reach
 * /api/twi/* without the owner gate?" is open-ended, and four rounds of review
 * answered it four different ways, each time by finding an entry point the
 * previous round had not modelled:
 *
 *   round 1  a sibling module — functions/api/twi/health.ts
 *   round 2  the same, at any depth, plus functions/api/twi.ts and a _redirects
 *            rewrite
 *   round 3  the EXISTING functions/_middleware.ts answering without next(); a new
 *            functions/api/_middleware.ts; functions/api/twi.js, because the
 *            parent-level refusal named one exact path with one extension
 *   round 3  (this round, probing the above) ./_worker.js, which replaces the
 *            entire Functions runtime, and ./_routes.json, which can exclude
 *            /api/twi/* from invoking a Function at all
 *
 * That is not converging, and an open-ended claim that keeps being falsified is
 * worse than a smaller one that holds. So the shape of the assertion changes:
 * every file under functions/ must be DECLARED here, the check asserts the
 * filesystem and this registry agree EXACTLY, and each entry states what the file
 * may do with the TWI URL space. Adding a file — any name, any extension, any
 * depth, middleware or not — fails until it is declared. That is a set equality,
 * it cannot be evaded by a spelling, and it is small enough to keep true.
 *
 * What it still does not prove, stated so the next round does not have to
 * rediscover it: how Cloudflare dispatches. Whether a re-exported handler answers,
 * whether a _redirects rule outranks a Function, which export wins when several
 * exist — deploy-time facts. The registry refuses the ambiguities rather than
 * resolving them, which is the same position the rest of the guard takes.
 *
 * Purity: this module reads no file. The caller passes in the listing and the file
 * contents it needs, exactly as scripts/lib/migration-sql.mjs does.
 */

/**
 * The marker a file must carry to be public, and the rule that it needs a REASON.
 *
 * Round 2 documented "the marker with a reason" and asserted only
 * `contents.includes('TWI-PUBLIC-ROUTE:')`, so a bare `// TWI-PUBLIC-ROUTE:` with
 * nothing after it passed. The reason is now the assertion: non-whitespace text
 * must follow the marker on the same line, and the registry entry must carry its
 * own non-empty `why` — two independent statements of intent, in two files.
 */
export const PUBLIC_ROUTE_MARKER = 'TWI-PUBLIC-ROUTE:';

export const markerReason = (contents) => {
  for (const line of (contents ?? '').split('\n')) {
    const at = line.indexOf(PUBLIC_ROUTE_MARKER);
    if (at === -1) continue;
    const reason = line.slice(at + PUBLIC_ROUTE_MARKER.length).trim();
    if (reason.length > 0) return reason;
  }
  return null;
};

/**
 * `twi` says what the file is permitted to do with the /api/twi/* URL space:
 *
 *   'gated'             this is the catch-all that holds the owner gate. Exactly one.
 *   'public'            declared public BY DECISION; needs `why` here and the
 *                       marker-with-reason in the file. Never allowed for a
 *                       _middleware, whose blast radius is every path at once.
 *   'must-not-reference' the file can run for a TWI path (middleware, or the parent
 *                       catch-all) but must not mention the TWI URL space, so it
 *                       cannot answer one. Asserted against its source.
 *   'unreachable'       the file's own path cannot serve /api/twi/*. Asserted, so
 *                       mislabelling a reachable file fails.
 */
export const FUNCTIONS_REGISTRY = {
  'functions/api/[[route]].ts': {
    role: 'route',
    twi: 'must-not-reference',
    why: 'the standalone health and owner-session API; the more-specific TWI route owns the TWI URL space.',
  },
  'functions/api/twi/[[route]].ts': {
    role: 'route',
    twi: 'gated',
    why: 'the standalone repository\'s only Pages entry point; the owner gate lives here and scripts/lib/twi-route-structure.mjs pins its structure.',
  },
};

/**
 * Files at the BUILD OUTPUT ROOT that take over routing wholesale.
 *
 * `_worker.js` puts Pages in advanced mode: the Functions directory is ignored
 * entirely and that one module answers everything, gate included. `_routes.json`
 * decides which paths invoke Functions at all, so an `exclude` covering
 * /api/twi/* serves those paths as static assets and the gate never runs. Neither
 * exists in this repo and neither is reachable from any code path the other checks
 * read; both are one committed file away.
 */
export const WORKER_TAKEOVER_NAMES = ['_worker.js', '_worker.ts', '_worker.mjs', '_worker'];
export const ROUTES_MANIFEST_NAME = '_routes.json';

/** Does this path answer /api/twi/*? Extension-blind, depth-blind, by construction. */
export const canAnswerTwi = (file) =>
  file.startsWith('functions/api/twi/') ||
  /^functions\/api\/twi\.[^/]+$/.test(file) ||
  /^functions\/(?:api\/(?:twi\/)?)?_middleware\.[^/]+$/.test(file);

const REFERENCES_TWI = ['/api/twi', '/twi/'];

/**
 * The filesystem against the registry, and the registry against its own rules.
 *
 * `files` is every file under functions/, as repo-relative POSIX paths.
 * `contentsOf(file)` returns its source text (or '' when unreadable).
 * `rootEntries` is every name at the build output root.
 * `routesManifest` is the text of _routes.json when it exists.
 */
export function classifyFunctionsTree({
  files,
  registry = FUNCTIONS_REGISTRY,
  contentsOf,
  rootEntries = [],
  routesManifest = null,
}) {
  // Three separate verdicts, because they answer three separate questions and the
  // caller asserts them under three separate names. Folding them into one list
  // would leave a check whose NAME describes a directory while its body decides
  // whether Pages runs the functions directory at all — and an assertion that
  // under-describes itself is how the previous rounds' overclaiming started.
  const twiOffenders = [];
  const treeOffenders = [];
  const declared = Object.keys(registry);

  // ── 1. Set equality, both directions ───────────────────────────────────────
  for (const file of files) {
    if (declared.includes(file)) continue;
    const message = `${file} is not declared in FUNCTIONS_REGISTRY (scripts/lib/functions-registry.mjs) — every file under functions/ is a Pages entry point, so declare it with its \`twi\` disposition before adding it`;
    treeOffenders.push(message);
    if (canAnswerTwi(file)) twiOffenders.push(message);
  }
  for (const file of declared) {
    if (files.includes(file)) continue;
    const message = `${file} is declared in FUNCTIONS_REGISTRY but does not exist — the registry has drifted from the tree`;
    treeOffenders.push(message);
    if (canAnswerTwi(file)) twiOffenders.push(message);
  }

  // ── 2. Exactly one gated TWI catch-all ─────────────────────────────────────
  const gated = declared.filter((file) => registry[file].twi === 'gated');
  if (gated.length !== 1) {
    twiOffenders.push(`expected exactly ONE registry entry with twi: 'gated', found ${gated.length}`);
  }

  // ── 3. Every entry's declared disposition must hold ────────────────────────
  for (const file of declared) {
    const entry = registry[file];
    const reachable = canAnswerTwi(file);

    if (entry.twi === 'unreachable' && reachable) {
      twiOffenders.push(`${file} is declared twi: 'unreachable' but its path CAN answer /api/twi/*`);
    }

    if (entry.twi === 'must-not-reference') {
      const source = contentsOf(file) ?? '';
      const hits = REFERENCES_TWI.filter((needle) => source.includes(needle));
      if (hits.length > 0) {
        twiOffenders.push(
          `${file} is declared twi: 'must-not-reference' and mentions ${hits.join(', ')} — it runs before or beside the gate, so a branch there can answer a TWI path without it`,
        );
      }
    }

    if (entry.twi === 'public') {
      if (entry.role === 'middleware') {
        twiOffenders.push(
          `${file} is a _middleware and cannot be declared public: middleware runs for EVERY matching path, so the exemption would not be one route but all of them`,
        );
      }
      if (!entry.why || !entry.why.trim()) {
        twiOffenders.push(`${file} is declared public with no \`why\` — a public route on a private studio needs a stated reason`);
      }
      if (!markerReason(contentsOf(file))) {
        twiOffenders.push(
          `${file} is declared public but carries no ${PUBLIC_ROUTE_MARKER} marker WITH A REASON after it on the same line`,
        );
      }
      if (!reachable) {
        twiOffenders.push(`${file} is declared public for the TWI URL space but its path cannot answer /api/twi/*`);
      }
    }

    if (reachable && !['gated', 'public', 'must-not-reference'].includes(entry.twi)) {
      twiOffenders.push(
        `${file} can answer /api/twi/* and is declared twi: '${entry.twi}' — it must be 'gated', 'public' (with a reason) or 'must-not-reference'`,
      );
    }
  }

  return {
    twiOffenders,
    treeOffenders,
    deployOffenders: classifyDeployTakeover({ rootEntries, routesManifest }),
    // Kept so a caller can assert the whole verdict at once, which the unit suite does.
    offenders: [...treeOffenders, ...twiOffenders.filter((message) => !treeOffenders.includes(message))],
  };
}

/**
 * The two ways to answer /api/twi/* without any file under functions/ at all.
 *
 * Both were found while probing the entry-point enumeration in round 3, and
 * neither is reachable from any code path the other checks read: they are deploy
 * configuration, like _redirects, and they outrank the Functions runtime rather
 * than living inside it.
 */
export function classifyDeployTakeover({ rootEntries = [], routesManifest = null }) {
  const offenders = [];
  for (const name of WORKER_TAKEOVER_NAMES) {
    if (rootEntries.includes(name)) {
      offenders.push(
        `${name} exists at the build output root — Pages advanced mode IGNORES the whole functions/ directory, so this file answers /api/twi/* instead of the gated catch-all`,
      );
    }
  }
  if (routesManifest !== null) offenders.push(...classifyRoutesManifest(routesManifest));
  return offenders;
}

/**
 * `_routes.json`, if it is ever added: it must not take /api/ out of the Functions
 * runtime.
 *
 * An `exclude` entry matching an /api/twi/* path makes Pages serve that path from
 * static assets, so the Function — and the gate inside it — never runs. Written to
 * fail closed on anything it cannot parse, because an unparseable routing manifest
 * is a deploy-time fact this check must not wave through.
 */
export function classifyRoutesManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [`_routes.json does not parse as JSON (${error.message}), so which paths invoke a Function is unknown`];
  }

  const offenders = [];
  const matchesApi = (pattern) => {
    if (typeof pattern !== 'string') return true;
    if (pattern === '/*' || pattern === '/api' || pattern === '/api/*') return true;
    return pattern.startsWith('/api/');
  };

  for (const pattern of parsed.exclude ?? []) {
    if (matchesApi(pattern)) {
      offenders.push(
        `_routes.json excludes ${JSON.stringify(pattern)} from the Functions runtime — an /api/ path served as a static asset never reaches the owner gate`,
      );
    }
  }

  const include = parsed.include ?? [];
  if (include.length > 0 && !include.some((pattern) => matchesApi(pattern))) {
    offenders.push(
      `_routes.json includes ${JSON.stringify(include)} and nothing covering /api/ — the TWI Function would not be invoked at all`,
    );
  }

  return offenders;
}
