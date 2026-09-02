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

/*
 * Task 11 CHANGED two names here and ADDED three, and the change is recorded rather than
 * quietly applied. `assertWavHeader` became `assertRawWavIntegrity` (the old one assumed the
 * canonical 44-byte layout, which real provider audio is entitled not to have) and
 * `assertCandidateAudio` became `assertStoredObject` (the old one asserted raw, master and
 * preview share a digest, which was true only of the fake in-Worker finishing path and is
 * false the moment a FLAC and an MP3 are involved). ZERO guards were dropped without a
 * replacement: five names became five, plus three for the parts of the Modal seam that did not
 * exist before.
 */
const WORKFLOW_GUARDS = [
  ['assertRawWavIntegrity', 'the raw candidate is still read as a real RIFF/WAVE before publication'],
  ['assertStoredObject', 'each finished object is still confirmed present, typed and sized as the manifest claims'],
  ['parseFinishCallback', 'the Workflow still re-parses the callback rather than trusting what the route forwarded'],
  ['assertCallbackBindsCall', 'the callback is still proven to answer the exact Modal call that was submitted'],
  ['assertFinishManifest', 'the finishing manifest is still gated, including the archive\'s "never targeted" rule'],
  ['assertProvenance', 'the stored provenance is still matched against the candidate and the spec'],
  ['assertBothCandidatesValidated', 'publication still refuses a partial or reordered pair'],
  ['assertAssetsProvisional', 'the assets are still confirmed provisional before they go active'],
];

/*
 * The route half. `/callback/modal` is the only way an event reaches a Workflow from outside,
 * and every one of these runs BEFORE `sendEvent`. Deleting any of them leaves the integration
 * suite green on the happy path -- which presents a valid secret and a fresh timestamp -- so
 * this is the only thing that notices.
 */
const CALLBACK_GUARDS = [
  ['assertCallbackAuthentic', 'the callback route still checks the secret, the replay window and the two tokens'],
  ['parseFinishCallback', 'the callback route still refuses an envelope it does not fully understand'],
  ['recordFinishCallback', 'a replayed callback is still refused by the database before a second event is sent'],
  ['secretsMatch', 'the raw-object route still requires the shared secret'],
  ['sendEvent', 'the route still delivers the event the Workflow is waiting on'],
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
  const route = calledNames(read('twi-orchestrator/src/index.ts'), 'index.ts');

  check('the Workflow module is readable as a call graph, so its guards can be accounted for', workflow.size > 0);
  check('the orchestration store is readable as a call graph, so its guards can be accounted for', store.size > 0);
  check('the orchestrator route module is readable as a call graph, so its guards can be accounted for', route.size > 0);

  for (const [name, why] of WORKFLOW_GUARDS) {
    check(`${why} (twi-orchestrator/src/workflow.ts calls ${name})`, workflow.has(name));
  }
  for (const [name, why] of STORE_GUARDS) {
    check(`${why} (twi-orchestrator/src/db.ts calls ${name})`, store.has(name));
  }
  for (const [name, why] of CALLBACK_GUARDS) {
    check(`${why} (twi-orchestrator/src/index.ts calls ${name})`, route.has(name));
  }

  /*
   * The finishing gate must be re-derived from stems-gpu/finish.py's constants, not from the
   * plan's superseded range. Both files are read as TEXT here on purpose: the point is that
   * two independently-maintained declarations AGREE, and importing one into the other would
   * make them the same declaration and prove nothing.
   */
  const python = read('stems-gpu/finish.py');
  const gates = read('twi-orchestrator/src/finishing/manifest.ts');
  const pythonConstant = (name) => {
    const match = new RegExp(`^${name} = (-?[0-9.]+)$`, 'm').exec(python);
    return match ? Number(match[1]) : null;
  };
  const tsConstant = (name) => {
    const match = new RegExp(`^export const ${name} = (-?[0-9.]+);$`, 'm').exec(gates);
    return match ? Number(match[1]) : null;
  };

  for (const [pyName, tsName] of [
    ['REVIEW_TARGET_LUFS', 'REVIEW_TARGET_LUFS'],
    ['REVIEW_MAX_TRUE_PEAK_DBTP', 'REVIEW_MAX_TRUE_PEAK_DBTP'],
    ['REVIEW_TOLERANCE_LUFS', 'REVIEW_TOLERANCE_LUFS'],
    ['DURATION_TOLERANCE_SECONDS', 'DURATION_TOLERANCE_SECONDS'],
  ]) {
    const py = pythonConstant(pyName);
    const ts = tsConstant(tsName);
    check(
      `the orchestrator re-validates ${tsName} against the value stems-gpu/finish.py ships, read from both sources`,
      py !== null && ts !== null && py === ts,
    );
  }

  // The word "master" was removed from the finishing vocabulary deliberately. A rendition
  // named `master.*` anywhere in the finishing seam means the archive is being mastered again.
  check(
    'the finishing seam still names archive.flac and review.mp3, and no "master" rendition',
    /archive\.flac/.test(gates) && /review\.mp3/.test(gates) && !/master\.(wav|flac|mp3)/.test(gates),
  );
  check(
    'the archive is still refused a loudness target by the orchestrator as well as by finish.py',
    /archive must never carry a loudness target/.test(gates),
  );
};
