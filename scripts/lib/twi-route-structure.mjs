/**
 * twi-route-structure.mjs — the TWI owner gate as STRUCTURE, not as text.
 *
 * Why this file exists at all. The gate in functions/api/twi/[[route]].ts is the
 * only thing making /api/twi/* private, and three rounds of review have now
 * attacked the guard that pins it. Every round the guard was a line scan, and
 * every round the line scan lost — to a leading block comment on the offending
 * line, to a decoy `await requireOwnerSession(request, env);` inside a comment
 * that moved the anchor, to a nested `} catch (error) {` that truncated the
 * scanned region, to `onRequestGet`, and, worst of all, to two
 * constructions that needed no trickery whatever:
 *
 *   if (segments[0] !== 'health') await requireOwnerSession(request, env);
 *
 * — the gate is present, it is early, it contains the anchored string
 * byte-for-byte, and it does not run for the new resource; and a sibling file
 * `functions/api/twi/health.ts` exporting its own ungated `onRequest`, which
 * Cloudflare Pages resolves by path specificity while the gate sits in a file
 * that is never entered.
 *
 * The lesson taken here is the one section 9 of scripts/twi-contract-check.mjs
 * already recorded for _redirects: a check a comment can flip is not a check.
 * So this module parses. `typescript` is already a devDependency and the checks
 * are a build-time tool, so a real AST costs the deploy nothing — Pages runs no
 * build command for this project.
 *
 * What is asserted, and it is a different SHAPE from "the gate appears early":
 *
 *   1. There is exactly ONE call to `requireOwnerSession` in the file, it is
 *      awaited, and it is a statement — not a condition, not a floating promise.
 *      The NAME is bound to the import: that identifier must be a named import of
 *      `requireOwnerSession` from src/twi/server/auth, and the file must not
 *      redeclare it. Round 2 checked the name and not the binding, so a
 *      module-scope `const requireOwnerSession = async (…) => { if (path is
 *      /health) return; await ownerSession(…); }` satisfied every assertion
 *      truthfully while making a path public.
 *   2. Its only enclosing constructs, up to the `onRequest` body, are blocks and
 *      exactly one `try` that is a direct statement of that body — and the gate
 *      is a DIRECT statement of that try. No `if`, no loop, no `switch`, no
 *      callback, no inner try, and no bare `{ }`. Round 2 allowed the bare block
 *      and located the gate with `indexOf`, which then returned −1 and emptied
 *      the pre-gate region: everything above the gate was silently reclassified
 *      as gated, where `return json(…)` is admitted. That is the regression this
 *      round exists to close, and the −1 case now fails CLOSED.
 *   3. That try's `catch` cannot fall through — it ends in `return` or `throw` —
 *      so a thrown 401 becomes a 401 response and never becomes "carry on". And
 *      what it returns is bounded: an error envelope, never a resource. The catch
 *      runs on the gate's own 401, so a catch that serves data on a 401 is the
 *      gate inverted.
 *   4. Above the gate there may be variable declarations and ONE structurally
 *      verified CORS preflight, and nothing else — and, stronger, the region as a
 *      whole must equal a DECLARED preamble, statement for statement, compared as
 *      canonical printed AST. That is a closed-set equality rather than a hunt
 *      for known-bad forms: four rounds of enumerating privileged reaches
 *      (`env`, `ctx.env`, `ctx['env']`, `const { env: box } = ctx`, `ctx[key]`)
 *      did not converge, and equality does not have to. The offender rules are
 *      KEPT underneath it as a second layer with better messages.
 *   5. Every `return` below the gate inside the try is `await …` or `json(…)`,
 *      at any nesting depth, parentheses unwrapped.
 *   6. `onRequest` is the only Pages handler export, by DECODED identifier, so a
 *      unicode escape declares the same name the assertion sees — and a
 *      `export * from './x'` is refused as OPAQUE, because the star can carry an
 *      `onRequestPost` this module cannot see.
 *
 * What is NOT asserted here: anything about which FILE Pages enters. That is a
 * closed-set question over the filesystem and it lives in
 * scripts/lib/functions-registry.mjs, because control-flow analysis of one file
 * cannot see a sibling, an ancestor `_middleware`, a `_worker.js` takeover or a
 * `_routes.json` exclusion. Nor anything about src/twi/server/auth.ts's own
 * logic: this module pins WHICH function is called, not what it does.
 *
 * Purity: nothing here reads a file, spawns a process or touches a database.
 * Callers pass source text and a directory listing in and get facts out — the
 * same contract scripts/lib/migration-sql.mjs keeps, and what makes these facts
 * safe to assert from anywhere.
 */

import ts from 'typescript';

import {
  ancestorsUpTo,
  canonicalStatement,
  descendants,
  exportedNames,
  hasExportModifier,
  importBindings,
  lineOf,
  localDeclarationsOf,
  parseTypeScript,
  syntaxErrorsOf,
  unwrap,
} from './ts-ast.mjs';
import { preflightForm } from './twi-preflight.mjs';

/**
 * Cloudflare Pages dispatches `onRequest` and the verb-specific
 * `onRequestGet`/`onRequestPost`/… exports. Anything else exported from a
 * function file is inert. The guard refuses every name that BEGINS with
 * `onRequest` other than `onRequest` itself rather than enumerating the seven
 * verbs, because an enumeration is one more spelling check and spelling checks
 * are what lost the previous three rounds.
 */
const PAGES_HANDLER_PREFIX = 'onRequest';

const isPagesHandlerName = (name) => name.startsWith(PAGES_HANDLER_PREFIX);

const parse = (source) => parseTypeScript(source, 'twi-route.ts');

/**
 * The gate function and the module it must come from.
 *
 * The specifier is matched by SUFFIX so the relative depth of the route file can
 * change without weakening the fact: what matters is that the name resolves to
 * src/twi/server/auth and not to a local wrapper or a look-alike module.
 */
export const GATE_NAME = 'requireOwnerSession';
export const GATE_MODULE_SUFFIX = 'src/twi/server/auth';

/**
 * The region above the gate, DECLARED — every statement of it except the CORS
 * preflight, which is verified by shape instead.
 *
 * This is the round-3 change of tactic, and the reason for it is the record: four
 * rounds of enumerating ways to reach a privileged binding above the gate
 * (`env`, `ctx.env`, `ctx['env']`, `const { env: box } = ctx`, `ctx[key]`,
 * `await using`) did not converge, and each round's denylist was beaten by the
 * next round's spelling. An EQUALITY does not have to converge: the region either
 * is these statements or it is not, and anything added to it — a route, a throw, a
 * D1 write, an alias, a form nobody has thought of yet — fails on the same line of
 * code, before any reasoning about what the addition does.
 *
 * The cost is stated plainly and it is the point: changing the preamble is a
 * two-file edit, the route file and this constant, and the failure message prints
 * the canonical form to paste. That makes a change to the only region of this
 * function that runs unauthenticated a reviewed change rather than a diff nobody
 * had to look at twice.
 *
 * Compared as canonically printed AST, so reindentation, line breaks and comments
 * do not fail it, and a unicode escape cannot smuggle a different name past it.
 */
export const EXPECTED_PREGATE_PREAMBLE = [
  'const { request, env } = ctx;',
  'const method = request.method.toUpperCase();',
  "const segments = Array.isArray(ctx.params.route) ? ctx.params.route : ctx.params.route ? [ctx.params.route] : [];",
  "const [resource = '', id = '', sub = ''] = segments;",
];

/**
 * The declared preamble against the measured one, as a list of differences.
 *
 * Reported per position so the message says which statement drifted rather than
 * only that something did.
 */
export function comparePreamble(actual, expected = EXPECTED_PREGATE_PREAMBLE) {
  const differences = [];
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    if (actual[index] === expected[index]) continue;
    if (expected[index] === undefined) {
      differences.push(`statement ${index + 1} above the gate is NOT DECLARED: ${actual[index]}`);
    } else if (actual[index] === undefined) {
      differences.push(`statement ${index + 1} above the gate is MISSING: expected ${expected[index]}`);
    } else {
      differences.push(
        `statement ${index + 1} above the gate CHANGED: expected ${expected[index]} — found ${actual[index]}`,
      );
    }
  }
  return differences;
}

/** The exported `onRequest`, however it is spelled: `export const`, `export async function`. */
const findOnRequest = (sf) => {
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'onRequest') continue;
        const initializer = unwrap(declaration.initializer);
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return initializer;
      }
    }
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name?.text === 'onRequest') {
      return statement;
    }
  }
  return null;
};

/**
 * Admitted return forms inside the gate: `return await …` and `return json(…)`.
 *
 * Unchanged in substance from the text version this replaces, and one class
 * wider by accident of parsing: `return (await handler(id, repo));` is the same
 * expression as `return await handler(id, repo);` and the regex called it
 * UNAWAITED. Parentheses are unwrapped here, so correct code passes.
 */
const isAdmittedReturnExpression = (expression) => {
  const returned = unwrap(expression);
  if (!returned) return false;
  if (ts.isAwaitExpression(returned)) return true;
  if (ts.isCallExpression(returned) && ts.isIdentifier(returned.expression) && returned.expression.text === 'json') {
    return true;
  }
  // `cond ? await handler(…) : json(…, 405)` is both admitted forms and safe in
  // either branch, so it is admitted too — checked per branch rather than by
  // adding a third shape.
  if (ts.isConditionalExpression(returned)) {
    return isAdmittedReturnExpression(returned.whenTrue) && isAdmittedReturnExpression(returned.whenFalse);
  }
  return false;
};

const isAwaitedReturn = (statement) => isAdmittedReturnExpression(statement.expression);

/** True when the return settles a promise before leaving the try, in any admitted branch. */
const settlesInsideTry = (expression) => {
  const returned = unwrap(expression);
  if (!returned) return false;
  if (ts.isAwaitExpression(returned)) return true;
  if (ts.isConditionalExpression(returned)) {
    return settlesInsideTry(returned.whenTrue) || settlesInsideTry(returned.whenFalse);
  }
  return false;
};

/**
 * What the mapping `catch` may return: an error envelope, and nothing else.
 *
 * The catch runs on the gate's OWN 401, so a catch that answers with data is the
 * gate inverted — and round 2 constrained it only to "bind, read, end in return
 * or throw". `if (error.status === 401 && segments[0] === 'health') return
 * json({ capabilities: … });` satisfied all three and served the resource to an
 * unauthenticated caller with the whole suite green.
 *
 * Three rules, none of which needs control-flow analysis:
 *
 *   1. every `return` is `json(<object literal>, …)` whose property names are a
 *      subset of the envelope's — so a resource payload has nowhere to go;
 *   2. nothing in the catch is `await`ed, so no handler and no query runs here;
 *   3. the only names it may borrow from this file's imports are the response
 *      vocabulary (`json`, `HttpError`), and it may not touch `env` or the
 *      context parameter — so it cannot reach a repository, a binding or a
 *      secret even to put one in an envelope.
 *
 * The cost is stated plainly: an envelope field beyond these three (a
 * `retryAfter`, say) is a one-line edit HERE as well as in the route file. That
 * is deliberate — the catch is a security-relevant region and a change to what it
 * discloses should be a reviewed change.
 */
export const CATCH_ENVELOPE_FIELDS = ['error', 'code', 'correlationId'];
const CATCH_IMPORT_ALLOWLIST = ['json', 'HttpError'];

const classifyCatchBlock = (sf, catchBlock, imports) => {
  const offenders = [];
  const importedLocals = new Set(imports.filter((entry) => !entry.typeOnly).map((entry) => entry.local));

  for (const statement of [catchBlock, ...descendants(catchBlock)].filter(ts.isReturnStatement)) {
    const returned = unwrap(statement.expression);
    const isJsonCall =
      returned && ts.isCallExpression(returned) && ts.isIdentifier(returned.expression) && returned.expression.text === 'json';
    if (!isJsonCall) {
      offenders.push(`the catch returns something other than json(…): ${lineOf(sf, statement)}`);
      continue;
    }
    const payload = unwrap(returned.arguments[0]);
    if (!payload || !ts.isObjectLiteralExpression(payload)) {
      offenders.push(`the catch returns a json() payload that is not an object literal: ${lineOf(sf, statement)}`);
      continue;
    }
    const fields = payload.properties.map((property) =>
      property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : '?',
    );
    const extra = fields.filter((field) => !CATCH_ENVELOPE_FIELDS.includes(field));
    if (extra.length > 0) {
      offenders.push(
        `the catch answers with ${extra.join(', ')} rather than an error envelope (${CATCH_ENVELOPE_FIELDS.join('/')}): ${lineOf(sf, statement)}`,
      );
    }
  }

  for (const node of descendants(catchBlock)) {
    if (ts.isAwaitExpression(node)) offenders.push(`the catch awaits something: ${lineOf(sf, node)}`);
    if (!ts.isIdentifier(node)) continue;
    if (importedLocals.has(node.text) && !CATCH_IMPORT_ALLOWLIST.includes(node.text)) {
      offenders.push(`the catch reaches for the imported \`${node.text}\`: ${lineOf(sf, node)}`);
    }
    if (node.text === 'env' || node.text === 'ctx') {
      const isPropertyName = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      if (!isPropertyName) offenders.push(`the catch reaches \`${node.text}\`: ${lineOf(sf, node)}`);
    }
  }

  return offenders;
};

/**
 * Facts about the route file, all derived from the AST.
 *
 * Every field is either a boolean fact or a list of human-readable offenders, so
 * the caller can assert without knowing anything about TypeScript's syntax
 * kinds. `reasons` is empty exactly when the structural gate holds.
 */
export function analyseTwiRouteFile(source, { httpSource = '' } = {}) {
  const sf = parse(source);
  const syntaxErrors = syntaxErrorsOf(sf);

  const exports_ = exportedNames(sf);
  const handlerExports = exports_.names.filter(isPagesHandlerName);
  const extraHandlerExports = handlerExports.filter((name) => name !== 'onRequest');
  const opaqueExports = exports_.opaque;

  const imports = importBindings(sf);
  const httpImports = imports.filter((entry) => entry.module.endsWith('src/twi/server/http'));

  const onRequest = findOnRequest(sf);
  const body = onRequest && onRequest.body && ts.isBlock(onRequest.body) ? onRequest.body : null;

  const empty = {
    syntaxErrors,
    handlerExports,
    extraHandlerExports,
    opaqueExports,
    hasOnRequest: Boolean(body),
    gateReasons: ['the exported onRequest handler was not found, or its body is not a block'],
    preGateOffenders: [],
    preGateCanonical: [],
    catchOffenders: [],
    unawaitedReturns: [],
    awaitedReturnCount: 0,
    gatedReturnCount: 0,
    preflightKind: null,
  };
  if (!body) return empty;

  const gateReasons = [];
  const catchOffenders = [];

  // ── The NAME is the import, not just the spelling ──────────────────────────
  // Round 2 asserted a call to an identifier called `requireOwnerSession` and
  // separately grepped src/twi/server/auth.ts's contents. Nothing joined the two,
  // so a module-scope wrapper of the same name — which exempted /api/twi/health
  // and delegated everything else — satisfied every structural assertion
  // truthfully, kept the unit suite green, and made a path public.
  const gateImport = imports.find(
    (entry) => entry.local === GATE_NAME && !entry.typeOnly && entry.module.endsWith(GATE_MODULE_SUFFIX),
  );
  if (!gateImport) {
    gateReasons.push(
      `${GATE_NAME} is not imported from ${GATE_MODULE_SUFFIX} under that name, so the call below is not the owner gate`,
    );
  } else if (gateImport.imported !== GATE_NAME) {
    gateReasons.push(`${GATE_NAME} is aliased from ${gateImport.imported}, so the call below is not the owner gate`);
  }

  const redeclared = localDeclarationsOf(sf, GATE_NAME);
  if (redeclared.length > 0) {
    gateReasons.push(
      `${GATE_NAME} is redeclared in this file (${redeclared
        .map((node) => lineOf(sf, node))
        .join(' | ')}), so the call in onRequest is not the import`,
    );
  }

  // ── The gate: exactly one call, awaited, as a statement ────────────────────
  const gateCalls = descendants(body)
    .filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression))
    .filter((node) => node.expression.text === GATE_NAME);

  if (gateCalls.length !== 1) {
    gateReasons.push(`expected exactly ONE ${GATE_NAME} call in onRequest, found ${gateCalls.length}`);
  }

  const gateCall = gateCalls[0] ?? null;
  const awaited = gateCall && ts.isAwaitExpression(gateCall.parent) ? gateCall.parent : null;
  if (gateCall && !awaited) {
    gateReasons.push(`the requireOwnerSession call is not awaited: ${lineOf(sf, gateCall)}`);
  }

  const gateStatement =
    awaited && ts.isExpressionStatement(awaited.parent) ? awaited.parent : null;
  if (awaited && !gateStatement) {
    gateReasons.push(`the awaited gate is an expression, not a statement, so it can be conditional: ${lineOf(sf, awaited)}`);
  }

  // ── Unconditional: blocks and ONE body-level try, nothing else ─────────────
  let gateTry = null;
  if (gateStatement) {
    const chain = ancestorsUpTo(gateStatement, body);
    if (!chain) {
      gateReasons.push('the gate statement is not inside the onRequest body');
    } else {
      const tries = chain.filter(ts.isTryStatement);
      const wrappers = chain.filter((node) => !ts.isBlock(node) && !ts.isTryStatement(node));
      if (wrappers.length > 0) {
        gateReasons.push(
          `the gate is CONDITIONAL — enclosed by ${wrappers
            .map((node) => ts.SyntaxKind[node.kind])
            .join(' inside ')}: ${lineOf(sf, gateStatement)}`,
        );
      }
      if (tries.length !== 1) {
        gateReasons.push(
          `the gate must sit in exactly one try (the one that maps its 401), found ${tries.length}`,
        );
      } else if (tries[0].parent !== body) {
        gateReasons.push('the gate sits in a NESTED try, so its 401 can be swallowed instead of answered');
      } else if (body.statements[body.statements.length - 1] !== tries[0]) {
        // Nothing may follow the try. A statement after it is outside the mapping
        // catch, so a handler called there escapes to Pages' own 500 — carrying the
        // repository's message, which quotes SQL — whether it is awaited or not.
        // It is also outside every assertion below, which examine the try's block.
        gateReasons.push('code follows the gated try, so it answers outside the catch that maps failures');
      } else if (gateStatement.parent !== tries[0].tryBlock) {
        // THE ROUND-2 REGRESSION, closed. The regions above and below the gate were
        // sliced with `tryBlock.statements.indexOf(gateStatement)`, which is −1 for a
        // gate nested in a bare `{ }` — and −1 was converted to `slice(0, 0)`, an
        // EMPTY pre-gate region. The statements it dropped were then re-classified as
        // GATED, where `return json({ ok: true })` is an admitted form, so an ungated
        // public answer above the gate was not merely missed, it was validated. Round
        // 1's deleted `preGateReturns.length === 1` rule caught that case by name.
        //
        // Requiring the gate to be a DIRECT statement of the try removes the class
        // instead of the instance: there is then exactly one index and it is never
        // −1. Nesting BELOW the gate stays legal, which is what a route table needs.
        gateReasons.push(
          `the gate is nested inside ${ts.SyntaxKind[gateStatement.parent.kind]} within the try rather than being a direct statement of it, so the region above it cannot be determined: ${lineOf(sf, gateStatement)}`,
        );
      } else {
        gateTry = tries[0];
      }
    }
  }

  if (gateTry) {
    const catchBlock = gateTry.catchClause?.block;
    const last = catchBlock?.statements[catchBlock.statements.length - 1];
    if (!catchBlock) {
      gateReasons.push('the gate is in a try with no catch, so a thrown 401 escapes to Pages');
    } else if (!last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last))) {
      gateReasons.push('the catch around the gate can FALL THROUGH — it must end in return or throw');
    }

    // The catch must READ what it caught. Stated as a relationship rather than as
    // a name: the previous guard anchored on the literal text `} catch (error) {`,
    // so renaming the binding while the body still said `error` failed the check
    // for the wrong reason (a −1 anchor) and renaming BOTH would have passed it.
    // Here the binding may be called anything, and must be referenced — which is
    // the fact that makes the 401 mapping below it reachable at all.
    const binding = gateTry.catchClause?.variableDeclaration?.name;
    if (catchBlock && (!binding || !ts.isIdentifier(binding))) {
      gateReasons.push('the catch does not bind the error it caught, so it cannot map a 401 to a response');
    } else if (catchBlock && binding) {
      const reads = descendants(catchBlock).filter((node) => ts.isIdentifier(node) && node.text === binding.text);
      if (reads.length === 0) {
        gateReasons.push(`the catch binds \`${binding.text}\` and never reads it, so its mapping references something else`);
      }
    }
    if (catchBlock) catchOffenders.push(...classifyCatchBlock(sf, catchBlock, imports));
  }

  // ── Above the gate: declarations and one verified preflight, nothing else ──
  const preGateOffenders = [];
  const preGateCanonical = [];
  let preflightCount = 0;
  let preflightKind = null;

  if (gateTry) {
    const gateIndex = gateTry.tryBlock.statements.indexOf(gateStatement);
    if (gateIndex === -1) {
      // Unreachable while the direct-statement reason above holds, and asserted
      // anyway: this is the −1 that failed OPEN in round 2, and a future edit to
      // the ancestor rules must not be able to reintroduce it silently.
      gateReasons.push('the gate could not be located inside the gated try block');
    }
    const preGate =
      gateIndex === -1
        ? []
        : [
            ...body.statements.slice(0, body.statements.indexOf(gateTry)),
            ...gateTry.tryBlock.statements.slice(0, gateIndex),
          ];

    for (const statement of preGate) {
      const preflight = preflightForm(statement, { httpSource, httpImports });
      const isPreflight = preflight !== null;
      if (isPreflight) {
        preflightCount += 1;
        preflightKind = preflight.kind;
      } else {
        // The preflight is verified by SHAPE, in either of its two admitted forms,
        // so it is deliberately outside the preamble equality — otherwise factoring
        // it out would have to edit the declared constant as well. Everything else
        // above the gate is compared against that constant.
        preGateCanonical.push(canonicalStatement(sf, statement));
      }

      if (!isPreflight && !ts.isVariableStatement(statement)) {
        preGateOffenders.push(`${ts.SyntaxKind[statement.kind]} above the gate: ${lineOf(sf, statement)}`);
        continue;
      }

      // Answering is not the only thing that must wait for the gate. `env` is the
      // only route to D1, to the bindings and to every secret, so an
      // unauthenticated write is reachable without any `return` at all —
      // `const _ = env.DB.prepare('DELETE FROM projects').run();` answers nothing
      // and destroys everything. Nothing above the gate touches `env`; the
      // destructuring that BINDS it is the sole exception, and `request` stays
      // readable because reading a request discloses nothing.
      const sideEffects = descendants(statement).filter(
        (node) => ts.isAwaitExpression(node) || ts.isThrowStatement(node),
      );
      if (sideEffects.length > 0) {
        preGateOffenders.push(`awaited or throwing code above the gate: ${lineOf(sf, statement)}`);
      }

      const privileged = descendants(statement).filter(
        (node) =>
          ts.isIdentifier(node) &&
          node.text === 'env' &&
          !(ts.isBindingElement(node.parent) && node.parent.name === node) &&
          !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node),
      );
      if (privileged.length > 0) {
        preGateOffenders.push(`\`env\` is reachable above the gate: ${lineOf(sf, statement)}`);
      }

      // `ctx['env']` is an ElementAccessExpression whose argument is a String-
      // Literal, so the rule above — a rule about the IDENTIFIER `env` — never saw
      // it, and neither would `ctx[key]` with the key computed anywhere. Computed
      // member access above the gate is refused outright: it is the one form in
      // which a privileged property name is not a name at all, the region has no
      // legitimate use for it, and refusing it does not depend on how the string
      // is spelled.
      const computed = descendants(statement).filter(ts.isElementAccessExpression);
      if (computed.length > 0) {
        preGateOffenders.push(
          `computed member access above the gate can name a privileged binding without spelling it (${computed
            .map((node) => canonicalStatement(sf, node))
            .join(', ')}): ${lineOf(sf, statement)}`,
        );
      }
    }

    if (preflightCount !== 1) {
      preGateOffenders.push(
        `expected exactly ONE verified CORS preflight above the gate (if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() }), or a zero-argument helper imported from src/twi/server/http with exactly that body), found ${preflightCount}`,
      );
    }
  }

  // ── Below the gate, inside the try: every return is awaited or json() ──────
  const unawaitedReturns = [];
  let awaitedReturnCount = 0;
  let gatedReturnCount = 0;

  if (gateTry) {
    const gateIndex = gateTry.tryBlock.statements.indexOf(gateStatement);
    const gated = gateIndex === -1 ? [] : gateTry.tryBlock.statements.slice(gateIndex + 1);
    const returns = gated.flatMap((statement) => [
      ...(ts.isReturnStatement(statement) ? [statement] : []),
      ...descendants(statement, { intoFunctions: false }).filter(ts.isReturnStatement),
    ]);

    gatedReturnCount = returns.length;
    for (const statement of returns) {
      if (isAwaitedReturn(statement)) {
        if (settlesInsideTry(statement.expression)) awaitedReturnCount += 1;
      } else {
        unawaitedReturns.push(lineOf(sf, statement));
      }
    }
  }

  return {
    syntaxErrors,
    handlerExports,
    extraHandlerExports,
    opaqueExports,
    hasOnRequest: true,
    gateReasons,
    preGateOffenders,
    preGateCanonical,
    catchOffenders,
    unawaitedReturns,
    awaitedReturnCount,
    // The vacuity guard. Round 2 used `awaitedReturnCount > 0`, which asks the
    // region to contain an `await` — so a read-only sub-router whose gated returns
    // are all `json(…)` would have failed the await assertion with a message
    // listing no offenders. Counting the returns tests what the clause is for: that
    // the region was read at all.
    gatedReturnCount,
    preflightKind,
  };
}

/**
 * Which FILE Pages enters is not a question about this file's structure.
 *
 * Round 2's `classifyRouteInventory` lived here and pinned one directory. It was
 * beaten by three entry points outside that directory — an ancestor
 * `_middleware.ts` (which already exists), a `functions/api/_middleware.ts`, and
 * `functions/api/twi.js`, a parent-level sibling refused only at `.ts` — and it
 * accepted a bare `TWI-PUBLIC-ROUTE:` marker with no reason, including on a
 * `_middleware` whose blast radius is every path.
 *
 * The replacement is a closed set over the whole `functions/` tree rather than a
 * denylist over one directory, so it lives with the other filesystem facts:
 * scripts/lib/functions-registry.mjs. Nothing in this module reads a path.
 */
