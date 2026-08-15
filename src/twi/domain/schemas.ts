import { z } from 'zod';
import type { GenerationSpec } from './types';

const cleanList = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
const normalizedList = (maximumEntries: number, maximumItemLength: number, minimumEntries = 0) => z
  .array(z.string())
  .transform(cleanList)
  .pipe(z.array(z.string().max(maximumItemLength)).min(minimumEntries).max(maximumEntries));
const uuid = z.string().uuid();

export const generationSpecSchema: z.ZodType<GenerationSpec> = z.object({
  intent: z.object({
    purpose: z.string().trim().min(1).max(160),
    mood: normalizedList(16, 80),
    narrative: z.string().trim().max(4_000),
    durationSeconds: z.number().int().min(30).max(240),
    instrumental: z.boolean(),
  }).strict(),
  composition: z.object({
    lyrics: z.string().trim().max(16_000),
    sections: normalizedList(64, 100),
    bpm: z.number().min(30).max(300).nullable(),
    key: z.string().trim().max(64),
    meter: z.string().trim().max(32),
    arrangement: z.string().trim().max(2_000),
  }).strict(),
  sound: z.object({
    styles: normalizedList(32, 100, 1),
    exclusions: normalizedList(32, 160),
    novelty: z.number().min(0).max(100),
    imageAssetIds: z.array(uuid).max(10),
  }).strict(),
  performance: z.object({
    mode: z.literal('generic'),
    vocalRange: z.string().trim().max(100),
    timbre: z.string().trim().max(300),
    delivery: z.string().trim().max(300),
  }).strict(),
  rightsAccepted: z.literal(true),
}).strict();

export const estimateRequestSchema = z.object({
  projectId: uuid,
  spec: generationSpecSchema,
}).strict();

export const submitJobSchema = estimateRequestSchema.extend({
  idempotencyKey: uuid,
}).strict();
