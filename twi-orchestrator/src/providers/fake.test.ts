import { describe, expect, it } from 'vitest';

import { draft } from '../../../src/twi/domain/spec.fixture';
import { specSha256 } from '../../../src/twi/server/spec-digest';
import { createSineWav } from '../audio/wav';
import { DeterministicFakeMusicProvider } from './fake';

describe('DeterministicFakeMusicProvider', () => {
  it('returns stable, provenance-bearing A and B WAV candidates from the normalized spec', async () => {
    const spec = { ...draft, intent: { ...draft.intent, durationSeconds: 30 } };
    const provider = new DeterministicFakeMusicProvider({ sampleRate: 800 });
    const specHash = await specSha256(JSON.stringify(spec));

    const candidateA = await provider.generate(spec, 'A');
    const candidateB = await provider.generate(spec, 'B');

    expect(candidateA).toEqual({
      label: 'A',
      bytes: createSineWav({ seconds: spec.intent.durationSeconds, frequencyHz: 220, sampleRate: 800 }),
      contentType: 'audio/wav',
      provider: 'fake',
      model: 'deterministic-sine-v1',
      durationSeconds: spec.intent.durationSeconds,
      providerCostUsd: 0,
      providerRequestId: `${specHash}-A`,
    });
    expect(candidateB).toEqual({
      ...candidateA,
      label: 'B',
      bytes: createSineWav({ seconds: spec.intent.durationSeconds, frequencyHz: 277.18, sampleRate: 800 }),
      providerRequestId: `${specHash}-B`,
    });
  });
});
