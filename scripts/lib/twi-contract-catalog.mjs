/**
 * twi-contract-catalog.mjs — sections 7 and 8 of the TWI contract check: the capability catalog
 * the wizard reads to decide what to offer, and the bounds on a project name.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs.
 */

/** Sections 7 and 8. */
export const checkCatalogAndProjects = (context, check) => {
  const { capabilities, projects } = context;

  // ── 7. Capability catalog: the wizard reads these to decide what to offer ────
  check(
    'capability catalog reports the Creation Core provider and its limits',
    /provider: 'lyria-3-pro'/.test(capabilities) &&
      /fullSong: true/.test(capabilities) &&
      /customLyrics: true/.test(capabilities) &&
      /imageReference: true/.test(capabilities) &&
      /maxImageReferences: 10/.test(capabilities) &&
      /outputFormats: \['audio\/wav'\]/.test(capabilities),
  );
  check(
    'capability catalog reports the Phase 1 unavailable inputs as unavailable',
    /audioReference: false/.test(capabilities) &&
      /midiReference: false/.test(capabilities) &&
      /deterministicSeed: false/.test(capabilities),
  );

  // ── 8. Project names ─────────────────────────────────────────────────────────
  check(
    'project names are bounded at 120 characters and required',
    /MAX_PROJECT_NAME_LENGTH = 120/.test(projects) && /toSingleLineText/.test(projects),
  );
  check(
    'project creation mints its own id and ISO timestamp rather than asking SQL',
    /crypto\.randomUUID\(\)/.test(projects) &&
      /new Date\(\)\.toISOString\(\)/.test(projects) &&
      !/datetime\('now'\)/.test(projects),
  );
};
