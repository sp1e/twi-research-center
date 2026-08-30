import type { GenerationSpec } from '../../../src/twi/domain/types';

export type CandidateLabel = 'A' | 'B';

export interface ProviderCandidate {
  label: CandidateLabel;
  bytes: Uint8Array;
  contentType: 'audio/wav';
  provider: string;
  model: string;
  durationSeconds: number;
  providerCostUsd: number;
  providerRequestId: string;
}

export interface MusicProvider {
  generate(spec: GenerationSpec, label: CandidateLabel): Promise<ProviderCandidate>;
}
