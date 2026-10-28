import type { z } from "zod";

import { LIMITS } from "./limits";
import { createProblem, type ProblemDetails, type ValidationIssue } from "./problem";
import { type StreamEvent, StreamEventSchema } from "./stream";

/**
 * Resilient consumption of upstream stream frames: every helper returns a result object
 * instead of throwing, so one malformed frame can be reported and skipped without tearing
 * down the whole stream.
 */

export type StreamParseErrorCode =
  | "empty"
  | "too-large"
  | "invalid-json"
  | "invalid-event"
  | "event-mismatch";

export interface StreamParseError {
  code: StreamParseErrorCode;
  /** One line, safe to log or show in a developer console. */
  message: string;
  issues: ValidationIssue[];
}

export type StreamParseResult =
  | { ok: true; event: StreamEvent }
  | { ok: false; error: StreamParseError };

export type SseFrameResult =
  | { kind: "event"; event: StreamEvent; id?: string }
  | { kind: "heartbeat" }
  | { kind: "done" }
  | { kind: "error"; error: StreamParseError };

/** Terminal `data:` value of the AI SDK / OpenAI-style SSE streams. */
export const SSE_DONE_SENTINEL = "[DONE]";

const MAX_SUMMARY_ISSUES = 3;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `["tabs", 0, "artifactId"]` → `tabs[0].artifactId`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** Zod issues → bounded, serializable issues (fits ProblemDetails.errors). */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): ValidationIssue[] {
  return issues.slice(0, LIMITS.problemErrors).map((issue) => ({
    path: truncate(formatIssuePath(issue.path), LIMITS.issuePathLength),
    message: truncate(issue.message, LIMITS.issueMessageLength),
  }));
}

function summarize(issues: readonly ValidationIssue[]): string {
  const shown = issues
    .slice(0, MAX_SUMMARY_ISSUES)
    .map(({ path, message }) => (path === "" ? message : `${path}: ${message}`));
  const more = issues.length - shown.length;
  return more > 0 ? `${shown.join("; ")} (+${more} more)` : shown.join("; ");
}

function parseError(
  code: StreamParseErrorCode,
  message: string,
  issues: ValidationIssue[] = [],
): StreamParseError {
  return { code, message, issues };
}

function failure(...args: Parameters<typeof parseError>): StreamParseResult {
  return { ok: false, error: parseError(...args) };
}

const encoder = new TextEncoder();

function exceedsFrameLimit(text: string): boolean {
  // Cheap bound first: a string never encodes to fewer UTF-8 bytes than it has code units.
  if (text.length > LIMITS.frameBytes) return true;
  if (text.length * 3 <= LIMITS.frameBytes) return false;
  return encoder.encode(text).byteLength > LIMITS.frameBytes;
}

/** Validate an already-decoded value (e.g. a JSON object from another transport). */
export function safeParseStreamEvent(value: unknown): StreamParseResult {
  const result = StreamEventSchema.safeParse(value);
  if (result.success) return { ok: true, event: result.data };
  const issues = formatIssues(result.error.issues);
  return failure("invalid-event", `Invalid stream event: ${summarize(issues)}`, issues);
}

/** Parse the JSON text carried by one SSE `data:` field. */
export function parseStreamEventData(data: string): StreamParseResult {
  if (data.trim() === "") return failure("empty", "Empty stream frame");
  if (exceedsFrameLimit(data)) {
    return failure("too-large", `Stream frame exceeds ${LIMITS.frameBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failure("invalid-json", `Stream frame is not valid JSON: ${truncate(reason, 200)}`);
  }
  return safeParseStreamEvent(value);
}

/**
 * Parse one SSE message block (the text between blank lines) per the WHATWG
 * event-stream rules: `data:` lines are joined with "\n", `:` lines are comments, and a
 * single space after the colon is dropped. A named `event:` must agree with the payload type.
 */
export function parseSseFrame(frame: string): SseFrameResult {
  if (exceedsFrameLimit(frame)) {
    return {
      kind: "error",
      error: parseError("too-large", `SSE frame exceeds ${LIMITS.frameBytes} bytes`),
    };
  }

  const data: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id" && !value.includes("\0")) id = value;
  }

  if (data.length === 0) return { kind: "heartbeat" };
  const payload = data.join("\n");
  if (payload === SSE_DONE_SENTINEL) return { kind: "done" };

  const parsed = parseStreamEventData(payload);
  if (!parsed.ok) return { kind: "error", error: parsed.error };
  const { event } = parsed;
  if (eventName !== undefined && eventName !== "message" && eventName !== event.type) {
    return {
      kind: "error",
      error: parseError(
        "event-mismatch",
        `SSE event name "${truncate(eventName, 64)}" does not match payload type "${event.type}"`,
      ),
    };
  }
  return id === undefined ? { kind: "event", event } : { kind: "event", event, id };
}

/** Wrap a parse failure in the app's error envelope (upstream sent garbage → 502). */
export function streamParseErrorToProblem(error: StreamParseError): ProblemDetails {
  return createProblem("invalid_frame", {
    detail: truncate(error.message, LIMITS.problemDetailLength),
    ...(error.issues.length > 0 ? { errors: error.issues } : {}),
  });
}
