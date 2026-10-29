import { describe, expect, it } from "vitest";
import {
  ArtifactEntrySchema,
  type ArtifactLanguage,
  type ArtifactType,
  LIMITS,
  type StreamEvent,
} from "@/lib/schemas";
import { validEvents, validProblem } from "~tests/fixtures/schemas";

import {
  type ArtifactStoreAction,
  type ArtifactStoreState,
  artifactReducer,
  contentHash,
  INITIAL_ARTIFACT_STORE,
  selectArtifact,
  selectArtifacts,
  selectSnapshot,
  toArtifactEntry,
} from "./artifact-reducer";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Reduce over frozen states so any in-place mutation throws. */
function run(actions: ArtifactStoreAction[], from: ArtifactStoreState = INITIAL_ARTIFACT_STORE) {
  return actions.reduce((state, action) => artifactReducer(deepFreeze(state), action), from);
}

const open = (
  artifactId: string,
  revision = 1,
  extra: { messageId?: string; artifactType?: ArtifactType; language?: ArtifactLanguage } = {},
): StreamEvent => ({
  type: "artifact-open",
  messageId: extra.messageId ?? "msg_1",
  artifactId,
  revision,
  title: `Artifact ${artifactId}`,
  artifactType: extra.artifactType ?? "html",
  language: extra.language ?? "html",
});
const delta = (artifactId: string, seq: number, text: string, revision = 1): StreamEvent => ({
  type: "artifact-delta",
  messageId: "msg_1",
  artifactId,
  revision,
  seq,
  delta: text,
});
const close = (artifactId: string, revision = 1, contentLength?: number): StreamEvent => ({
  type: "artifact-close",
  messageId: "msg_1",
  artifactId,
  revision,
  ...(contentLength === undefined ? {} : { contentLength }),
});

const get = (state: ArtifactStoreState, id: string) => {
  const record = selectArtifact(state, id);
  if (record === undefined) throw new Error(`artifact ${id} missing`);
  return record;
};
const codes = (state: ArtifactStoreState) => state.diagnostics.map((d) => d.code);

describe("contentHash", () => {
  it.each([
    ["", "811c9dc5"],
    ["a", "e40c292c"],
    ["foobar", "bf9cf968"],
  ])("FNV-1a(%j) = %s", (input, hash) => {
    expect(contentHash(input)).toBe(hash);
  });
});

describe("artifactReducer — lifecycle", () => {
  it("registers an opened artifact as streaming revision 1", () => {
    const state = run([open("a")]);
    expect(get(state, "a")).toMatchObject({
      revision: 1,
      state: "streaming",
      content: "",
      nextSeq: 0,
      pending: [],
      truncated: false,
      history: [],
    });
    expect(state.order).toEqual(["a"]);
  });

  it("appends in-order deltas and seals on close with a snapshot", () => {
    const state = run([
      open("a"),
      delta("a", 0, "<h1>"),
      delta("a", 1, "Hi</h1>"),
      close("a", 1, 11),
    ]);
    const record = get(state, "a");
    expect(record).toMatchObject({ state: "complete", content: "<h1>Hi</h1>" });
    expect(record.history).toEqual([
      {
        revision: 1,
        messageId: "msg_1",
        title: "Artifact a",
        type: "html",
        language: "html",
        content: "<h1>Hi</h1>",
        hash: contentHash("<h1>Hi</h1>"),
      },
    ]);
    expect(state.diagnostics).toEqual([]);
  });

  it("returns the same state object for unrelated events", () => {
    const state = run([open("a")]);
    for (const event of [
      validEvents["start-message"],
      validEvents["text-delta"],
      validEvents["tool-call"],
      validEvents["tool-result"],
    ]) {
      expect(artifactReducer(state, event)).toBe(state);
    }
  });

  it("tracks several artifacts independently, in open order", () => {
    const state = run([open("b"), open("a"), delta("a", 0, "A"), delta("b", 0, "B"), close("b")]);
    expect(selectArtifacts(state).map((r) => [r.id, r.state, r.content])).toEqual([
      ["b", "complete", "B"],
      ["a", "streaming", "A"],
    ]);
  });
});

describe("artifactReducer — ordering guards", () => {
  it("buffers out-of-order deltas and drains them once the gap fills", () => {
    const partial = run([open("a"), delta("a", 2, "C"), delta("a", 1, "B")]);
    expect(get(partial, "a")).toMatchObject({ content: "", nextSeq: 0 });
    expect(get(partial, "a").pending.map((p) => p.seq)).toEqual([1, 2]);

    const filled = run([delta("a", 0, "A"), close("a")], partial);
    expect(get(filled, "a")).toMatchObject({
      content: "ABC",
      nextSeq: 3,
      pending: [],
      state: "complete",
    });
  });

  it("ignores a delta that was already applied or buffered", () => {
    const state = run([
      open("a"),
      delta("a", 0, "A"),
      delta("a", 0, "A"),
      delta("a", 3, "D"),
      delta("a", 3, "D"),
    ]);
    expect(get(state, "a").content).toBe("A");
    expect(get(state, "a").pending).toHaveLength(1);
    expect(codes(state)).toEqual(["duplicate-delta", "duplicate-delta"]);
  });

  it("fails the artifact when a delta is too far ahead (packets lost)", () => {
    const state = run([open("a"), delta("a", LIMITS.reorderWindow + 1, "x")]);
    expect(get(state, "a")).toMatchObject({
      state: "error",
      error: { code: "stream_interrupted" },
      pending: [],
    });
    expect(codes(state)).toEqual(["reorder-overflow"]);
  });

  it("fails on close when deltas never arrived", () => {
    const state = run([open("a"), delta("a", 0, "A"), delta("a", 3, "D"), close("a")]);
    expect(get(state, "a")).toMatchObject({
      state: "error",
      error: { code: "stream_interrupted" },
    });
    expect(state.diagnostics.at(-1)).toMatchObject({
      code: "missing-deltas",
      message: "Deltas 1-2 never arrived",
    });
  });

  it("fails on close when the assembled length does not match", () => {
    const state = run([open("a"), delta("a", 0, "abc"), close("a", 1, 4)]);
    expect(get(state, "a").state).toBe("error");
    expect(codes(state)).toEqual(["integrity-mismatch"]);
  });

  it.each([
    ["a delta", delta("ghost", 0, "x")],
    ["a close", close("ghost")],
  ])("reports %s for an artifact that was never opened", (_case, event) => {
    const state = run([event]);
    expect(selectArtifact(state, "ghost")).toBeUndefined();
    expect(codes(state)).toEqual(["unknown-artifact"]);
  });

  it("rejects deltas for another revision", () => {
    const state = run([open("a"), delta("a", 0, "x", 2)]);
    expect(get(state, "a").content).toBe("");
    expect(codes(state)).toEqual(["unexpected-revision"]);
  });

  it("ignores deltas and closes after the revision is sealed", () => {
    const state = run([open("a"), close("a"), delta("a", 0, "late"), close("a")]);
    expect(get(state, "a")).toMatchObject({ state: "complete", content: "" });
    expect(codes(state)).toEqual(["not-streaming", "not-streaming"]);
  });
});

describe("artifactReducer — revisions and history", () => {
  it("rejects a new artifact that does not start at revision 1", () => {
    const state = run([open("a", 2)]);
    expect(selectArtifact(state, "a")).toBeUndefined();
    expect(codes(state)).toEqual(["unexpected-revision"]);
  });

  it("rejects a duplicate open of the same revision", () => {
    const state = run([open("a"), delta("a", 0, "x"), open("a")]);
    expect(get(state, "a").content).toBe("x");
    expect(codes(state)).toEqual(["duplicate-open"]);
  });

  it("restarts a revision that broke off mid-stream when it is sent again", () => {
    const broken = run([open("a"), close("a"), open("a", 2), delta("a", 0, "half", 2)]);
    const interrupted = artifactReducer(broken, { type: "stream-aborted" });
    expect(get(interrupted, "a").state).toBe("error");

    const retried = run([open("a", 2), delta("a", 0, "whole", 2), close("a", 2)], interrupted);
    expect(get(retried, "a")).toMatchObject({ revision: 2, state: "complete", content: "whole" });
    expect(get(retried, "a").error).toBeUndefined();
    expect(get(retried, "a").history.map((s) => s.revision)).toEqual([1, 2]);
    expect(codes(retried)).toEqual(["interrupted"]);
  });

  it("never restarts a quarantined revision", () => {
    const sealed = run([open("a"), delta("a", 0, "bad"), close("a")]);
    const quarantined = artifactReducer(sealed, {
      type: "artifact-quarantined",
      artifactId: "a",
      revision: 1,
      problem: validProblem,
    });
    const replayed = run([open("a"), delta("a", 0, "bad")], quarantined);
    expect(get(replayed, "a")).toMatchObject({ state: "error", content: "bad", quarantined: true });
    expect(codes(replayed)).toEqual(["quarantined", "duplicate-open", "not-streaming"]);
  });

  it("rejects the next revision while the current one is streaming", () => {
    const state = run([open("a"), open("a", 2)]);
    expect(get(state, "a").revision).toBe(1);
    expect(codes(state)).toEqual(["revision-in-progress"]);
  });

  it("rejects skipping a revision", () => {
    const state = run([open("a"), close("a"), open("a", 3)]);
    expect(codes(state)).toEqual(["unexpected-revision"]);
  });

  it("starts the next revision from empty content and keeps the history", () => {
    const state = run([
      open("a"),
      delta("a", 0, "v1"),
      close("a"),
      open("a", 2, { artifactType: "react", language: "tsx" }),
      delta("a", 0, "v2", 2),
      close("a", 2),
    ]);
    const record = get(state, "a");
    expect(record).toMatchObject({ revision: 2, type: "react", content: "v2", state: "complete" });
    expect(record.history.map((s) => [s.revision, s.content, s.type])).toEqual([
      [1, "v1", "html"],
      [2, "v2", "react"],
    ]);
    expect(selectSnapshot(state, "a", 1)?.content).toBe("v1");
    expect(selectSnapshot(state, "a", 3)).toBeUndefined();
    expect(selectSnapshot(state, "zzz", 1)).toBeUndefined();
    expect(state.order).toEqual(["a"]);
  });

  it("allows a new revision after a failed one and clears the error", () => {
    const state = run([open("a"), close("a", 1, 5), open("a", 2)]);
    const record = get(state, "a");
    expect(record).toMatchObject({ revision: 2, state: "streaming" });
    expect(record.error).toBeUndefined();
  });

  it("keeps at most LIMITS.artifactHistory snapshots", () => {
    const total = LIMITS.artifactHistory + 2;
    const actions = Array.from({ length: total }, (_, i) => [
      open("a", i + 1),
      close("a", i + 1),
    ]).flat();
    const { history } = get(run(actions), "a");
    expect(history).toHaveLength(LIMITS.artifactHistory);
    expect(history[0]?.revision).toBe(3);
    expect(history.at(-1)?.revision).toBe(total);
  });
});

describe("artifactReducer — payload limits", () => {
  const max = LIMITS.artifactContentChars;

  it("truncates content at the limit and fails the artifact", () => {
    const state = run([
      open("a"),
      delta("a", 0, "x".repeat(max - 2)),
      delta("a", 1, "yyyy"),
      delta("a", 2, "z"),
    ]);
    const record = get(state, "a");
    expect(record.content).toHaveLength(max);
    expect(record.content.endsWith("yy")).toBe(true);
    expect(record).toMatchObject({ truncated: true, state: "error", nextSeq: 2 });
    expect(record.error).toMatchObject({ code: "validation_failed" });
    expect(codes(state)).toEqual(["content-truncated", "not-streaming"]);
  });

  it("never truncates in the middle of a surrogate pair", () => {
    const emoji = String.fromCodePoint(0x1f98a);
    const state = run([open("a"), delta("a", 0, "x".repeat(max - 1)), delta("a", 1, emoji)]);
    expect(get(state, "a").content).toBe("x".repeat(max - 1));
  });

  it("counts buffered out-of-order deltas toward the limit", () => {
    const state = run([open("a"), delta("a", 1, "x".repeat(max)), delta("a", 2, "y")]);
    expect(get(state, "a")).toMatchObject({ state: "error", error: { code: "validation_failed" } });
    expect(codes(state)).toEqual(["reorder-overflow"]);
  });
});

describe("artifactReducer — error transitions", () => {
  it("captures an error event's problem on that message's streaming artifacts", () => {
    const state = run([
      open("a"),
      open("b", 1, { messageId: "msg_2" }),
      open("c"),
      close("c"),
      { type: "error", messageId: "msg_1", error: validProblem },
    ]);
    expect(get(state, "a")).toMatchObject({ state: "error", error: validProblem });
    expect(get(state, "b").state).toBe("streaming");
    expect(get(state, "c").state).toBe("complete");
    expect(state.diagnostics.at(-1)).toMatchObject({
      code: "interrupted",
      message: "Connection refused",
    });
  });

  it("fails every streaming artifact for an error without a messageId", () => {
    const { detail: _omitted, ...problem } = validProblem;
    const state = run([
      open("a"),
      open("b", 1, { messageId: "msg_2" }),
      { type: "error", error: problem },
    ]);
    expect([get(state, "a").state, get(state, "b").state]).toEqual(["error", "error"]);
    expect(state.diagnostics.at(-1)?.message).toBe(problem.title);
  });

  it("fails artifacts left open when their message finishes", () => {
    const state = run([open("a"), { ...validEvents["finish-message"], messageId: "msg_1" }]);
    expect(get(state, "a")).toMatchObject({
      state: "error",
      error: { code: "stream_interrupted" },
    });
  });

  it("fails streaming artifacts when the transport aborts", () => {
    const state = run([
      open("a"),
      open("b", 1, { messageId: "msg_2" }),
      { type: "stream-aborted", messageId: "msg_2" },
    ]);
    expect(get(state, "a").state).toBe("streaming");
    expect(get(state, "b")).toMatchObject({ state: "error", error: { retryable: true } });

    const all = run([{ type: "stream-aborted" }], state);
    expect(get(all, "a").state).toBe("error");
  });

  it("bounds the diagnostics log", () => {
    const state = run(
      Array.from({ length: LIMITS.diagnostics + 5 }, (_, i) => delta(`g${i}`, 0, "x")),
    );
    expect(state.diagnostics).toHaveLength(LIMITS.diagnostics);
    expect(state.diagnostics[0]?.artifactId).toBe("g5");
  });
});

describe("selectors", () => {
  it("never resolves inherited object members as artifacts", () => {
    expect(selectArtifact(INITIAL_ARTIFACT_STORE, "constructor")).toBeUndefined();
    expect(selectArtifact(INITIAL_ARTIFACT_STORE, "toString")).toBeUndefined();
    const state = run([open("constructor"), delta("constructor", 0, "ok")]);
    expect(get(state, "constructor").content).toBe("ok");
    expect(Object.getPrototypeOf(state.artifacts)).toBe(Object.prototype);
  });

  it.each([
    ["streaming", [open("a"), delta("a", 0, "x")]],
    ["complete", [open("a"), close("a")]],
    ["error", [open("a"), { type: "stream-aborted" } as const]],
  ] as const)("maps a %s record to a schema-valid ArtifactEntry", (state, actions) => {
    const entry = toArtifactEntry(get(run([...actions]), "a"));
    expect(ArtifactEntrySchema.parse(entry)).toEqual(entry);
    expect(entry.state).toBe(state);
  });
});

describe("artifactReducer — quarantine", () => {
  const problem = { ...validProblem, code: "artifact_rejected" as const, status: 422 };
  const quarantine = (revision = 1): ArtifactStoreAction => ({
    type: "artifact-quarantined",
    artifactId: "a",
    revision,
    problem,
  });

  it("fails a sealed revision closed and drops its snapshot", () => {
    const state = run([open("a"), delta("a", 0, "<p>"), close("a"), quarantine()]);
    expect(get(state, "a")).toMatchObject({
      state: "error",
      error: problem,
      history: [],
      content: "<p>",
    });
    expect(state.diagnostics.at(-1)).toMatchObject({
      code: "quarantined",
      message: problem.detail,
    });
  });

  it("keeps earlier sealed revisions in the history", () => {
    const state = run([open("a"), close("a"), open("a", 2), close("a", 2), quarantine(2)]);
    expect(get(state, "a").history.map((s) => s.revision)).toEqual([1]);
  });

  it.each([
    ["a stale revision", [open("a"), close("a"), open("a", 2), close("a", 2), quarantine(1)]],
    ["a still-streaming revision", [open("a"), quarantine()]],
    ["an unknown artifact", [quarantine()]],
  ])("ignores %s", (_case, actions) => {
    const before = run(actions.slice(0, -1));
    expect(artifactReducer(before, actions.at(-1) as ArtifactStoreAction)).toBe(before);
  });

  it("falls back to the title when the problem has no detail", () => {
    const { detail: _omitted, ...bare } = problem;
    const state = run([
      open("a"),
      close("a"),
      { ...quarantine(), problem: bare } as ArtifactStoreAction,
    ]);
    expect(state.diagnostics.at(-1)?.message).toBe(bare.title);
  });
});
