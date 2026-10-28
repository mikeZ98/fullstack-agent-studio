import { describe, expect, expectTypeOf, it } from "vitest";
import { validEvents } from "~tests/fixtures/schemas";

import type { ArtifactCloseData, ArtifactDeltaData, ArtifactOpenData } from "./stream";
import {
  type MessageMetadata,
  MessageMetadataSchema,
  type StudioUIMessage,
  studioDataPartSchemas,
} from "./ui-message";

type DataPart<Name extends string> = Extract<StudioUIMessage["parts"][number], { type: Name }>;

function withoutType<T extends { type: string }>({ type: _type, ...rest }: T) {
  return rest;
}

describe("studioDataPartSchemas", () => {
  it("covers the artifact lifecycle", () => {
    expect(Object.keys(studioDataPartSchemas)).toEqual([
      "artifact-open",
      "artifact-delta",
      "artifact-close",
    ]);
  });

  it.each(["artifact-open", "artifact-delta", "artifact-close"] as const)(
    "validates %s data with the same payload as the SSE event",
    (name) => {
      const data = withoutType(validEvents[name]);
      expect(studioDataPartSchemas[name].parse(data)).toEqual(data);
      expect(studioDataPartSchemas[name].safeParse({ ...data, extra: 1 }).success).toBe(false);
    },
  );

  it("works through the Standard Schema interface the AI SDK consumes", async () => {
    const schema = studioDataPartSchemas["artifact-delta"]["~standard"];
    const ok = await schema.validate(withoutType(validEvents["artifact-delta"]));
    const bad = await schema.validate({ artifactId: "a" });
    expect(ok.issues).toBeUndefined();
    expect(bad.issues?.length).toBeGreaterThan(0);
  });

  it("types data parts from the schemas", () => {
    expectTypeOf<DataPart<"data-artifact-open">["data"]>().toEqualTypeOf<ArtifactOpenData>();
    expectTypeOf<DataPart<"data-artifact-delta">["data"]>().toEqualTypeOf<ArtifactDeltaData>();
    expectTypeOf<DataPart<"data-artifact-close">["data"]>().toEqualTypeOf<ArtifactCloseData>();
    expectTypeOf<StudioUIMessage["metadata"]>().toEqualTypeOf<MessageMetadata | undefined>();
  });
});

describe("MessageMetadataSchema", () => {
  it("accepts full and empty metadata", () => {
    const full = {
      createdAt: "2026-10-28T12:00:00.000Z",
      model: "agent-large",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    expect(MessageMetadataSchema.parse(full)).toEqual(full);
    expect(MessageMetadataSchema.parse({})).toEqual({});
  });

  it.each([
    ["unknown keys", { userId: "u1" }],
    ["an invalid timestamp", { createdAt: "now" }],
    ["an empty model", { model: "" }],
    ["fractional usage", { usage: { inputTokens: 1.5, outputTokens: 0 } }],
  ])("rejects %s", (_case, value) => {
    expect(MessageMetadataSchema.safeParse(value).success).toBe(false);
  });
});
