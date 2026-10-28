import { z } from "zod";

/**
 * Circuit breaker for the preview runner.
 *
 * Static side: flag loops that can never exit before they are run. Runtime side: the runner
 * document posts heartbeats to the studio; when they stop (main thread stuck) the preview
 * is torn down, and content that hangs repeatedly is not started again.
 *
 * Limits: a sandboxed srcdoc frame may share the studio's process, so a truly blocked
 * frame can delay the studio's own timers too. The watchdog fires as soon as the studio
 * gets the thread back; the static check is what prevents most hangs in the first place.
 */

// --- Static loop heuristics ------------------------------------------------------------

/**
 * Blank out comments (and, optionally, string and template literals) while keeping every
 * character's offset, so findings on the masked text map back to the original source.
 */
export function maskJs(source: string, options: { strings: boolean }): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char) j += source[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, source.length);
      if (options.strings) blank(i + 1, stop - 1);
      i = stop;
    } else {
      i++;
    }
  }
  return out.join("");
}

export type LoopKind = "while-true" | "for-ever" | "do-while-true";

export interface LoopFinding {
  kind: LoopKind;
  /** Offset of the loop keyword in the original source. */
  index: number;
}

const EXIT_RE = /\b(?:break|return|throw|await|yield)\b/;
const TRUTHY = "(?:true|1|!0|!false|!!1)";

/** Index just past the brace block opening at `open`, or source end if unbalanced. */
function blockEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i + 1;
  }
  return code.length;
}

/** The loop body following a header that ends at `from`: a block or a single statement. */
function bodyAfter(code: string, from: number): string {
  const start = code.slice(from).search(/\S/);
  if (start === -1) return "";
  const at = from + start;
  if (code[at] === "{") return code.slice(at, blockEnd(code, at));
  const semicolon = code.indexOf(";", at);
  return code.slice(at, semicolon === -1 ? code.length : semicolon + 1);
}

/** Loops with a constant-true condition and no way out in their body. */
export function detectRunawayLoops(source: string): LoopFinding[] {
  const code = maskJs(source, { strings: true });
  const findings: LoopFinding[] = [];

  const headers: [LoopKind, RegExp][] = [
    ["while-true", new RegExp(String.raw`\bwhile\s*\(\s*${TRUTHY}\s*\)`, "g")],
    ["for-ever", /\bfor\s*\(\s*;\s*;\s*\)/g],
  ];
  for (const [kind, pattern] of headers) {
    for (const match of code.matchAll(pattern)) {
      // `} while (true);` closes a do-while; that form is handled below.
      if (kind === "while-true" && /\}\s*$/.test(code.slice(0, match.index))) continue;
      const body = bodyAfter(code, match.index + match[0].length);
      if (!EXIT_RE.test(body)) findings.push({ kind, index: match.index });
    }
  }

  for (const match of code.matchAll(/\bdo\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const end = blockEnd(code, open);
    const tail = new RegExp(String.raw`^\s*while\s*\(\s*${TRUTHY}\s*\)`);
    if (tail.test(code.slice(end)) && !EXIT_RE.test(code.slice(open, end))) {
      findings.push({ kind: "do-while-true", index: match.index });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

// --- Runtime watchdog --------------------------------------------------------------------

export const RUNNER_CHANNEL = "agent-studio-runner";

export const RunnerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    channel: z.literal(RUNNER_CHANNEL),
    token: z.string(),
    type: z.literal("heartbeat"),
  }),
  z.strictObject({
    channel: z.literal(RUNNER_CHANNEL),
    token: z.string(),
    type: z.literal("error"),
    message: z.string().max(500),
  }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>;

/**
 * Bootstrap injected (with the CSP nonce) at the top of every runner document: sends a
 * heartbeat on an interval and forwards uncaught errors to the studio.
 */
export function heartbeatScript(token: string, intervalMs = 500): string {
  const base = JSON.stringify({ channel: RUNNER_CHANNEL, token });
  return [
    "(() => {",
    `  const send = (message) => parent.postMessage(Object.assign(${base}, message), "*");`,
    "  const describe = (value) => String((value && value.message) || value).slice(0, 500);",
    '  send({ type: "heartbeat" });',
    `  setInterval(() => send({ type: "heartbeat" }), ${intervalMs});`,
    '  addEventListener("error", (event) => send({ type: "error", message: describe(event.error || event.message) }));',
    '  addEventListener("unhandledrejection", (event) => send({ type: "error", message: describe(event.reason) }));',
    "})();",
  ].join("\n");
}

/** A runner message for `token`, or null for anything else posted to the window. */
export function parseRunnerMessage(data: unknown, token: string): RunnerMessage | null {
  const result = RunnerMessageSchema.safeParse(data);
  return result.success && result.data.token === token ? result.data : null;
}

export type TripReason = "boot-timeout" | "stalled";
export type MonitorState = "idle" | "booting" | "healthy" | "tripped" | "stopped";

export interface SandboxMonitorOptions {
  /** Time allowed for the first heartbeat. */
  bootTimeoutMs?: number;
  /** Longest gap tolerated between heartbeats once running. */
  stallTimeoutMs?: number;
  onTrip: (reason: TripReason) => void;
  onError?: (message: string) => void;
}

/** Watchdog for one runner frame. Feed it every `message` event from that frame. */
export class SandboxMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: MonitorState = "idle";
  private readonly bootTimeoutMs: number;
  private readonly stallTimeoutMs: number;

  constructor(
    private readonly token: string,
    private readonly options: SandboxMonitorOptions,
  ) {
    this.bootTimeoutMs = options.bootTimeoutMs ?? 15_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 4_000;
  }

  get state(): MonitorState {
    return this.current;
  }

  private arm(ms: number, reason: TripReason): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.current = "tripped";
      this.options.onTrip(reason);
    }, ms);
  }

  start(): void {
    if (this.current !== "idle") return;
    this.current = "booting";
    this.arm(this.bootTimeoutMs, "boot-timeout");
  }

  /** Returns true when `data` was a message for this frame. */
  handle(data: unknown): boolean {
    const message = parseRunnerMessage(data, this.token);
    if (message === null) return false;
    if (this.current !== "booting" && this.current !== "healthy") return true;
    if (message.type === "heartbeat") {
      this.current = "healthy";
      this.arm(this.stallTimeoutMs, "stalled");
    } else {
      this.options.onError?.(message.message);
    }
    return true;
  }

  stop(): void {
    clearTimeout(this.timer);
    if (this.current !== "tripped") this.current = "stopped";
  }
}

/** Remembers which content keeps hanging; open circuits are not run again. */
export class CircuitBreaker {
  private readonly failures = new Map<string, number>();

  constructor(readonly threshold = 2) {}

  recordFailure(key: string): void {
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
  }

  failuresFor(key: string): number {
    return this.failures.get(key) ?? 0;
  }

  isOpen(key: string): boolean {
    return this.failuresFor(key) >= this.threshold;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

/** Shared by every preview in the studio. */
export const runnerCircuitBreaker = new CircuitBreaker();
