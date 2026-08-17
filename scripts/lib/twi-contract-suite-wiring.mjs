/**
 * twi-contract-suite-wiring.mjs — sections 10 and 11 of the TWI contract check: this guard is
 * wired into `npm test`, and the modules it reads its facts off are themselves tested.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Sections 10 and 11. */
export const checkSuiteWiring = (context, check) => {
  const { root, runner, packageJson } = context;

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

  /**
   * ── 11. THE GUARD'S OWN GUARD ────────────────────────────────────────────────
   *
   * Everything in section 4 is read off two pure modules, and until this round
   * nothing tested them. The re-review measured what that is worth: a 14-line
   * permissive stub of scripts/lib/twi-route-structure.mjs kept `npm test` at 7/7
   * AND this script reporting 33 — the count is invariant under the removal of the
   * entire kill signal for API-27 through API-50, so the one number a reviewer might
   * plausibly be tracking does not move.
   *
   * scripts/twi-route-structure.test.mjs closes that: it drives both modules
   * directly, and its corpus is the mutant manifest's own exact-from-source
   * find/replace pairs, so each entry's prose `premise` becomes an executed
   * assertion. These two checks assert the suite is DECLARED and RUN — a test nobody
   * runs is a comment, which is the same argument section 10 makes for this script.
   */
  check(
    'test:twi:structure is declared in package.json',
    /"test:twi:structure":\s*"node --test scripts\/twi-route-structure\.test\.mjs"/.test(packageJson),
  );
  check(
    'the runner lists test:twi:structure, so the gate analysis is itself tested',
    /'test:twi:structure'/.test(suitesBlock) && fs.existsSync(path.join(root, 'scripts/twi-route-structure.test.mjs')),
  );
};
