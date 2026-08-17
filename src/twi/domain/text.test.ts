import { expect, test } from 'vitest';
import { compileLyriaPrompt, normalizeGenerationSpec } from './prompt';
import { generationSpecSchema } from './schemas';
import type { NormalizedGenerationSpec } from './schemas';
import { LYRICS_FENCE_CLOSE, closesLyricsFence, toLyricText } from './text';
import { draft } from './spec.fixture';

// What a "line" of lyrics is, spelled out rather than imported from ./text on
// purpose: a test that reused the production character class could not catch a
// wrong one. These are the terminators toLyricText folds to U+000A, so they are
// the ones the fence detector has to split on to give the same answer the
// validated path would have given.
const LINE_BREAKS = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r'],
  ['U+2028', '\u2028'],
  ['U+2029', '\u2029'],
  ['U+0085', '\u0085'],
] as const;

// Every spelling that folds to the closing marker's words once case and
// non-alphanumerics are dropped. The first is the literal marker (caught by the
// position-independent arm); the rest are the near misses that only the
// whole-line arm can see, and therefore the ones a separator could hide.
const CLOSING_SPELLINGS = [
  LYRICS_FENCE_CLOSE,
  '--- End Lyrics ---',
  '---end lyrics---',
  'END LYRICS',
  '[end lyrics]',
  'End, Lyrics.',
] as const;

/** A lyric sheet whose middle line is `spelling`, separated by `separator`. */
const sheet = (separator: string, spelling: string): string =>
  `[Verse]${separator}${spelling}${separator}Northbound again`;

const schemaAccepts = (lyrics: string): boolean => generationSpecSchema
  .safeParse({ ...draft, composition: { ...draft.composition, lyrics } })
  .success;

/** A spec that reached the compiler without going through the schema. */
const bypassed = (lyrics: string): NormalizedGenerationSpec => ({
  ...draft,
  composition: { ...draft.composition, lyrics },
} as unknown as NormalizedGenerationSpec);

const compilerAccepts = (lyrics: string): boolean => {
  try {
    compileLyriaPrompt(bypassed(lyrics));
    return true;
  } catch (error) {
    expect(String(error)).toMatch(/close the lyrics fence/);
    return false;
  }
};

test.each(LINE_BREAKS)(
  'a closing marker separated by %s closes the fence, whatever the spelling',
  (_name, separator) => {
    for (const spelling of CLOSING_SPELLINGS) {
      expect(closesLyricsFence(sheet(separator, spelling))).toBe(true);
    }
  },
);

test.each(LINE_BREAKS)(
  'the schema refuses a closing marker separated by %s',
  (_name, separator) => {
    for (const spelling of CLOSING_SPELLINGS) {
      expect(schemaAccepts(sheet(separator, spelling))).toBe(false);
    }
  },
);

test.each(LINE_BREAKS)(
  'the compiler refuses a bypassing spec whose closing marker is separated by %s',
  (_name, separator) => {
    for (const spelling of CLOSING_SPELLINGS) {
      expect(compilerAccepts(sheet(separator, spelling))).toBe(false);
    }
  },
);

// The property behind the fix. The compiler sees raw text and the schema sees
// normalized text, so the predicate has to answer identically on both or the two
// enforcement points disagree — which is exactly how the gap arose.
test('the predicate gives the same answer before and after normalization', () => {
  const vectors = [
    ...LINE_BREAKS.flatMap(([, separator]) => CLOSING_SPELLINGS.map((s) => sheet(separator, s))),
    ...LINE_BREAKS.flatMap(([, separator]) => [
      sheet(separator, 'Key: to my heart'),
      sheet(separator, 'the end lyrics were rewritten'),
      sheet(separator, 'Ending lyrics'),
      `${separator}${separator}[Chorus]${separator}`,
    ]),
  ];

  for (const vector of vectors) {
    expect(closesLyricsFence(vector)).toBe(closesLyricsFence(toLyricText(vector)));
  }
});

test.each(LINE_BREAKS)('ordinary lyrics separated by %s are accepted', (_name, separator) => {
  for (const line of [
    'Key: to my heart',
    'Tempo: of a slow goodbye',
    'the end lyrics were rewritten twice',
    'Ending lyrics, and beginning again',
    '---BEGIN LYRICS---',
  ]) {
    const lyrics = sheet(separator, line);
    expect(closesLyricsFence(lyrics)).toBe(false);
    expect(schemaAccepts(lyrics)).toBe(true);
    expect(compilerAccepts(lyrics)).toBe(true);
  }
});

// The boundary of the fix, pinned so it cannot be widened by accident. U+000B and
// U+000C are NOT lyric line breaks: toLyricText collapses them as intra-line
// whitespace, so the marker words end up inside a longer line and no line of the
// emitted prompt reads as the close. Splitting on them would make the compiler
// stricter than the schema — the same drift, pointing the other way.
test.each([['U+000B', '\u000b'], ['U+000C', '\u000c']] as const)(
  '%s is intra-line whitespace, not a line break, so a near miss behind it stays lyrics',
  (_name, separator) => {
    const lyrics = sheet(separator, '--- End Lyrics ---');

    expect(closesLyricsFence(lyrics)).toBe(false);
    expect(schemaAccepts(lyrics)).toBe(true);
    expect(compilerAccepts(lyrics)).toBe(true);

    const prompt = compileLyriaPrompt(normalizeGenerationSpec({
      ...draft,
      composition: { ...draft.composition, lyrics },
    }));
    expect(prompt).toContain('[Verse] --- End Lyrics --- Northbound again');
    expect(prompt.split(LYRICS_FENCE_CLOSE)).toHaveLength(2);
  },
);

// The hard guarantee, restated across every separator a reader might honour: no
// spec that the compiler accepts can put a second close marker in the prompt.
test('an accepted spec emits exactly one closing marker under every convention', () => {
  for (const [, separator] of LINE_BREAKS) {
    const prompt = compileLyriaPrompt(normalizeGenerationSpec({
      ...draft,
      composition: { ...draft.composition, lyrics: sheet(separator, 'Key: to my heart') },
    }));

    expect(prompt.split(LYRICS_FENCE_CLOSE)).toHaveLength(2);
    expect(prompt.split('\n').at(-1)).toBe(LYRICS_FENCE_CLOSE);
  }
});
