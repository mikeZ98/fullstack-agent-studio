import { z } from "zod";

import { LIMITS } from "./limits";
import { IdentifierSchema, IsoDateTimeSchema, RevisionSchema, singleLineText } from "./primitives";
import { ProblemDetailsSchema } from "./problem";

export const ArtifactTypeSchema = z.enum(["html", "svg", "markdown", "react", "code", "mermaid"]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStateSchema = z.enum(["idle", "streaming", "complete", "error"]);
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;

/** Lower-case language slug, e.g. `tsx`, `html`, `py`, `c++`, `c#`. */
export const ArtifactLanguageSchema = z
  .string()
  .min(1)
  .max(LIMITS.languageLength)
  .regex(/^[a-z0-9][a-z0-9+#.-]*$/, "Must be a lower-case language slug");
export type ArtifactLanguage = z.infer<typeof ArtifactLanguageSchema>;

/** Languages each artifact type may declare; `null` means any language (source code). */
export const ARTIFACT_LANGUAGES: Readonly<Record<ArtifactType, readonly string[] | null>> = {
  html: ["html"],
  svg: ["svg", "xml"],
  markdown: ["markdown", "md"],
  react: ["tsx", "jsx"],
  mermaid: ["mermaid", "mmd"],
  code: null,
};

export function isLanguageCompatible(type: ArtifactType, language: string): boolean {
  const allowed = ARTIFACT_LANGUAGES[type];
  return allowed === null || allowed.includes(language);
}

/** Every type except plain source code has a rendered Preview in the canvas. */
export function artifactSupportsPreview(type: ArtifactType): boolean {
  return type !== "code";
}

/** Shared refinement: the declared language must match the artifact type. */
export function checkArtifactLanguage(
  ctx: z.RefinementCtx,
  type: ArtifactType,
  language: string,
  path: PropertyKey[] = ["language"],
): void {
  const allowed = ARTIFACT_LANGUAGES[type];
  if (allowed === null || allowed.includes(language)) return;
  ctx.addIssue({
    code: "custom",
    path,
    message: `Language "${language}" is not valid for ${type} artifacts (expected: ${allowed.join(", ")})`,
  });
}

const TagSchema = z
  .string()
  .min(1)
  .max(LIMITS.tagLength)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Must be a lower-case slug");

export const ArtifactMetadataSchema = z.strictObject({
  description: z.string().trim().max(LIMITS.descriptionLength).optional(),
  tags: z
    .array(TagSchema)
    .max(LIMITS.tags)
    .refine((tags) => new Set(tags).size === tags.length, "Tags must be unique")
    .optional(),
  /** Assistant message that produced this revision. */
  sourceMessageId: IdentifierSchema.optional(),
  createdAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema.optional(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

/** One immutable revision of an artifact, as rendered by the canvas. */
export const ArtifactPayloadSchema = z
  .strictObject({
    id: IdentifierSchema,
    revision: RevisionSchema,
    title: singleLineText(LIMITS.titleLength),
    type: ArtifactTypeSchema,
    language: ArtifactLanguageSchema,
    /** May be empty while the first deltas are still streaming. */
    content: z.string().max(LIMITS.artifactContentChars),
    metadata: ArtifactMetadataSchema.optional(),
  })
  .superRefine((artifact, ctx) => {
    checkArtifactLanguage(ctx, artifact.type, artifact.language);
  });
export type ArtifactPayload = z.infer<typeof ArtifactPayloadSchema>;

/** Client-side record of an artifact and where it is in its lifecycle. */
export const ArtifactEntrySchema = z
  .strictObject({
    artifact: ArtifactPayloadSchema,
    state: ArtifactStateSchema,
    error: ProblemDetailsSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.state === "error" && entry.error === undefined) {
      ctx.addIssue({ code: "custom", path: ["error"], message: "Required when state is error" });
    }
    if (entry.state !== "error" && entry.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only allowed when state is error",
      });
    }
  });
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;
