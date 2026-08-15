import { generationSpecSchema } from './schemas';
import type { GenerationSpec } from './types';

export function normalizeGenerationSpec(input: unknown): GenerationSpec {
  return generationSpecSchema.parse(input);
}

function durationText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const parts: string[] = [];
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (remainder) parts.push(`${remainder} second${remainder === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export function compileLyriaPrompt(spec: GenerationSpec): string {
  const lines = [
    `Create a full-length ${spec.intent.instrumental ? 'instrumental composition' : 'song with vocals'}.`,
    `Purpose: ${spec.intent.purpose}.`,
    spec.intent.mood.length ? `Mood: ${spec.intent.mood.join(', ')}.` : '',
    spec.intent.narrative ? `Narrative: ${spec.intent.narrative}.` : '',
    `Target duration: ${durationText(spec.intent.durationSeconds)}.`,
    spec.composition.bpm !== null ? `Tempo: ${spec.composition.bpm} BPM.` : '',
    spec.composition.key ? `Key: ${spec.composition.key}.` : '',
    spec.composition.meter ? `Meter: ${spec.composition.meter}.` : '',
    spec.composition.sections.length ? `Structure: ${spec.composition.sections.join(' → ')}.` : '',
    spec.composition.arrangement ? `Arrangement: ${spec.composition.arrangement}.` : '',
    `Style vocabulary: ${spec.sound.styles.join(', ')}.`,
    `Novelty: ${spec.sound.novelty}/100; preserve coherence while avoiding generic choices.`,
    !spec.intent.instrumental && spec.performance.vocalRange ? `Vocal range: ${spec.performance.vocalRange}.` : '',
    !spec.intent.instrumental && spec.performance.timbre ? `Vocal timbre: ${spec.performance.timbre}.` : '',
    !spec.intent.instrumental && spec.performance.delivery ? `Vocal delivery: ${spec.performance.delivery}.` : '',
    spec.sound.exclusions.length ? `Avoid: ${spec.sound.exclusions.join(', ')}.` : '',
    !spec.intent.instrumental && spec.composition.lyrics ? `Use these exact section-tagged lyrics:\n${spec.composition.lyrics}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
