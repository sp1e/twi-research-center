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
 *   2. Its only enclosing constructs, up to the `onRequest` body, are blocks and
 *      exactly one `try` that is a direct statement of that body. No `if`, no
 *      loop, no `switch`, no callback, no inner try. That is what UNCONDITIONAL
 *      means here, and it is what the positional lock never said.
 *   3. That try's `catch` cannot fall through — it ends in `return` or `throw` —
 *      so a thrown 401 becomes a 401 response and never becomes "carry on".
 *   4. Above the gate there may be variable declarations and ONE structurally
 *      verified CORS preflight, and nothing else. Not "one `return` token": no
 *      other statement at all, so a `throw` answers nothing either and the
 *      preflight's condition cannot be widened by an `||`. Nothing up there may
 *      `await`, `throw`, or reach `env` — the last one because answering is not
 *      the only way to abuse an ungated path: `env` is D1, the bindings and every
 *      secret, and an unauthenticated write needs no `return`.
 *   5. Every `return` below the gate inside the try is `await …` or `json(…)`,
 *      at any nesting depth, parentheses unwrapped.
 *   6. `onRequest` is the only Pages handler export, by DECODED identifier, so a
 *      unicode escape declares the same name the assertion sees.
 *
 * Purity: nothing here reads a file, spawns a process or touches a database.
 * Callers pass source text and a directory listing in and get facts out — the
 * same contract scripts/lib/migration-sql.mjs keeps, and what makes these facts
 * safe to assert from anywhere.
 */

import ts from 'typescript';

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

const parse = (source) =>
  ts.createSourceFile('twi-route.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

/** `(x)` and `x` are the same expression. Every predicate below sees through parentheses. */
const unwrap = (node) => (node && ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

const hasExportModifier = (node) =>
  (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** The node's first source line, trimmed — for a failure message that names the offender. */
const lineOf = (sf, node) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return (sf.text.split('\n')[line] ?? '').trim();
};

/** Every node in the subtree, optionally not descending into nested functions. */
const descendants = (node, { intoFunctions = true } = {}) => {
  const out = [];
  const visit = (current) => {
    current.forEachChild((child) => {
      if (!intoFunctions && ts.isFunctionLike(child)) return;
      out.push(child);
      visit(child);
    });
  };
  visit(node);
  return out;
};

/** The chain of parents from `node` up to (not including) `stopAt`, or null if `stopAt` is not an ancestor. */
const ancestorsUpTo = (node, stopAt) => {
  const chain = [];
  let current = node.parent;
  while (current && current !== stopAt) {
    chain.push(current);
    current = current.parent;
  }
  return current === stopAt ? chain : null;
};

/** Names bound by an export, including destructured ones, with unicode escapes DECODED. */
const exportedNames = (sf) => {
  const names = [];
  const fromBinding = (name) => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) fromBinding(element.name);
    }
  };

  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) fromBinding(declaration.name);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasExportModifier(statement) &&
      statement.name
    ) {
      names.push(statement.name.text);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.push(element.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.push('default');
    }
  }
  return names;
};

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
 * The CORS preflight, verified as a shape rather than recognised as a string.
 *
 * `if (method === 'OPTIONS') return new Response(null, { status: 204, … });`
 * and nothing else. The condition must be that comparison ENTIRE — the previous
 * guard asked only whether the text appeared on the line, so
 * `method === 'OPTIONS' || segments[0] === 'debug'` kept the exemption and
 * answered for `debug` too. There is no `else`, the branch is one `return`, the
 * body argument is the `null` literal, and the status is the literal 204: a
 * preflight that carries no data cannot leak any.
 */
const isMethodOptionsComparison = (expression) => {
  const expr = unwrap(expression);
  return (
    !!expr &&
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(unwrap(expr.left)) &&
    unwrap(expr.left).text === 'method' &&
    ts.isStringLiteral(unwrap(expr.right)) &&
    unwrap(expr.right).text === 'OPTIONS'
  );
};

const soleStatement = (statement) => {
  if (statement && ts.isBlock(statement)) return statement.statements.length === 1 ? statement.statements[0] : null;
  return statement;
};

const isEmptyBodyPreflightResponse = (statement) => {
  if (!statement || !ts.isReturnStatement(statement)) return false;
  const created = unwrap(statement.expression);
  if (!created || !ts.isNewExpression(created)) return false;
  if (!ts.isIdentifier(created.expression) || created.expression.text !== 'Response') return false;

  const args = created.arguments ?? [];
  if (args.length !== 2) return false;
  if (unwrap(args[0]).kind !== ts.SyntaxKind.NullKeyword) return false;

  const options = unwrap(args[1]);
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'status' &&
      ts.isNumericLiteral(unwrap(property.initializer)) &&
      unwrap(property.initializer).text === '204',
  );
};

const isPreflightGuard = (statement) =>
  ts.isIfStatement(statement) &&
  !statement.elseStatement &&
  isMethodOptionsComparison(statement.expression) &&
  isEmptyBodyPreflightResponse(soleStatement(statement.thenStatement));

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
 * Facts about the route file, all derived from the AST.
 *
 * Every field is either a boolean fact or a list of human-readable offenders, so
 * the caller can assert without knowing anything about TypeScript's syntax
 * kinds. `reasons` is empty exactly when the structural gate holds.
 */
export function analyseTwiRouteFile(source) {
  const sf = parse(source);
  const syntaxErrors = (sf.parseDiagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );

  const handlerExports = exportedNames(sf).filter(isPagesHandlerName);
  const extraHandlerExports = handlerExports.filter((name) => name !== 'onRequest');

  const onRequest = findOnRequest(sf);
  const body = onRequest && onRequest.body && ts.isBlock(onRequest.body) ? onRequest.body : null;

  const empty = {
    syntaxErrors,
    handlerExports,
    extraHandlerExports,
    hasOnRequest: Boolean(body),
    gateReasons: ['the exported onRequest handler was not found, or its body is not a block'],
    preGateOffenders: [],
    unawaitedReturns: [],
    awaitedReturnCount: 0,
  };
  if (!body) return empty;

  // ── The gate: exactly one call, awaited, as a statement ────────────────────
  const gateCalls = descendants(body)
    .filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression))
    .filter((node) => node.expression.text === 'requireOwnerSession');

  const gateReasons = [];
  if (gateCalls.length !== 1) {
    gateReasons.push(`expected exactly ONE requireOwnerSession call in onRequest, found ${gateCalls.length}`);
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
  }

  // ── Above the gate: declarations and one verified preflight, nothing else ──
  const preGateOffenders = [];
  let preflightCount = 0;

  if (gateTry) {
    const gateIndex = gateTry.tryBlock.statements.indexOf(gateStatement);
    const preGate = [
      ...body.statements.slice(0, body.statements.indexOf(gateTry)),
      ...gateTry.tryBlock.statements.slice(0, gateIndex === -1 ? 0 : gateIndex),
    ];

    for (const statement of preGate) {
      const isPreflight = isPreflightGuard(statement);
      if (isPreflight) preflightCount += 1;

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
    }

    if (preflightCount !== 1) {
      preGateOffenders.push(
        `expected exactly ONE verified CORS preflight above the gate (if (method === 'OPTIONS') return new Response(null, { status: 204, … })), found ${preflightCount}`,
      );
    }
  }

  // ── Below the gate, inside the try: every return is awaited or json() ──────
  const unawaitedReturns = [];
  let awaitedReturnCount = 0;

  if (gateTry) {
    const gateIndex = gateTry.tryBlock.statements.indexOf(gateStatement);
    const gated = gateTry.tryBlock.statements.slice(gateIndex + 1);
    const returns = gated.flatMap((statement) => [
      ...(ts.isReturnStatement(statement) ? [statement] : []),
      ...descendants(statement, { intoFunctions: false }).filter(ts.isReturnStatement),
    ]);

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
    hasOnRequest: true,
    gateReasons,
    preGateOffenders,
    unawaitedReturns,
    awaitedReturnCount,
  };
}

/**
 * Which files under functions/api/twi/ are allowed to exist, and why.
 *
 * Cloudflare Pages routes by path specificity, so EVERY module in this directory
 * is an entry point: `functions/api/twi/health.ts` answers /api/twi/health
 * without the catch-all — and therefore without the gate — ever being entered.
 * That evasion needed no code trickery at all, and no script in this repo looked
 * at the directory.
 *
 * The inventory is therefore pinned. A later task that legitimately needs a
 * public endpoint here has to turn TWO keys, both of them visible in review:
 * add the file name to `publicAllowlist` in the caller, AND write the marker
 * below into the file itself with a reason. Neither happens by accident, and a
 * reviewer reading the diff sees an allowlist entry rather than a new file.
 */
export const PUBLIC_ROUTE_MARKER = 'TWI-PUBLIC-ROUTE:';

export function classifyRouteInventory({ files, gatedFile, publicAllowlist = {}, contentsOf }) {
  const allowed = new Set([gatedFile, ...Object.keys(publicAllowlist)]);
  const offenders = files
    .filter((file) => !allowed.has(file))
    .map(
      (file) =>
        `${file} can answer /api/twi/* WITHOUT the gate in ${gatedFile} — route it through onRequest there, or declare it in publicAllowlist and mark it ${PUBLIC_ROUTE_MARKER}`,
    );

  const unmarked = Object.keys(publicAllowlist)
    .filter((file) => !(contentsOf(file) ?? '').includes(PUBLIC_ROUTE_MARKER))
    .map((file) => `${file} is allowlisted as public but does not carry the ${PUBLIC_ROUTE_MARKER} marker`);

  const missing = files.includes(gatedFile) ? [] : [`${gatedFile} is missing`];

  return { offenders: [...missing, ...offenders, ...unmarked] };
}
