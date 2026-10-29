/**
 * Building blocks that reproduce the serde attributes stremio-core uses, so each
 * schema reads like the Rust struct it ports.
 *
 * | serde (stremio-core)                     | here                          |
 * |------------------------------------------|-------------------------------|
 * | `Option<T>` (missing or null is `None`)  | `optional(schema)`            |
 * | `#[serde(default)] T` (null is an error) | `schema.default(() => value)` |
 * | `DefaultOnNull` + `#[serde(default)]`    | `defaultOnNull(schema, fn)`   |
 * | `DefaultOnError<NoneAsEmptyString> Url`  | `lenientUrl`                  |
 * | `NumberAsString`                         | `numberAsString`              |
 */
import { z } from 'zod';

/** A string the WHATWG URL parser accepts as an absolute URL (Rust's `url::Url`). */
export const urlString = z.string().refine((value) => URL.canParse(value), {
  message: 'Invalid URL',
});

/** `u16`, as used for `fileIdx`. */
export const u16 = z.number().int().min(0).max(0xffff);

/** `u32`, as used for season and episode numbers. */
export const u32 = z.number().int().min(0).max(0xffff_ffff);

/** `u64`/`usize`. Values above 2^53 lose precision, as they would in any JS client. */
export const u64 = z.number().int().min(0);

/** `Option<T>` with `#[serde(default)]`: a missing key or `null` becomes `undefined`. */
export function optional<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value): z.output<T> | undefined => value ?? undefined);
}

/** `#[serde(default)]` + `DefaultOnNull`: a missing key or `null` becomes the default. */
export function defaultOnNull<T extends z.ZodType>(schema: T, fallback: () => z.output<T>) {
  return schema.nullish().transform((value): z.output<T> => value ?? fallback());
}

/**
 * `DefaultOnError<NoneAsEmptyString>` on an `Option<Url>`: anything other than a
 * valid absolute URL (missing, null, empty, not a string, unparsable) becomes
 * `undefined` instead of failing the item.
 */
export const lenientUrl = z
  .unknown()
  .optional()
  .transform((value): string | undefined =>
    typeof value === 'string' && value !== '' && URL.canParse(value) ? value : undefined,
  );

/** `NumberAsString`: a JSON number or string, kept as a string (`2010` → `"2010"`). */
export const numberAsString = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value));

// chrono's `DateTime<Utc>` parser accepts RFC 3339 date-times; a space may stand in for `T`.
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** Parses an RFC 3339 date-time into an ISO 8601 UTC string, or `undefined`. */
export function parseDateTime(value: string): string | undefined {
  if (!RFC3339.test(value)) return undefined;
  const ms = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Converts epoch milliseconds into an ISO 8601 UTC string, or `undefined` if out of range. */
export function millisToDateTime(value: number): string | undefined {
  if (!Number.isInteger(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
