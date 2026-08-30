/**
 * twi-contract-orchestrator.mjs — section 14: the cross-package start envelope.
 *
 * WHY THIS SECTION EXISTS. src/twi/server/jobs.ts builds the object dispatched to the
 * orchestrator's /start; twi-orchestrator/src/index.ts declares the keys it accepts.
 * They live in separate packages with separate toolchains and separate test runs, and
 * NOTHING else compares them. Two independently-green suites can drift apart at exactly
 * this seam: the orchestrator's own suite would assert its accepted shape and pass, the
 * Pages suite counts dispatches against a fake binding and passes, and a key renamed on
 * one side reaches production as a rejected submission for a job that was already paid
 * for. The 2026-08-19 plan amendment records the instance-id defect that lived in this
 * same seam and was invisible to both suites.
 *
 * IT READS BOTH SIDES INDEPENDENTLY, FROM SOURCE. A check that imported one shared
 * constant into both packages would drift together and prove nothing -- the two
 * declarations would agree because they are the same declaration. So each side is parsed
 * out of its own file with the TypeScript compiler, never with a line scan: a leading
 * block comment can delete a line from a regex's view and a unicode escape can smuggle a
 * name past a string comparison, and this project has already been beaten that way once.
 *
 * IT FAILS CLOSED. If either declaration cannot be found -- renamed, moved to another
 * module, restructured into something this cannot read -- the check FAILS rather than
 * comparing two empty sets and reporting agreement. An absent side is the loudest signal
 * available that the seam moved, so it must never read as "no difference".
 */

import ts from 'typescript';

import { descendants, localDeclarationsOf, parseTypeScript, unwrap } from './ts-ast.mjs';

/** The property names of the object literal `startPayload` returns. */
const emittedKeys = (source) => {
  const sf = parseTypeScript(source, 'jobs.ts');
  const [declaration] = localDeclarationsOf(sf, 'startPayload');
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;

  const initializer = unwrap(declaration.initializer);
  if (!ts.isArrowFunction(initializer)) return null;

  // `(job, attempt, estimate) => ({ ... })` — the body is a parenthesized object literal.
  const literal = descendants(initializer).find((node) => ts.isObjectLiteralExpression(node));
  if (!literal) return null;

  const names = [];
  for (const property of literal.properties) {
    // A spread would make the emitted set unknowable from this file alone. Refuse the
    // ambiguity rather than reporting the keys that happen to be spelled out beside it.
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null;
    if (!property.name || !ts.isIdentifier(property.name)) return null;
    names.push(property.name.text);
  }
  return names.length > 0 ? names : null;
};

/** The string literals of the orchestrator's `START_PAYLOAD_KEYS` array. */
const acceptedKeys = (source) => {
  const sf = parseTypeScript(source, 'index.ts');
  const [declaration] = localDeclarationsOf(sf, 'START_PAYLOAD_KEYS');
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;

  // `[...] as const` — step through the assertion to the array itself.
  let initializer = unwrap(declaration.initializer);
  if (ts.isAsExpression(initializer)) initializer = unwrap(initializer.expression);
  if (!ts.isArrayLiteralExpression(initializer)) return null;

  const names = [];
  for (const element of initializer.elements) {
    if (!ts.isStringLiteral(element)) return null;
    names.push(element.text);
  }
  return names.length > 0 ? names : null;
};

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().every((key, i) => key === [...b].sort()[i]);

/** Section 14. */
export const checkOrchestratorSeam = (context, check) => {
  const { read } = context;

  const emitted = emittedKeys(read('src/twi/server/jobs.ts'));
  const accepted = acceptedKeys(read('twi-orchestrator/src/index.ts'));

  check(
    'the Pages side\'s startPayload object literal is readable, so the seam can be compared at all',
    emitted !== null,
  );
  check(
    "the orchestrator's START_PAYLOAD_KEYS array is readable, so the seam can be compared at all",
    accepted !== null,
  );
  check(
    'the orchestrator accepts EXACTLY the keys src/twi/server/jobs.ts emits, read independently from both sources',
    emitted !== null && accepted !== null && sameSet(emitted, accepted),
  );
  check(
    'the start envelope still carries the attempt ordinal, without which a retry cannot address its own run',
    emitted !== null && emitted.includes('attempt') && accepted !== null && accepted.includes('attempt'),
  );
  check(
    'the start envelope still carries the repository-derived spec digest rather than leaving the Worker to recompute one',
    emitted !== null && emitted.includes('specSha256') && accepted !== null && accepted.includes('specSha256'),
  );
};
