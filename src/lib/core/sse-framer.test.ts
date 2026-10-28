import { describe, expect, it } from "vitest";

import { createSseFramer, type FramerOutput } from "./sse-framer";

const frames = (outputs: FramerOutput[]) =>
  outputs.map((output) => (output.kind === "frame" ? output.text : "<overflow>"));

function feed(chunks: string[], maxFrameChars?: number) {
  const framer = createSseFramer(maxFrameChars);
  const out = chunks.flatMap((chunk) => frames(framer.push(chunk)));
  const finished = framer.finish();
  return { frames: [...out, ...frames(finished.outputs)], discardedTail: finished.discardedTail };
}

describe("createSseFramer", () => {
  it("splits frames on blank lines", () => {
    expect(feed(["data: a\n\ndata: b\n\n"])).toEqual({
      frames: ["data: a", "data: b"],
      discardedTail: false,
    });
  });

  it.each([
    ["CRLF", "data: a\r\n\r\ndata: b\r\n\r\n"],
    ["CR", "data: a\r\rdata: b\r\r"],
    ["mixed", "data: a\r\n\ndata: b\n\r\n"],
  ])("normalizes %s line endings", (_name, input) => {
    expect(feed([input]).frames).toEqual(["data: a", "data: b"]);
  });

  it("joins a CRLF split across chunks", () => {
    expect(feed(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"]).frames).toEqual(["data: a", "data: b"]);
  });

  it("finds a delimiter split across chunks", () => {
    expect(feed(["data: a\n", "\ndata: b\n", "\n"]).frames).toEqual(["data: a", "data: b"]);
  });

  it("produces the same frames when fed one character at a time", () => {
    const input = "event: x\r\ndata: 1\r\n\r\n: ping\n\ndata: 2\rid: 7\r\r";
    expect(feed([...input]).frames).toEqual(feed([input]).frames);
    expect(feed([...input]).frames).toEqual(["event: x\ndata: 1", ": ping", "data: 2\nid: 7"]);
  });

  it("skips runs of blank lines", () => {
    expect(feed(["\n\n\n\ndata: a\n\n\n\n\n\ndata: b\n\n"]).frames).toEqual(["data: a", "data: b"]);
  });

  it("reports an oversized frame once and resumes after its delimiter", () => {
    const result = feed(["data: ", "x".repeat(30), "y".repeat(30), "z\n", "\ndata: ok\n\n"], 20);
    expect(result.frames).toEqual(["<overflow>", "data: ok"]);
  });

  it("rejects an oversized frame that arrives complete in one chunk", () => {
    expect(feed([`data: ${"x".repeat(30)}\n\ndata: ok\n\n`], 20).frames).toEqual([
      "<overflow>",
      "data: ok",
    ]);
  });

  it("keeps memory bounded while skipping", () => {
    const framer = createSseFramer(10);
    expect(frames(framer.push("x".repeat(50)))).toEqual(["<overflow>"]);
    for (let i = 0; i < 100; i++) expect(framer.push("y".repeat(1000))).toEqual([]);
    expect(frames(framer.push("\n\ndata: ok\n\n"))).toEqual(["data: ok"]);
  });

  it("recognizes a delimiter split while skipping", () => {
    const result = feed(["x".repeat(50), "\n", "\ndata: ok\n\n"], 10);
    expect(result.frames).toEqual(["<overflow>", "data: ok"]);
  });

  it("discards an unterminated trailing event at finish", () => {
    expect(feed(["data: a\n\ndata: partial"])).toEqual({
      frames: ["data: a"],
      discardedTail: true,
    });
  });

  it("completes a frame whose final CR arrives last", () => {
    expect(feed(["data: a\n\r"])).toEqual({ frames: ["data: a"], discardedTail: false });
  });

  it("does not report trailing whitespace-only input as a discarded event", () => {
    expect(feed(["data: a\n\n\n"]).discardedTail).toBe(false);
  });

  it("does not report the remainder of an oversized frame as a discarded tail", () => {
    expect(feed(["x".repeat(50)], 10)).toEqual({ frames: ["<overflow>"], discardedTail: false });
  });

  it("resets after finish", () => {
    const framer = createSseFramer();
    framer.push("data: stale");
    framer.finish();
    expect(frames(framer.push("data: fresh\n\n"))).toEqual(["data: fresh"]);
  });
});
