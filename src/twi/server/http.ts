/**
 * HTTP primitives for the TWI Pages Function.
 *
 * These are deliberately a local copy of the helpers in the sibling functions
 * (`functions/api/[[route]].ts` and `functions/api/fredagsfett/[[route]].ts`)
 * rather than an import from them: those files define theirs privately, and the
 * Fredagsfett split established that each nested function owns its own. Copying
 * the CORS values keeps `/api/twi/*` answering with the same policy as the rest
 * of the site.
 *
 * Living here rather than in the route file has one further point: every response
 * shape and every rejection in this API is then unit-testable without a Workers
 * runtime, which is what src/twi/server/http.test.ts does.
 */

/** Largest JSON request body this API will parse. Project metadata is tiny. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Stable machine-readable codes per status, so a client can branch on `code`
 * instead of matching prose. Callers may override with something more specific
 * (`invalid_project_name`); the default exists so no throw site can forget one
 * and emit `{ code: undefined }`.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'rate_limited',
};

/**
 * A failure the caller is allowed to see. The route table maps this — and only
 * this — to `{ error, code }`; anything else becomes `internal_error`, so an
 * unexpected exception cannot narrate the database to the network.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? CODE_BY_STATUS[status] ?? 'internal_error';
  }
}

export function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': 'https://sp1e.se',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

/**
 * The only JSON writer in this API. A hand-rolled `new Response(JSON.stringify(…))`
 * compiles, runs, and silently drops the CORS headers.
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    // Compared as a whole name on purpose: a `startsWith`/`endsWith` test would
    // accept `ff_session` as `session` and hand a Fredagsfett token to the owner
    // lookup.
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * CSRF defence for state-changing requests.
 *
 * The site session cookie is `SameSite=Strict`, which already stops a
 * cross-site form post from carrying it. This is the second lock, and it fails
 * CLOSED: a missing `Origin` is rejected rather than trusted, because "no
 * Origin" is exactly what a request forged through a non-browser client looks
 * like. Safe methods are exempt — they change nothing, and `GET` navigations do
 * not always carry the header.
 */
export function assertSameOriginMutation(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'origin mismatch');
  }
}

/**
 * Reads and parses a JSON object body. The Pages dispatcher never touches the
 * body, so this is the only place it is consumed.
 *
 * Non-objects are rejected rather than returned: every request body in this API
 * is an object, and returning `"name"` or `null` as `unknown` only moves the
 * type error into each caller.
 */
export async function parseJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, 'request body too large');
  }

  const raw = await request.text();
  // A streamed body carries no Content-Length, so the check above cannot see it.
  if (raw.length > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'request body too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // The parser's message quotes the body back. Withheld deliberately.
    throw new HttpError(400, 'request body is not valid JSON', 'invalid_json');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object', 'invalid_json');
  }
  return parsed as Record<string, unknown>;
}
