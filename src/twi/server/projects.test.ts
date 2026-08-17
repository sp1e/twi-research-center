// @vitest-environment node
/// <reference types="node" />
//
// Project use cases, driven against a REAL in-memory database loading the actual
// Task 3 migration. A stubbed repository would happily accept a name the
// `twi_projects_name_text` CHECK rejects, so every acceptance here is also proof
// that the row can be stored, and every rejection is checked to have written
// nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject, getProject, listProjects, MAX_PROJECT_NAME_LENGTH, RAW_NAME_LENGTH_LIMIT } from './projects';
import { D1TwiRepository } from './repository';
import { SqliteD1 } from './repository.harness';

const clock = (id: string, now: string) => ({ newId: () => id, now: () => now });

const createRequest = (body: unknown) =>
  new Request('https://sp1e.se/api/twi/projects', {
    method: 'POST',
    headers: { Origin: 'https://sp1e.se', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('project use cases', () => {
  let db: SqliteD1;
  let repo: D1TwiRepository;

  beforeEach(() => {
    db = new SqliteD1();
    repo = new D1TwiRepository({ DB: db });
  });

  afterEach(() => db.close());

  const storedNames = () =>
    db.database.prepare('SELECT name FROM twi_projects ORDER BY created_at').all() as Array<{ name: string }>;

  describe('createProject', () => {
    it('stores the project and answers 201 with the created record', async () => {
      const response = await createProject(
        createRequest({ name: 'Nocturne Instrument' }),
        repo,
        clock('11111111-1111-4111-8111-111111111111', '2026-08-17T09:15:00.000Z'),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        project: {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Nocturne Instrument',
          currentRevisionId: null,
          lifecycleState: 'active',
          deletedAt: null,
          createdAt: '2026-08-17T09:15:00.000Z',
          updatedAt: '2026-08-17T09:15:00.000Z',
        },
      });
      expect(db.value<number>('SELECT COUNT(*) FROM twi_projects')).toBe(1);
      expect(db.value<string>('SELECT created_at FROM twi_projects')).toBe('2026-08-17T09:15:00.000Z');
    });

    it('mints a distinct id per creation when using the default clock', async () => {
      await createProject(createRequest({ name: 'One' }), repo);
      await createProject(createRequest({ name: 'Two' }), repo);

      const ids = db.database.prepare('SELECT id FROM twi_projects').all() as Array<{ id: string }>;
      expect(new Set(ids.map((row) => row.id)).size).toBe(2);
      expect(db.value<string>("SELECT created_at FROM twi_projects WHERE name = 'One'")).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it('normalizes the name to a single trimmed line', async () => {
      const response = await createProject(createRequest({ name: '  Take\n\tTwo  ' }), repo);

      expect(response.status).toBe(201);
      expect(storedNames()).toEqual([{ name: 'Take Two' }]);
    });

    // Rejections are thrown as HttpError rather than returned as a Response: the
    // route table owns the single { error, code } mapping, so a handler cannot
    // invent its own error envelope. route-dispatch.test.ts proves the status and
    // body a client actually receives.
    it('accepts a name of exactly the maximum length and rejects one character more', async () => {
      const atLimit = 'a'.repeat(MAX_PROJECT_NAME_LENGTH);
      expect((await createProject(createRequest({ name: atLimit }), repo)).status).toBe(201);

      await expect(
        createProject(createRequest({ name: 'b'.repeat(MAX_PROJECT_NAME_LENGTH + 1) }), repo),
      ).rejects.toThrowError(expect.objectContaining({ status: 400, code: 'invalid_project_name' }));
      expect(storedNames()).toEqual([{ name: atLimit }]);
    });

    it('refuses a name that is missing, blank, or invisible, and writes nothing', async () => {
      // U+200B is a zero-width space: it survives String.prototype.trim, so a
      // name made only of those reaches SQLite and trips the CHECK there instead
      // of being rejected here — unless the name is normalized, not merely trimmed.
      const bodies = [{}, { name: '' }, { name: '   ' }, { name: '​​' }, { name: 42 }, { name: null }];

      for (const body of bodies) {
        await expect(createProject(createRequest(body), repo), JSON.stringify(body)).rejects.toThrowError(
          expect.objectContaining({ status: 400, code: 'invalid_project_name' }),
        );
      }
      expect(storedNames()).toEqual([]);
    });

    it('accepts a padded name inside the raw bound, and refuses one past it before normalizing', async () => {
      // The raw bound is the only thing standing between this endpoint and being
      // asked to normalize an arbitrarily large string inside a Worker isolate.
      // Both cases below normalize to a 1-character name, so the check on the
      // NORMALIZED length cannot distinguish them — only the raw bound can, and
      // without it the second case is accepted and stored.
      const padded = (rawLength: number) => `${' '.repeat(rawLength - 1)}x`;

      expect((await createProject(createRequest({ name: padded(RAW_NAME_LENGTH_LIMIT) }), repo)).status).toBe(201);
      expect(storedNames()).toEqual([{ name: 'x' }]);

      await expect(
        createProject(createRequest({ name: padded(RAW_NAME_LENGTH_LIMIT + 1) }), repo),
      ).rejects.toThrowError(expect.objectContaining({ status: 400, code: 'invalid_project_name' }));
      expect(storedNames()).toEqual([{ name: 'x' }]);
    });

    it('refuses unknown fields rather than silently dropping them', async () => {
      await expect(
        createProject(createRequest({ name: 'Nocturne', lifecycleState: 'deleted' }), repo),
      ).rejects.toThrowError(expect.objectContaining({ status: 400, code: 'unknown_field' }));
      expect(storedNames()).toEqual([]);
    });

    it('refuses a malformed JSON body', async () => {
      await expect(createProject(createRequest('{"name":'), repo)).rejects.toThrowError(
        expect.objectContaining({ status: 400, code: 'invalid_json' }),
      );
      expect(storedNames()).toEqual([]);
    });
  });

  describe('listProjects', () => {
    it('answers an empty list before anything exists', async () => {
      const response = await listProjects(repo);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ projects: [] });
    });

    it('lists active projects most-recently-updated first', async () => {
      await createProject(createRequest({ name: 'Older' }), repo, clock('a', '2026-08-15T00:00:00.000Z'));
      await createProject(createRequest({ name: 'Newer' }), repo, clock('b', '2026-08-16T00:00:00.000Z'));

      const body = (await (await listProjects(repo)).json()) as { projects: Array<{ name: string }> };
      expect(body.projects.map((project) => project.name)).toEqual(['Newer', 'Older']);
    });

    it('omits soft-deleted projects', async () => {
      await createProject(createRequest({ name: 'Kept' }), repo, clock('keep', '2026-08-15T00:00:00.000Z'));
      await createProject(createRequest({ name: 'Gone' }), repo, clock('gone', '2026-08-16T00:00:00.000Z'));
      db.exec(
        "UPDATE twi_projects SET lifecycle_state = 'deleted', deleted_at = '2026-08-16T10:00:00.000Z' WHERE id = 'gone'",
      );

      const body = (await (await listProjects(repo)).json()) as { projects: Array<{ name: string }> };
      expect(body.projects.map((project) => project.name)).toEqual(['Kept']);
    });
  });

  describe('getProject', () => {
    it('returns the requested project', async () => {
      await createProject(createRequest({ name: 'Nocturne' }), repo, clock('proj-1', '2026-08-17T09:15:00.000Z'));

      const response = await getProject('proj-1', repo);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ project: { id: 'proj-1', name: 'Nocturne' } });
    });

    it('rejects an id that does not exist as a 404', async () => {
      await expect(getProject('missing', repo)).rejects.toThrowError(
        expect.objectContaining({ status: 404, code: 'not_found', message: 'project not found' }),
      );
    });

    it('refuses a soft-deleted project rather than serving it', async () => {
      await createProject(createRequest({ name: 'Gone' }), repo, clock('gone', '2026-08-16T00:00:00.000Z'));
      db.exec(
        "UPDATE twi_projects SET lifecycle_state = 'deleted', deleted_at = '2026-08-16T10:00:00.000Z' WHERE id = 'gone'",
      );

      await expect(getProject('gone', repo)).rejects.toThrowError(expect.objectContaining({ status: 404 }));
    });

    it('answers 404 rather than a repository validation fault when the id is blank', async () => {
      // The repository asserts a nonblank id and would surface a
      // TwiRepositoryValidationError, which the route table maps to a 500.
      await expect(getProject('   ', repo)).rejects.toThrowError(
        expect.objectContaining({ name: 'HttpError', status: 404 }),
      );
    });
  });
});
