// @vitest-environment node
/// <reference types="node" />
//
// SHARED-VECTOR PARITY: the schema and the repository boundary must reject the
// same set of timestamps.
//
// Two layers enforce the timestamp format and they were built independently:
//
//   * the SCHEMA, via `x IS strftime('%Y-%m-%dT%H:%M:%fZ', x)` round-trip CHECKs
//     in twi-migration-001-creation-core.sql
//   * the REPOSITORY BOUNDARY, via `isIsoUtcTimestamp` in ./assertions
//
// Testing them separately proves nothing about the seam: each can be green while
// they disagree, which is exactly what happened. SQLite's date parser accepts
// `HH` up to 24 and round-trips it verbatim for some dates, so the CHECK used to
// admit `2026-08-16T24:00:00.000Z` while the boundary rejected it. Nothing was
// broken in production because the repository is the only writer — but hour 24
// is the one shape that defeats the ordering the guard exists to protect. It is
// the same instant as the next day's `T00:xx`, and it sorts a whole day lower as
// TEXT, so `MAX(updated_at, ?)` ranks it under timestamps that are really
// earlier and the column can move backwards in real time while still looking
// monotonic.
//
// So this file drives ONE shared vector set through BOTH enforcers and asserts
// they return the same verdict, rather than asserting each one separately and
// hoping. Neither rule is transcribed here: the boundary is imported, and the
// CHECK expressions are lifted out of the migration text at runtime and handed
// to a real `node:sqlite` with the real migration loaded. A change to either
// side that is not matched on the other fails here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertNullableTimestamp, assertTimestamp, isIsoUtcTimestamp } from './assertions';
import { SqliteD1, readMigrationSql } from './repository.harness';

// ---------------------------------------------------------------------------
// Enforcer 1 — the schema, lifted from the migration rather than transcribed
// ---------------------------------------------------------------------------

interface IsoCheck {
  /** Constraint name, e.g. `twi_projects_updated_at_iso`. */
  readonly name: string;
  /** Guarded column, read back out of the expression's own `typeof(...)`. */
  readonly column: string;
  /** The CHECK expression text, exactly as the file has it. */
  readonly body: string;
}

const CONSTRAINT_HEAD_RE = /CONSTRAINT\s+(\w+_iso)\s+CHECK\s*\(/g;

/**
 * Every `CONSTRAINT <name>_iso CHECK ( ... )` in the migration, with the
 * expression body delimited by paren balance rather than by a regex — the
 * bodies contain nested parens, so a lazy `[^)]*` would truncate them and
 * silently test a shorter rule than the file enforces.
 */
function isoChecks(sql: string): IsoCheck[] {
  const found: IsoCheck[] = [];
  for (const head of sql.matchAll(CONSTRAINT_HEAD_RE)) {
    const start = (head.index ?? 0) + head[0].length;
    let depth = 1;
    let i = start;
    for (; i < sql.length && depth > 0; i += 1) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
    }
    const name = head[1];
    if (name === undefined) throw new Error('CONSTRAINT_HEAD_RE lost its capture group');
    if (depth !== 0) throw new Error(`unbalanced parens in ${name}`);
    const body = sql.slice(start, i - 1);
    // The guarded column is read back out of the expression's own typeof(...)
    // rather than parsed off the constraint name, which would have to guess
    // where the table prefix ends.
    const column = /typeof\((\w+)\)/.exec(body)?.[1];
    if (column === undefined) throw new Error(`${name} has no typeof() guard to read the column from`);
    found.push({ name, column, body });
  }
  return found;
}

const MIGRATION_SQL = readMigrationSql();
const ISO_CHECKS = isoChecks(MIGRATION_SQL);

/** One named CHECK, or a loud failure — never a silent `undefined`. */
function isoCheck(name: string): IsoCheck {
  const found = ISO_CHECKS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} is not among the migration's iso CHECKs`);
  return found;
}

const PROJECTS_CREATED_AT = isoCheck('twi_projects_created_at_iso');
const PROJECTS_UPDATED_AT = isoCheck('twi_projects_updated_at_iso');
const PROJECTS_DELETED_AT = isoCheck('twi_projects_deleted_at_iso');

/**
 * The conjunct this file exists to keep. Removing it reopens the hour-24 gap.
 * The operand alternative matches both the raw column name and the `$v` it is
 * rewritten to, so the same pattern serves the structural check and the mutation.
 */
const HOUR_24_CONJUNCT_RE = /\s*AND\s+substr\(\$?\w+, 12, 2\) <> '24'/g;

const withColumnBound = (check: IsoCheck): string =>
  check.body.replace(new RegExp(`\\b${check.column}\\b`, 'g'), '$v');

const shapeOf = (check: IsoCheck): string =>
  withColumnBound(check).replace(/\s+/g, ' ').trim();

/**
 * One database for every expression probe. It only ever evaluates `SELECT`, so
 * no test can leave state behind for the next one.
 */
const harness = new SqliteD1();
afterAll(() => harness.close());

/**
 * Compiles one CHECK expression into a predicate. `SELECT (<expr>)` evaluates
 * the same expression the constraint evaluates, which is what makes it possible
 * to probe tens of thousands of vectors — `twi_projects` has other constraints
 * and an INSERT cannot say which of them fired first. The two forms are tied
 * together by `real INSERT and UPDATE statements` below.
 */
function schemaPredicate(expression: string): (value: string) => boolean {
  const statement = harness.database.prepare(`SELECT (${expression}) AS accepted`);
  return (value: string) => statement.get({ v: value })?.accepted === 1;
}

// ---------------------------------------------------------------------------
// The shared vector set
// ---------------------------------------------------------------------------

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * Every vector the review's method demanded, named, so a failure says which
 * shape moved rather than printing a bare string. These are asserted
 * individually as well as swept, because "both enforcers agree" is also
 * satisfiable by both wrongly ACCEPTING something.
 */
const NAMED_VECTORS: ReadonlyArray<readonly [label: string, value: string, accepted: boolean]> = [
  ['the canonical shape', '2026-08-16T04:05:06.789Z', true],
  ['hour 24', '2026-08-16T24:00:00.000Z', false],
  ['hour 24 with minutes', '2026-08-16T24:30:00.000Z', false],
  ['hour 25', '2026-08-16T25:00:00.000Z', false],
  ['minute 60', '2026-08-16T00:60:00.000Z', false],
  ['second 60', '2026-08-16T00:00:60.000Z', false],
  ['0 fractional digits', '2026-08-16T00:00:00Z', false],
  ['1 fractional digit', '2026-08-16T00:00:00.0Z', false],
  ['3 fractional digits', '2026-08-16T00:00:00.000Z', true],
  ['6 fractional digits', '2026-08-16T00:00:00.000000Z', false],
  ['9 fractional digits', '2026-08-16T00:00:00.000000000Z', false],
  ["'+00:00' instead of 'Z'", '2026-08-16T00:00:00.000+00:00', false],
  ["lowercase 'z'", '2026-08-16T00:00:00.000z', false],
  ["a bare space instead of 'T'", '2026-08-16 00:00:00.000Z', false],
  ['year 0000', '0000-01-01T00:00:00.000Z', true],
  ['year 10000', '10000-01-01T00:00:00.000Z', false],
  ['the empty string', '', false],
];

/** Shapes that are not in the mandated list but have broken something before. */
const EXTRA_EDGE_VECTORS: readonly string[] = [
  ' ',
  'now',
  'not a date',
  '2026-08-16',
  '2026-08-16T00:00:00.00Z',
  '2026-08-16T00:00:00.0000Z',
  '2026-08-16T00:00:00.000',
  '2026-08-16T00:00:00.000+0000',
  '2026-08-16T00:00:00.000+01:00',
  '2026-08-16T00:00:00.000-00:00',
  '2026-08-16t00:00:00.000Z',
  '2026-8-16T00:00:00.000Z',
  '2026-08-6T00:00:00.000Z',
  '2026-00-16T00:00:00.000Z',
  '2026-13-16T00:00:00.000Z',
  '2026-08-00T00:00:00.000Z',
  '2026-08-32T00:00:00.000Z',
  '2026-02-30T00:00:00.000Z',
  '2024-02-29T00:00:00.000Z',
  '2026-02-29T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
  '-0001-01-01T00:00:00.000Z',
  ' 2026-08-16T00:00:00.000Z',
  '2026-08-16T00:00:00.000Z ',
  '2026-08-16T00:00:00.000Z\n',
  '2026-08-16T00:00:00.000Z\u0000',
  '2026-08-16T00:00:00.000Z+1 day',
  '2461269.5',
  '1755302400',
  // Every hour 00-24 at a date the round-trip preserves, so the boundary between
  // the last legal hour and the illegal one is probed at full resolution.
  ...Array.from({ length: 25 }, (_, h) => `2026-08-16T${pad(h, 2)}:30:00.000Z`),
];

/**
 * The structured sweep. Wide on purpose: an asymmetry found by hand is one
 * asymmetry, and the point of this file is that there are none left anywhere in
 * the space either layer can be handed.
 */
function buildVectors(): string[] {
  const vectors = new Set<string>();
  const day = '2026-08-16';

  for (let hour = 0; hour < 100; hour += 1) {
    for (let minute = 0; minute < 100; minute += 1) {
      vectors.add(`${day}T${pad(hour, 2)}:${pad(minute, 2)}:00.000Z`);
    }
  }
  for (let second = 0; second < 100; second += 1) vectors.add(`${day}T00:00:${pad(second, 2)}.000Z`);
  for (let ms = 0; ms < 1000; ms += 1) vectors.add(`${day}T00:00:00.${pad(ms, 3)}Z`);
  for (const year of [1900, 2000, 2024, 2026]) {
    for (let month = 0; month < 100; month += 1) {
      for (let date = 0; date < 100; date += 1) {
        vectors.add(`${year}-${pad(month, 2)}-${pad(date, 2)}T00:00:00.000Z`);
      }
    }
  }
  // Every year the 4-digit shape can express, plus every year's Feb 29 — which
  // is the leap rule itself, the place a hand-rolled parser and a real one are
  // most likely to part company.
  for (let year = 0; year < 10000; year += 1) {
    vectors.add(`${pad(year, 4)}-08-16T00:00:00.000Z`);
    vectors.add(`${pad(year, 4)}-02-29T00:00:00.000Z`);
  }

  for (const [, value] of NAMED_VECTORS) vectors.add(value);
  for (const value of EXTRA_EDGE_VECTORS) vectors.add(value);

  return [...vectors];
}

const VECTORS = buildVectors();
const CURATED = [...new Set([...NAMED_VECTORS.map(([, value]) => value), ...EXTRA_EDGE_VECTORS])];

interface Divergence {
  readonly value: string;
  readonly schema: boolean;
  readonly boundary: boolean;
}

const describeDivergences = (rows: readonly Divergence[]): string[] =>
  rows.map((row) => `${JSON.stringify(row.value)} schema=${row.schema} boundary=${row.boundary}`);

/** Every vector on which the two enforcers disagree, in both directions. */
function divergences(schemaAccepts: (value: string) => boolean, values: readonly string[]): {
  schemaLaxer: Divergence[];
  boundaryLaxer: Divergence[];
} {
  const schemaLaxer: Divergence[] = [];
  const boundaryLaxer: Divergence[] = [];
  for (const value of values) {
    const schema = schemaAccepts(value);
    const boundary = isIsoUtcTimestamp(value);
    if (schema === boundary) continue;
    (schema ? schemaLaxer : boundaryLaxer).push({ value, schema, boundary });
  }
  return { schemaLaxer, boundaryLaxer };
}

const hourFieldOf = (value: string): string => value.slice(11, 13);

/** The thrown message, or null if the call succeeded. */
function messageOf(call: () => void): string | null {
  try {
    call();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------

describe('timestamp enforcement is the same rule in the schema and at the repository boundary', () => {
  it('the migration guards 12 timestamp columns with 2 shapes of the same rule', () => {
    // Hardcoded on purpose. A 13th timestamp column, or a second spelling of the
    // rule, has to come here and be swept rather than sliding in unguarded.
    expect(ISO_CHECKS.map((check) => check.name)).toEqual([
      'twi_projects_deleted_at_iso',
      'twi_projects_created_at_iso',
      'twi_projects_updated_at_iso',
      'twi_project_revisions_created_at_iso',
      'twi_generation_specs_created_at_iso',
      'twi_jobs_created_at_iso',
      'twi_jobs_updated_at_iso',
      'twi_jobs_finished_at_iso',
      'twi_job_events_created_at_iso',
      'twi_assets_created_at_iso',
      'twi_assets_deleted_at_iso',
      'twi_cost_events_created_at_iso',
    ]);

    const shapes = new Map<string, number>();
    for (const check of ISO_CHECKS) {
      const shape = shapeOf(check);
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    }
    expect([...shapes.entries()].sort((a, b) => b[1] - a[1])).toEqual([
      [
        "typeof($v) = 'text' AND $v IS strftime('%Y-%m-%dT%H:%M:%fZ', $v) AND substr($v, 12, 2) <> '24'",
        9,
      ],
      [
        "$v IS NULL OR ( typeof($v) = 'text' AND $v IS strftime('%Y-%m-%dT%H:%M:%fZ', $v) AND substr($v, 12, 2) <> '24' )",
        3,
      ],
    ]);

    const missing = ISO_CHECKS.filter((check) => !new RegExp(HOUR_24_CONJUNCT_RE.source).test(check.body));
    expect(missing.map((check) => check.name), 'these CHECKs would accept hour 24').toEqual([]);
  });

  it(
    'the two enforcers return the same verdict on every vector in the shared set',
    () => {
      expect(VECTORS.length).toBeGreaterThanOrEqual(70_000);

      const { schemaLaxer, boundaryLaxer } = divergences(schemaPredicate(withColumnBound(PROJECTS_CREATED_AT)), VECTORS);

      // The direction that would be a RUNTIME FAILURE: the repository builds a
      // value the schema then refuses, i.e. a write that cannot succeed.
      expect(
        describeDivergences(boundaryLaxer),
        'the boundary would accept these and the schema would reject the write',
      ).toEqual([]);

      // The direction that is merely a latent hazard: the schema admits shapes
      // no current writer produces. Also empty, which is what parity means.
      expect(
        describeDivergences(schemaLaxer),
        'the schema is laxer than the boundary on these',
      ).toEqual([]);
    },
    60_000,
  );

  it('every one of the 12 CHECK expressions agrees with the boundary on the curated edges', () => {
    const offenders: string[] = [];
    for (const check of ISO_CHECKS) {
      const accepts = schemaPredicate(withColumnBound(check));
      const { schemaLaxer, boundaryLaxer } = divergences(accepts, CURATED);
      for (const row of [...schemaLaxer, ...boundaryLaxer]) {
        offenders.push(`${check.name}: ${JSON.stringify(row.value)} schema=${row.schema} boundary=${row.boundary}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('records the verdict of every mandated edge vector, so agreeing on the WRONG answer fails too', () => {
    const accepts = schemaPredicate(withColumnBound(PROJECTS_CREATED_AT));
    const verdicts = NAMED_VECTORS.map(([label, value]) => `${label}: ${accepts(value) ? 'accepted' : 'rejected'}`);
    expect(verdicts).toEqual(
      NAMED_VECTORS.map(([label, , accepted]) => `${label}: ${accepted ? 'accepted' : 'rejected'}`),
    );
    // Same expectations, restated against the boundary, so neither side can move
    // alone without failing this.
    expect(NAMED_VECTORS.map(([label, value]) => `${label}: ${isIsoUtcTimestamp(value) ? 'accepted' : 'rejected'}`)).toEqual(
      NAMED_VECTORS.map(([label, , accepted]) => `${label}: ${accepted ? 'accepted' : 'rejected'}`),
    );
  });

  it('the exported assertions agree with the predicate the sweep uses', () => {
    for (const [label, value, accepted] of NAMED_VECTORS) {
      const message = messageOf(() => assertTimestamp('probe', value));
      expect(message === null, `assertTimestamp must ${accepted ? 'accept' : 'reject'} ${label}`).toBe(accepted);
    }
    // NULL is the one value the nullable CHECKs accept and the sweep never sends.
    expect(() => assertNullableTimestamp('probe', null)).not.toThrow();
    expect(schemaPredicate(withColumnBound(PROJECTS_DELETED_AT))('')).toBe(false);
  });

  it('the hour-24 conjunct is exactly what closes the gap, and its removal is caught', () => {
    // Built-in mutation. Strip the conjunct from the real expression and the
    // sweep must fail — naming hour 24 and nothing else.
    const relaxed = withColumnBound(PROJECTS_CREATED_AT).replace(HOUR_24_CONJUNCT_RE, '');
    expect(relaxed).not.toContain('substr');

    const { schemaLaxer, boundaryLaxer } = divergences(schemaPredicate(relaxed), VECTORS);
    expect(boundaryLaxer).toEqual([]);
    expect(schemaLaxer.length, 'without the conjunct the schema must be laxer somewhere').toBeGreaterThan(0);

    const notHour24 = schemaLaxer.filter((row) => hourFieldOf(row.value) !== '24');
    expect(
      describeDivergences(notHour24),
      'hour 24 is the whole gap — anything else here is a second, unfixed asymmetry',
    ).toEqual([]);
    expect(schemaLaxer.some((row) => row.value === '2026-08-16T24:00:00.000Z')).toBe(true);
  }, 60_000);

  it('hour 24 is the shape that inverts MAX(updated_at, ?), which is why it cannot be stored', () => {
    // Both arguments are the same instant to within 15 minutes of each other,
    // and MAX picks the one that is chronologically EARLIER.
    const later = '2026-08-16T24:30:00.000Z'; // = 2026-08-17T00:30Z
    const earlier = '2026-08-17T00:15:00.000Z';
    expect(harness.value<string>('SELECT MAX(?, ?) AS m', later, earlier)).toBe(earlier);
    // For contrast, the correctly shaped spelling of the same instant sorts right.
    expect(harness.value<string>('SELECT MAX(?, ?) AS m', '2026-08-17T00:30:00.000Z', earlier)).toBe(
      '2026-08-17T00:30:00.000Z',
    );
    expect(isIsoUtcTimestamp(later)).toBe(false);
    expect(schemaPredicate(withColumnBound(PROJECTS_UPDATED_AT))(later)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expression form ties back to constraint form
// ---------------------------------------------------------------------------

const T0 = '2026-08-16T00:00:00.000Z';
const HOUR_24 = '2026-08-16T24:00:00.000Z';

/**
 * Every column the 12 CHECKs guard, reached through a real statement. The sweep
 * above evaluates the expressions, which is the only way to probe 70k vectors —
 * this proves the expression form and the constraint form are the same rule, at
 * every column, by making SQLite name the constraint it rejected on.
 */
const DML: ReadonlyArray<readonly [constraint: string, sql: string, bindings: readonly string[]]> = [
  [
    'twi_projects_created_at_iso',
    `INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-c','P',?,?)`,
    [HOUR_24, HOUR_24],
  ],
  [
    'twi_projects_updated_at_iso',
    `INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-u','P',?,?)`,
    [T0, HOUR_24],
  ],
  [
    'twi_projects_deleted_at_iso',
    `INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
     VALUES ('p-d','P','deleted',?,?,?)`,
    [HOUR_24, T0, T0],
  ],
  [
    'twi_project_revisions_created_at_iso',
    `INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
     VALUES ('r-1','p-seed',NULL,'twi/p-seed/revisions/r-1.json','sha','summary',?)`,
    [HOUR_24],
  ],
  [
    'twi_generation_specs_created_at_iso',
    `INSERT INTO twi_generation_specs (id,project_id,spec_json,spec_sha256,rights_assertion_version,created_at)
     VALUES ('s-2','p-seed','{}','sha','v1',?)`,
    [HOUR_24],
  ],
  [
    'twi_jobs_created_at_iso',
    `INSERT INTO twi_jobs (id,project_id,spec_id,kind,status,idempotency_key,created_at,updated_at)
     VALUES ('j-c','p-seed','s-seed','full-song','queued','k-c',?,?)`,
    [HOUR_24, HOUR_24],
  ],
  [
    'twi_jobs_updated_at_iso',
    `INSERT INTO twi_jobs (id,project_id,spec_id,kind,status,idempotency_key,created_at,updated_at)
     VALUES ('j-u','p-seed','s-seed','full-song','queued','k-u',?,?)`,
    [T0, HOUR_24],
  ],
  ['twi_jobs_finished_at_iso', `UPDATE twi_jobs SET finished_at=? WHERE id='j-seed'`, [HOUR_24]],
  [
    'twi_job_events_created_at_iso',
    `INSERT INTO twi_job_events (job_id,event_key,to_status,created_at) VALUES ('j-seed','e-1','queued',?)`,
    [HOUR_24],
  ],
  [
    'twi_assets_created_at_iso',
    `INSERT INTO twi_assets (id,project_id,kind,r2_key,content_type,bytes,sha256,created_at)
     VALUES ('a-c','p-seed','image-reference','twi/p-seed/a-c','audio/wav',0,'sha',?)`,
    [HOUR_24],
  ],
  [
    'twi_assets_deleted_at_iso',
    `INSERT INTO twi_assets (id,project_id,kind,r2_key,content_type,bytes,sha256,lifecycle_state,created_at,deleted_at)
     VALUES ('a-d','p-seed','image-reference','twi/p-seed/a-d','audio/wav',0,'sha','deleted',?,?)`,
    [T0, HOUR_24],
  ],
  [
    'twi_cost_events_created_at_iso',
    `INSERT INTO twi_cost_events (job_id,idempotency_key,category,amount_usd,created_at)
     VALUES ('j-seed','c-1','provider',1.0,?)`,
    [HOUR_24],
  ],
];

describe('real INSERT and UPDATE statements reject hour 24 at every guarded column', () => {
  let db: SqliteD1;

  beforeAll(() => {
    db = new SqliteD1();
    db.exec(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-seed','Seed',?,?)`, T0, T0);
    db.exec(
      `INSERT INTO twi_generation_specs (id,project_id,spec_json,spec_sha256,rights_assertion_version,created_at)
       VALUES ('s-seed','p-seed','{}','sha','v1',?)`,
      T0,
    );
    db.exec(
      `INSERT INTO twi_jobs (id,project_id,spec_id,kind,status,idempotency_key,created_at,updated_at)
       VALUES ('j-seed','p-seed','s-seed','full-song','queued','k-seed',?,?)`,
      T0,
      T0,
    );
  });

  afterAll(() => db.close());

  it('covers the same 12 constraints the migration declares', () => {
    expect(DML.map(([constraint]) => constraint).sort()).toEqual(
      ISO_CHECKS.map((check) => check.name).sort(),
    );
  });

  for (const [constraint, sql, bindings] of DML) {
    it(`${constraint} rejects ${HOUR_24}`, () => {
      // The exact engine message, not just "it threw". A bare throw also passes
      // when an unrelated NOT NULL or FOREIGN KEY fires first and the timestamp
      // is never examined at all.
      expect(messageOf(() => db.exec(sql, ...bindings))).toBe(`CHECK constraint failed: ${constraint}`);
    });
  }

  it('still accepts the canonical shape at the same columns', () => {
    for (const [constraint, sql, bindings] of DML) {
      const good = bindings.map((value) => (value === HOUR_24 ? '2026-08-16T12:00:00.000Z' : value));
      expect(messageOf(() => db.exec(sql, ...good)), `${constraint} rejected a canonical timestamp`).toBeNull();
    }
  });
});
