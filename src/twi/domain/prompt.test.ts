import { expect, test } from 'vitest';
import { compileLyriaPrompt, normalizeGenerationSpec } from './prompt';
import { estimateRequestSchema, submitJobSchema } from './schemas';

const projectId = '11111111-1111-4111-8111-111111111111';
const idempotencyKey = '22222222-2222-4222-8222-222222222222';

const draft = {
  intent: { purpose: 'album track', mood: ['intimate', 'unstable'], narrative: 'leaving home', durationSeconds: 150, instrumental: false },
  composition: { lyrics: '[Verse]\nNorthbound again', sections: ['Intro', 'Verse', 'Chorus'], bpm: 82, key: 'F minor', meter: '7/8', arrangement: 'bowed bass and dry drums' },
  sound: { styles: ['art rock', 'trip-hop'], exclusions: ['festival EDM'], novelty: 72, imageAssetIds: [] },
  performance: { mode: 'generic' as const, vocalRange: 'low', timbre: 'close and grainy', delivery: 'restrained' },
  rightsAccepted: true,
};

test('normalization cleans all lists in first-occurrence order without mutating input', () => {
  const input = {
    ...draft,
    intent: { ...draft.intent, mood: [' intimate ', '', 'intimate', ' unstable '] },
    composition: { ...draft.composition, sections: [' Intro ', 'Verse', ' Intro ', '  '] },
    sound: {
      ...draft.sound,
      styles: [' art rock ', '', 'trip-hop', 'art rock'],
      exclusions: [' festival EDM ', '', 'festival EDM', 'trance'],
    },
  };
  const before = structuredClone(input);
  const normalized = normalizeGenerationSpec(input);

  expect(normalized.intent.mood).toEqual(['intimate', 'unstable']);
  expect(normalized.composition.sections).toEqual(['Intro', 'Verse']);
  expect(normalized.sound.styles).toEqual(['art rock', 'trip-hop']);
  expect(normalized.sound.exclusions).toEqual(['festival EDM', 'trance']);
  expect(input).toEqual(before);
});

test('normalization rejects styles that are empty after cleaning', () => {
  expect(() => normalizeGenerationSpec({
    ...draft,
    sound: { ...draft.sound, styles: ['', '   '] },
  })).toThrow();
});

test('normalization trims scalar text and preserves internal lyric newlines', () => {
  const normalized = normalizeGenerationSpec({
    ...draft,
    intent: { ...draft.intent, purpose: ' album track ', narrative: ' leaving home ' },
    composition: {
      ...draft.composition,
      lyrics: '  [Verse]\nNorthbound again\n  ',
      key: ' F minor ',
      meter: ' 7/8 ',
      arrangement: ' bowed bass ',
    },
    performance: { ...draft.performance, vocalRange: ' low ', timbre: ' grainy ', delivery: ' restrained ' },
  });

  expect(normalized.intent.purpose).toBe('album track');
  expect(normalized.intent.narrative).toBe('leaving home');
  expect(normalized.composition.lyrics).toBe('[Verse]\nNorthbound again');
  expect(normalized.composition).toMatchObject({ key: 'F minor', meter: '7/8', arrangement: 'bowed bass' });
  expect(normalized.performance).toMatchObject({ vocalRange: 'low', timbre: 'grainy', delivery: 'restrained' });
});

test('Lyria prompt contains supplied musical controls, lyrics and exclusions', () => {
  const prompt = compileLyriaPrompt(normalizeGenerationSpec(draft));
  expect(prompt).toContain('Tempo: 82 BPM');
  expect(prompt).toContain('Key: F minor');
  expect(prompt).toContain('Meter: 7/8');
  expect(prompt).toContain('[Verse]\nNorthbound again');
  expect(prompt).toContain('Avoid: festival EDM');
});

test('instrumental prompts omit lyrics and vocal controls', () => {
  const prompt = compileLyriaPrompt(normalizeGenerationSpec({
    ...draft,
    intent: { ...draft.intent, instrumental: true },
  }));

  expect(prompt).toContain('instrumental composition');
  expect(prompt).not.toContain('Use these exact section-tagged lyrics');
  expect(prompt).not.toContain('Northbound again');
  expect(prompt).not.toContain('Vocal range:');
  expect(prompt).not.toContain('Vocal timbre:');
  expect(prompt).not.toContain('Vocal delivery:');
});

test('prompt omits optional lines whose normalized values are empty', () => {
  const prompt = compileLyriaPrompt(normalizeGenerationSpec({
    ...draft,
    intent: { ...draft.intent, mood: [' '], narrative: ' ' },
    composition: { lyrics: ' \n ', sections: [' '], bpm: null, key: ' ', meter: ' ', arrangement: ' ' },
    sound: { ...draft.sound, exclusions: [' '] },
    performance: { ...draft.performance, vocalRange: ' ', timbre: ' ', delivery: ' ' },
  }));

  expect(prompt).toContain('Purpose: album track.');
  expect(prompt).toContain('Style vocabulary: art rock, trip-hop.');
  for (const label of ['Mood:', 'Narrative:', 'Tempo:', 'Key:', 'Meter:', 'Structure:', 'Arrangement:', 'Vocal range:', 'Vocal timbre:', 'Vocal delivery:', 'Avoid:', 'Use these exact section-tagged lyrics:']) {
    expect(prompt).not.toContain(label);
  }
});

test.each([
  [30, 'Target duration: 30 seconds.'],
  [60, 'Target duration: 1 minute.'],
  [61, 'Target duration: 1 minute 1 second.'],
  [150, 'Target duration: 2 minutes 30 seconds.'],
])('duration grammar formats %i seconds', (durationSeconds, expected) => {
  const prompt = compileLyriaPrompt(normalizeGenerationSpec({
    ...draft,
    intent: { ...draft.intent, durationSeconds },
  }));
  expect(prompt).toContain(expected);
});

test('duration accepts 30–240 seconds and rejects values outside that range', () => {
  for (const durationSeconds of [30, 240]) {
    expect(() => normalizeGenerationSpec({ ...draft, intent: { ...draft.intent, durationSeconds } })).not.toThrow();
  }
  for (const durationSeconds of [29, 241]) {
    expect(() => normalizeGenerationSpec({ ...draft, intent: { ...draft.intent, durationSeconds } })).toThrow();
  }
});

test('BPM accepts null or 30–300 and rejects values outside that range', () => {
  for (const bpm of [null, 30, 300]) {
    expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, bpm } })).not.toThrow();
  }
  for (const bpm of [29, 301]) {
    expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, bpm } })).toThrow();
  }
});

test('novelty accepts 0–100 and rejects values outside that range', () => {
  for (const novelty of [0, 100]) {
    expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, novelty } })).not.toThrow();
  }
  for (const novelty of [-1, 101]) {
    expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, novelty } })).toThrow();
  }
});

test('image references accept at most ten UUIDs', () => {
  const imageAssetIds = Array.from(
    { length: 10 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  );
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, imageAssetIds } })).not.toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, imageAssetIds: [...imageAssetIds, projectId] } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, imageAssetIds: ['not-a-uuid'] } })).toThrow();
});

test('rights must be accepted and all generation objects reject unknown keys', () => {
  expect(() => normalizeGenerationSpec({ ...draft, rightsAccepted: false })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, unknown: true })).toThrow();
  expect(() => normalizeGenerationSpec({
    ...draft,
    intent: { ...draft.intent, unknown: true },
  })).toThrow();
});

test('list normalization does not coerce non-string entries', () => {
  expect(() => normalizeGenerationSpec({
    ...draft,
    intent: { ...draft.intent, mood: ['intimate', 3] },
  })).toThrow();
});

test('intent limits reject overlong normalized fields and arrays', () => {
  expect(() => normalizeGenerationSpec({ ...draft, intent: { ...draft.intent, purpose: ` ${'p'.repeat(161)} ` } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, intent: { ...draft.intent, mood: [` ${'m'.repeat(81)} `] } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, intent: { ...draft.intent, mood: Array.from({ length: 17 }, (_, index) => `mood ${index}`) } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, intent: { ...draft.intent, narrative: ` ${'n'.repeat(4001)} ` } })).toThrow();
});

test('composition limits reject overlong normalized fields and arrays', () => {
  expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, lyrics: ` ${'l'.repeat(16001)} ` } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, sections: [` ${'s'.repeat(101)} `] } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, sections: Array.from({ length: 65 }, (_, index) => `Section ${index}`) } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, key: ` ${'k'.repeat(65)} ` } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, meter: ` ${'m'.repeat(33)} ` } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, composition: { ...draft.composition, arrangement: ` ${'a'.repeat(2001)} ` } })).toThrow();
});

test('sound limits reject overlong normalized fields and arrays', () => {
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, styles: [` ${'s'.repeat(101)} `] } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, styles: Array.from({ length: 33 }, (_, index) => `style ${index}`) } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, exclusions: [` ${'e'.repeat(161)} `] } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, sound: { ...draft.sound, exclusions: Array.from({ length: 33 }, (_, index) => `exclude ${index}`) } })).toThrow();
});

test('performance limits reject overlong normalized fields', () => {
  expect(() => normalizeGenerationSpec({ ...draft, performance: { ...draft.performance, vocalRange: ` ${'v'.repeat(101)} ` } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, performance: { ...draft.performance, timbre: ` ${'t'.repeat(301)} ` } })).toThrow();
  expect(() => normalizeGenerationSpec({ ...draft, performance: { ...draft.performance, delivery: ` ${'d'.repeat(301)} ` } })).toThrow();
});

test('request schemas reject invalid UUID identifiers', () => {
  expect(() => estimateRequestSchema.parse({ projectId: 'project-1', spec: draft })).toThrow();
  expect(() => submitJobSchema.parse({ projectId, idempotencyKey: 'key-1', spec: draft })).toThrow();
});

test('request schemas accept valid UUID identifiers and normalized specs', () => {
  const spec = normalizeGenerationSpec(draft);
  expect(estimateRequestSchema.parse({ projectId, spec })).toEqual({ projectId, spec });
  expect(submitJobSchema.parse({ projectId, idempotencyKey, spec })).toEqual({ projectId, idempotencyKey, spec });
});
