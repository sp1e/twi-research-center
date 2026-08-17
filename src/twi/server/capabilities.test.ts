// @vitest-environment node
//
// The capability catalog is a promise to the wizard: it decides which inputs are
// offered and which are explained as unavailable. A wrong value here does not
// crash anything — it silently offers an input the provider will refuse, or hides
// one it supports. So the values are pinned exactly, field by field.
import { describe, expect, it } from 'vitest';

import type { CapabilityCatalog } from '../domain/types';

import { creationCoreCapabilities } from './capabilities';

describe('creationCoreCapabilities', () => {
  it('is exactly the Phase 1 Creation Core catalog', () => {
    expect(creationCoreCapabilities).toEqual({
      provider: 'lyria-3-pro',
      fullSong: true,
      customLyrics: true,
      imageReference: true,
      audioReference: false,
      midiReference: false,
      deterministicSeed: false,
      maxImageReferences: 10,
      outputFormats: ['audio/wav'],
    });
  });

  it('declares no field the frontend contract does not know about', () => {
    // `toEqual` above would miss nothing, but this states the coupling: the
    // response is consumed as CapabilityCatalog, so the key sets must agree.
    const catalog: CapabilityCatalog = {
      provider: creationCoreCapabilities.provider,
      fullSong: creationCoreCapabilities.fullSong,
      customLyrics: creationCoreCapabilities.customLyrics,
      imageReference: creationCoreCapabilities.imageReference,
      audioReference: creationCoreCapabilities.audioReference,
      midiReference: creationCoreCapabilities.midiReference,
      deterministicSeed: creationCoreCapabilities.deterministicSeed,
      maxImageReferences: creationCoreCapabilities.maxImageReferences,
      outputFormats: [...creationCoreCapabilities.outputFormats],
    };

    expect(Object.keys(catalog).sort()).toEqual(Object.keys(creationCoreCapabilities).sort());
  });

  it('caps image references at the number the specification schema also enforces', () => {
    // src/twi/domain/schemas.ts bounds sound.imageAssetIds at 10. If the catalog
    // advertised more, the wizard would collect references the schema rejects.
    expect(creationCoreCapabilities.maxImageReferences).toBe(10);
  });

  it('survives JSON serialization with its array intact', () => {
    expect(JSON.parse(JSON.stringify(creationCoreCapabilities)).outputFormats).toEqual(['audio/wav']);
  });
});
