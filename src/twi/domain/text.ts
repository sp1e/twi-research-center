// Text normalization for the generation specification.
//
// The compiled Lyria prompt is a line-oriented document: one directive per line,
// sent verbatim to a paid third-party model. Any code point that can forge a line
// boundary therefore has to be neutralised before a value reaches the template,
// and it has to happen on ONE code path so a new field cannot forget to do it.
//
// Normalization is also required to be TOTAL: two inputs that mean the same thing
// must produce byte-identical output, because the idempotency layer fingerprints
// the canonical document and a fingerprint is only as good as the normalization
// beneath it.

/** Zero-width and word-joining code points: no visible content, survive trimming. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** C0/C1 controls that are not whitespace. Unrenderable; never forwarded. */
const NON_WHITESPACE_CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g;

/** Anything that pads a value or forges a line boundary, U+2028/U+2029/U+0085 included. */
const ANY_WHITESPACE = /[\s\u0085]+/g;

/** Every code point that opens a new line in some renderer. */
const LINE_BREAK = /[\n\r\u2028\u2029\u0085\u000B\u000C]/;

/** Line terminators folded to a single U+000A inside lyrics. */
const LINE_TERMINATOR = /\r\n|[\r\u2028\u2029\u0085]/g;

/** Whitespace other than the line feed, collapsed within a single lyric line. */
const INTRA_LINE_WHITESPACE = /[^\S\n]+/g;

/** Three or more consecutive line feeds, collapsed to one blank line. */
const BLANK_LINE_RUN = /\n{3,}/g;

/**
 * The seventeen line openings the Lyria prompt template can emit, in template order.
 * Used to prove the compiler emits nothing else, and to reject lyric lines that
 * would read as a generation directive rather than as sung words.
 */
export const PROMPT_DIRECTIVE_PREFIXES = [
  'Create a full-length ',
  'Purpose: ',
  'Mood: ',
  'Narrative: ',
  'Target duration: ',
  'Tempo: ',
  'Key: ',
  'Meter: ',
  'Structure: ',
  'Arrangement: ',
  'Style vocabulary: ',
  'Novelty: ',
  'Vocal range: ',
  'Vocal timbre: ',
  'Vocal delivery: ',
  'Avoid: ',
  'Use these exact section-tagged lyrics:',
] as const;

/** Directives that must never appear in an instrumental render, whatever field they came from. */
export const VOCAL_DIRECTIVE_PREFIXES = [
  'Vocal range: ',
  'Vocal timbre: ',
  'Vocal delivery: ',
  'Use these exact section-tagged lyrics:',
] as const;

const stripUnrenderable = (value: string): string => value
  .normalize('NFC')
  .replace(INVISIBLE, '')
  .replace(NON_WHITESPACE_CONTROL, '');

/** Collapse a value to a single line: no code point left can forge a line boundary. */
export const toSingleLineText = (value: string): string => stripUnrenderable(value)
  .replace(ANY_WHITESPACE, ' ')
  .trim();

/**
 * Lyrics are the one legitimately multi-line field. They are normalized rather
 * than exempted: line terminators are unified, each line is collapsed and trimmed,
 * and blank-line runs are capped, so the same lyric sheet always renders identically.
 */
export const toLyricText = (value: string): string => stripUnrenderable(value)
  .replace(LINE_TERMINATOR, '\n')
  .split('\n')
  .map((line) => line.replace(INTRA_LINE_WHITESPACE, ' ').trim())
  .join('\n')
  .replace(BLANK_LINE_RUN, '\n\n')
  .trim();

export const containsLineBreak = (value: string): boolean => LINE_BREAK.test(value);

/**
 * The directive a lyric line would forge, or undefined when the line is just words.
 * Lyrics sit last in the prompt, so a line that opens with a directive prefix is the
 * only way user text can still be read as an instruction.
 */
export const forgedDirective = (line: string): string | undefined =>
  PROMPT_DIRECTIVE_PREFIXES.find((prefix) => line.startsWith(prefix));

/**
 * Case- and form-insensitive identity of a normalized value. Used only as a dedup
 * key; the first-seen spelling is what gets emitted. toLowerCase (not the locale
 * variant) keeps the key deterministic across runtimes.
 */
const dedupeKey = (value: string): string => value.toLowerCase().normalize('NFC');

/**
 * Normalize, drop empties and deduplicate, preserving first-occurrence order.
 * Deliberately allocates: the caller's array is never touched.
 */
export const cleanList = (items: readonly string[]): string[] => {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of items) {
    const value = toSingleLineText(item);
    if (!value) continue;
    const key = dedupeKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  return cleaned;
};
