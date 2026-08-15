export type JobStatus = 'draft' | 'estimated' | 'queued' | 'generating' | 'ingesting' | 'finishing' | 'validating' | 'complete' | 'cancelling' | 'cancelled' | 'error' | 'retrying';
export type JobPhase = Exclude<JobStatus, 'draft' | 'estimated'>;
export type AssetKind = 'image-reference' | 'generation-raw' | 'generation-master' | 'generation-preview' | 'provenance';

export interface GenerationSpec {
  intent: { purpose: string; mood: string[]; narrative: string; durationSeconds: number; instrumental: boolean };
  composition: { lyrics: string; sections: string[]; bpm: number | null; key: string; meter: string; arrangement: string };
  sound: { styles: string[]; exclusions: string[]; novelty: number; imageAssetIds: string[] };
  performance: { mode: 'generic'; vocalRange: string; timbre: string; delivery: string };
  rightsAccepted: true;
}

export interface CapabilityCatalog {
  provider: string;
  fullSong: boolean;
  customLyrics: boolean;
  imageReference: boolean;
  audioReference: boolean;
  midiReference: boolean;
  deterministicSeed: boolean;
  maxImageReferences: number;
  outputFormats: Array<'audio/wav' | 'audio/mpeg'>;
}

export interface CostEstimate { currency: 'USD'; provider: number; finishing: number; storage: number; total: number; estimatedSeconds: number; }
export interface CandidateAsset { id: string; label: 'A' | 'B'; previewUrl: string; masterUrl: string; durationSeconds: number; provider: string; model: string; actualCost: number; }
