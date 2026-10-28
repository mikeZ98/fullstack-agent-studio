import { z } from "zod";

import { ArtifactLanguageSchema, ArtifactTypeSchema, checkArtifactLanguage } from "./artifact";
import { JsonValueSchema } from "./json";
import { LIMITS } from "./limits";
import { IdentifierSchema, RevisionSchema, singleLineText } from "./primitives";
import { ProblemDetailsSchema } from "./problem";

/**
 * Wire protocol of the agent backend (BACKEND_SSE_URL): one JSON object per SSE `data:`
 * field, discriminated by `type`. Every event object is strict, so unknown or reserved keys
 * (`__proto__`, ...) are rejected rather than carried into client state.
 */

const DeltaSchema = z.string().min(1).max(LIMITS.deltaChars);

export const ToolNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.toolNameLength)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "Must be a tool identifier");
export type ToolName = z.infer<typeof ToolNameSchema>;

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "abort",
  "other",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const TokenUsageSchema = z.strictObject({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// --- Artifact lifecycle payloads (shared with the AI SDK data parts) -------------------

export const ArtifactOpenDataSchema = z
  .strictObject({
    messageId: IdentifierSchema,
    artifactId: IdentifierSchema,
    revision: RevisionSchema,
    title: singleLineText(LIMITS.titleLength),
    artifactType: ArtifactTypeSchema,
    language: ArtifactLanguageSchema,
  })
  .superRefine((data, ctx) => {
    checkArtifactLanguage(ctx, data.artifactType, data.language);
  });
export type ArtifactOpenData = z.infer<typeof ArtifactOpenDataSchema>;

export const ArtifactDeltaDataSchema = z.strictObject({
  messageId: IdentifierSchema,
  artifactId: IdentifierSchema,
  revision: RevisionSchema,
  delta: DeltaSchema,
});
export type ArtifactDeltaData = z.infer<typeof ArtifactDeltaDataSchema>;

export const ArtifactCloseDataSchema = z.strictObject({
  messageId: IdentifierSchema,
  artifactId: IdentifierSchema,
  revision: RevisionSchema,
  /** Final content length in UTF-16 code units, so the client can detect lost deltas. */
  contentLength: z.int().min(0).max(LIMITS.artifactContentChars).optional(),
});
export type ArtifactCloseData = z.infer<typeof ArtifactCloseDataSchema>;

// --- Stream events --------------------------------------------------------------------

export const StartMessageEventSchema = z.strictObject({
  type: z.literal("start-message"),
  messageId: IdentifierSchema,
});
export type StartMessageEvent = z.infer<typeof StartMessageEventSchema>;

export const TextDeltaEventSchema = z.strictObject({
  type: z.literal("text-delta"),
  messageId: IdentifierSchema,
  delta: DeltaSchema,
});
export type TextDeltaEvent = z.infer<typeof TextDeltaEventSchema>;

export const ToolCallEventSchema = z.strictObject({
  type: z.literal("tool-call"),
  messageId: IdentifierSchema,
  toolCallId: IdentifierSchema,
  toolName: ToolNameSchema,
  input: JsonValueSchema,
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolResultEventSchema = z.strictObject({
  type: z.literal("tool-result"),
  messageId: IdentifierSchema,
  toolCallId: IdentifierSchema,
  toolName: ToolNameSchema,
  output: JsonValueSchema,
  isError: z.boolean().optional(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

export const ArtifactOpenEventSchema = z
  .strictObject({
    type: z.literal("artifact-open"),
    ...ArtifactOpenDataSchema.shape,
  })
  .superRefine((event, ctx) => {
    checkArtifactLanguage(ctx, event.artifactType, event.language);
  });
export type ArtifactOpenEvent = z.infer<typeof ArtifactOpenEventSchema>;

export const ArtifactDeltaEventSchema = z.strictObject({
  type: z.literal("artifact-delta"),
  ...ArtifactDeltaDataSchema.shape,
});
export type ArtifactDeltaEvent = z.infer<typeof ArtifactDeltaEventSchema>;

export const ArtifactCloseEventSchema = z.strictObject({
  type: z.literal("artifact-close"),
  ...ArtifactCloseDataSchema.shape,
});
export type ArtifactCloseEvent = z.infer<typeof ArtifactCloseEventSchema>;

export const FinishMessageEventSchema = z.strictObject({
  type: z.literal("finish-message"),
  messageId: IdentifierSchema,
  finishReason: FinishReasonSchema,
  usage: TokenUsageSchema.optional(),
});
export type FinishMessageEvent = z.infer<typeof FinishMessageEventSchema>;

export const ErrorEventSchema = z.strictObject({
  type: z.literal("error"),
  /** Absent when the failure is not tied to a message (e.g. upstream unavailable). */
  messageId: IdentifierSchema.optional(),
  error: ProblemDetailsSchema,
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  StartMessageEventSchema,
  TextDeltaEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ArtifactOpenEventSchema,
  ArtifactDeltaEventSchema,
  ArtifactCloseEventSchema,
  FinishMessageEventSchema,
  ErrorEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type StreamEventType = StreamEvent["type"];

/** All event discriminators, in protocol order. */
export const STREAM_EVENT_TYPES = StreamEventSchema.options.map(
  (option) => option.shape.type.value,
) as readonly StreamEventType[];
