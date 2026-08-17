/**
 * twi-preflight.mjs — the one thing that may answer above the owner gate.
 *
 * A CORS preflight carries no cookies, so gating it would answer 401 to the
 * browser's own probe and the real request would never be sent. It is therefore
 * the single exemption in the pre-gate region — which makes its exact shape a
 * security question rather than a formatting one, and gives it its own module.
 *
 * Two rounds of history are why every clause below exists:
 *
 *   round 1  the guard asked whether the TEXT `method === 'OPTIONS'` appeared on a
 *            line with one `return`, so the condition could be widened by one
 *            `||` and keep the exemption while answering for a second resource.
 *            Here the condition must be that comparison ENTIRE.
 *   round 3  the guard asked whether `status: 204` appeared somewhere in the
 *            options object, so `{ status: 204, headers: { ...cors(), 'x-leak':
 *            String(Object.keys(ctx['env'])) } }` was an admitted preflight that
 *            exfiltrated the binding names to anyone: 204 forbids a BODY, not
 *            headers. Here the options object holds exactly `status: 204` and
 *            `headers: cors()`, so there is nowhere left to put a payload.
 *
 * And one round-3 concession, because refusing it was a false positive rather than
 * a defence: the preflight may be FACTORED OUT into a helper, provided the helper
 * is resolved in the http module's own source and found to return exactly the
 * verified response. Round 2 refused `return preflight();` outright because the
 * guard could not see what the helper returned. Now it can.
 *
 * Purity: source text in, facts out. Nothing here reads a file.
 */

import ts from 'typescript';

import { parseTypeScript, unwrap } from './ts-ast.mjs';

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

/**
 * `new Response(null, { status: 204, headers: cors() })` and NOTHING else.
 *
 * The headers value is pinned to the bare `cors()` call because 204 forbids a
 * body but not headers, and the round-2 guard only asked that `status: 204`
 * appeared somewhere in the options object. So
 * `{ status: 204, headers: { ...cors(), 'x-leak': String(Object.keys(ctx['env'])) } }`
 * was an admitted preflight that exfiltrated the binding names to anyone — the
 * construction the round-2 report itself called the one that "changed the
 * design", re-opened by spelling `env` with brackets. Pinning the SHAPE of the
 * headers closes it however `env` is spelled, and closes the class rather than
 * the spelling: the option object may hold exactly `status` and `headers`, so
 * there is nowhere left to put a payload.
 */
const isBareCorsCall = (expression) => {
  const expr = unwrap(expression);
  return (
    !!expr &&
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'cors' &&
    (expr.arguments ?? []).length === 0
  );
};

const isEmptyBodyPreflightExpression = (expression) => {
  const created = unwrap(expression);
  if (!created || !ts.isNewExpression(created)) return false;
  if (!ts.isIdentifier(created.expression) || created.expression.text !== 'Response') return false;

  const args = created.arguments ?? [];
  if (args.length !== 2) return false;
  if (unwrap(args[0]).kind !== ts.SyntaxKind.NullKeyword) return false;

  const options = unwrap(args[1]);
  if (!options || !ts.isObjectLiteralExpression(options)) return false;

  const named = new Map();
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return false;
    named.set(property.name.text, property.initializer);
  }
  if (named.size !== 2 || !named.has('status') || !named.has('headers')) return false;

  const status = unwrap(named.get('status'));
  return (
    ts.isNumericLiteral(status) && status.text === '204' && isBareCorsCall(named.get('headers'))
  );
};

const isEmptyBodyPreflightResponse = (statement) =>
  Boolean(statement) && ts.isReturnStatement(statement) && isEmptyBodyPreflightExpression(statement.expression);

/**
 * The preflight, factored out — `if (method === 'OPTIONS') return preflight();`
 *
 * Round 2 refused this, deliberately, because the guard could not see what the
 * helper returned. It is refused no longer: the helper is resolved in the http
 * module's own source and must itself be a zero-argument function whose whole
 * body is the verified response above. Task 6 onward can therefore share the
 * preflight with the other route files instead of copying it, and the fact the
 * guard needs is still proven rather than assumed.
 */
const resolvePreflightHelper = (httpSource, name) => {
  if (!httpSource || !name) return false;
  const bodyIsPreflight = (fn) => {
    if ((fn.parameters ?? []).length !== 0 || !fn.body) return false;
    return ts.isBlock(fn.body)
      ? isEmptyBodyPreflightResponse(soleStatement(fn.body))
      : isEmptyBodyPreflightExpression(fn.body);
  };

  const sf = parseTypeScript(httpSource, 'http.ts');
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        const fn = unwrap(declaration.initializer);
        return Boolean(fn) && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && bodyIsPreflight(fn);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return bodyIsPreflight(statement);
  }
  return false;
};

/** `if (method === 'OPTIONS') return <the verified preflight response>;` */
export const preflightForm = (statement, { httpSource = '', httpImports = [] } = {}) => {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return null;
  if (!isMethodOptionsComparison(statement.expression)) return null;
  const only = soleStatement(statement.thenStatement);
  if (isEmptyBodyPreflightResponse(only)) return { kind: 'inline' };

  // The factored form: `return helper();` where `helper` is imported from the
  // http module and resolves there to the same verified response.
  if (!only || !ts.isReturnStatement(only)) return null;
  const call = unwrap(only.expression);
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
  if ((call.arguments ?? []).length !== 0) return null;
  const binding = httpImports.find((entry) => entry.local === call.expression.text);
  if (!binding) return null;
  return resolvePreflightHelper(httpSource, binding.imported) ? { kind: 'factored', name: binding.imported } : null;
};
