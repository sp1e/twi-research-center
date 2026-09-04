interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
}

interface Env {
  DB: D1DatabaseLike;
  AUTH_PASSWORD_HASH: string;
}

interface RouteContext {
  request: Request;
  env: Env;
  params: { route?: string | string[] };
}

interface PasswordHash {
  iterations: number;
  salt: Uint8Array;
  expected: Uint8Array;
}

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const onRequest = async ({ request, env, params }: RouteContext): Promise<Response> => {
  const route = Array.isArray(params.route) ? params.route.join('/') : String(params.route ?? '');
  const [resource = '', id = ''] = route.split('/');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

  try {
    if (resource === 'health' && !id && method === 'GET') return json({ status: 'ok' });

    if (resource === 'auth') {
      if (id === 'login' && method === 'POST') return handleLogin(request, env);
      if (id === 'logout' && method === 'POST') return handleLogout(request, env);
      if (id === 'check' && method === 'GET') return handleCheck(request, env);
      return json({ error: 'not found', code: 'not_found' }, 404);
    }

    await requireAuth(request, env);
    return json({ error: 'not found', code: 'not_found' }, 404);
  } catch (error) {
    console.error('twi root api error', error);
    return json({ error: 'internal error', code: 'internal_error' }, 500);
  }
};

async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON', code: 'invalid_json' }, 400);
  }

  if (typeof body.password !== 'string' || body.password.length === 0) {
    return json({ error: 'password required', code: 'password_required' }, 400);
  }

  const configured = parsePasswordHash(env.AUTH_PASSWORD_HASH);
  if (!configured) {
    console.error('AUTH_PASSWORD_HASH is missing or invalid');
    return json({ error: 'auth not configured', code: 'auth_not_configured' }, 500);
  }

  if (!(await verifyPassword(body.password, configured))) {
    return json({ error: 'wrong password', code: 'invalid_credentials' }, 401);
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await env.DB.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)')
    .bind(token, expiresAt.toISOString())
    .run();

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE_SECONDS),
      ...cors(),
    },
  });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, 'session');
  if (token) {
    try {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    } catch {
      // Cookie clearing is still useful when best-effort server revocation fails.
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie('', 0),
      ...cors(),
    },
  });
}

async function handleCheck(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, 'session');
  if (!token) return json({ authenticated: false });
  const session = await env.DB.prepare(
    `SELECT token FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')`,
  )
    .bind(token)
    .first();
  return json({ authenticated: !!session });
}

async function requireAuth(request: Request, env: Env): Promise<void> {
  const token = getCookie(request, 'session');
  if (!token) throw new Error('Unauthorized');
  const session = await env.DB.prepare(
    `SELECT token FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')`,
  )
    .bind(token)
    .first();
  if (!session) throw new Error('Unauthorized');
}

function parsePasswordHash(value: string | undefined): PasswordHash | null {
  if (!value) return null;
  const [algorithm, iterationsRaw, saltHex, expectedHex] = value.split(':');
  const iterations = Number(iterationsRaw);
  if (algorithm !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 100_000) return null;
  const salt = fromHex(saltHex ?? '');
  const expected = fromHex(expectedHex ?? '');
  if (salt.length < 16 || expected.length !== 32) return null;
  return { iterations, salt, expected };
}

async function verifyPassword(password: string, configured: PasswordHash): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: configured.salt.buffer as ArrayBuffer,
    iterations: configured.iterations,
  }, key, 256));

  let difference = 0;
  for (let index = 0; index < derived.length; index += 1) {
    difference |= derived[index]! ^ configured.expected[index]!;
  }
  return difference === 0;
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return new Uint8Array();
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sessionCookie(token: string, maxAge: number): string {
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function getCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
