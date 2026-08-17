import { toSingleLineText } from '../domain/text';

import { HttpError, json, parseJson } from './http';
import type { TwiRepository } from './repository';

/**
 * Project use cases for `/api/twi/*`.
 *
 * Each function owns one route's whole job — validate, call the repository, shape
 * the response — so the Pages Function stays a route table and nothing else.
 */

/** Longest project name accepted, after normalization. */
export const MAX_PROJECT_NAME_LENGTH = 120;

/**
 * Bound on the RAW value, before normalization. The slack is what lets a name
 * arrive padded with whitespace and still be accepted, while keeping a megabyte
 * of text from being normalized inside a Worker isolate first. Same shape as
 * `RAW_LENGTH_SLACK` in src/twi/domain/schemas.ts.
 *
 * Exported for its boundary test. It is not redundant with the check on the
 * normalized length: a value that is mostly padding normalizes to something
 * short, so only this bound decides how much text `toSingleLineText` is asked to
 * walk. Removing it changes no observable answer for any realistic name, which is
 * exactly why it needs a test naming the number.
 */
export const RAW_NAME_LENGTH_LIMIT = MAX_PROJECT_NAME_LENGTH * 2;

/**
 * Identity and time, injectable.
 *
 * Not for tidiness: the timestamp written here has to be exactly
 * `YYYY-MM-DDTHH:MM:SS.sssZ` or the row is refused by the migration's
 * strftime round-trip CHECK, and `updated_at` is advanced with `MAX()` over TEXT
 * downstream. A test that can pin the value is how that stays proven. It is
 * generated in JS, never by the database.
 */
export interface ProjectIdentityClock {
  newId(): string;
  now(): string;
}

export const systemIdentityClock: ProjectIdentityClock = {
  // Both minted in JS, never asked of SQLite: its clock emits no milliseconds and
  // separates date from time with a space, which the TWI tables reject outright.
  newId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

/**
 * Normalizes and validates a submitted project name.
 *
 * Rejection rather than truncation: a silently shortened name is data the owner
 * typed and cannot see was changed. Normalization rather than `trim()`: a name of
 * zero-width spaces survives trimming and would reach the
 * `twi_projects_name_text` CHECK as a 500 instead of a 400 here.
 */
export function parseProjectName(body: Record<string, unknown>): string {
  const unknownFields = Object.keys(body).filter((key) => key !== 'name');
  if (unknownFields.length > 0) {
    throw new HttpError(400, `unknown field: ${unknownFields.join(', ')}`, 'unknown_field');
  }

  const raw = body.name;
  const invalid = new HttpError(
    400,
    `name is required and must be 1-${MAX_PROJECT_NAME_LENGTH} characters`,
    'invalid_project_name',
  );
  if (typeof raw !== 'string' || raw.length > RAW_NAME_LENGTH_LIMIT) throw invalid;

  const name = toSingleLineText(raw);
  if (name.length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) throw invalid;
  return name;
}

export async function listProjects(repo: TwiRepository): Promise<Response> {
  return json({ projects: await repo.listProjects() });
}

export async function createProject(
  request: Request,
  repo: TwiRepository,
  clock: ProjectIdentityClock = systemIdentityClock,
): Promise<Response> {
  const name = parseProjectName(await parseJson(request));
  const project = await repo.createProject({ id: clock.newId(), name, now: clock.now() });
  return json({ project }, 201);
}

export async function getProject(projectId: string, repo: TwiRepository): Promise<Response> {
  // A blank id is a request for a project that cannot exist, not a server fault:
  // answered as 404 rather than letting the repository's nonblank assertion
  // surface as internal_error.
  const project = projectId.trim().length === 0 ? null : await repo.getProject(projectId);
  // Thrown, not returned: every failure in this API is shaped by the one mapping
  // in the route table, so `{ error, code }` cannot drift per handler.
  if (!project) throw new HttpError(404, 'project not found');
  return json({ project });
}
