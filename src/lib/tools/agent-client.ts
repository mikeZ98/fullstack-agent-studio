import {
  type AgentRequest,
  createProblem,
  LIMITS,
  type ProblemDetails,
  ProblemDetailsSchema,
} from "@/lib/schemas";

/**
 * HTTP client for the agent backend (BACKEND_SSE_URL).
 *
 * Retries are bounded and happen only *before* any byte of the answer is handed out: a
 * generation that has started streaming is never replayed. Every outbound fetch is tied to
 * the caller's AbortSignal, a connect timeout and an idle (stall) timeout, and all timers
 * and listeners are released when the body finishes, errors or is cancelled.
 */

export interface AgentStreamInit {
  signal?: AbortSignal;
}

export interface AgentClient {
  /** Resolves with the upstream SSE body once the backend accepted the request. */
  stream(request: AgentRequest, init?: AgentStreamInit): Promise<ReadableStream<Uint8Array>>;
}

export interface AgentClientOptions {
  endpoint: string;
  /** Injected fetch; resolved from globalThis at call time when omitted. */
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>>;
  /** Extra attempts after the first for retryable failures. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A Retry-After longer than this is not waited for; the 429/503 is returned instead. */
  maxRetryAfterMs?: number;
  /** Time allowed until response headers arrive. */
  connectTimeoutMs?: number;
  /** Longest silence tolerated between body chunks. */
  idleTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

export class AgentClientError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly options: { retryAfterMs?: number; upstreamStatus?: number; cause?: unknown } = {},
  ) {
    super(problem.detail ?? problem.title, { cause: options.cause });
    this.name = "AgentClientError";
  }

  get status(): number {
    return this.problem.status;
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Abortable delay. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After as milliseconds (delta-seconds or HTTP-date); undefined when absent/invalid. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Read at most `limit` bytes of a body as text, then cancel the rest. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= limit) break;
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Translate an upstream HTTP failure into this gateway's problem. The upstream's own
 * RFC 9457 detail is kept when it sent one; status and code reflect the gateway's view.
 */
export async function problemFromResponse(response: Response): Promise<ProblemDetails> {
  const { status, statusText } = response;
  const isProblem = response.headers.get("content-type")?.includes("json") ?? false;
  const body = await readCapped(response.body, LIMITS.upstreamErrorBytes);

  let upstreamDetail: string | undefined;
  if (isProblem) {
    try {
      upstreamDetail = ProblemDetailsSchema.parse(JSON.parse(body)).detail;
    } catch {
      upstreamDetail = undefined;
    }
  }
  const label = `${status}${statusText ? ` ${statusText}` : ""}`;
  const detail = upstreamDetail ?? `Agent backend responded ${label}`;

  if (status === 429) return createProblem("rate_limited", { detail });
  if (status === 401 || status === 403) {
    // The gateway's own credentials were refused: a server-side fault, not the user's.
    return createProblem("upstream_error", {
      detail: `Agent backend refused credentials (${label})`,
    });
  }
  if (status === 502 || status === 503) return createProblem("upstream_unavailable", { detail });
  if (status === 504) return createProblem("timeout", { detail });
  return createProblem("upstream_error", { detail });
}

/** Link a child controller to a parent signal; returns the unlink function. */
function follow(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => undefined;
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

class TimeoutSignal extends Error {
  constructor(readonly phase: "connect" | "idle") {
    super(`Agent backend ${phase} timeout`);
    this.name = "TimeoutError";
  }
}

/**
 * Wrap the upstream body: enforce the idle timeout, and on consumer cancel or caller abort
 * tear down the upstream fetch. `release` runs exactly once when the body settles.
 */
function guardBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const finish = () => {
    if (!released) {
      released = true;
      release();
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(downstream) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutSignal("idle")), idleTimeoutMs);
        });
        const read = reader.read();
        // If the idle timer wins, the pending read may still reject later: never leave it unhandled.
        read.catch(() => undefined);
        try {
          const result = await Promise.race([read, idle]);
          if (result.done) {
            finish();
            downstream.close();
          } else {
            downstream.enqueue(result.value);
          }
        } catch (error) {
          const stalled = error instanceof TimeoutSignal;
          controller.abort(error);
          await reader.cancel(error).catch(() => undefined);
          finish();
          downstream.error(
            new AgentClientError(
              stalled
                ? createProblem("timeout", {
                    detail: `No data from agent backend for ${idleTimeoutMs} ms`,
                  })
                : createProblem("stream_interrupted", { detail: "Agent backend stream failed" }),
              { cause: error },
            ),
          );
        } finally {
          clearTimeout(timer);
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        await reader.cancel(reason).catch(() => undefined);
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}

export function createAgentClient(options: AgentClientOptions): AgentClient {
  const {
    endpoint,
    headers = {},
    maxRetries = 2,
    baseDelayMs = 250,
    maxDelayMs = 4_000,
    maxRetryAfterMs = 10_000,
    connectTimeoutMs = 15_000,
    idleTimeoutMs = 30_000,
    sleep: wait = sleep,
    random = Math.random,
  } = options;

  const backoff = (attempt: number) =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() * 0.5);

  async function attempt(
    request: AgentRequest,
    signal: AbortSignal | undefined,
  ): Promise<
    { body: ReadableStream<Uint8Array> } | { error: AgentClientError; retryable: boolean }
  > {
    const controller = new AbortController();
    const unfollow = follow(signal, controller);
    const connectTimer = setTimeout(
      () => controller.abort(new TimeoutSignal("connect")),
      connectTimeoutMs,
    );
    const release = () => {
      clearTimeout(connectTimer);
      unfollow();
    };

    let response: Response;
    try {
      const doFetch = options.fetch ?? globalThis.fetch;
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(request),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      release();
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.reason instanceof TimeoutSignal) {
        const detail = `No response from agent backend within ${connectTimeoutMs} ms`;
        return {
          error: new AgentClientError(createProblem("timeout", { detail }), { cause: error }),
          retryable: true,
        };
      }
      const detail = "Could not connect to the agent backend";
      return {
        error: new AgentClientError(createProblem("upstream_unavailable", { detail }), {
          cause: error,
        }),
        retryable: true,
      };
    }
    clearTimeout(connectTimer);

    if (!response.ok) {
      const problem = await problemFromResponse(response);
      release();
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const error = new AgentClientError(problem, {
        upstreamStatus: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
      return { error, retryable: RETRYABLE_STATUS.has(response.status) };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (response.body === null || !contentType.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      release();
      const detail = `Agent backend answered with ${contentType || "no content type"}, expected an event stream`;
      return {
        error: new AgentClientError(createProblem("upstream_error", { detail })),
        retryable: false,
      };
    }
    return { body: guardBody(response.body, controller, idleTimeoutMs, release) };
  }

  return {
    async stream(request, init = {}) {
      const { signal } = init;
      for (let attemptNo = 0; ; attemptNo++) {
        if (signal?.aborted) throw signal.reason;
        const result = await attempt(request, signal);
        if ("body" in result) return result.body;

        const { error, retryable } = result;
        const retryAfter = error.options.retryAfterMs;
        if (!retryable || attemptNo >= maxRetries) throw error;
        if (retryAfter !== undefined && retryAfter > maxRetryAfterMs) throw error;
        await wait(Math.max(retryAfter ?? 0, backoff(attemptNo)), signal);
      }
    },
  };
}
