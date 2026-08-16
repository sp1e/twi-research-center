import { generationSpecSchema } from './schemas';
import type { NormalizedGenerationSpec } from './schemas';
import { VOCAL_DIRECTIVE_PREFIXES, containsLineBreak } from './text';

export function normalizeGenerationSpec(input: unknown): NormalizedGenerationSpec {
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

// Defence in depth. The schema already guarantees both of these, so a failure here
// means a spec reached the compiler without being validated — which is exactly the
// case that must fail loudly rather than quietly bill a wrong generation.
function assertDirectivesAreSingleLine(directives: readonly string[]): void {
  const offender = directives.findIndex(containsLineBreak);
  if (offender !== -1) {
    throw new Error(`compileLyriaPrompt: directive ${offender} contains a line break; the spec was not normalized`);
  }
}

function assertInstrumentalIsSilent(prompt: string): void {
  const offender = prompt
    .split('\n')
    .find((line) => VOCAL_DIRECTIVE_PREFIXES.some((prefix) => line.startsWith(prefix)));
  if (offender !== undefined) {
    throw new Error(`compileLyriaPrompt: instrumental prompt carries a vocal directive: ${offender}`);
  }
}

export function compileLyriaPrompt(spec: NormalizedGenerationSpec): string {
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
    spec.performance.vocalRange ? `Vocal range: ${spec.performance.vocalRange}.` : '',
    spec.performance.timbre ? `Vocal timbre: ${spec.performance.timbre}.` : '',
    spec.performance.delivery ? `Vocal delivery: ${spec.performance.delivery}.` : '',
    spec.sound.exclusions.length ? `Avoid: ${spec.sound.exclusions.join(', ')}.` : '',
    spec.composition.lyrics ? `Use these exact section-tagged lyrics:\n${spec.composition.lyrics}` : '',
  ];
  // Every entry but the lyrics block is a single directive line.
  assertDirectivesAreSingleLine(lines.slice(0, -1));
  const prompt = lines.filter(Boolean).join('\n');
  if (spec.intent.instrumental) assertInstrumentalIsSilent(prompt);
  return prompt;
}
