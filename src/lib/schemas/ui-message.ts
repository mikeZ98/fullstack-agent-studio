import type { InferUIDataParts, UIDataPartSchemas, UIMessage } from "ai";
import { z } from "zod";

import { LIMITS } from "./limits";
import { IsoDateTimeSchema } from "./primitives";
import {
  ArtifactCloseDataSchema,
  ArtifactDeltaDataSchema,
  ArtifactOpenDataSchema,
  FinishReasonSchema,
  TokenUsageSchema,
} from "./stream";

/**
 * Contracts for the Vercel AI SDK UI message stream between the Next.js route and the
 * browser. Artifact lifecycle events travel as typed `data-artifact-*` parts that reuse the
 * backend SSE payload schemas, so both hops validate identical shapes.
 */

export const MessageMetadataSchema = z.strictObject({
  createdAt: IsoDateTimeSchema.optional(),
  model: z.string().min(1).max(LIMITS.modelNameLength).optional(),
  finishReason: FinishReasonSchema.optional(),
  usage: TokenUsageSchema.optional(),
});
export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

/** Pass as `dataPartSchemas` to `useChat` / `Chat` to validate incoming data parts. */
export const studioDataPartSchemas = {
  "artifact-open": ArtifactOpenDataSchema,
  "artifact-delta": ArtifactDeltaDataSchema,
  "artifact-close": ArtifactCloseDataSchema,
} as const satisfies UIDataPartSchemas;

export type StudioDataParts = InferUIDataParts<typeof studioDataPartSchemas>;

/** The message type of the studio chat (`useChat<StudioUIMessage>()`). */
export type StudioUIMessage = UIMessage<MessageMetadata, StudioDataParts>;
