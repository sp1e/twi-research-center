import { z } from 'zod';
import type { GenerationSpec } from './types';
import { cleanList, closesLyricsFence, LYRICS_FENCE_CLOSE, toLyricText, toSingleLineText } from './text';

// Raw payloads are bounded BEFORE any normalization runs. The piped caps below
// describe the normalized contract; these describe the request. Without them the
// caps say nothing about what a client may send, and trimming plus Set-hashing a
// million entries becomes a CPU and memory amplifier inside a Worker isolate.
// The slack exists so that legitimate whitespace and duplicate entries — the very
// things normalization is here to absorb — are not rejected at the door.
// RAW_ENTRY_SLACK is applied by rawEntryCountBound below, which sits ahead of the
// element schema rather than beside it; see the comment there for why that matters.
const RAW_LENGTH_SLACK = 2;
const RAW_ENTRY_SLACK = 2;

/**
 * A free-text field that must occupy exactly one line of the compiled prompt.
 * Every interpolated value goes through this one factory, so a field added later
 * cannot forget to be sanitised.
 */
const singleLine = (maximumLength: number, minimumLength = 0) => z
  .string()
  .max(maximumLength * RAW_LENGTH_SLACK)
  .transform(toSingleLineText)
  .pipe(z.string().min(minimumLength).max(maximumLength));

/** The one legitimately multi-line field. Normalized, never exempted. */
const lyricText = (maximumLength: number) => z
  .string()
  .max(maximumLength * RAW_LENGTH_SLACK)
  .transform(toLyricText)
  .pipe(z.string().max(maximumLength));

/**
 * The raw entry-count bound, placed so that it runs BEFORE the element schema is
 * mapped over the array.
 *
 * `z.array(element).max(n)` does not do that, which made the guard above a partial
 * mitigation. Measured on zod 3.25.76: an over-count array records its `too_big`
 * issue, marks the result dirty, and then still maps the element schema over EVERY
 * entry — a 100 000-entry payload cost 100 000 element parses before the isolate
 * said no. Only the `.transform()` was skipped, so the trimming and Set-hashing were
 * avoided but the per-element parse was not.
 *
 * `.pipe()` is what closes it: it returns without touching its right-hand side once
 * the left one has failed, so a count check in front of the array stage makes the
 * rejection cost O(1) instead of O(entries).
 *
 * The issue is raised by hand so the rejection stays indistinguishable from the
 * `.max()` this replaces — same `code`, `type`, `maximum`, path and message — and is
 * fatal so the parse aborts rather than merely going dirty. A non-array falls through
 * untouched: the array stage is what must report the type error, and it still does.
 *
 * This is the ONLY raw entry-count bound. The array stage deliberately keeps no
 * `.max()` of its own: a second copy of the same check sitting behind this one could
 * never fire, so no test could hold it honest and no mutation to it could be caught.
 */
const rawEntryCountBound = (maximumRawEntries: number) => z
  .unknown()
  .superRefine((value, ctx) => {
    if (!Array.isArray(value) || value.length <= maximumRawEntries) return;
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      type: 'array',
      maximum: maximumRawEntries,
      inclusive: true,
      exact: false,
      fatal: true,
    });
  });

const normalizedList = (maximumEntries: number, maximumItemLength: number, minimumEntries = 0) => rawEntryCountBound(maximumEntries * RAW_ENTRY_SLACK)
  .pipe(z
    .array(z.string().max(maximumItemLength * RAW_LENGTH_SLACK))
    .transform(cleanList)
    .pipe(z.array(z.string().max(maximumItemLength)).min(minimumEntries).max(maximumEntries)));

/**
 * An array whose elements need no normalization, so there is no slack to absorb: the
 * raw count IS the declared count. It still needs the pre-bound, because parsing a
 * million UUIDs to discover the eleventh was one too many is the same amplifier.
 */
const boundedArray = <T extends z.ZodTypeAny>(element: T, maximumEntries: number) =>
  rawEntryCountBound(maximumEntries).pipe(z.array(element));

/**
 * A whole-number control. Fractional BPM and novelty are nonsense directives to a
 * music model and destabilise any fingerprint that round-trips through a REAL
 * column; `-0` is folded to `0` so identical meaning is identical output.
 */
const integer = (minimum: number, maximum: number) => z
  .number()
  .int()
  .min(minimum)
  .max(maximum)
  .transform((value) => value + 0);

const uuid = z.string().uuid();

export const generationSpecObject = z.object({
  intent: z.object({
    purpose: singleLine(160, 1),
    mood: normalizedList(16, 80),
    narrative: singleLine(4_000),
    durationSeconds: integer(30, 240),
    instrumental: z.boolean(),
  }).strict(),
  composition: z.object({
    lyrics: lyricText(16_000),
    sections: normalizedList(64, 100),
    bpm: integer(30, 300).nullable(),
    key: singleLine(64),
    meter: singleLine(32),
    arrangement: singleLine(2_000),
  }).strict(),
  sound: z.object({
    styles: normalizedList(32, 100, 1),
    exclusions: normalizedList(32, 160),
    novelty: integer(0, 100),
    imageAssetIds: boundedArray(uuid, 10),
  }).strict(),
  performance: z.object({
    mode: z.literal('generic'),
    vocalRange: singleLine(100),
    timbre: singleLine(300),
    delivery: singleLine(300),
  }).strict(),
  rightsAccepted: z.literal(true),
}).strict();

// Bidirectional drift guard. A plain `z.ZodType<GenerationSpec>` annotation only
// catches a schema that is MISSING a field: a schema that gains one, or narrows a
// type, both stay assignable and compile clean. It also erases the ZodObject
// surface (.shape/.partial()/.extend()) that later tasks need. This assertion
// fails in both directions and costs nothing at runtime.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const specMatchesDeclaredType: Exact<z.infer<typeof generationSpecObject>, GenerationSpec> = true;
void specMatchesDeclaredType;

declare const normalized: unique symbol;

/**
 * A GenerationSpec that provably came out of {@link generationSpecSchema}.
 * The compiler accepts nothing else, so a raw D1 row or a resumed Workflow payload
 * cannot reach the paid provider without being re-validated.
 */
export type NormalizedGenerationSpec = GenerationSpec & { readonly [normalized]: true };

interface VocalField {
  readonly path: readonly [string, string];
  readonly read: (spec: GenerationSpec) => string;
}

const VOCAL_FIELDS: readonly VocalField[] = [
  { path: ['composition', 'lyrics'], read: (spec) => spec.composition.lyrics },
  { path: ['performance', 'vocalRange'], read: (spec) => spec.performance.vocalRange },
  { path: ['performance', 'timbre'], read: (spec) => spec.performance.timbre },
  { path: ['performance', 'delivery'], read: (spec) => spec.performance.delivery },
];

/**
 * `instrumental` has to mean something. Silently dropping lyrics the user typed and
 * paid to generate is data loss, so the contradiction is an explicit rejection the
 * caller can surface instead.
 */
const assertInstrumentalCarriesNoVoice = (spec: GenerationSpec, ctx: z.RefinementCtx): void => {
  if (!spec.intent.instrumental) return;
  for (const { path, read } of VOCAL_FIELDS) {
    if (!read(spec)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path],
      message: `An instrumental generation cannot carry ${path.join('.')}. Clear the field, or turn off instrumental — it will not be dropped silently.`,
    });
  }
};

/**
 * Lyrics are emitted inside a delimited fence, so a lyric line can say anything a
 * songwriter wants — `Key: to my heart` is words, not a directive. The single thing
 * it may not do is close the fence and step back out into directive position.
 */
const assertLyricsCannotCloseTheFence = (spec: GenerationSpec, ctx: z.RefinementCtx): void => {
  if (!closesLyricsFence(spec.composition.lyrics)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['composition', 'lyrics'],
    message: `Lyrics cannot contain the closing lyrics marker "${LYRICS_FENCE_CLOSE}".`,
  });
};

export const generationSpecSchema = generationSpecObject
  .superRefine((spec, ctx) => {
    assertInstrumentalCarriesNoVoice(spec, ctx);
    assertLyricsCannotCloseTheFence(spec, ctx);
  })
  .transform((spec) => spec as NormalizedGenerationSpec);

export const estimateRequestSchema = z.object({
  projectId: uuid,
  spec: generationSpecSchema,
}).strict();

export const submitJobSchema = estimateRequestSchema.extend({
  idempotencyKey: uuid,
}).strict();
