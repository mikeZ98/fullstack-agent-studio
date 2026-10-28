import { z } from "zod";

import { LIMITS } from "./limits";

/** Typed application error codes carried as an RFC 9457 extension member. */
export const AppErrorCodeSchema = z.enum([
  "invalid_frame",
  "stream_interrupted",
  "upstream_unavailable",
  "rate_limited",
  "unauthorized",
  "validation_failed",
  "artifact_render_failed",
  "internal",
]);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

const SAFE_URI_SCHEMES = new Set(["https:", "http:", "about:", "urn:", "tag:"]);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * RFC 3986 URI reference (absolute or relative). Absolute URIs are limited to schemes that
 * are safe to render as links, so a problem `type` can never smuggle in `javascript:`.
 */
function isSafeUriReference(value: string): boolean {
  if (/[\s\p{Cc}]/u.test(value)) return false;
  const scheme = SCHEME_RE.exec(value)?.[0].toLowerCase();
  if (scheme !== undefined && !SAFE_URI_SCHEMES.has(scheme)) return false;
  return URL.canParse(value, "https://base.invalid/");
}

export const UriReferenceSchema = z
  .string()
  .min(1)
  .max(LIMITS.uriLength)
  .refine(isSafeUriReference, "Must be a URI reference with a safe scheme");
export type UriReference = z.infer<typeof UriReferenceSchema>;

/** One field-level problem, e.g. a failed schema check. */
export const ValidationIssueSchema = z.strictObject({
  path: z.string().max(LIMITS.issuePathLength),
  message: z.string().min(1).max(LIMITS.issueMessageLength),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/**
 * RFC 9457 Problem Details with this app's extension members (`code`, `retryable`, `errors`).
 *
 * Deliberately *strip* mode rather than strict: RFC 9457 §3.2 requires consumers to ignore
 * unknown extension members. Stripping still keeps them out of the parsed output entirely.
 */
export const ProblemDetailsSchema = z.object({
  type: UriReferenceSchema.default("about:blank"),
  title: z.string().trim().min(1).max(LIMITS.problemTitleLength),
  status: z.int().min(400).max(599),
  detail: z.string().max(LIMITS.problemDetailLength).optional(),
  instance: UriReferenceSchema.optional(),
  code: AppErrorCodeSchema,
  retryable: z.boolean().optional(),
  errors: z.array(ValidationIssueSchema).max(LIMITS.problemErrors).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** Canonical status, title and retry semantics per error code. */
export const PROBLEM_DEFAULTS: Readonly<
  Record<AppErrorCode, Readonly<{ status: number; title: string; retryable: boolean }>>
> = {
  invalid_frame: { status: 502, title: "Malformed stream frame", retryable: false },
  stream_interrupted: { status: 502, title: "Stream interrupted", retryable: true },
  upstream_unavailable: { status: 503, title: "Agent backend unavailable", retryable: true },
  rate_limited: { status: 429, title: "Too many requests", retryable: true },
  unauthorized: { status: 401, title: "Unauthorized", retryable: false },
  validation_failed: { status: 422, title: "Validation failed", retryable: false },
  artifact_render_failed: { status: 422, title: "Artifact failed to render", retryable: false },
  internal: { status: 500, title: "Internal error", retryable: false },
};

export interface ProblemOverrides {
  detail?: string;
  instance?: UriReference;
  errors?: ValidationIssue[];
}

/** Build a schema-valid problem for `code`, filled from PROBLEM_DEFAULTS. */
export function createProblem(
  code: AppErrorCode,
  overrides: ProblemOverrides = {},
): ProblemDetails {
  return ProblemDetailsSchema.parse({ code, ...PROBLEM_DEFAULTS[code], ...overrides });
}
