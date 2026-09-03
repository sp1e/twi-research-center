import { toSingleLineText } from '../domain/text';

import { HttpError, json, parseJson } from './http';
import { clockOf, requireJob, type JobDeps } from './jobs';
import {
  CANDIDATE_LABELS,
  PROVIDER_CALL_RESOLUTIONS,
  type ProviderCallRecord,
  type ProviderCallResolution,
} from './provider-call-types';
import type { CandidateLabel } from './repository-types';

/**
 * The reconciliation route: the human half of the ambiguous-paid-call state machine.
 *
 * WHY IT EXISTS. `retryJob` refuses while any of a job's provider calls has a charge that
 * is not known to be absent and that nobody has resolved. That refusal is what stops a
 * retry buying a second pair of renders, because a retried Workflow starts at `load-job`
 * and re-runs both `generate` steps. Until this route existed the only way to clear such a
 * row was to run `TwiRepository.resolveProviderCall` against the real database by hand, so
 * the gate could block an owner with no way out that did not involve an engineer.
 *
 * A THIRD MODULE IN THE JOB USE CASE, and the reason is the one that split
 * `jobs-cancel-retry` out of `jobs`: this acts on a job whose money is already spent, and
 * it must never create a job, a specification or a cost row. `saveSpec`,
 * `createEstimatedJob` and `appendCost` are not imported here and must never be. Section 13
 * of the contract check reads all three modules as one corpus and refuses an absent one by
 * name, so moving a function between them changes nothing it can see.
 *
 * WHAT IT MAY AND MAY NOT DO. A resolution makes an unknown charge KNOWN, or acknowledges a
 * charge that is already known. It never relabels one:
 *
 *   charge unknown  (submitting, ambiguous) -> `to` REQUIRED, accepted or abandoned
 *   charge known    (completed, accepted, abandoned) -> `to` FORBIDDEN; the note stands alone
 *
 * The second rule is the laundering refusal. Allowing `accepted -> abandoned` would let a
 * charged call be relabelled as never charged, which is the one write that makes the retry
 * gate stop blocking on a call that really was paid for. A refund is a different fact from
 * "never charged" and this schema does not model it; if one is ever needed it is a new state
 * with its own certainty, not a rewrite of an old one.
 *
 * EVERY RULE IS CHECKED HERE AS WELL AS IN THE REPOSITORY, and that duplication is
 * deliberate. `resolveProviderCall` enforces its own preconditions with
 * `TwiRepositoryValidationError`, which is not an `HttpError`, so the route file's catch maps
 * it to `internal_error` with a correlation id -- a 500 for a request that was simply wrong.
 * Checking first is what makes a bad request a 400 or a 409 that says which rule it broke.
 * The repository's copy stays as the backstop for a caller that is not this route.
 */

/** The note is a human sentence, not a document. Long enough to cite an invoice line. */
export const MAX_RESOLUTION_NOTE_LENGTH = 500;

/**
 * The raw length accepted before normalization, so a note of padding cannot be used to make
 * the normalizer do unbounded work -- the same shape as `parseProjectName`'s two limits.
 */
const RAW_NOTE_LENGTH_LIMIT = MAX_RESOLUTION_NOTE_LENGTH * 8;

const KNOWN_FIELDS: readonly string[] = ['attempt', 'label', 'to', 'note'];

export interface ResolveProviderCallRequest {
  attempt: number;
  label: CandidateLabel;
  to?: ProviderCallResolution;
  note: string;
}

/**
 * Validates the body against every rule that does not depend on the row's current state.
 *
 * Exported so a unit test can drive it without a database, and so the mutation harness has
 * a named target: a parser that silently widened would otherwise only be visible through
 * whichever end-to-end case happened to cover it.
 */
export function parseResolveProviderCallRequest(body: Record<string, unknown>): ResolveProviderCallRequest {
  const unknownFields = Object.keys(body).filter((key) => !KNOWN_FIELDS.includes(key));
  if (unknownFields.length > 0) {
    throw new HttpError(400, `unknown field: ${unknownFields.join(', ')}`, 'unknown_field');
  }

  const { attempt, label } = body;
  // `Number.isInteger` rather than a typeof check plus a modulo: D1 stores `attempt` in an
  // INTEGER column whose CHECK refuses a real, and a numeric STRING would be converted by
  // affinity before that CHECK ever ran. So the string has to be refused here or not at all.
  if (!Number.isInteger(attempt) || (attempt as number) < 0 || !CANDIDATE_LABELS.includes(label as CandidateLabel)) {
    throw new HttpError(
      400,
      `attempt must be an integer of 0 or more and label one of ${CANDIDATE_LABELS.join(', ')}`,
      'invalid_provider_call_identity',
    );
  }

  // Present-and-wrong is refused; absent is the "acknowledge only" case and is legal here.
  // `null` counts as present: a caller that sends it meant to say something.
  if ('to' in body && !PROVIDER_CALL_RESOLUTIONS.includes(body.to as ProviderCallResolution)) {
    throw new HttpError(
      400,
      `to must be one of ${PROVIDER_CALL_RESOLUTIONS.join(', ')} when given`,
      'invalid_resolution',
    );
  }

  const rawNote = body.note;
  const invalidNote = new HttpError(
    400,
    `note is required and must be 1-${MAX_RESOLUTION_NOTE_LENGTH} characters of text`,
    'invalid_resolution_note',
  );
  if (typeof rawNote !== 'string' || rawNote.length > RAW_NOTE_LENGTH_LIMIT) throw invalidNote;
  // Normalization rather than `trim()`: a note of zero-width spaces survives trimming and
  // would reach the repository's nonblank assertion as a 500, then the
  // `twi_provider_calls_resolution_pair` CHECK. Stored normalized, so the audit trail reads
  // the same way whoever typed it.
  const note = toSingleLineText(rawNote);
  if (note.length === 0 || note.length > MAX_RESOLUTION_NOTE_LENGTH) throw invalidNote;

  return {
    attempt: attempt as number,
    label: label as CandidateLabel,
    ...('to' in body ? { to: body.to as ProviderCallResolution } : {}),
    note,
  };
}

/**
 * Refuses the two rules that depend on what the row currently says.
 *
 * Separate from the parser because these need the row, and 409 rather than 400 because the
 * request is well formed -- it is the ledger that makes it wrong, and the same body may be
 * correct a moment later or against a different call.
 */
function assertResolutionMatchesCharge(call: ProviderCallRecord, to: ProviderCallResolution | undefined): void {
  const chargeUnknown = call.chargeCertainty === 'unknown';
  if (chargeUnknown && to === undefined) {
    throw new HttpError(
      409,
      `attempt ${call.attempt} candidate ${call.label} is ${call.state}, so its charge is unknown; ` +
        `resolving it requires to=${PROVIDER_CALL_RESOLUTIONS.join(' or to=')}`,
      'resolution_requires_charge',
    );
  }
  if (!chargeUnknown && to !== undefined) {
    throw new HttpError(
      409,
      `attempt ${call.attempt} candidate ${call.label} is ${call.state}, so its charge is already ` +
        `${call.chargeCertainty}; a resolution acknowledges a known charge and cannot change it`,
      'resolution_cannot_rewrite_charge',
    );
  }
}

const notFound = (jobId: string, attempt: number, label: CandidateLabel): HttpError =>
  new HttpError(
    404,
    `job ${jobId} has no recorded provider call for attempt ${attempt} candidate ${label}`,
    'provider_call_not_found',
  );

// ---------------------------------------------------------------------------
// POST /api/twi/jobs/:id/resolve-provider-call
// ---------------------------------------------------------------------------

/**
 * Answers 200 with the row as it now stands, for both `resolved` and `already-resolved`.
 *
 * `already-resolved` is a 200 and not a 409 because this route is the thing an operator
 * retries when a request times out, so the second call has to be safe. The outcome names
 * which happened, and the returned row is the one that WON -- so a resolution that lost a
 * race reads back as somebody else's note rather than as its own.
 */
export async function resolveProviderCallRoute(
  jobId: string,
  request: Request,
  deps: JobDeps,
): Promise<Response> {
  const body = parseResolveProviderCallRequest(await parseJson(request));
  const job = await requireJob(jobId, deps.repo);

  // Read first, so both state-dependent rules answer 4xx with the row quoted. The write is
  // guarded on the state this read saw, so a row that moves in between cannot be resolved
  // twice -- it comes back `already-resolved` instead.
  const calls = await deps.repo.listProviderCalls(job.id);
  const call = calls.find(({ attempt, label }) => attempt === body.attempt && label === body.label);
  if (!call) throw notFound(job.id, body.attempt, body.label);

  // THE CHARGE RULES COME FIRST, BEFORE the already-resolved short circuit, and the order is
  // load-bearing. Answering 200 `already-resolved` to a request that asked to relabel a
  // charged call as abandoned would report success for a write that is never allowed: nothing
  // changes, but the caller is told its relabel landed, and a script reading the status could
  // not tell the difference. A resolved row always carries a KNOWN charge -- resolving an
  // unknown one requires `to`, which makes it known -- so these rules apply to it unchanged.
  assertResolutionMatchesCharge(call, body.to);

  // An already-resolved row is then reported, never rewritten: the note that landed first is
  // the audit trail, and a repeat with no `to` is the safe retry an operator makes when a
  // request times out.
  if (call.resolvedAt !== null) return json({ call, outcome: 'already-resolved' }, 200);

  const resolution = await deps.repo.resolveProviderCall({
    jobId: job.id,
    attempt: body.attempt,
    label: body.label,
    ...(body.to === undefined ? {} : { to: body.to }),
    note: body.note,
    now: clockOf(deps).now(),
  });
  // `not-found` after a successful read means the row went away underneath this call, which
  // only a job deletion does. Answered as the 404 it is rather than as a 500.
  if (resolution.call === null) throw notFound(job.id, body.attempt, body.label);
  return json({ call: resolution.call, outcome: resolution.outcome }, 200);
}
