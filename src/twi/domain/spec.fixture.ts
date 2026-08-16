// Shared, deliberately un-normalized draft payloads for the domain test suites.
// Kept out of the *.test.ts glob so both prompt.test.ts and schemas.test.ts can
// build variants from one canonical starting point.

export const projectId = '11111111-1111-4111-8111-111111111111';
export const idempotencyKey = '22222222-2222-4222-8222-222222222222';

export const draft = {
  intent: { purpose: 'album track', mood: ['intimate', 'unstable'], narrative: 'leaving home', durationSeconds: 150, instrumental: false },
  composition: { lyrics: '[Verse]\nNorthbound again', sections: ['Intro', 'Verse', 'Chorus'], bpm: 82, key: 'F minor', meter: '7/8', arrangement: 'bowed bass and dry drums' },
  sound: { styles: ['art rock', 'trip-hop'], exclusions: ['festival EDM'], novelty: 72, imageAssetIds: [] as string[] },
  performance: { mode: 'generic' as const, vocalRange: 'low', timbre: 'close and grainy', delivery: 'restrained' },
  rightsAccepted: true as const,
};

// The same request as an instrumental render: an instrumental spec may not carry
// lyrics or vocal direction at all, so those fields are cleared rather than ignored.
export const instrumentalDraft = {
  ...draft,
  intent: { ...draft.intent, instrumental: true },
  composition: { ...draft.composition, lyrics: '' },
  performance: { ...draft.performance, vocalRange: '', timbre: '', delivery: '' },
};
