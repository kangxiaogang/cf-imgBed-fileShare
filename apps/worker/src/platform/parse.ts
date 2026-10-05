import { MAX_EXPIRATION_DAYS, MULTIPART_UPLOAD_THRESHOLD_BYTES } from "@picoshare/shared";

export const nowIso = (): string => new Date().toISOString();

export function parseExpirationDays(input: string | null): number | null {
  const n = Number.parseInt(input ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_EXPIRATION_DAYS) : null;
}

export function expirationToISO(days: number | null): string | null {
  if (!days) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time <= Date.now();
}

export function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parsePartNumber(input: string | null): number | null {
  if (!input || !/^\d+$/.test(input)) return null;
  const n = Number.parseInt(input, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const useMultipart = (size: number): boolean =>
  Number.isFinite(size) && size >= MULTIPART_UPLOAD_THRESHOLD_BYTES;

export function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function tryDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function positiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Never return 0: callers gate on truthiness, so a floored fraction (0.5 -> 0) would
  // read as "no limit configured" and silently disable the cap it was meant to set.
  const i = Math.floor(n);
  return i < 1 ? null : Math.min(i, max);
}

export const asFile = (value: unknown): File | null => (value instanceof File ? value : null);

/*
 * Strict field readers, for bodies where a wrong type is an error rather than something to
 * coerce away.
 *
 * These exist because the lenient readers above return `""`/`null`/`0` for anything
 * unusable, and a lenient reader cannot distinguish "field absent" from "field present but the
 * wrong type". For a flag that decides whether an expiry is set, that difference matters: any
 * truthy value used to pass, so `{deleteAfterExpiration: "false"}` turned the expiry on while
 * the same-shaped field in `updateSettings` was rejected with a `typeof` check. Deciding which
 * fields are strict per call site is how those two drifted apart in the first place.
 *
 * Each returns `null` for the wrong type so `=== null` is the invalid check and the caller
 * supplies the Chinese message.
 */

/** A real boolean, or `null` for every other JSON value including `"true"` and `1`. */
export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A finite number, or `null`. Rejects the numeric strings `positiveInt` accepts: this is for
 * fields the API documents as JSON numbers, where a string is a client bug worth reporting
 * rather than a form field worth coercing.
 */
export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A number within `[min, max]`, or `null`. Use where the bounds are part of the contract
 * rather than a silent clamp.
 */
export function boundedNumber(value: unknown, min: number, max: number): number | null {
  const n = finiteNumber(value);
  return n !== null && n >= min && n <= max ? n : null;
}

/**
 * A positive whole number, clamped to `max`, or `null`.
 *
 * `positiveInt` clamps the same way but coerces with `Number`, so it accepts `"30"`; this is
 * its strict counterpart for JSON bodies, where a string where a number is documented is a client
 * bug worth reporting. The bound is a clamp rather than a rejection for a reason
 * `boundedNumber` cannot serve here: the create path has always clamped, so rejecting on update
 * would give one value two answers depending on which endpoint it arrived at.
 */
export function strictPositiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  const n = finiteNumber(value);
  if (n === null) return null;
  const i = Math.floor(n);
  // Floored rather than kept. Above 1 this matches what the date maths does anyway, because
  // `expirationToISO` goes through `setUTCDate`, which truncates its argument; below 1 it does
  // not, because truncating "today plus half a day" yields today — an expiry that has already
  // passed. Flooring turns that into a rejected value instead of a file that dies on arrival.
  // Never 0: callers gate on truthiness, so a fraction that floors to nothing would read as
  // "no limit configured" and silently disable the bound it was meant to set.
  return i < 1 ? null : Math.min(i, max);
}

/** A trimmed, non-empty string of at most `max` characters, or `null`. */
export function nonEmptyString(value: unknown, max: number): string | null {
  return str(value, max) || null;
}
