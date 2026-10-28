import { describe, expect, it } from "vitest";
import { patch, validEvents } from "~tests/fixtures/schemas";

import { LIMITS } from "./limits";
import { STREAM_EVENT_TYPES, StreamEventSchema } from "./stream";

const issuesOf = (value: unknown) => StreamEventSchema.safeParse(value).error?.issues ?? [];

describe("StreamEventSchema — discriminated union", () => {
  it("declares exactly the protocol event types", () => {
    expect(STREAM_EVENT_TYPES).toEqual([
      "start-message",
      "text-delta",
      "tool-call",
      "tool-result",
      "artifact-open",
      "artifact-delta",
      "artifact-close",
      "finish-message",
      "error",
    ]);
    expect(Object.keys(validEvents).sort()).toEqual([...STREAM_EVENT_TYPES].sort());
  });

  it.each(Object.values(validEvents))("parses a valid $type event unchanged", (event) => {
    expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it.each(Object.values(validEvents))("rejects unknown keys on $type (strict)", (event) => {
    expect(issuesOf({ ...event, injected: "<script>" })).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["injected"] }),
    );
  });

  it.each(Object.values(validEvents))("rejects a __proto__ key on $type", (event) => {
    const raw: unknown = JSON.parse(
      JSON.stringify(event).replace(/}$/, ',"__proto__":{"isAdmin":true}}'),
    );
    expect(issuesOf(raw)).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["__proto__"] }),
    );
  });

  it.each([
    ["an unknown type", { type: "artifact-explode", messageId: "msg_1" }],
    ["a missing type", { messageId: "msg_1", delta: "hi" }],
    ["a non-string type", { type: 7, messageId: "msg_1" }],
    ["a type with different casing", { type: "TEXT-DELTA", messageId: "msg_1", delta: "hi" }],
  ])("rejects %s with a discriminator issue", (_case, value) => {
    expect(issuesOf(value)).toEqual([
      expect.objectContaining({ code: "invalid_union", path: ["type"] }),
    ]);
  });

  it.each([null, undefined, "text-delta", 42, [], [validEvents["text-delta"]]])(
    "rejects non-object frame %j",
    (value) => {
      expect(StreamEventSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("StreamEventSchema — per-event constraints", () => {
  it.each([
    ["text-delta with an empty delta", validEvents["text-delta"], { delta: "" }, ["delta"]],
    [
      "text-delta with an oversized delta",
      validEvents["text-delta"],
      { delta: "x".repeat(LIMITS.deltaChars + 1) },
      ["delta"],
    ],
    [
      "text-delta without a messageId",
      validEvents["text-delta"],
      { messageId: undefined },
      ["messageId"],
    ],
    ["artifact-delta with an empty delta", validEvents["artifact-delta"], { delta: "" }, ["delta"]],
    [
      "artifact-delta with an oversized delta",
      validEvents["artifact-delta"],
      { delta: "x".repeat(LIMITS.deltaChars + 1) },
      ["delta"],
    ],
    [
      "artifact-delta with revision 0",
      validEvents["artifact-delta"],
      { revision: 0 },
      ["revision"],
    ],
    [
      "artifact-open with an unknown artifactType",
      validEvents["artifact-open"],
      { artifactType: "pdf" },
      ["artifactType"],
    ],
    [
      "artifact-open with a mismatched language",
      validEvents["artifact-open"],
      { language: "py" },
      ["language"],
    ],
    ["artifact-open with a blank title", validEvents["artifact-open"], { title: " " }, ["title"]],
    [
      "artifact-close with a negative contentLength",
      validEvents["artifact-close"],
      { contentLength: -1 },
      ["contentLength"],
    ],
    [
      "artifact-close with an oversized contentLength",
      validEvents["artifact-close"],
      { contentLength: LIMITS.artifactContentChars + 1 },
      ["contentLength"],
    ],
    [
      "tool-call with an invalid toolName",
      validEvents["tool-call"],
      { toolName: "rm -rf" },
      ["toolName"],
    ],
    ["tool-call without input", validEvents["tool-call"], { input: undefined }, ["input"]],
    [
      "tool-result with a non-boolean isError",
      validEvents["tool-result"],
      { isError: "yes" },
      ["isError"],
    ],
    [
      "finish-message with an unknown reason",
      validEvents["finish-message"],
      { finishReason: "bored" },
      ["finishReason"],
    ],
    [
      "finish-message with negative usage",
      validEvents["finish-message"],
      { usage: { inputTokens: -1, outputTokens: 0 } },
      ["usage", "inputTokens"],
    ],
    ["error without a problem", validEvents.error, { error: undefined }, ["error"]],
    [
      "error with an invalid problem",
      validEvents.error,
      { error: { title: "x" } },
      ["error", "status"],
    ],
  ])("rejects %s", (_case, base, changes, path) => {
    expect(issuesOf(patch(base, changes))).toContainEqual(expect.objectContaining({ path }));
  });

  it("rejects a reserved key nested inside tool-call input", () => {
    const raw: unknown = JSON.parse(
      '{"type":"tool-call","messageId":"m","toolCallId":"c","toolName":"t","input":{"a":{"__proto__":{"x":1}}}}',
    );
    expect(issuesOf(raw)).toContainEqual(
      expect.objectContaining({ path: ["input", "a", "__proto__"] }),
    );
  });

  it("accepts optional fields being absent", () => {
    for (const [event, key] of [
      [validEvents["tool-result"], "isError"],
      [validEvents["artifact-close"], "contentLength"],
      [validEvents["finish-message"], "usage"],
      [validEvents.error, "messageId"],
    ] as const) {
      expect(StreamEventSchema.safeParse(patch(event, { [key]: undefined })).success, key).toBe(
        true,
      );
    }
  });

  it("accepts a delta at exactly the size limit", () => {
    const delta = "x".repeat(LIMITS.deltaChars);
    expect(StreamEventSchema.safeParse(patch(validEvents["text-delta"], { delta })).success).toBe(
      true,
    );
  });
});
