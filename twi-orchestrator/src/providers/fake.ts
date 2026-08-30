import type { GenerationSpec } from '../../../src/twi/domain/types';
import { specSha256 } from '../../../src/twi/server/spec-digest';
import { createSineWav } from '../audio/wav';
import type { CandidateLabel, MusicProvider, ProviderCandidate } from './types';

const FREQUENCIES: Record<CandidateLabel, number> = {
  A: 220,
  B: 277.18,
};

export interface DeterministicFakeProviderOptions {
  sampleRate?: number;
}

export class DeterministicFakeMusicProvider implements MusicProvider {
  private readonly sampleRate: number;

  constructor(options: DeterministicFakeProviderOptions = {}) {
    this.sampleRate = options.sampleRate ?? 8_000;
  }

  async generate(spec: GenerationSpec, label: CandidateLabel): Promise<ProviderCandidate> {
    const specHash = await specSha256(JSON.stringify(spec));
    return {
      label,
      bytes: createSineWav({
        seconds: spec.intent.durationSeconds,
        frequencyHz: FREQUENCIES[label],
        sampleRate: this.sampleRate,
      }),
      contentType: 'audio/wav',
      provider: 'fake',
      model: 'deterministic-sine-v1',
      durationSeconds: spec.intent.durationSeconds,
      providerCostUsd: 0,
      providerRequestId: `${specHash}-${label}`,
    };
  }
}
