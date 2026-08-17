// @vitest-environment node
// No DOM needed: these are Request/Response semantics, which Node provides.
import { describe, expect, it } from 'vitest';

import { HttpError, MAX_JSON_BODY_BYTES, assertSameOriginMutation, cors, getCookie, json, parseJson } from './http';

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://sp1e.se/api/twi/projects', { method: 'POST', body, headers });

describe('json', () => {
  it('carries the CORS headers, so a caller cannot lose them by hand-rolling a Response', async () => {
    const response = json({ ok: true });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://sp1e.se');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('honours an explicit status', () => {
    expect(json({ error: 'not found', code: 'not_found' }, 404).status).toBe(404);
  });

  it('advertises the same origin and verbs as the sibling API functions', () => {
    expect(cors()['Access-Control-Allow-Origin']).toBe('https://sp1e.se');
    expect(cors()['Access-Control-Allow-Methods']).toContain('POST');
  });
});

describe('HttpError', () => {
  it('derives a stable machine code from the status when none is given', () => {
    expect(new HttpError(401, 'Unauthorized').code).toBe('unauthorized');
    expect(new HttpError(403, 'origin mismatch').code).toBe('forbidden');
    expect(new HttpError(404, 'not found').code).toBe('not_found');
    expect(new HttpError(400, 'bad').code).toBe('bad_request');
    expect(new HttpError(413, 'too big').code).toBe('payload_too_large');
  });

  it('prefers an explicit code over the status default', () => {
    expect(new HttpError(400, 'no name', 'invalid_project_name').code).toBe('invalid_project_name');
  });

  it('keeps the status and message the router reports', () => {
    const error = new HttpError(409, 'conflict');
    expect(error.status).toBe(409);
    expect(error.message).toBe('conflict');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('getCookie', () => {
  const withCookie = (header: string) =>
    new Request('https://sp1e.se/api/twi/bootstrap', { headers: { Cookie: header } });

  it('reads the named cookie out of a multi-cookie header', () => {
    expect(getCookie(withCookie('theme=dark; session=abc123; other=1'), 'session')).toBe('abc123');
  });

  it('tolerates the whitespace browsers actually send', () => {
    expect(getCookie(withCookie('  session = abc123  '), 'session')).toBe('abc123');
  });

  it('returns null when the cookie is absent', () => {
    expect(getCookie(withCookie('theme=dark'), 'session')).toBeNull();
    expect(getCookie(new Request('https://sp1e.se/api/twi/bootstrap'), 'session')).toBeNull();
  });

  it('does not treat a cookie whose name merely ENDS with the wanted name as a match', () => {
    // ff_session is a real cookie on this site. Matching it as `session` would
    // hand the Fredagsfett token to the owner-session lookup.
    expect(getCookie(withCookie('ff_session=fredagsfett-token'), 'session')).toBeNull();
  });

  it('does not treat a cookie whose name merely BEGINS with the wanted name as a match', () => {
    // The other half of the same confusion, and the half the suite used to miss:
    // `.startsWith(name)` survived every test in this project. Nothing on this
    // site sets `sessionfoo`, but any subdomain that can write cookies on the
    // parent domain can, and under a prefix match it would SHADOW the real
    // session — the browser sends both, the loop returns the first hit, and the
    // owner is logged out of the studio until the shadow expires.
    expect(getCookie(withCookie('sessionfoo=x'), 'session')).toBeNull();
    expect(getCookie(withCookie('sessionfoo=x; session=abc123'), 'session')).toBe('abc123');
  });

  it('returns the EMPTY STRING for a valueless cookie, not null', () => {
    // Recorded because it is load-bearing rather than because it is pretty: the
    // gate tests `!token`, so '' short-circuits to 401 with no database read, the
    // same as no cookie at all (src/twi/server/auth.test.ts pins that). A caller
    // that switched to `=== null` would send '' to D1 instead.
    expect(getCookie(withCookie('session='), 'session')).toBe('');
    expect(getCookie(withCookie('theme=dark; session=; other=1'), 'session')).toBe('');
  });

  it('resolves a duplicated cookie name first-match-wins, like the site router it copies', () => {
    // A duplicate can arrive legitimately (same name written for both `.sp1e.se`
    // and `sp1e.se`), so this is not a hypothetical. First-match-wins is the
    // parent router's behaviour and the deliberate choice here; the consequence
    // worth knowing is that an EMPTY first copy shadows a valid second one and
    // reads as logged out, which fails closed rather than open.
    expect(getCookie(withCookie('session=first; session=second'), 'session')).toBe('first');
    expect(getCookie(withCookie('session=; session=valid'), 'session')).toBe('');
    expect(getCookie(withCookie('session=valid; session='), 'session')).toBe('valid');
  });

  it('keeps a value containing "=" intact', () => {
    expect(getCookie(withCookie('session=a=b=c'), 'session')).toBe('a=b=c');
  });
});

describe('assertSameOriginMutation', () => {
  it('lets safe methods through with no Origin header at all', () => {
    expect(() => assertSameOriginMutation(new Request('https://sp1e.se/api/twi/projects'))).not.toThrow();
    expect(() =>
      assertSameOriginMutation(new Request('https://sp1e.se/api/twi/projects', { method: 'HEAD' })),
    ).not.toThrow();
  });

  it('accepts a mutation whose Origin matches the request origin', () => {
    expect(() => assertSameOriginMutation(post('{}', { Origin: 'https://sp1e.se' }))).not.toThrow();
  });

  it('rejects a mutation with no Origin header', () => {
    expect(() => assertSameOriginMutation(post('{}'))).toThrowError(
      expect.objectContaining({ status: 403, message: 'origin mismatch' }),
    );
  });

  it('rejects a mutation from a foreign origin, including a lookalike host', () => {
    for (const origin of ['https://evil.example', 'https://sp1e.se.evil.example', 'http://sp1e.se']) {
      expect(() => assertSameOriginMutation(post('{}', { Origin: origin }))).toThrowError(
        expect.objectContaining({ status: 403 }),
      );
    }
  });

  it('applies to every mutating verb, not just POST', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const request = new Request('https://sp1e.se/api/twi/projects/x', { method });
      expect(() => assertSameOriginMutation(request)).toThrowError(expect.objectContaining({ status: 403 }));
    }
  });
});

describe('parseJson', () => {
  it('returns the parsed object', async () => {
    await expect(parseJson(post('{"name":"Nocturne"}'))).resolves.toEqual({ name: 'Nocturne' });
  });

  it('rejects a malformed body with 400 and no parser detail', async () => {
    await expect(parseJson(post('{"name":'))).rejects.toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid_json' }),
    );
  });

  it('rejects JSON that is not an object, so a handler cannot read a field off a string', async () => {
    for (const body of ['"name"', '42', 'null', '[{"name":"x"}]']) {
      await expect(parseJson(post(body))).rejects.toThrowError(expect.objectContaining({ status: 400 }));
    }
  });

  it('rejects an oversized body on Content-Length before reading it', async () => {
    const request = post('{}', { 'Content-Length': String(MAX_JSON_BODY_BYTES + 1) });
    await expect(parseJson(request)).rejects.toThrowError(
      expect.objectContaining({ status: 413, code: 'payload_too_large' }),
    );
  });

  it('rejects an oversized body that declared no length at all', async () => {
    // A streamed body carries no Content-Length, so the header check cannot see
    // it. Without the post-read guard this request would be parsed in full.
    const oversized = `{"name":"${'x'.repeat(MAX_JSON_BODY_BYTES)}"}`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const request = new Request('https://sp1e.se/api/twi/projects', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);

    expect(request.headers.get('Content-Length')).toBeNull();
    await expect(parseJson(request)).rejects.toThrowError(expect.objectContaining({ status: 413 }));
  });
});
