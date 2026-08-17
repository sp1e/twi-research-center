import type { CapabilityCatalog } from '../domain/types';

/**
 * What the initial authorized provider can actually do, stated once.
 *
 * The wizard reads this to decide which inputs to offer and which to EXPLAIN as
 * unavailable. That distinction is the point: Phase 1 accepts text, custom lyrics
 * and up to ten image references because Lyria 3 Pro supports them, and reports
 * audio and MIDI reference as unavailable rather than accepting the input and
 * dropping it on the way to a paid render.
 *
 * `maxImageReferences` agrees with the bound on `sound.imageAssetIds` in
 * src/twi/domain/schemas.ts. Advertising more would invite the wizard to collect
 * references the specification schema then rejects.
 */

/**
 * The catalog as a frozen literal. `CapabilityCatalog` declares `outputFormats`
 * as a mutable array, which a `readonly` tuple is not assignable to, so the
 * drift guard is stated against a readonly view of the same contract — a missing
 * field, a stray field or a wrong type still fails to compile.
 */
type ReadonlyCapabilityCatalog = Omit<CapabilityCatalog, 'outputFormats'> & {
  readonly outputFormats: readonly CapabilityCatalog['outputFormats'][number][];
};

export const creationCoreCapabilities = {
  provider: 'lyria-3-pro',
  fullSong: true,
  customLyrics: true,
  imageReference: true,
  audioReference: false,
  midiReference: false,
  deterministicSeed: false,
  maxImageReferences: 10,
  outputFormats: ['audio/wav'],
} as const satisfies ReadonlyCapabilityCatalog;
