/**
 * ts-ast.mjs — the TypeScript-AST facts the TWI guards are built from.
 *
 * Split out of scripts/lib/twi-route-structure.mjs, which grew past this repo's
 * 800-line ceiling in fix round 3. The seam is deliberate rather than arbitrary:
 * NOTHING here knows anything about the TWI route file, the owner gate or
 * Cloudflare Pages. These are general facts about a parsed module — its exports,
 * its imports, its declarations, a canonical rendering of one statement — and the
 * TWI-specific reasoning composes them next door.
 *
 * Two of these deserve their reason recorded, because they are why the round-3
 * assertions cannot be beaten the way the round-1 and round-2 ones were:
 *
 *   canonicalStatement  prints from the AST with comments removed, so a leading
 *                       block comment cannot delete a statement from a region and
 *                       a unicode identifier escape cannot smuggle a name past a
 *                       comparison. Both beat a line scan; neither touches this.
 *   exportedNames       returns the names it CAN see and, separately, the exports
 *                       it cannot — `export * from './x'` carries whatever that
 *                       module exports, including a Pages handler, and there is no
 *                       name here to compare. The caller refuses the ambiguity
 *                       rather than assuming either answer.
 *
 * Purity: nothing here reads a file, spawns a process or touches a database.
 */

import ts from 'typescript';

/** Parse source text as a TypeScript module, with parent pointers set. */
export const parseTypeScript = (source, fileName = 'module.ts') =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

/**
 * Syntax errors, from an INTERNAL TypeScript property.
 *
 * `ts.createSourceFile` has no public diagnostics accessor, so this reads
 * `sf.parseDiagnostics` and would fail OPEN — reporting a clean parse forever — if
 * a future typescript bump renamed or hid it. That is why
 * scripts/twi-route-structure.test.mjs carries a sentinel asserting that source
 * which cannot parse really does produce an error here.
 */
export const syntaxErrorsOf = (sf) =>
  (sf.parseDiagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));

/**
 * One statement, printed from the AST and whitespace-normalised.
 *
 * Used for the pre-gate preamble equality. Printing from the AST rather than
 * slicing the source is what makes the comparison immune to the two tricks that
 * beat every line scan in rounds 1–3: comments are trivia and are removed, and a
 * unicode identifier escape is printed DECODED (`env` prints as `env`).
 * Re-indentation and line breaks collapse to single spaces, so reformatting the
 * file does not fail the check while adding a statement does.
 */
export const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
export const canonicalStatement = (sf, node) =>
  printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, ' ').trim();

/** `(x)` and `x` are the same expression. Every predicate below sees through parentheses. */
export const unwrap = (node) => (node && ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

export const hasExportModifier = (node) =>
  (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** The node's first source line, trimmed — for a failure message that names the offender. */
export const lineOf = (sf, node) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return (sf.text.split('\n')[line] ?? '').trim();
};

/** Every node in the subtree, optionally not descending into nested functions. */
export const descendants = (node, { intoFunctions = true } = {}) => {
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
export const ancestorsUpTo = (node, stopAt) => {
  const chain = [];
  let current = node.parent;
  while (current && current !== stopAt) {
    chain.push(current);
    current = current.parent;
  }
  return current === stopAt ? chain : null;
};

/**
 * Names bound by an export, including destructured ones, with unicode escapes
 * DECODED — plus the exports whose names this module CANNOT see.
 *
 * `export * from './x'` re-exports whatever `./x` exports, including an
 * `onRequestPost`, and there is no name in this file to compare. Whether Pages
 * dispatches a re-exported handler is a deploy-time fact this repo cannot settle,
 * so the star form is returned as OPAQUE and the caller refuses the ambiguity —
 * the same position the guard already takes on _redirects precedence. The route
 * file has no star export, so this costs nothing today.
 */
export const exportedNames = (sf) => {
  const names = [];
  const opaque = [];
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
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
      names.push(statement.exportClause.name.text);
    } else if (ts.isExportDeclaration(statement) && !statement.exportClause) {
      opaque.push(
        `export * from ${statement.moduleSpecifier?.getText(sf) ?? '?'} — a star re-export can carry a Pages handler this check cannot see`,
      );
    } else if (ts.isExportAssignment(statement)) {
      names.push('default');
    }
  }
  return { names, opaque };
};

/**
 * Every name this file imports, with the module it came from.
 *
 * `local` is the name used in the body; `imported` is the name in the source
 * module (they differ under `as`). A namespace import (`import * as auth from`)
 * is recorded with `imported: '*'`, because `auth.requireOwnerSession(…)` is a
 * different construct from the bare call the gate assertion pins.
 */
export const importBindings = (sf) => {
  const bindings = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.push({ local: clause.name.text, imported: 'default', module, typeOnly: clause.isTypeOnly });
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.push({ local: named.name.text, imported: '*', module, typeOnly: clause.isTypeOnly });
    } else {
      for (const element of named.elements) {
        bindings.push({
          local: element.name.text,
          imported: (element.propertyName ?? element.name).text,
          module,
          typeOnly: clause.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  }
  return bindings;
};

/** Declarations of `name` anywhere in the file that are not the import of it. */
export const localDeclarationsOf = (sf, name) =>
  descendants(sf).filter(
    (node) =>
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );

