import { z } from "zod";

import { LIMITS } from "./limits";

/**
 * Opaque identifier. Must start with an alphanumeric character, so reserved object keys
 * such as `__proto__` can never be used as an id (ids double as record keys in UI state).
 */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(LIMITS.idLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Must be alphanumeric with optional '_' or '-'");
export type Identifier = z.infer<typeof IdentifierSchema>;

/** Monotonic artifact revision, starting at 1. */
export const RevisionSchema = z.int().min(1);
export type Revision = z.infer<typeof RevisionSchema>;

/** ISO 8601 timestamp with an explicit UTC offset. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Single-line, human-readable text: trimmed, non-empty, free of control characters. */
export function singleLineText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .regex(/^[^\p{Cc}]*$/u, "Must not contain control characters");
}
