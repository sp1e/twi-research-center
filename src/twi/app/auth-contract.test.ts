// @vitest-environment node
// A filesystem contract check needs no DOM, and under jsdom `import.meta.url` is an http:
// URL, which fileURLToPath rejects.
/**
 * Pins the /api/auth/check coupling between the TWI shell and the router.
 *
 * App.test.tsx proves the shell behaves correctly against a STUB. Nothing in that file
 * notices if the router renames the route or the response field, because the stub happily
 * answers whatever the component asks for. This is the other half: the same text-matching
 * contract style as scripts/stems-contract-check.mjs, so a rename on either side fails a
 * test instead of locking the owner out of production silently.
 *
 * Sources are matched as TEXT. The repo pins eol=lf in .gitattributes; keep it that way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const app = read('src/twi/app/App.tsx');
const router = read('functions/api/[[route]].ts');

test('the shell requests the literal /api/auth/check path with same-origin credentials', () => {
  expect(app).toMatch(/fetch\('\/api\/auth\/check',\s*\{\s*credentials:\s*'same-origin'\s*\}\)/);
});

test('the shell reads the authenticated field the router actually returns', () => {
  expect(app).toContain('authenticated');
  expect(app).toMatch(/body\.authenticated\s*\?\s*'allowed'\s*:\s*'denied'/);
});

test('the router serves GET /api/auth/check', () => {
  expect(router).toMatch(/resource === 'auth'/);
  expect(router).toMatch(/id === 'check'\s*&&\s*method === 'GET'\)\s*return handleCheck\(/);
});

test('handleCheck answers with an authenticated boolean on both paths', () => {
  const handler = router.slice(router.indexOf('async function handleCheck('));
  expect(handler.slice(0, 900)).toMatch(/return json\(\{ authenticated: false \}\)/);
  expect(handler.slice(0, 900)).toMatch(/return json\(\{ authenticated: !!session \}\)/);
});

test('the auth block sits above the requireAuth gate so the check itself is reachable', () => {
  // If /api/auth/check ever fell below the gate it would 401 for an unauthenticated
  // visitor, and the shell would report 'denied' forever with no way to log in.
  const authIdx = router.indexOf("if (resource === 'auth') {");
  const gateIdx = router.indexOf('await requireAuth(request, env);');
  expect(authIdx).toBeGreaterThan(0);
  expect(gateIdx).toBeGreaterThan(0);
  expect(authIdx).toBeLessThan(gateIdx);
});
