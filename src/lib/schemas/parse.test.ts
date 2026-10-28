import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validEvents } from "~tests/fixtures/schemas";

import { LIMITS } from "./limits";
import {
  formatIssuePath,
  formatIssues,
  parseSseFrame,
  parseStreamEventData,
  SSE_DONE_SENTINEL,
  safeParseStreamEvent,
  streamParseErrorToProblem,
} from "./parse";
import { ProblemDetailsSchema } from "./problem";

const textDelta = validEvents["text-delta"];
const json = (value: unknown) => JSON.stringify(value);

describe("parseStreamEventData", () => {
  it.each(Object.values(validEvents))("parses a valid $type frame", (event) => {
    expect(parseStreamEventData(json(event))).toEqual({ ok: true, event });
  });

  it.each(["", "   ", "\n\t"])("rejects empty chunk %j", (data) => {
    expect(parseStreamEventData(data)).toEqual({
      ok: false,
      error: { code: "empty", message: "Empty stream frame", issues: [] },
    });
  });

  it.each([
    '{"type":"text-delta",',
    "{'type':'text-delta'}",
    "undefined",
    '{"type":"text-delta"}}',
    "NaN",
  ])("rejects malformed JSON %j", (data) => {
    const result = parseStreamEventData(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-json");
      expect(result.error.message).toMatch(/^Stream frame is not valid JSON: /);
    }
  });

  it.each(["42", "null", '"text"', "[]", "true"])("rejects non-object JSON %s", (data) => {
    const result = parseStreamEventData(data);
    expect(!result.ok && result.error.code).toBe("invalid-event");
  });

  it("rejects frames above the byte limit by length", () => {
    const result = parseStreamEventData(`"${"x".repeat(LIMITS.frameBytes)}"`);
    expect(!result.ok && result.error.code).toBe("too-large");
  });

  it("rejects frames that only exceed the limit once UTF-8 encoded", () => {
    const delta = "é".repeat(Math.ceil(LIMITS.frameBytes / 2));
    const data = json({ ...textDelta, delta });
    expect(data.length).toBeLessThan(LIMITS.frameBytes);
    const result = parseStreamEventData(data);
    expect(!result.ok && result.error.code).toBe("too-large");
  });

  it("measures multi-byte frames under the limit without rejecting them", () => {
    // 2-byte characters: too long for the cheap bound, but within the limit once encoded.
    const input = { text: "é".repeat(Math.floor(LIMITS.frameBytes / 2.5)) };
    const data = json({ ...validEvents["tool-call"], input });
    expect(data.length * 3).toBeGreaterThan(LIMITS.frameBytes);
    expect(parseStreamEventData(data).ok).toBe(true);
  });

  it("reports schema issues with paths and a readable summary", () => {
    const result = parseStreamEventData(json({ ...textDelta, delta: "", messageId: "bad id" }));
    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-event",
        message: expect.stringMatching(/^Invalid stream event: messageId: .+; delta: .+$/),
        issues: [
          { path: "messageId", message: expect.any(String) },
          { path: "delta", message: expect.any(String) },
        ],
      },
    });
  });

  it("caps the summary at three issues", () => {
    const result = parseStreamEventData(
      json({ type: "artifact-open", messageId: "", artifactId: "", revision: 0, title: "" }),
    );
    expect(!result.ok && result.error.message).toMatch(/\(\+\d+ more\)$/);
  });

  it("reports an unknown event type at the discriminator", () => {
    const result = parseStreamEventData(json({ type: "nope" }));
    expect(!result.ok && result.error.issues[0]?.path).toBe("type");
  });
});

describe("safeParseStreamEvent", () => {
  it("accepts an already-decoded event", () => {
    expect(safeParseStreamEvent(textDelta)).toEqual({ ok: true, event: textDelta });
  });

  it("formats a root-level issue without a path prefix", () => {
    const result = safeParseStreamEvent("not an object");
    if (result.ok) throw new Error("expected failure");
    const [issue] = result.error.issues;
    expect(issue?.path).toBe("");
    expect(result.error.message).toBe(`Invalid stream event: ${issue?.message}`);
  });
});

describe("parseSseFrame", () => {
  it("parses a named event with an id", () => {
    expect(parseSseFrame(`event: text-delta\nid: 42\ndata: ${json(textDelta)}`)).toEqual({
      kind: "event",
      event: textDelta,
      id: "42",
    });
  });

  it("omits id when the frame has none", () => {
    expect(parseSseFrame(`data: ${json(textDelta)}`)).toEqual({ kind: "event", event: textDelta });
  });

  it("accepts CRLF and CR line endings", () => {
    expect(parseSseFrame(`event: text-delta\r\ndata: ${json(textDelta)}\r\n`)).toMatchObject({
      kind: "event",
    });
    expect(parseSseFrame(`id: 1\rdata: ${json(textDelta)}`)).toMatchObject({ kind: "event" });
  });

  it("joins multiple data lines with a newline", () => {
    const frame = `data: {"type":"text-delta",\ndata: "messageId":"msg_1",\ndata: "delta":"hi"}`;
    expect(parseSseFrame(frame)).toEqual({
      kind: "event",
      event: { type: "text-delta", messageId: "msg_1", delta: "hi" },
    });
  });

  it("strips only a single leading space from field values", () => {
    expect(parseSseFrame(`data:${json(textDelta)}`)).toMatchObject({ kind: "event" });
    const spaced = parseSseFrame(`data:   ${json(textDelta)}`);
    expect(spaced.kind).toBe("event");
  });

  it("treats the default 'message' event name as unnamed", () => {
    expect(parseSseFrame(`event: message\ndata: ${json(textDelta)}`)).toMatchObject({
      kind: "event",
    });
  });

  it("rejects an event name that disagrees with the payload type", () => {
    expect(parseSseFrame(`event: artifact-open\ndata: ${json(textDelta)}`)).toEqual({
      kind: "error",
      error: {
        code: "event-mismatch",
        message: 'SSE event name "artifact-open" does not match payload type "text-delta"',
        issues: [],
      },
    });
  });

  it.each(["", ": keep-alive", ":\n:\n", "retry: 3000", "event: ping\nid: 9"])(
    "treats a frame without data (%j) as a heartbeat",
    (frame) => {
      expect(parseSseFrame(frame)).toEqual({ kind: "heartbeat" });
    },
  );

  it("recognizes the [DONE] sentinel", () => {
    expect(parseSseFrame(`data: ${SSE_DONE_SENTINEL}`)).toEqual({ kind: "done" });
  });

  it("reports an empty data field as an empty chunk", () => {
    for (const frame of ["data:", "data", "data: \ndata: "]) {
      expect(parseSseFrame(frame)).toMatchObject({ kind: "error", error: { code: "empty" } });
    }
  });

  it("ignores an id containing NUL", () => {
    expect(parseSseFrame(`id: a\0b\ndata: ${json(textDelta)}`)).toEqual({
      kind: "event",
      event: textDelta,
    });
  });

  it("ignores unknown fields", () => {
    expect(parseSseFrame(`foo: bar\ndata: ${json(textDelta)}`)).toMatchObject({ kind: "event" });
  });

  it("propagates malformed payloads as errors instead of throwing", () => {
    expect(parseSseFrame("data: {oops")).toMatchObject({
      kind: "error",
      error: { code: "invalid-json" },
    });
    expect(parseSseFrame(`data: ${json({ type: "nope" })}`)).toMatchObject({
      kind: "error",
      error: { code: "invalid-event" },
    });
  });

  it("rejects an oversized frame before scanning it", () => {
    expect(parseSseFrame(`data: ${"x".repeat(LIMITS.frameBytes)}`)).toMatchObject({
      kind: "error",
      error: { code: "too-large" },
    });
  });
});

describe("issue formatting", () => {
  it.each([
    [[], ""],
    [["delta"], "delta"],
    [["tabs", 0, "artifactId"], "tabs[0].artifactId"],
    [[0, "a"], "[0].a"],
    [["usage", "inputTokens"], "usage.inputTokens"],
    [[Symbol("s")], "Symbol(s)"],
  ])("formats path %j as %j", (path, expected) => {
    expect(formatIssuePath(path)).toBe(expected);
  });

  it("bounds the number and size of issues", () => {
    const schema = z.array(z.string());
    const issues = schema.safeParse(Array.from({ length: 60 }, () => 0)).error?.issues ?? [];
    const formatted = formatIssues(issues);
    expect(formatted).toHaveLength(LIMITS.problemErrors);

    const long = formatIssues([
      { code: "custom", path: ["p".repeat(400)], message: "m".repeat(600), input: null },
    ]);
    expect(long[0]?.path).toHaveLength(LIMITS.issuePathLength);
    expect(long[0]?.message).toHaveLength(LIMITS.issueMessageLength);
    expect(long[0]?.message.endsWith("…")).toBe(true);
  });
});

describe("streamParseErrorToProblem", () => {
  it("wraps a schema failure as a 502 invalid_frame problem with field errors", () => {
    const result = parseStreamEventData(json({ ...textDelta, delta: "" }));
    if (result.ok) throw new Error("expected failure");
    const problem = streamParseErrorToProblem(result.error);

    expect(ProblemDetailsSchema.safeParse(problem).success).toBe(true);
    expect(problem).toMatchObject({
      code: "invalid_frame",
      status: 502,
      retryable: false,
      detail: result.error.message,
      errors: [{ path: "delta", message: expect.any(String) }],
    });
  });

  it("omits errors when the failure has no field issues", () => {
    const problem = streamParseErrorToProblem({ code: "empty", message: "Empty", issues: [] });
    expect(problem).not.toHaveProperty("errors");
  });
});
