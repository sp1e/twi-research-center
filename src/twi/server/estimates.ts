import type { CostEstimate, GenerationSpec } from '../domain/types';

import { HttpError } from './http';

/**
 * What a render is expected to cost, quoted BEFORE it is submitted.
 *
 * The product rule this implements is locked, and it is the reason `twi_cost_events`
 * exists at all: *no hard budget cap, but every job shows ESTIMATED cost before
 * submission and records ACTUAL cost after.* Those are two halves of one mechanism.
 * The estimate is quoted here and stored on the job (`twi_jobs.estimate_json`) with a
 * matching `category = 'estimate'` cost row; the actual provider, finishing and
 * storage costs are appended later under their own categories and `actual_cost_usd` is
 * RECOMPUTED from `SUM(amount_usd) WHERE category <> 'estimate'`. So the estimate can
 * never be mistaken for a charge, and a charge can never be hidden inside the estimate.
 *
 * INJECTABLE, and not for tidiness. A hard-coded number inside the submit path is a
 * number nobody can quote back at a review, and this one is going to change: Lyria 3
 * Pro's preview pricing has no stable published rate, so the provider component is
 * deliberately NOT invented here. It is reported as `unavailable` — which is a
 * different statement from "zero" — until deployment configures
 * {@link PROVIDER_ESTIMATE_VARIABLE}, and the confirmation text says out loud that the
 * actual provider cost is recorded either way.
 */

/** Modal finishing, per render. Two candidates, one finishing pass each. */
export const FINISHING_ESTIMATE_USD = 0.04;

/** R2 for the raw, master, preview and provenance objects of both candidates. */
export const STORAGE_ESTIMATE_USD = 0.01;

/** Wall-clock the wizard shows against the progress bar, not a timeout. */
export const ESTIMATED_SECONDS = 360;

/**
 * The deployment variable that turns the provider component from `unavailable` into a
 * quote. A Pages environment variable, so it arrives as a string or not at all.
 */
export const PROVIDER_ESTIMATE_VARIABLE = 'TWI_LYRIA_ESTIMATE_USD';

export type ProviderEstimateStatus = 'estimated' | 'unavailable';

export interface EstimatePolicy {
  /**
   * Whether the deployment configured a provider rate AT ALL — which is a different
   * question from whether that rate is zero. See {@link providerRateConfigured}.
   */
  readonly providerConfigured: boolean;
  estimate(spec: GenerationSpec): Promise<CostEstimate>;
}

export interface JobEstimateView {
  estimate: CostEstimate;
  /**
   * The provider component, LABELLED. `amountUsd: 0` with
   * `status: 'unavailable'` says "not priced"; the same zero with
   * `status: 'estimated'` would say "free". The wizard must be able to tell those
   * apart before the owner authorises a paid render, and a bare number cannot.
   */
  provider: { status: ProviderEstimateStatus; amountUsd: number };
  confirmation: string;
}

const ACTUAL_COST_SENTENCE =
  'The actual provider cost is measured after the render and recorded against this job; this estimate does not cap it.';

const UNAVAILABLE_SENTENCE =
  `Provider pricing is not configured (${PROVIDER_ESTIMATE_VARIABLE} is unset), so the provider component is unavailable rather than zero.`;

/**
 * Reads the configured provider rate, or refuses.
 *
 * Absent and blank mean "not configured" and quote `unavailable`. Anything present but
 * unusable — negative, non-numeric, or an overflow like `1e999` that `Number` turns
 * into `Infinity` — is a MISCONFIGURATION and the request is refused rather than
 * quoted at zero. Quoting zero for a misconfigured rate is the one outcome that would
 * let the owner authorise a paid render against a number the deployment did not mean.
 */
export function providerEstimateUsd(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim().length === 0) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(
      500,
      `${PROVIDER_ESTIMATE_VARIABLE} must be a non-negative number`,
      'estimate_misconfigured',
    );
  }
  return parsed;
}

/**
 * Whether a provider rate was CONFIGURED — not whether it is non-zero.
 *
 * This is the distinction {@link JobEstimateView.provider} exists to draw, and reading it
 * off the AMOUNT could not draw it: `providerEstimateUsd` answers `0` both for an absent
 * variable and for a deliberate `TWI_LYRIA_ESTIMATE_USD=0`, so a deployment that priced the
 * provider component at zero was told, in owner-facing confirmation text on a money path,
 * that the variable "is unset". That is a specific falsehood about the deployment's own
 * configuration. Presence is the only thing that separates the two, so presence is what is
 * tested here: absent, `undefined` and blank are unconfigured; `'0'` is configured, and
 * therefore FREE rather than unpriced.
 */
export const providerRateConfigured = (raw: string | null | undefined): boolean =>
  typeof raw === 'string' && raw.trim().length > 0;

/**
 * The policy, built around whatever the deployment configured.
 *
 * `total` is COMPUTED from the components rather than written as a literal, so the
 * identity `total === provider + finishing + storage` cannot drift from the numbers it
 * describes — and a component added later is included by construction.
 */
export function creationCoreEstimatePolicy(raw: string | null | undefined): EstimatePolicy {
  return {
    providerConfigured: providerRateConfigured(raw),
    async estimate(): Promise<CostEstimate> {
      const provider = providerEstimateUsd(raw);
      return {
        currency: 'USD',
        provider,
        finishing: FINISHING_ESTIMATE_USD,
        storage: STORAGE_ESTIMATE_USD,
        total: provider + FINISHING_ESTIMATE_USD + STORAGE_ESTIMATE_USD,
        estimatedSeconds: ESTIMATED_SECONDS,
      };
    },
  };
}

/** The unconfigured policy: everything but the unpriced provider component. */
export const fixedCreationCoreEstimate: EstimatePolicy = creationCoreEstimatePolicy(null);

/**
 * The wire shape, with the provider component labelled and the promise stated.
 *
 * The label comes from whether the rate was CONFIGURED, never from the amount: a configured
 * `0` is `estimated` at `amountUsd: 0` — "free" — while an absent variable is `unavailable`,
 * and the confirmation sentence about the variable being unset is then true whenever it is
 * shown. Deriving the label from `estimate.provider === 0` collapsed those two.
 */
export function estimateView(estimate: CostEstimate, providerConfigured: boolean): JobEstimateView {
  const status: ProviderEstimateStatus = providerConfigured ? 'estimated' : 'unavailable';
  return {
    estimate,
    provider: { status, amountUsd: estimate.provider },
    confirmation:
      status === 'unavailable' ? `${UNAVAILABLE_SENTENCE} ${ACTUAL_COST_SENTENCE}` : ACTUAL_COST_SENTENCE,
  };
}
