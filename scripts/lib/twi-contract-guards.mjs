/**
 * twi-contract-guards.mjs — section 15: the publication guards are actually invoked.
 *
 * WHY THIS SECTION EXISTS. A mutation campaign on 2026-08-30 deleted, one at a time, every
 * defensive check standing between a finished render and a published one: the audio-digest
 * comparison, the provenance match, the both-candidates gate, the provisional assertion and
 * the frozen-job identity check. NINE of twelve mutants SURVIVED the full Workflow
 * integration suite. The checks only ever run on state the happy path cannot produce, so a
 * suite that exercises the happy path proves nothing about them.
 *
 * Extracting them into publication-guards.ts made the PREDICATES provable — a unit test can
 * forge a mismatched digest. It cannot, however, prove the predicate is still CALLED: delete
 * the call and every unit test stays green, because the function it tests is untouched.
 *
 * That is what this section is for. It reads the call graph of the Workflow and its store
 * out of the TypeScript AST — never a line scan, since a block comment hides a line from a
 * regex — and fails if a guard has stopped being invoked. It fails closed: an unreadable or
 * empty call set is reported as a failure, not as agreement.
 */

import ts from 'typescript';

import { descendants, parseTypeScript, unwrap } from './ts-ast.mjs';

/** Every function name invoked anywhere in the module, by identifier or by property access. */
const calledNames = (source, fileName) => {
  const sf = parseTypeScript(source, fileName);
  const names = new Set();
  for (const node of descendants(sf)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee)) names.add(callee.text);
    else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
  }
  return names;
};

const WORKFLOW_GUARDS = [
  ['assertWavHeader', 'a finished master is still checked for a playable RIFF/WAVE header'],
  ['assertCandidateAudio', 'the three renditions are still compared before publication'],
  ['assertProvenance', 'the stored provenance is still matched against the candidate and the spec'],
  ['assertBothCandidatesValidated', 'publication still refuses a partial or reordered pair'],
  ['assertAssetsProvisional', 'the assets are still confirmed provisional before they go active'],
];

const STORE_GUARDS = [
  ['assertFrozenJobMatchesPayload', 'the frozen job identity is still checked against the payload'],
  ['assertAllProvisional', 'the provisional row count is still compared against what was registered'],
];

/** Section 15. */
export const checkPublicationGuards = (context, check) => {
  const { read } = context;

  const workflow = calledNames(read('twi-orchestrator/src/workflow.ts'), 'workflow.ts');
  const store = calledNames(read('twi-orchestrator/src/db.ts'), 'db.ts');

  check('the Workflow module is readable as a call graph, so its guards can be accounted for', workflow.size > 0);
  check('the orchestration store is readable as a call graph, so its guards can be accounted for', store.size > 0);

  for (const [name, why] of WORKFLOW_GUARDS) {
    check(`${why} (twi-orchestrator/src/workflow.ts calls ${name})`, workflow.has(name));
  }
  for (const [name, why] of STORE_GUARDS) {
    check(`${why} (twi-orchestrator/src/db.ts calls ${name})`, store.has(name));
  }
};
