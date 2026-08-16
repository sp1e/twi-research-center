import { assertNonBlank, assertPlainObject } from './assertions';
import { corruption, validation } from './errors';
import type { JsonValue } from './repository-types';

/**
 * Canonical JSON: recursively key-sorted, non-finite numbers rejected.
 *
 * Every idempotency decision in this layer rests on comparing a stored payload
 * against a freshly built one. Canonicalising both sides is what makes key
 * reordering and whitespace unable to fake — or break — a match.
 */
export function canonicalizeJson(value: JsonValue, reject: (reason: string) => never, path = '$'): JsonValue {
  if (typeof value === 'number' && !Number.isFinite(value)) reject(`${path} contains a non-finite number`);
  if (Array.isArray(value)) return value.map((child, index) => canonicalizeJson(child, reject, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key]!, reject, `${path}.${key}`)]),
    );
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    reject(`${path} contains an unsupported JSON value`);
  }
  return value;
}

export function canonicalStringify(
  value: Record<string, JsonValue>,
  reject: (reason: string) => never,
): string {
  return JSON.stringify(canonicalizeJson(value, reject));
}

/** Parses caller-supplied JSON text into a canonical object plus its canonical text. */
export function parseInputObjectJson(
  field: string,
  json: unknown,
): { object: Record<string, JsonValue>; canonical: string } {
  assertNonBlank(field, json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    validation(`${field} must contain valid JSON`, { field });
  }
  assertPlainObject(field, parsed);
  const canonical = canonicalStringify(parsed, (reason) => validation(`${field} ${reason}`, { field }));
  return { object: JSON.parse(canonical) as Record<string, JsonValue>, canonical };
}

export function parseStoredObjectJson(
  json: string | null,
  context: string,
  nullable: true,
): Record<string, unknown> | null;
export function parseStoredObjectJson(json: string, context: string, nullable?: false): Record<string, unknown>;
export function parseStoredObjectJson(
  json: string | null,
  context: string,
  nullable = false,
): Record<string, unknown> | null {
  if (json === null) {
    if (nullable) return null;
    corruption(`corrupt ${context}: unexpected null`, { context });
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown JSON error';
    corruption(`corrupt ${context}: ${reason}`, { context }, error);
  }
}

export function canonicalStoredObjectJson(json: string, context: string): string {
  return canonicalStringify(parseStoredObjectJson(json, context) as Record<string, JsonValue>, (reason) =>
    corruption(`corrupt ${context}: ${reason}`, { context }),
  );
}
