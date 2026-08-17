// @vitest-environment node
/// <reference types="node" />
//
// `spec_sha256` is the fingerprint the paid submit path replays on: a mismatch
// under a used idempotency key is read as "a different request" and the replay is
// refused. So "the digest describes the row it sits in" is a money-path invariant,
// and it gets its own file rather than a corner of the behavioural suite.
//
// Two deliberate choices here:
//
//   * A REAL database (the same `node:sqlite` harness and the same migration as
//     repository-sqlite.test.ts). A fake that only records SQL cannot tell you what
//     bytes were persisted, and the persisted bytes are the whole subject.
//   * node:crypto for the expected digests, not the production hash. An
//     independent SHA-256 has to agree, so these assertions cannot be satisfied by
//     a hash function that is merely self-consistent.

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeGenerationSpec } from '../domain/prompt';
import { draft } from '../domain/spec.fixture';

import {
  D1TwiRepository,
  specSha256,
  type CreateEstimatedJobInput,
  type SaveSpecInput,
} from './repository';
import { SqliteD1 } from './repository.harness';

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const specInput = (overrides: Partial<SaveSpecInput> = {}): SaveSpecInput => ({
  id: 'spec-1',
  projectId: 'project-1',
  specJson: JSON.stringify(normalizeGenerationSpec(draft)),
  rightsAssertionVersion: '2026-08-16',
  createdAt: '2026-08-16T02:00:00.000Z',
  ...overrides,
});

const jobInput = (specId: string): CreateEstimatedJobInput => ({
  id: 'job-created',
  projectId: 'project-1',
  specId,
  idempotencyKey: 'submission-created',
  estimateJson: '{"total":1}',
  estimateAmountUsd: 1,
  provider: 'google',
  model: 'lyria-3-pro-preview',
  eventKey: 'job-created:estimated',
  eventDetailJson: '{}',
  costIdempotencyKey: 'job-created:estimate',
  costDetailJson: '{}',
  now: '2026-08-16T03:00:00.000Z',
});

/** Same document, every key order reversed at every level. */
const reverseKeyOrder = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseKeyOrder(child)]),
  );
};

describe('stored spec fingerprint', () => {
  let db: SqliteD1;
  let repository: D1TwiRepository;

  const storedSpec = (specId: string): { json: string; digest: string } => ({
    json: db.value<string>('SELECT spec_json FROM twi_generation_specs WHERE id = ?', specId),
    digest: db.value<string>('SELECT spec_sha256 FROM twi_generation_specs WHERE id = ?', specId),
  });

  beforeEach(() => {
    db = new SqliteD1();
    repository = new D1TwiRepository({ DB: db });
    db.exec(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
       VALUES ('project-1', 'Night Signal', 'active', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
    );
  });

  afterEach(() => db.close());

  it('digests the document it stored, not the document it was handed', async () => {
    // The caller hands over the domain-normalised spec, which is in schema order.
    // The column is written in key-sorted canonical order. Those are different byte
    // strings, which is exactly how the digest used to end up describing neither
    // more nor less than a document nobody had stored.
    const input = specInput({ id: 'spec-fingerprint' });
    const saved = await repository.saveSpec(input);
    const row = storedSpec('spec-fingerprint');

    // Guard the premise: were these ever the same bytes, the assertions below would
    // pass for a reason unrelated to the invariant.
    expect(row.json).not.toBe(input.specJson);
    expect(row.digest).toBe(sha256(row.json));
    expect(saved.specSha256).toBe(sha256(row.json));
    expect(JSON.stringify(saved.spec)).toBe(row.json);
  });

  it('serves the replay a correct caller asks for instead of crying collision', async () => {
    // The end-to-end consequence, reproduced: a caller looking its job up by the
    // digest of the stored document was told "this is a different request" about
    // the very job it had just created.
    const input = specInput({ id: 'spec-replay' });
    const saved = await repository.saveSpec(input);
    await repository.createEstimatedJob(jobInput('spec-replay'));
    const storedDigest = sha256(storedSpec('spec-replay').json);

    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-1',
        idempotencyKey: 'submission-created',
        specSha256: storedDigest,
      }),
    ).resolves.toMatchObject({ id: 'job-created', specSha256: storedDigest });

    // And `specSha256()` — the value the submit path must look up with, computed
    // before any row exists — agrees with the stored one, including for a
    // cosmetically different retry of the same submission. A reordered resubmission
    // replays rather than charging twice.
    await expect(specSha256(input.specJson)).resolves.toBe(storedDigest);
    const reordered = JSON.stringify(reverseKeyOrder(JSON.parse(input.specJson)));
    expect(reordered).not.toBe(input.specJson);
    await expect(specSha256(reordered)).resolves.toBe(saved.specSha256);
  });

  it('cannot be handed a digest to store', async () => {
    // Compile-time half of the guard: `SaveSpecInput` has no digest field, so the
    // marked line must not typecheck. Reintroduce the field and the suppression
    // goes unused, which fails `npm run typecheck:twi` right here — the divergence
    // cannot come back quietly.
    const rogue: SaveSpecInput = {
      ...specInput({ id: 'spec-rogue', specJson: '{"z":1,"a":2}' }),
      // @ts-expect-error - a caller must not be able to supply the stored digest
      specSha256: 'f'.repeat(64),
    };

    // Runtime half: a digest smuggled past the compiler is ignored outright. What
    // lands in the row is still the digest of the row's own bytes.
    const saved = await repository.saveSpec(rogue);
    const row = storedSpec('spec-rogue');
    expect(row.json).toBe('{"a":2,"z":1}');
    expect(row.digest).toBe(sha256('{"a":2,"z":1}'));
    expect(saved.specSha256).toBe(sha256('{"a":2,"z":1}'));
  });
});
