/**
 * WHERE the raw entry-count bound sits — not merely that it exists.
 *
 * raw-bounds.test.ts pins that an over-count array is rejected and which bound
 * reported it. What it cannot see is WHEN. Measured on zod 3.25.76,
 * `z.array(element).max(n)` records its `too_big`, marks the result dirty, and THEN
 * still maps `element` over every entry: a 100 000-entry payload cost 100 000 element
 * parses inside the Worker isolate before the isolate said no. The guard skipped the
 * `.transform()` — the trim + NFC + Set-hash, the expensive half — but not the
 * per-element parse. Every assertion in raw-bounds.test.ts passes either way, because
 * the rejection OUTCOME is identical; only the cost differs. That is why the defect
 * survived a round of mutation testing that scored 8/8 on the same bounds.
 *
 * These tests measure the cost. The mechanism is a live counter — the same technique
 * raw-bounds.test.ts uses on the transform, moved to the elements. The payload is a
 * real array (`Array.isArray` true, honest `length`) whose every index is an accessor
 * property, so each element read is observable. That count IS the element-parse count
 * rather than a proxy for it: zod's array stage reads the elements in exactly one
 * place, the `[...ctx.data].map((item, i) => element._parseSync(...))` which is the
 * element-parse loop itself (zod 3.25.76, v3/types.js). No wall-clock timing anywhere,
 * and the counter is proved able to move on every field before it is trusted at zero.
 *
 * Move the bound back beside the element schema and the outcome does not change by one
 * character — the counts go from 0 to one-per-entry, and nothing else in the suite
 * notices. That mutation is exactly what this file is here to kill.
 */
import { expect, test } from 'vitest';
import { z } from 'zod';
import { normalizeGenerationSpec } from './prompt';
import { draft } from './spec.fixture';

type SpecPatch = Record<string, unknown>;

interface ArrayField {
  /** Dotted field path; also the expected issue path. */
  readonly field: string;
  /**
   * The raw entry limit, written out as a literal — never derived from the schema's
   * constants, so a mutation to them moves the schema and not the expectation.
   */
  readonly rawLimit: number;
  /** An entry the element schema accepts. Duplicates are fine: dedup happens later. */
  readonly entry: string;
  readonly set: (value: unknown) => SpecPatch;
}

/** Valid, and deliberately repeatable: imageAssetIds does not dedup. */
const ASSET_ID = '33333333-3333-4333-8333-333333333333';

const mood: ArrayField = {
  field: 'intent.mood',
  rawLimit: 32,
  entry: 'dup',
  set: (value) => ({ intent: { ...draft.intent, mood: value } }),
};

const ARRAY_FIELDS: readonly ArrayField[] = [
  mood,
  {
    field: 'composition.sections',
    rawLimit: 128,
    entry: 'dup',
    set: (value) => ({ composition: { ...draft.composition, sections: value } }),
  },
  {
    field: 'sound.styles',
    rawLimit: 64,
    entry: 'dup',
    set: (value) => ({ sound: { ...draft.sound, styles: value } }),
  },
  {
    field: 'sound.exclusions',
    rawLimit: 64,
    entry: 'dup',
    set: (value) => ({ sound: { ...draft.sound, exclusions: value } }),
  },
  // No slack, deliberately: imageAssetIds needs no normalization, so its raw count IS
  // its declared count. It still needs the pre-bound — parsing a million UUIDs to
  // discover that the eleventh was one too many is the same amplifier.
  {
    field: 'sound.imageAssetIds',
    rawLimit: 10,
    entry: ASSET_ID,
    set: (value) => ({ sound: { ...draft.sound, imageAssetIds: value } }),
  },
];

/**
 * A real array whose every index is an accessor property, so element reads are counted.
 * Not a Proxy: `Array.isArray`, `length` and iteration must be the genuine article, or
 * a zero count could be an artefact of the instrument rather than of the schema.
 */
const countingArray = (length: number, value: string, onRead: () => void): unknown[] => {
  const array: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    Object.defineProperty(array, index, {
      get: () => {
        onRead();
        return value;
      },
      enumerable: true,
      configurable: true,
    });
  }
  return array;
};

interface Measurement {
  /** Element parses the schema performed. */
  readonly parses: number;
  readonly issues: readonly z.ZodIssue[];
}

const measure = (field: ArrayField, entries: number): Measurement => {
  let parses = 0;
  const payload = countingArray(entries, field.entry, () => {
    parses += 1;
  });
  try {
    normalizeGenerationSpec({ ...draft, ...field.set(payload) });
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return { parses, issues: error.issues };
  }
  return { parses, issues: [] };
};

const rejectionIssues = (patch: SpecPatch): z.ZodIssue[] => {
  try {
    normalizeGenerationSpec({ ...draft, ...patch });
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues;
    throw error;
  }
  throw new Error('expected this payload to be rejected, but the schema accepted it');
};

const fingerprints = (issues: readonly z.ZodIssue[]): string[] =>
  issues.map((issue) => `${issue.code}@${issue.path.join('.')}`);

/**
 * The message and shape zod's own `z.array(...).max(n)` produces for an over-count
 * array. Computed rather than quoted, so the parity assertion below compares the
 * hand-raised issue with the real thing instead of with a literal that a zod upgrade
 * could silently invalidate.
 */
const zodArrayMaxIssue = (maximum: number): z.ZodIssue => {
  const result = z.array(z.string()).max(maximum)
    .safeParse(Array.from({ length: maximum + 1 }, () => 'x'));
  if (result.success) throw new Error('unreachable: the payload is one over the maximum');
  const [issue] = result.error.issues;
  if (!issue) throw new Error('unreachable: an over-count array always raises one issue');
  return issue;
};

test('zod keeps parsing elements after an array-side .max() has already failed', () => {
  let parses = 0;
  const element = z.string().superRefine(() => {
    parses += 1;
  });
  const oversized = Array.from({ length: 100 }, () => 'x');

  // The shape normalizedList used to have: the count check BESIDE the element schema.
  // 100 elements are parsed to reject an array already known to be too long.
  const beside = z.array(element).max(4);
  expect(() => beside.parse(oversized)).toThrow(z.ZodError);
  expect(parses).toBe(100);

  // The shape it has now: the same check AHEAD of the array, joined by .pipe(), which
  // returns without touching its right-hand side once the left one has failed.
  parses = 0;
  const ahead = z
    .unknown()
    .superRefine((value, ctx) => {
      if (!Array.isArray(value) || value.length <= 4) return;
      ctx.addIssue({ code: z.ZodIssueCode.too_big, type: 'array', maximum: 4, inclusive: true, fatal: true });
    })
    .pipe(z.array(element));
  expect(() => ahead.parse(oversized)).toThrow(z.ZodError);
  expect(parses).toBe(0);

  // Both halves are needed: within the bound the elements ARE parsed, so a zero above
  // cannot be a counter that never moves.
  expect(ahead.parse(['x', 'x'])).toEqual(['x', 'x']);
  expect(parses).toBe(2);
});

test.each(ARRAY_FIELDS)(
  '$field: the counter is live — an array of exactly the raw limit is accepted and every entry IS parsed',
  (field) => {
    const { parses, issues } = measure(field, field.rawLimit);
    expect(fingerprints(issues)).toEqual([]);
    expect(parses).toBe(field.rawLimit);
  },
);

test.each(ARRAY_FIELDS)(
  '$field: one entry over the raw limit costs ZERO element parses — the bound runs BEFORE the element schema',
  (field) => {
    const { parses, issues } = measure(field, field.rawLimit + 1);
    expect(fingerprints(issues)).toEqual([`too_big@${field.field}`]);
    expect(parses).toBe(0);
  },
);

test.each(ARRAY_FIELDS)(
  '$field: the pre-bound rejects with the same issue the array-side .max() raised, so no caller can tell',
  (field) => {
    const { issues } = measure(field, field.rawLimit + 1);
    const [issue] = issues;
    expect(issues).toHaveLength(1);
    if (!issue || issue.code !== 'too_big') throw new Error('unreachable: just asserted');

    const reference = zodArrayMaxIssue(field.rawLimit);
    if (reference.code !== 'too_big') throw new Error('unreachable: .max() raises too_big');
    expect({
      code: issue.code,
      type: issue.type,
      maximum: Number(issue.maximum),
      inclusive: issue.inclusive,
      message: issue.message,
    }).toEqual({
      code: reference.code,
      type: reference.type,
      maximum: field.rawLimit,
      inclusive: reference.inclusive,
      message: reference.message,
    });
    expect(issue.path.join('.')).toBe(field.field);
  },
);

test.each(ARRAY_FIELDS)(
  '$field: the pre-bound passes non-arrays through, so the array stage still reports the type error itself',
  (field) => {
    for (const notAnArray of ['not an array', 42, true, {}, null, undefined]) {
      expect(fingerprints(rejectionIssues(field.set(notAnArray))))
        .toEqual([`invalid_type@${field.field}`]);
    }
  },
);

/**
 * The one observable change, pinned deliberately rather than left to be discovered.
 * A payload that breaks the entry count AND carries an over-length entry used to
 * produce two issues, because zod recorded the array's `too_big` and then parsed the
 * elements anyway. It now produces one: the parse stops at the count, so the element
 * parse that would have found the second violation never runs. The request is rejected
 * either way, for a reason that is true either way.
 */
test('an over-count array reports the entry count alone, not also an issue per oversized entry', () => {
  const overCountAndOverLength = [
    'a'.repeat(161), // over intent.mood's per-item raw limit of 160
    ...Array.from({ length: 32 }, () => 'dup'),
  ];
  expect(fingerprints(rejectionIssues(mood.set(overCountAndOverLength))))
    .toEqual(['too_big@intent.mood']);

  // Inside the entry count, the per-item raw bound still answers for itself.
  expect(fingerprints(rejectionIssues(mood.set(['a'.repeat(161)]))))
    .toEqual(['too_big@intent.mood.0']);
});

test('the rejection cost does not grow with the array: 100 000 entries still costs zero element parses', () => {
  const { parses, issues } = measure(mood, 100_000);
  expect(fingerprints(issues)).toEqual(['too_big@intent.mood']);
  expect(parses).toBe(0);
});
