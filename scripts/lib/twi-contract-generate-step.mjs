/**
 * twi-contract-generate-step.mjs — section 16: the billable step still claims before it pays,
 * and the retry gate still stands in front of the retry.
 *
 * WHY THIS SECTION EXISTS. The research P0 ("never auto-retry an ambiguous paid call without
 * persisted state and reconciliation") landed as three things that are each provable in
 * isolation and each silently removable from the call graph:
 *
 *   - `runGenerateStep` (twi-orchestrator/src/generate-step.ts) writes the claim BEFORE the
 *     provider call and settles it IMMEDIATELY after. Its unit suite proves that order against a
 *     real ledger. It cannot prove the Workflow still CALLS it: inline the old body back into the
 *     `generate-<label>` step and every unit test stays green, because the function it tests is
 *     untouched. That is the lesson section 15 records for the publication guards and the T13
 *     mutant of task11_finishing_mutants.py measured — a unit test proves a predicate, only the
 *     call graph proves the call.
 *   - `retryJob` reads the job's provider calls BEFORE it computes the attempt or writes anything.
 *     The lifecycle suite proves the refusal; this pins the ORDER, which is what makes the refusal
 *     cost nothing and leave no `retrying` event behind.
 *   - Three consumers hard-code the migration set (the schema suite, the repository harness, the
 *     orchestrator's vitest config). Drop migration 002 from any one and that consumer's whole
 *     suite runs against a database WITHOUT the table — green and blind. Each is pinned to the
 *     file by name here, so the omission is red in the contract check as well as in the suite.
 *
 * Everything below is read off the TypeScript AST or a comment-free canonical rendering — never a
 * line scan, since a block comment hides a line from a regex — and fails CLOSED: a construct this
 * cannot find is a failure, never agreement.
 */

import ts from 'typescript';

import { canonicalStatement, descendants, parseTypeScript, unwrap } from './ts-ast.mjs';

const MIGRATION_002 = 'twi-migration-002-provider-call-state.sql';

/** Every `step.do(...)` whose first argument is a template literal beginning `generate-`. */
const generateSteps = (sf) =>
  descendants(sf).filter((node) => {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'do') return false;
    const [name] = node.arguments;
    if (!name) return false;
    if (ts.isTemplateExpression(name)) return name.head.text === 'generate-';
    return ts.isNoSubstitutionTemplateLiteral(name) || ts.isStringLiteral(name) ? name.text.startsWith('generate-') : false;
  });

/** Function names called anywhere inside `node`, by identifier or property access. */
const callsWithin = (node) => {
  const names = new Set();
  for (const child of descendants(node)) {
    if (!ts.isCallExpression(child)) continue;
    const callee = unwrap(child.expression);
    if (ts.isIdentifier(callee)) names.add(callee.text);
    else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
  }
  return names;
};

/** One named top-level declaration, rendered comment-free, or '' — so every consumer fails closed. */
const declarationOf = (sf, name) =>
  sf.statements
    .map((statement) => canonicalStatement(sf, statement))
    .find(
      (text) =>
        new RegExp(`^export (?:async )?function ${name}\\b`).test(text) ||
        new RegExp(`^(?:export )?const ${name}\\b`).test(text),
    ) ?? '';

/** Is `first` present and does it come before `second`? False if either is absent. */
const precedes = (text, first, second) => {
  const at = text.indexOf(first);
  const then = text.indexOf(second, at === -1 ? 0 : at);
  return at !== -1 && then !== -1 && at < then;
};

/** Section 16. */
export const checkProviderCallLedger = (context, check) => {
  const { read } = context;

  const workflowSource = read('twi-orchestrator/src/workflow.ts');
  const stepSource = read('twi-orchestrator/src/generate-step.ts');
  const storeSource = read('twi-orchestrator/src/db.ts');
  const retrySource = read('src/twi/server/jobs-cancel-retry.ts');

  // ── 16a. The Workflow still calls the function whose order the unit suite proves ──

  const workflow = parseTypeScript(workflowSource, 'workflow.ts');
  const steps = generateSteps(workflow);
  check(
    `the Workflow declares its generate step through step.do(\`generate-\${label}\`), so the billable body can be located (found ${steps.length})`,
    steps.length === 1,
  );
  check(
    'the generate step body calls runGenerateStep — the claim-then-pay-then-settle order lives there and nowhere inline (twi-orchestrator/src/workflow.ts)',
    steps.length === 1 && callsWithin(steps[0]).has('runGenerateStep'),
  );
  check(
    'the generate step body no longer calls the provider itself: neither generate() nor callProvider() appears inside it',
    steps.length === 1 && !callsWithin(steps[0]).has('generate') && !callsWithin(steps[0]).has('callProvider'),
  );
  check(
    "runGenerateStep is imported from './generate-step', the module the unit suite tests",
    /import \{ runGenerateStep \} from '\.\/generate-step';/.test(workflowSource),
  );

  // ── 16b. Inside runGenerateStep the order is claim → provider → settle ──

  const step = parseTypeScript(stepSource, 'generate-step.ts');
  const body = declarationOf(step, 'runGenerateStep');
  check('runGenerateStep is declared at the top level of twi-orchestrator/src/generate-step.ts', body.length > 0);
  check(
    'inside runGenerateStep the claim is written BEFORE the provider is called (claimProviderCall precedes .generate)',
    precedes(body, 'store.claimProviderCall(', 'provider.generate('),
  );
  check(
    "inside runGenerateStep an already-claimed identity is refused BEFORE the provider is called ('already-claimed' precedes .generate)",
    precedes(body, "'already-claimed'", 'provider.generate('),
  );
  check(
    'inside runGenerateStep the successful call is settled BEFORE the R2 put (settleProviderCall precedes files.put)',
    precedes(body, 'provider.generate(', "state: 'completed'") && precedes(body, "state: 'completed'", 'files.put('),
  );
  check(
    'the ProviderError path maps charged false/true/null to abandoned/accepted/ambiguous, in that order, in one place',
    (() => {
      const mapping = declarationOf(step, 'settledStateFor');
      return (
        precedes(mapping, "charged === false) return 'abandoned'", "charged === true) return 'accepted'") &&
        precedes(mapping, "charged === true) return 'accepted'", "return 'ambiguous'")
      );
    })(),
  );

  // ── 16c. The store exposes both ledger writes, and the schema is the only clock ──

  const store = callsWithin(parseTypeScript(storeSource, 'db.ts'));
  check('TwiWorkflowStore delegates claimProviderCall to the repository (twi-orchestrator/src/db.ts)', store.has('claimProviderCall'));
  check('TwiWorkflowStore delegates settleProviderCall to the repository (twi-orchestrator/src/db.ts)', store.has('settleProviderCall'));
  check(
    "no timestamp in the ledger path comes from SQL: datetime('now') and CURRENT_TIMESTAMP appear in none of the ledger modules",
    [stepSource, storeSource, read('src/twi/server/provider-calls.ts'), read('src/twi/server/queries-provider-calls.ts')].every(
      (source) => source.length > 0 && !/datetime\('now'\)|CURRENT_TIMESTAMP/i.test(source),
    ),
  );

  // ── 16d. The retry gate precedes the attempt ordinal and every write ──

  const retry = declarationOf(parseTypeScript(retrySource, 'jobs-cancel-retry.ts'), 'retryJob');
  check('retryJob is declared at the top level of src/twi/server/jobs-cancel-retry.ts', retry.length > 0);
  check(
    'retryJob reads the job’s provider calls BEFORE it computes the attempt ordinal (listProviderCalls precedes countJobEvents)',
    precedes(retry, 'listProviderCalls(', 'countJobEvents('),
  );
  check(
    "retryJob refuses an unreconciled provider call BEFORE it writes the retrying event ('unreconciled_provider_call' precedes transitionJob(job.id, 'retrying')",
    precedes(retry, "'unreconciled_provider_call'", "transitionJob(job.id, 'retrying'"),
  );
  check(
    'the retry gate uses the shared predicate isUnreconciledProviderCall, the same rule the inventory count spells in SQL',
    /isUnreconciledProviderCall/.test(retry),
  );

  // ── 16e. Every consumer that hard-codes the migration set names migration 002 ──

  for (const [file, why] of [
    ['scripts/twi-schema-behavior.test.mjs', 'the schema suite'],
    ['src/twi/server/repository.harness.ts', 'the repository harness, which every repository and jobs test runs on'],
    ['twi-orchestrator/vitest.config.ts', 'the orchestrator integration suite'],
  ]) {
    check(`${why} loads ${MIGRATION_002} (${file})`, read(file).includes(MIGRATION_002));
  }
  check(`${MIGRATION_002} exists at the repository root`, read(MIGRATION_002).length > 0);
};
