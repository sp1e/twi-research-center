/**
 * The raw pre-normalization bounds — pinned to the RAW bound, not to "oversized input is
 * rejected".
 *
 * `RAW_LENGTH_SLACK` and `RAW_ENTRY_SLACK` (schemas.ts:11-12) are applied at four sites:
 * `singleLine` (:21), `lyricText` (:28), and both stages of `normalizedList` — per-item
 * length (:33) and entry count (:34). They are NOT length validation; the `.pipe()` caps
 * already do that on the normalized value. They exist so a client cannot make a Worker
 * isolate trim, NFC-normalize and Set-hash megabytes before the isolate decides to say no.
 *
 * That distinction is exactly what makes them hard to test and why they were shadowed for
 * several rounds: an oversized payload is rejected either way, both routes raise `too_big`,
 * and a test asserting "a 5,000,000-character value is rejected" therefore PASSES with the
 * raw bound deleted. Three independent mechanisms are used here instead, none of them
 * wall-clock timing:
 *
 *   1. `maximum` in the ZodError. The raw bound reports `declaredMax * 2`; the normalized
 *      cap reports `declaredMax`. Both numbers are written out as literals below and never
 *      derived from the constants, because a test that imported them would move with a
 *      mutation to them and pin nothing. A single issue also proves the pipeline aborted at
 *      stage one — had the transform run, the normalized cap would have added its own.
 *   2. The acceptance flip. Every oversized payload here is paired with its own normalized
 *      image, which the schema ACCEPTS. Nothing downstream of the transform can be what
 *      rejected the payload, so the rejection provably happened before the expensive work.
 *      Delete the raw bound and these inputs are accepted — a much louder failure than a
 *      changed error code.
 *   3. The zod contract the guard rests on: a stage-one failure must not run the transform.
 *      Pinned with a live call counter on the same three-stage composition, so a future zod
 *      that stopped short-circuiting turns the guard into a no-op and goes red HERE rather
 *      than silently.
 *
 * Inputs are built with repeat() and are sized to the bound (tens of thousands of characters
 * at most, not millions): the boundary is what carries the information, and the suite runs
 * in CI.
 */
import { expect, test } from 'vitest';
import { z } from 'zod';
import { normalizeGenerationSpec } from './prompt';
import { generationSpecObject } from './schemas';
import { draft } from './spec.fixture';

type SpecPatch = Record<string, unknown>;
type SetField = (value: unknown) => SpecPatch;

interface RawBoundSite {
  /** Dotted field path. Doubles as the drift-guard key. */
  readonly field: string;
  readonly bound: 'per-value length' | 'per-item length' | 'entry count';
  readonly site: string;
  readonly issueType: 'string' | 'array';
  readonly issuePath: string;
  /** `declaredLimit * 2`, written out as a literal at the call site. */
  readonly rawLimit: number;
  readonly declaredLimit: number;
  /** Legitimately padded, exactly at the raw limit: the slack's documented purpose. */
  readonly atRawLimit: unknown;
  /** One unit over the raw limit, and legal once normalized. */
  readonly overRawLimit: unknown;
  /** The normalized image of `overRawLimit`. Accepted, by construction. */
  readonly normalizedImage: unknown;
  /** Inside the raw limit, over the normalized cap: the OTHER bound must fire. */
  readonly overNormalizedOnly: unknown;
  readonly set: SetField;
}

const padded = (content: number, whitespace: number): string =>
  `${'a'.repeat(content)}${' '.repeat(whitespace)}`;

const duplicates = (count: number): string[] => Array.from({ length: count }, () => 'dup');

const distinct = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => `entry-${index}`);

const scalarSite = (field: string, site: string, declared: number, set: SetField): RawBoundSite => ({
  field,
  bound: 'per-value length',
  site,
  issueType: 'string',
  issuePath: field,
  declaredLimit: declared,
  rawLimit: declared * 2,
  atRawLimit: padded(declared, declared),
  overRawLimit: `a${' '.repeat(declared * 2)}`,
  normalizedImage: 'a',
  overNormalizedOnly: 'a'.repeat(declared + 1),
  set,
});

const itemSite = (field: string, site: string, declared: number, set: SetField): RawBoundSite => ({
  field,
  bound: 'per-item length',
  site,
  issueType: 'string',
  issuePath: `${field}.0`,
  declaredLimit: declared,
  rawLimit: declared * 2,
  atRawLimit: [padded(declared, declared)],
  overRawLimit: [`a${' '.repeat(declared * 2)}`],
  normalizedImage: ['a'],
  overNormalizedOnly: ['a'.repeat(declared + 1)],
  set,
});

const entrySite = (field: string, site: string, declared: number, set: SetField): RawBoundSite => ({
  field,
  bound: 'entry count',
  site,
  issueType: 'array',
  issuePath: field,
  declaredLimit: declared,
  rawLimit: declared * 2,
  // Duplicates on purpose: they are what the normalized cap cannot catch, because
  // cleanList collapses them to one entry and the piped .max() then sees nothing wrong.
  atRawLimit: duplicates(declared * 2),
  overRawLimit: duplicates(declared * 2 + 1),
  normalizedImage: ['dup'],
  overNormalizedOnly: distinct(declared + 1),
  set,
});

const intentField = (key: string): SetField => (value) => ({ intent: { ...draft.intent, [key]: value } });
const compositionField = (key: string): SetField => (value) => ({ composition: { ...draft.composition, [key]: value } });
const soundField = (key: string): SetField => (value) => ({ sound: { ...draft.sound, [key]: value } });
const performanceField = (key: string): SetField => (value) => ({ performance: { ...draft.performance, [key]: value } });

/** Every application of the two slack constants, with the declared cap it is derived from. */
const SITES: readonly RawBoundSite[] = [
  scalarSite('intent.purpose', 'schemas.ts:21', 160, intentField('purpose')),
  scalarSite('intent.narrative', 'schemas.ts:21', 4_000, intentField('narrative')),
  scalarSite('composition.key', 'schemas.ts:21', 64, compositionField('key')),
  scalarSite('composition.meter', 'schemas.ts:21', 32, compositionField('meter')),
  scalarSite('composition.arrangement', 'schemas.ts:21', 2_000, compositionField('arrangement')),
  scalarSite('performance.vocalRange', 'schemas.ts:21', 100, performanceField('vocalRange')),
  scalarSite('performance.timbre', 'schemas.ts:21', 300, performanceField('timbre')),
  scalarSite('performance.delivery', 'schemas.ts:21', 300, performanceField('delivery')),
  scalarSite('composition.lyrics', 'schemas.ts:28', 16_000, compositionField('lyrics')),
  itemSite('intent.mood', 'schemas.ts:33', 80, intentField('mood')),
  itemSite('composition.sections', 'schemas.ts:33', 100, compositionField('sections')),
  itemSite('sound.styles', 'schemas.ts:33', 100, soundField('styles')),
  itemSite('sound.exclusions', 'schemas.ts:33', 160, soundField('exclusions')),
  entrySite('intent.mood', 'schemas.ts:34', 16, intentField('mood')),
  entrySite('composition.sections', 'schemas.ts:34', 64, compositionField('sections')),
  entrySite('sound.styles', 'schemas.ts:34', 32, soundField('styles')),
  entrySite('sound.exclusions', 'schemas.ts:34', 32, soundField('exclusions')),
];

const accepts = (patch: SpecPatch): void => {
  expect(() => normalizeGenerationSpec({ ...draft, ...patch })).not.toThrow();
};

const rejectionIssues = (patch: SpecPatch): z.ZodIssue[] => {
  try {
    normalizeGenerationSpec({ ...draft, ...patch });
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues;
    throw error;
  }
  throw new Error('expected this payload to be rejected at the raw bound, but the schema accepted it');
};

/**
 * The one issue the rejection produced. More than one would mean the transform ran and the
 * normalized stage contributed as well, i.e. the pipeline did NOT stop at the raw bound.
 */
const soleIssue = (patch: SpecPatch): z.ZodIssue => {
  const found = rejectionIssues(patch);
  expect(found.map((issue) => `${issue.code} at ${issue.path.join('.')}`)).toHaveLength(1);
  const [issue] = found;
  if (!issue) throw new Error('unreachable: length was just asserted');
  return issue;
};

/** Which bound fired, in comparable form. `maximum` is the discriminator. */
const fingerprint = (issue: z.ZodIssue) => ({
  code: issue.code,
  type: issue.code === 'too_big' ? issue.type : undefined,
  maximum: issue.code === 'too_big' ? Number(issue.maximum) : undefined,
  path: issue.path.join('.'),
});

test('a stage-one rejection short-circuits the transform — the property the raw bound rests on', () => {
  let transformRuns = 0;
  // The same three-stage composition singleLine/lyricText use: raw cap, transform, piped cap.
  const guarded = z
    .string()
    .max(4)
    .transform((value) => {
      transformRuns += 1;
      return value.trim();
    })
    .pipe(z.string().max(2));

  expect(() => guarded.parse('x'.repeat(5))).toThrow(z.ZodError);
  expect(transformRuns).toBe(0);

  // One character less: the raw cap admits it, so the transform DOES run and the piped cap
  // is what rejects. Both halves are needed — the counter has to be able to move.
  expect(() => guarded.parse('xxxx')).toThrow(z.ZodError);
  expect(transformRuns).toBe(1);

  expect(guarded.parse('  x ')).toBe('x');
  expect(transformRuns).toBe(2);
});

test('the same short-circuit holds for the array bound — this is what skips the Set-hashing', () => {
  let transformRuns = 0;
  const guarded = z
    .array(z.string())
    .max(4)
    .transform((items) => {
      transformRuns += 1;
      return [...new Set(items)];
    })
    .pipe(z.array(z.string()).max(2));

  expect(() => guarded.parse(duplicates(5))).toThrow(z.ZodError);
  expect(transformRuns).toBe(0);

  expect(guarded.parse(duplicates(4))).toEqual(['dup']);
  expect(transformRuns).toBe(1);
});

test.each(SITES)(
  '$field ($bound, $site): one unit over the raw limit is rejected BY THE RAW BOUND',
  (site) => {
    expect(fingerprint(soleIssue(site.set(site.overRawLimit)))).toEqual({
      code: 'too_big',
      type: site.issueType,
      maximum: site.rawLimit,
      path: site.issuePath,
    });
  },
);

test.each(SITES)(
  '$field ($bound, $site): the normalized image of that payload is accepted, so only the raw bound can have rejected it',
  (site) => {
    accepts(site.set(site.normalizedImage));
  },
);

test.each(SITES)(
  '$field ($bound, $site): the slack admits a legitimately padded payload of exactly the raw limit',
  (site) => {
    accepts(site.set(site.atRawLimit));
  },
);

test.each(SITES)(
  '$field ($bound, $site): the normalized cap is a separate bound and reports its own, lower limit',
  (site) => {
    expect(fingerprint(soleIssue(site.set(site.overNormalizedOnly)))).toEqual({
      code: 'too_big',
      type: site.issueType,
      maximum: site.declaredLimit,
      path: site.issuePath,
    });
  },
);

/**
 * Fields that legitimately carry no raw slack bound, with the reason. `imageAssetIds` is the
 * only array without one and that is correct: it has no transform, so there is no
 * pre-normalization work to guard — `z.array(uuid).max(10)` already bounds the request.
 */
const UNBOUNDED_BY_DESIGN = new Set([
  'intent.durationSeconds',
  'intent.instrumental',
  'composition.bpm',
  'sound.novelty',
  'sound.imageAssetIds',
  'performance.mode',
  'rightsAccepted',
]);

test('every field in the spec is either covered above or listed as unbounded by design', () => {
  const leaves = [
    'rightsAccepted',
    ...Object.keys(generationSpecObject.shape.intent.shape).map((key) => `intent.${key}`),
    ...Object.keys(generationSpecObject.shape.composition.shape).map((key) => `composition.${key}`),
    ...Object.keys(generationSpecObject.shape.sound.shape).map((key) => `sound.${key}`),
    ...Object.keys(generationSpecObject.shape.performance.shape).map((key) => `performance.${key}`),
  ];
  const covered = new Set(SITES.map((site) => site.field));
  expect(leaves.filter((leaf) => !covered.has(leaf) && !UNBOUNDED_BY_DESIGN.has(leaf))).toEqual([]);
  // And the reverse: a field removed from the schema must not keep a stale case here.
  expect([...covered].filter((field) => !leaves.includes(field))).toEqual([]);
});
