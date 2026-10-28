import { describe, expect, it } from "vitest";
import { patch, validArtifact, validProblem } from "~tests/fixtures/schemas";

import {
  ARTIFACT_LANGUAGES,
  ArtifactEntrySchema,
  ArtifactMetadataSchema,
  ArtifactPayloadSchema,
  ArtifactStateSchema,
  ArtifactTypeSchema,
  artifactSupportsPreview,
  isLanguageCompatible,
} from "./artifact";
import { LIMITS } from "./limits";

const issuesOf = (value: unknown) => ArtifactPayloadSchema.safeParse(value).error?.issues ?? [];

describe("ArtifactTypeSchema / ArtifactStateSchema", () => {
  it("enumerates the supported artifact kinds", () => {
    expect(ArtifactTypeSchema.options).toEqual([
      "html",
      "svg",
      "markdown",
      "react",
      "code",
      "mermaid",
    ]);
  });

  it("enumerates the lifecycle states", () => {
    expect(ArtifactStateSchema.options).toEqual(["idle", "streaming", "complete", "error"]);
  });

  it.each(["pdf", "HTML", "", null, 1])("rejects unrecognized artifact type %j", (type) => {
    expect(ArtifactTypeSchema.safeParse(type).success).toBe(false);
    expect(issuesOf(patch(validArtifact, { type }))).toContainEqual(
      expect.objectContaining({ path: ["type"] }),
    );
  });
});

describe("ArtifactPayloadSchema — happy paths", () => {
  it("accepts a complete payload unchanged", () => {
    expect(ArtifactPayloadSchema.parse(validArtifact)).toEqual(validArtifact);
  });

  it("accepts a payload without metadata and with empty (not yet streamed) content", () => {
    const parsed = ArtifactPayloadSchema.parse(
      patch(validArtifact, { metadata: undefined, content: "" }),
    );
    expect(parsed.content).toBe("");
    expect(parsed).not.toHaveProperty("metadata");
  });

  it.each(
    Object.entries(ARTIFACT_LANGUAGES).flatMap(([type, languages]) =>
      (languages ?? ["py", "c++", "c#", "objective-c", "x86.asm"]).map((language) => [
        type,
        language,
      ]),
    ),
  )("accepts %s artifacts in %s", (type, language) => {
    expect(issuesOf(patch(validArtifact, { type, language }))).toEqual([]);
  });

  it("trims the title", () => {
    expect(ArtifactPayloadSchema.parse(patch(validArtifact, { title: "  Chart  " })).title).toBe(
      "Chart",
    );
  });

  it("accepts content at exactly the size limit", () => {
    const content = "x".repeat(LIMITS.artifactContentChars);
    expect(ArtifactPayloadSchema.safeParse(patch(validArtifact, { content })).success).toBe(true);
  });
});

describe("ArtifactPayloadSchema — malformed payloads", () => {
  it.each([
    ["a missing id", { id: undefined }, ["id"]],
    ["an empty id", { id: "" }, ["id"]],
    ["a __proto__ id", { id: "__proto__" }, ["id"]],
    ["an id with spaces", { id: "art 1" }, ["id"]],
    ["an oversized id", { id: "a".repeat(LIMITS.idLength + 1) }, ["id"]],
    ["revision 0", { revision: 0 }, ["revision"]],
    ["a fractional revision", { revision: 1.5 }, ["revision"]],
    ["a string revision", { revision: "1" }, ["revision"]],
    ["a blank title", { title: "   " }, ["title"]],
    ["a multi-line title", { title: "a\nb" }, ["title"]],
    ["an oversized title", { title: "t".repeat(LIMITS.titleLength + 1) }, ["title"]],
    ["an upper-case language", { language: "TSX" }, ["language"]],
    ["an empty language", { language: "" }, ["language"]],
    ["a non-string content", { content: 42 }, ["content"]],
    ["oversized content", { content: "x".repeat(LIMITS.artifactContentChars + 1) }, ["content"]],
  ])("rejects %s", (_case, changes, path) => {
    expect(issuesOf(patch(validArtifact, changes))).toContainEqual(
      expect.objectContaining({ path }),
    );
  });

  it.each([
    ["react", "py"],
    ["html", "tsx"],
    ["svg", "html"],
    ["markdown", "html"],
    ["mermaid", "markdown"],
  ])("rejects a %s artifact declaring language %s", (type, language) => {
    const [issue] = issuesOf(patch(validArtifact, { type, language }));
    expect(issue).toMatchObject({ path: ["language"] });
    expect(issue?.message).toContain(`not valid for ${type} artifacts`);
  });

  it("rejects unknown keys (strict)", () => {
    expect(issuesOf({ ...validArtifact, script: "alert(1)" })).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["script"] }),
    );
  });

  it("rejects a __proto__ key from untrusted JSON", () => {
    const raw: unknown = JSON.parse(
      JSON.stringify(validArtifact).replace(/}$/, ',"__proto__":{"trusted":true}}'),
    );
    expect(issuesOf(raw)).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["__proto__"] }),
    );
  });

  it.each([null, undefined, "artifact", [], 42])("rejects non-object input %j", (value) => {
    expect(ArtifactPayloadSchema.safeParse(value).success).toBe(false);
  });
});

describe("ArtifactMetadataSchema", () => {
  it.each([
    ["unknown keys", { owner: "root" }],
    ["duplicate tags", { tags: ["ui", "ui"] }],
    ["upper-case tags", { tags: ["UI"] }],
    ["too many tags", { tags: Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`) }],
    ["a timestamp without offset", { createdAt: "2026-10-28T12:00:00" }],
    ["a non-ISO timestamp", { updatedAt: "yesterday" }],
    ["an invalid source message id", { sourceMessageId: "../etc" }],
    ["an oversized description", { description: "d".repeat(LIMITS.descriptionLength + 1) }],
  ])("rejects %s", (_case, changes) => {
    expect(ArtifactMetadataSchema.safeParse(patch(validArtifact.metadata, changes)).success).toBe(
      false,
    );
  });

  it("accepts an empty metadata object", () => {
    expect(ArtifactMetadataSchema.parse({})).toEqual({});
  });
});

describe("ArtifactEntrySchema", () => {
  it.each(["idle", "streaming", "complete"] as const)(
    "accepts state %s without an error",
    (state) => {
      expect(ArtifactEntrySchema.safeParse({ artifact: validArtifact, state }).success).toBe(true);
    },
  );

  it("accepts state error with a problem", () => {
    const entry = { artifact: validArtifact, state: "error", error: validProblem };
    expect(ArtifactEntrySchema.parse(entry)).toEqual(entry);
  });

  it("requires a problem when state is error", () => {
    const result = ArtifactEntrySchema.safeParse({ artifact: validArtifact, state: "error" });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["error"], message: "Required when state is error" }),
    ]);
  });

  it("forbids a problem in any other state", () => {
    const result = ArtifactEntrySchema.safeParse({
      artifact: validArtifact,
      state: "complete",
      error: validProblem,
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ["error"], message: "Only allowed when state is error" }),
    ]);
  });

  it("rejects an unknown state", () => {
    expect(ArtifactEntrySchema.safeParse({ artifact: validArtifact, state: "done" }).success).toBe(
      false,
    );
  });
});

describe("artifact helpers", () => {
  it.each(ArtifactTypeSchema.options)("reports preview support for %s", (type) => {
    expect(artifactSupportsPreview(type)).toBe(type !== "code");
  });

  it("treats code artifacts as language-agnostic", () => {
    expect(isLanguageCompatible("code", "anything")).toBe(true);
    expect(isLanguageCompatible("react", "anything")).toBe(false);
  });
});
