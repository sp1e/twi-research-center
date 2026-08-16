import { validation } from './errors';
import { MAX_FINITE_DATABASE_NUMBER, type JsonValue } from './repository-types';

/**
 * `YYYY-MM-DDTHH:MM:SS.sssZ` — the only timestamp shape this layer accepts.
 *
 * Two columns are advanced with SQLite's scalar `MAX(updated_at, ?)`, which is a
 * BINARY comparison over TEXT. `max('2026-08-16T05:00:00.000Z','now')` is
 * `'now'`, because `'n'` (0x6E) outranks every digit. A single non-ISO write
 * therefore does not merely store one wrong row: `MAX` keeps preferring it over
 * every future correct timestamp, so the column latches and no ordinary write
 * can repair it. Fixed-width UTC input is what makes the comparison correct.
 */
const ISO_UTC_MILLISECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_MILLISECOND.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function assertNonBlank(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    validation(`${field} must be nonblank`, { field });
  }
}

export function assertNullableNonBlank(field: string, value: unknown): asserts value is string | null {
  if (value !== null) assertNonBlank(field, value);
}

/**
 * Rejects anything that is not a fixed-width ISO-8601 UTC millisecond timestamp.
 * See {@link ISO_UTC_MILLISECOND} for why this is a correctness guard and not
 * cosmetics.
 */
export function assertTimestamp(field: string, value: unknown): asserts value is string {
  if (!isIsoUtcTimestamp(value)) {
    validation(`${field} must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)`, {
      field,
      received: typeof value === 'string' ? value : typeof value,
    });
  }
}

export function assertNullableTimestamp(field: string, value: unknown): asserts value is string | null {
  if (value !== null) assertTimestamp(field, value);
}

export function assertFiniteNonnegative(
  field: string,
  value: unknown,
  nullable = false,
): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_FINITE_DATABASE_NUMBER) {
    validation(`${field} must be finite, nonnegative, and less than 1e308`, { field });
  }
}

export function assertEnum<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    validation(`${field} is invalid`, { field, allowed });
  }
}

export function assertPlainObject(field: string, value: unknown): asserts value is Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    validation(`${field} must be a JSON object`, { field });
  }
}
