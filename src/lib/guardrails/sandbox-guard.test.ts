// @vitest-environment node
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CircuitBreaker,
  detectRunawayLoops,
  heartbeatScript,
  maskJs,
  parseRunnerMessage,
  RUNNER_CHANNEL,
  SandboxMonitor,
} from "./sandbox-guard";

describe("maskJs", () => {
  const source = 'a = "x // y"; // note\nb = `t`; /* c\n d */ e';

  it("blanks comments but keeps strings, preserving offsets and newlines", () => {
    const masked = maskJs(source, { strings: false });
    expect(masked).toHaveLength(source.length);
    expect(masked).toContain('"x // y"');
    expect(masked).not.toContain("note");
    expect(masked.split("\n")).toHaveLength(3);
  });

  it("can blank string contents too", () => {
    const masked = maskJs(source, { strings: true });
    expect(masked).not.toContain("x // y");
    expect(masked.startsWith('a = "      ";')).toBe(true);
  });

  it("handles escapes and unterminated literals", () => {
    expect(maskJs('"a\\"b" + c', { strings: true })).toBe('"    " + c');
    expect(maskJs('"open', { strings: true })).toHaveLength(5);
    expect(maskJs("/* open", { strings: false }).trim()).toBe("");
  });
});

describe("detectRunawayLoops", () => {
  it.each([
    ["while (true) {}", "while-true"],
    ["while (1) tick();", "while-true"],
    ["while(!0){ x++ }", "while-true"],
    ["for (;;) { draw(); }", "for-ever"],
    ["do { spin(); } while (true);", "do-while-true"],
  ])("flags %s", (code, kind) => {
    expect(detectRunawayLoops(code)).toEqual([{ kind, index: 0 }]);
  });

  it.each([
    "while (true) { if (done) break; }",
    "while (true) { return x; }",
    "while (true) { throw new Error(); }",
    "while (true) await sleep(1);",
    "function* g() { while (true) yield 1; }",
    "for (;;) { if (x) { break; } }",
    "do { if (y) break; } while (true);",
    "while (i < 10) { i++; }",
    "for (let i = 0; i < 3; i++) {}",
    'const s = "while (true) {}"; // while (true) {}',
  ])("does not flag %j", (code) => {
    expect(detectRunawayLoops(code)).toEqual([]);
  });

  it("reports several loops in source order", () => {
    const code = "for (;;) {}\nconst a = 1;\nwhile (true) {}";
    expect(detectRunawayLoops(code).map((f) => f.kind)).toEqual(["for-ever", "while-true"]);
  });

  it("copes with an unbalanced body", () => {
    expect(detectRunawayLoops("while (true) { x++;")).toEqual([{ kind: "while-true", index: 0 }]);
  });
});

describe("heartbeat script", () => {
  it("posts heartbeats and forwards errors from inside the frame", () => {
    const posted: unknown[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const intervals: [() => void, number][] = [];
    runInNewContext(heartbeatScript("tok-1", 250), {
      parent: { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) },
      setInterval: (fn: () => void, ms: number) => intervals.push([fn, ms]),
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      Object,
      String,
    });

    expect(posted).toEqual([[{ channel: RUNNER_CHANNEL, token: "tok-1", type: "heartbeat" }, "*"]]);
    expect(intervals[0]?.[1]).toBe(250);
    intervals[0]?.[0]();
    listeners.get("error")?.({ error: new Error("boom") });
    listeners.get("error")?.({ message: "plain" });
    listeners.get("unhandledrejection")?.({ reason: "x".repeat(600) });

    const messages = posted.map((entry) => (entry as [{ type?: string; message?: unknown }])[0]);
    expect(messages.map((m) => m.type)).toEqual([
      "heartbeat",
      "heartbeat",
      "error",
      "error",
      "error",
    ]);
    expect(messages[2]?.message).toBe("boom");
    expect(messages[3]?.message).toBe("plain");
    expect(String(messages[4]?.message)).toHaveLength(500);
    expect(messages.every((m) => parseRunnerMessage(m, "tok-1") !== null)).toBe(true);
  });
});

describe("parseRunnerMessage", () => {
  it.each([
    [{ channel: RUNNER_CHANNEL, token: "t", type: "heartbeat" }, true],
    [{ channel: RUNNER_CHANNEL, token: "t", type: "error", message: "x" }, true],
    [{ channel: RUNNER_CHANNEL, token: "other", type: "heartbeat" }, false],
    [{ channel: "someone-else", token: "t", type: "heartbeat" }, false],
    [{ channel: RUNNER_CHANNEL, token: "t", type: "heartbeat", extra: 1 }, false],
    [{ channel: RUNNER_CHANNEL, token: "t", type: "error", message: "x".repeat(501) }, false],
    ["heartbeat", false],
    [null, false],
  ])("accepts %j: %s", (data, accepted) => {
    expect(parseRunnerMessage(data, "t") !== null).toBe(accepted);
  });
});

describe("SandboxMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const beat = { channel: RUNNER_CHANNEL, token: "t", type: "heartbeat" };

  function setup() {
    const onTrip = vi.fn();
    const onError = vi.fn();
    const monitor = new SandboxMonitor("t", {
      bootTimeoutMs: 1000,
      stallTimeoutMs: 300,
      onTrip,
      onError,
    });
    return { monitor, onTrip, onError };
  }

  it("trips when the frame never starts", () => {
    const { monitor, onTrip } = setup();
    monitor.start();
    expect(monitor.state).toBe("booting");
    vi.advanceTimersByTime(999);
    expect(onTrip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTrip).toHaveBeenCalledWith("boot-timeout");
    expect(monitor.state).toBe("tripped");
  });

  it("stays healthy while heartbeats arrive and trips when they stop", () => {
    const { monitor, onTrip } = setup();
    monitor.start();
    for (let i = 0; i < 10; i++) {
      expect(monitor.handle(beat)).toBe(true);
      vi.advanceTimersByTime(250);
    }
    expect(monitor.state).toBe("healthy");
    expect(onTrip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onTrip).toHaveBeenCalledWith("stalled");
  });

  it("forwards runtime errors and ignores foreign messages", () => {
    const { monitor, onError } = setup();
    monitor.start();
    expect(monitor.handle({ ...beat, type: "error", message: "boom" })).toBe(true);
    expect(onError).toHaveBeenCalledWith("boom");
    expect(monitor.handle({ ...beat, token: "x" })).toBe(false);
    expect(monitor.handle("noise")).toBe(false);
  });

  it("ignores messages once stopped or tripped, and starts only once", () => {
    const { monitor, onTrip, onError } = setup();
    monitor.handle(beat);
    expect(monitor.state).toBe("idle");
    monitor.start();
    monitor.start();
    vi.advanceTimersByTime(1000);
    expect(onTrip).toHaveBeenCalledOnce();
    monitor.handle({ ...beat, type: "error", message: "late" });
    expect(onError).not.toHaveBeenCalled();
    monitor.stop();
    expect(monitor.state).toBe("tripped");

    const other = setup();
    other.monitor.start();
    other.monitor.stop();
    expect(other.monitor.state).toBe("stopped");
    vi.advanceTimersByTime(5000);
    expect(other.onTrip).not.toHaveBeenCalled();
  });

  it("uses sensible default timeouts", () => {
    const onTrip = vi.fn();
    const monitor = new SandboxMonitor("t", { onTrip });
    monitor.start();
    vi.advanceTimersByTime(14_999);
    expect(onTrip).not.toHaveBeenCalled();
    monitor.handle(beat);
    vi.advanceTimersByTime(4_000);
    expect(onTrip).toHaveBeenCalledWith("stalled");
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold and can be reset", () => {
    const breaker = new CircuitBreaker(2);
    breaker.recordFailure("a");
    expect(breaker.isOpen("a")).toBe(false);
    breaker.recordFailure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
    expect(breaker.failuresFor("a")).toBe(2);
    breaker.reset("a");
    expect(breaker.isOpen("a")).toBe(false);
  });
});
