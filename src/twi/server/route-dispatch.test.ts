// @vitest-environment node
/// <reference types="node" />
//
// The Pages Function itself, exercised end to end against a real in-memory
// database. scripts/twi-contract-check.mjs pins WHERE the routes sit in the file;
// this proves what they DO — above all that nothing answers without an owner
// session, which is the only thing standing between a private studio and the
// open internet.
//
// The route table is imported directly, so a signature or export change fails
// here rather than at deploy time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest, type TwiRouteContext } from '../../../functions/api/twi/[[route]]';

import { creationCoreCapabilities } from './capabilities';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types';
import { RecordingOrchestrator } from './jobs.harness';
import type { R2BucketLike, R2ObjectLike, R2PutOptionsLike, R2PutValue } from './r2-types';
import { SqliteD1 } from './repository.harness';

const SESSIONS_TABLE = `CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
)`;

const OWNER_COOKIE = 'session=owner-token';

interface CallOptions {
  method?: string;
  cookie?: string;
  origin?: string | null;
  body?: string | FormData;
  /**
   * `undefined` mints one per call, the way `mosquito.html`'s `api()` wrapper does for
   * every non-GET request on this site. `null` omits it deliberately, which is what a
   * client that has not been told about the contract looks like.
   */
  idempotencyKey?: string | null;
  db?: D1DatabaseLike;
}

/**
 * The R2 binding, recorded. Task 6 added `FILES` to `TwiEnv`, so the dispatch table
 * cannot be driven without one — and every gate assertion below is also an assertion
 * that nothing was written to it.
 */
class RecordingBucket implements R2BucketLike {
  readonly calls: string[] = [];

  async put(key: string, _value: R2PutValue, _options?: R2PutOptionsLike): Promise<R2ObjectLike | null> {
    this.calls.push(`put:${key}`);
    return { key, size: 0, etag: 'etag' };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.calls.push(`delete:${key}`);
  }
}

describe('/api/twi/* dispatch', () => {
  let db: SqliteD1;
  let files: RecordingBucket;
  let orchestrator: RecordingOrchestrator;

  beforeEach(() => {
    db = new SqliteD1();
    files = new RecordingBucket();
    // Task 7 added `TWI_ORCHESTRATOR` to `TwiEnv`, so the dispatch table cannot be
    // driven without one — and every gate assertion below is also an assertion that
    // nothing was dispatched to it. A job start is the most expensive thing this API
    // can do, so "no session ⇒ no start" is the assertion that matters most here.
    orchestrator = new RecordingOrchestrator();
    db.exec(SESSIONS_TABLE);
    db.exec(
      'INSERT INTO sessions (token, expires_at) VALUES (?, ?)',
      'owner-token',
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  const call = (route: string[], options: CallOptions = {}): Promise<Response> => {
    const { method = 'GET', cookie, origin, body, idempotencyKey, db: database } = options;
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    if (origin) headers.set('Origin', origin);
    // A mutation carries an idempotency key here for the same reason the browser
    // wrapper attaches one to every non-GET call: the asset upload requires it, and a
    // test client that skips it is not the client the site ships.
    if (method !== 'GET' && idempotencyKey !== null) {
      headers.set('Idempotency-Key', idempotencyKey ?? crypto.randomUUID());
    }
    // FormData sets its own multipart Content-Type, boundary included; overriding it
    // would make the body unparseable.
    if (typeof body === 'string') headers.set('Content-Type', 'application/json');

    const request = new Request(`https://sp1e.se/api/twi/${route.join('/')}`, { method, headers, body });
    const context: TwiRouteContext = {
      request,
      env: { DB: database ?? db, FILES: files, TWI_ORCHESTRATOR: orchestrator },
      params: { route },
    };
    return onRequest(context);
  };

  const projectCount = () => db.value<number>('SELECT COUNT(*) FROM twi_projects');
  const assetCount = () => db.value<number>('SELECT COUNT(*) FROM twi_assets');

  /** A four-byte JPEG. The bytes are what `validateImageReference` reads; the name is not. */
  const imageForm = (): FormData => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'mood.jpg', { type: 'image/jpeg' }));
    return form;
  };

  describe('the owner gate', () => {
    const everyRoute: Array<[string, CallOptions]> = [
      ['bootstrap', {}],
      ['projects', {}],
      ['projects', { method: 'POST', origin: 'https://sp1e.se', body: '{"name":"Nocturne"}' }],
      ['projects/some-id', {}],
      // Task 6's upload route. Added here rather than only to its own suite because
      // this is the parametrised list that proves a route is BEHIND the gate, and a
      // route absent from it is a route nobody checked.
      ['projects/some-id/assets', { method: 'POST', origin: 'https://sp1e.se', body: imageForm() }],
      // Task 7's six job routes, for the same reason: this list is what proves a route
      // is BEHIND the gate. These are the ones that cost provider money, so an ungated
      // one is not a disclosure, it is a stranger spending the owner's balance.
      ['jobs/estimate', { method: 'POST', origin: 'https://sp1e.se', body: '{}' }],
      ['jobs', { method: 'POST', origin: 'https://sp1e.se', body: '{}' }],
      ['jobs', {}],
      ['jobs/some-id', {}],
      ['jobs/some-id/cancel', { method: 'POST', origin: 'https://sp1e.se', body: '{}' }],
      ['jobs/some-id/retry', { method: 'POST', origin: 'https://sp1e.se', body: '{}' }],
      ['unknown-resource', {}],
    ];

    it.each(everyRoute)('answers 401 for /%s with no session cookie', async (route, options) => {
      const response = await call(route.split('/'), options);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized', code: 'unauthorized' });
      expect(projectCount()).toBe(0);
      expect(files.calls).toEqual([]);
      expect(orchestrator.calls).toEqual([]);
    });

    it('answers 401 when the session has expired', async () => {
      db.exec('UPDATE sessions SET expires_at = ?', new Date(Date.now() - 60_000).toISOString());

      expect((await call(['bootstrap'], { cookie: OWNER_COOKIE })).status).toBe(401);
    });

    it('lets a CORS preflight through without a session, and returns no body', async () => {
      const response = await call(['projects'], { method: 'OPTIONS' });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://sp1e.se');
      expect(await response.text()).toBe('');
    });
  });

  describe('GET /api/twi/bootstrap', () => {
    it('returns the capability catalog to the owner', async () => {
      const response = await call(['bootstrap'], { cookie: OWNER_COOKIE });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://sp1e.se');
      expect(await response.json()).toEqual({ capabilities: JSON.parse(JSON.stringify(creationCoreCapabilities)) });
    });

    it('is GET only', async () => {
      const response = await call(['bootstrap'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{}',
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found', code: 'not_found' });
    });
  });

  describe('projects', () => {
    it('creates, lists and reads back a project', async () => {
      const created = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{"name":"Nocturne"}',
      });
      expect(created.status).toBe(201);
      const { project } = (await created.json()) as { project: { id: string; name: string } };
      expect(project.name).toBe('Nocturne');

      const listed = await call(['projects'], { cookie: OWNER_COOKIE });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ projects: [{ id: project.id }] });

      const fetched = await call(['projects', project.id], { cookie: OWNER_COOKIE });
      expect(fetched.status).toBe(200);
      expect(await fetched.json()).toMatchObject({ project: { id: project.id, name: 'Nocturne' } });
    });

    it('refuses a create with no Origin header and writes nothing', async () => {
      const response = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        body: '{"name":"Nocturne"}',
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin mismatch', code: 'forbidden' });
      expect(projectCount()).toBe(0);
    });

    it('refuses a create from a foreign origin and writes nothing', async () => {
      const response = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://evil.example',
        body: '{"name":"Nocturne"}',
      });

      expect(response.status).toBe(403);
      expect(projectCount()).toBe(0);
    });

    it('answers 404 for an unknown project id', async () => {
      const response = await call(['projects', 'nope'], { cookie: OWNER_COOKIE });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'project not found', code: 'not_found' });
    });

    it('answers 404 for a nested path this phase does not serve, on a project that EXISTS', async () => {
      // The id has to be a real one. Against a nonexistent project both the
      // correct route table and one missing the `!sub` guard answer 404 — the
      // first from the fallthrough, the second from "project not found" — so a
      // made-up id cannot tell them apart. With a real project, dropping `!sub`
      // serves the whole record at /projects/:id/assets (and at every other
      // sub-path Task 6 onward will claim), which is what this pins.
      const created = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{"name":"Nocturne"}',
      });
      const { project } = (await created.json()) as { project: { id: string } };

      const response = await call(['projects', project.id, 'assets'], { cookie: OWNER_COOKIE });

      expect(response.status).toBe(404);
      // The route table's own fallthrough, not the project handler's 404.
      expect(await response.json()).toEqual({ error: 'not found', code: 'not_found' });
    });

    it('does not serve the project record from an unrecognised sub-path', async () => {
      const created = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{"name":"Nocturne"}',
      });
      const { project } = (await created.json()) as { project: { id: string } };

      for (const sub of ['assets', 'jobs', 'specs', 'anything-at-all']) {
        const body = await (await call(['projects', project.id, sub], { cookie: OWNER_COOKIE })).text();
        expect(body, sub).not.toContain('Nocturne');
      }
    });
  });

  describe('POST /api/twi/projects/:projectId/assets', () => {
    const owningProject = async (): Promise<string> => {
      const created = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{"name":"Nocturne"}',
      });
      return ((await created.json()) as { project: { id: string } }).project.id;
    };

    it('stores an image reference and answers 201 with the record', async () => {
      const projectId = await owningProject();

      const response = await call(['projects', projectId, 'assets'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: imageForm(),
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as { asset: { r2Key: string; contentType: string }; outcome: string };
      expect(body.outcome).toBe('inserted');
      expect(body.asset.contentType).toBe('image/jpeg');
      expect(body.asset.r2Key).toMatch(new RegExp(`^twi/${projectId}/assets/[0-9a-f-]{36}/source\\.jpg$`));
      expect(files.calls).toEqual([`put:${body.asset.r2Key}`]);
      expect(assetCount()).toBe(1);
    });

    it('discloses neither the binding name nor the bucket name', async () => {
      const projectId = await owningProject();

      const text = await (
        await call(['projects', projectId, 'assets'], {
          method: 'POST',
          cookie: OWNER_COOKIE,
          origin: 'https://sp1e.se',
          body: imageForm(),
        })
      ).text();

      expect(text).not.toContain('FILES');
      expect(text).not.toContain('sp1e-files');
    });

    it('refuses an upload with no Origin header and writes nothing anywhere', async () => {
      const projectId = await owningProject();

      const response = await call(['projects', projectId, 'assets'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        body: imageForm(),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin mismatch', code: 'forbidden' });
      expect(files.calls).toEqual([]);
      expect(assetCount()).toBe(0);
    });

    it('refuses an upload with no Idempotency-Key through the envelope, writing nothing', async () => {
      const projectId = await owningProject();

      const response = await call(['projects', projectId, 'assets'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        idempotencyKey: null,
        body: imageForm(),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Idempotency-Key header is required',
        code: 'idempotency_key_required',
      });
      expect(files.calls).toEqual([]);
      expect(assetCount()).toBe(0);
    });

    it('is POST only — a GET on the same path is the table fallthrough', async () => {
      const projectId = await owningProject();

      const response = await call(['projects', projectId, 'assets'], { cookie: OWNER_COOKIE });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found', code: 'not_found' });
    });

    it('does not claim a fourth segment', async () => {
      const projectId = await owningProject();

      const response = await call(['projects', projectId, 'assets', 'anything'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: imageForm(),
      });

      expect(response.status).toBe(404);
      expect(files.calls).toEqual([]);
      expect(assetCount()).toBe(0);
    });

    it('maps a rejected upload through the error envelope rather than Pages own 500', async () => {
      const projectId = await owningProject();
      const form = new FormData();
      form.set('file', new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], 'mood.jpg', { type: 'image/jpeg' }));

      const response = await call(['projects', projectId, 'assets'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: form,
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({
        error: 'image reference must be a JPEG, PNG or WebP image',
        code: 'unsupported_image',
      });
      expect(files.calls).toEqual([]);
      expect(assetCount()).toBe(0);
    });
  });

  describe('the job routes', () => {
    const owningProject = async (): Promise<string> => {
      const created = await call(['projects'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{"name":"Nocturne"}',
      });
      return ((await created.json()) as { project: { id: string } }).project.id;
    };

    /** A minimal valid specification. Kept here so the route table is driven end to end. */
    const specFor = (projectId: string, idempotencyKey: string) => ({
      projectId,
      idempotencyKey,
      spec: {
        intent: { purpose: 'album track', mood: [], narrative: '', durationSeconds: 120, instrumental: true },
        composition: { lyrics: '', sections: [], bpm: null, key: '', meter: '', arrangement: '' },
        sound: { styles: ['art rock'], exclusions: [], novelty: 50, imageAssetIds: [] },
        performance: { mode: 'generic', vocalRange: '', timbre: '', delivery: '' },
        rightsAccepted: true,
      },
    });

    it('quotes an estimate without creating a job or starting anything', async () => {
      const projectId = await owningProject();
      const { projectId: _omit, idempotencyKey: _key, ...rest } = specFor(projectId, 'x');

      const response = await call(['jobs', 'estimate'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: JSON.stringify({ projectId, ...rest }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ provider: { status: 'unavailable' } });
      expect(db.value<number>('SELECT COUNT(*) FROM twi_jobs')).toBe(0);
      expect(orchestrator.calls).toEqual([]);
    });

    it('submits, polls, lists and retries through the table', async () => {
      const projectId = await owningProject();
      const key = '22222222-2222-4222-8222-222222222222';

      const submitted = await call(['jobs'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: JSON.stringify(specFor(projectId, key)),
      });
      expect(submitted.status).toBe(201);
      const { job } = (await submitted.json()) as { job: { id: string; status: string } };
      expect(job.status).toBe('queued');

      expect((await call(['jobs', job.id], { cookie: OWNER_COOKIE })).status).toBe(200);
      const listed = await call(['jobs'], { cookie: OWNER_COOKIE });
      expect(await listed.json()).toMatchObject({ jobs: [{ id: job.id }] });

      // Retry is refused from `queued`, through the same error envelope every other
      // refusal uses — not through Pages' own 500.
      const retried = await call(['jobs', job.id, 'retry'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{}',
      });
      expect(retried.status).toBe(409);
      expect(await retried.json()).toMatchObject({ code: 'retry_not_allowed' });
    });

    it('cancels a queued job and tells the orchestrator to stop', async () => {
      const projectId = await owningProject();
      const submitted = await call(['jobs'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: JSON.stringify(specFor(projectId, '77777777-7777-4777-8777-777777777777')),
      });
      const { job } = (await submitted.json()) as { job: { id: string } };

      const cancelled = await call(['jobs', job.id, 'cancel'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: '{}',
      });

      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ job: { status: 'cancelling' } });
      expect(orchestrator.cancels).toBe(1);
    });

    it.each([
      [['jobs', 'estimate', 'extra'], 'POST'],
      [['jobs', 'some-id', 'cancel', 'extra'], 'POST'],
      [['jobs', 'some-id', 'retry', 'extra'], 'POST'],
      [['jobs', 'some-id', 'unknown'], 'GET'],
    ])('does not claim %s as a job route', async (route, method) => {
      const response = await call(route, {
        method,
        cookie: OWNER_COOKIE,
        origin: 'https://sp1e.se',
        body: method === 'POST' ? '{}' : undefined,
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found', code: 'not_found' });
      expect(orchestrator.calls).toEqual([]);
    });

    it('refuses a submission with no Origin header and starts nothing', async () => {
      const projectId = await owningProject();

      const response = await call(['jobs'], {
        method: 'POST',
        cookie: OWNER_COOKIE,
        body: JSON.stringify(specFor(projectId, '99999999-9999-4999-8999-999999999999')),
      });

      expect(response.status).toBe(403);
      expect(orchestrator.calls).toEqual([]);
      expect(db.value<number>('SELECT COUNT(*) FROM twi_jobs')).toBe(0);
    });
  });

  describe('unexpected failures', () => {
    /** Answers the session lookup, then fails every other statement. */
    const failAfterAuth = (): D1DatabaseLike => ({
      prepare: (sql: string): D1PreparedStatementLike => {
        if (sql.includes('FROM sessions')) return db.prepare(sql);
        throw new Error('D1_ERROR: no such table: twi_projects — secret-connection-string');
      },
      batch: () => {
        throw new Error('D1_ERROR: batch failed — secret-connection-string');
      },
    });

    it('reports internal_error with a correlation id and leaks nothing about the cause', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await call(['projects'], { cookie: OWNER_COOKIE, db: failAfterAuth() });

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; code: string; correlationId: string };
      expect(body.code).toBe('internal_error');
      expect(JSON.stringify(body)).not.toContain('secret-connection-string');
      expect(JSON.stringify(body)).not.toContain('no such table');
      expect(body.correlationId).toMatch(/[0-9a-f-]{36}/);

      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.mock.calls[0])).toContain(body.correlationId);
    });

    it('mints a fresh correlation id per failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const first = (await (await call(['projects'], { cookie: OWNER_COOKIE, db: failAfterAuth() })).json()) as {
        correlationId: string;
      };
      const second = (await (await call(['projects'], { cookie: OWNER_COOKIE, db: failAfterAuth() })).json()) as {
        correlationId: string;
      };

      expect(first.correlationId).not.toBe(second.correlationId);
    });
  });
});
