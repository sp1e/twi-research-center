/**
 * twi-contract-redirects.mjs — sections 3 and 9 of the TWI contract check: the _redirects file,
 * whose ORDER decides whether /twi/ serves JavaScript or HTML, and whether an /api/ path can be
 * answered by a rewrite instead of by its Function.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs. The two sections stay two functions
 * because the guard registers section 3 before the gate sections and section 9 after them, and
 * the ORDER of registration is part of the contract.
 */

/** Section 3: the SPA rewrite exists and the orchestrator source is blocked. */
export const checkRoutingProtections = (context, check) => {
  const { redirects } = context;

  // ── 3. Routing and source protections ────────────────────────────────────────
  check('TWI app has an SPA rewrite', /^\/twi\/\*\s+\/twi\/index\.html\s+200$/m.test(redirects));
  check('orchestrator source is blocked', /^\/twi-orchestrator\/\*\s+\/\s+301$/m.test(redirects));
};

/**
 * Section 9: the committed file parsed into the rules Cloudflare would actually apply, in
 * order, and three concrete paths resolved through that model.
 */
export const checkRedirectOrdering = (context, check) => {
  const { redirects } = context;

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
};
