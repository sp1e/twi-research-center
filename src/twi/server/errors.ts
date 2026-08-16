/**
 * Error taxonomy for the TWI repository boundary.
 *
 * Every throw site carries a distinct message plus a structured `context` bag.
 * A Cloudflare Workflow drives most of these paths unattended, so an operator
 * reading a log line needs to know *which* job, *which* event key and *what the
 * database actually reported* — a bare message is not a diagnosis.
 */

export type TwiErrorContext = Record<string, unknown>;

abstract class TwiRepositoryError extends Error {
  /** Structured diagnostic detail for logs. Never contains caller payload bodies. */
  readonly context: TwiErrorContext;

  protected constructor(message: string, context: TwiErrorContext = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.context = context;
  }
}

/** The caller supplied an input the boundary refuses to persist. Nothing was bound. */
export class TwiRepositoryValidationError extends TwiRepositoryError {
  override readonly name = 'TwiRepositoryValidationError';

  constructor(message: string, context: TwiErrorContext = {}, options?: { cause?: unknown }) {
    super(message, context, options);
  }
}

/** Stored data could not be interpreted. Indicates damage, not a caller mistake. */
export class TwiRepositoryCorruptionError extends TwiRepositoryError {
  override readonly name = 'TwiRepositoryCorruptionError';

  constructor(message: string, context: TwiErrorContext = {}, options?: { cause?: unknown }) {
    super(message, context, options);
  }
}

/** An idempotency key was reused for a materially different request. */
export class TwiRepositoryCollisionError extends TwiRepositoryError {
  override readonly name = 'TwiRepositoryCollisionError';

  constructor(message: string, context: TwiErrorContext = {}, options?: { cause?: unknown }) {
    super(message, context, options);
  }
}

/** The write could not be applied against the state the caller expected. */
export class TwiRepositoryConflictError extends TwiRepositoryError {
  override readonly name = 'TwiRepositoryConflictError';

  constructor(message: string, context: TwiErrorContext = {}, options?: { cause?: unknown }) {
    super(message, context, options);
  }
}

export function validation(message: string, context: TwiErrorContext = {}): never {
  throw new TwiRepositoryValidationError(message, context);
}

export function corruption(message: string, context: TwiErrorContext = {}, cause?: unknown): never {
  throw new TwiRepositoryCorruptionError(message, context, cause === undefined ? undefined : { cause });
}

export function collision(message: string, context: TwiErrorContext = {}, cause?: unknown): never {
  throw new TwiRepositoryCollisionError(message, context, cause === undefined ? undefined : { cause });
}

export function conflict(message: string, context: TwiErrorContext = {}, cause?: unknown): never {
  throw new TwiRepositoryConflictError(message, context, cause === undefined ? undefined : { cause });
}
