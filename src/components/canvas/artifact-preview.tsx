"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { contentHash } from "@/lib/core/artifact-reducer";
import { RUNNER_IFRAME_SANDBOX } from "@/lib/core/sandbox-preprocessor";
import {
  type CircuitBreaker,
  runnerCircuitBreaker,
  SandboxMonitor,
  type TripReason,
} from "@/lib/guardrails/sandbox-guard";
import { buildPreview, type PreviewInput, type PreviewPlan } from "@/lib/runner/preview";

import { Markdown } from "../markdown";
import { Button } from "../ui/button";

export const TRIP_MESSAGES: Readonly<Record<TripReason, string>> = {
  "boot-timeout": "The preview did not start in time and was shut down.",
  stalled: "The preview stopped responding and was shut down.",
};

interface SandboxedFrameProps {
  title: string;
  document: string;
  token: string;
  /** Identifies the content for the circuit breaker. */
  contentKey: string;
  breaker: CircuitBreaker;
  bootTimeoutMs?: number | undefined;
  stallTimeoutMs?: number | undefined;
}

/** The runner frame plus its watchdog: heartbeat monitoring, error relay, circuit breaker. */
function SandboxedFrame({
  title,
  document,
  token,
  contentKey,
  breaker,
  bootTimeoutMs,
  stallTimeoutMs,
}: SandboxedFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [run, setRun] = useState(0);
  const [tripped, setTripped] = useState<TripReason | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the watchdog for a fresh frame.
  useEffect(() => {
    setTripped(null);
    setErrors([]);
    const monitor = new SandboxMonitor(token, {
      ...(bootTimeoutMs === undefined ? {} : { bootTimeoutMs }),
      ...(stallTimeoutMs === undefined ? {} : { stallTimeoutMs }),
      onTrip: (reason) => {
        breaker.recordFailure(contentKey);
        setTripped(reason);
      },
      onError: (message) => setErrors((current) => [...current, message].slice(-3)),
    });
    // Only messages from this frame count; anything else on the window is ignored.
    const onMessage = (event: MessageEvent) => {
      if (frame.current !== null && event.source === frame.current.contentWindow)
        monitor.handle(event.data);
    };
    window.addEventListener("message", onMessage);
    monitor.start();
    return () => {
      window.removeEventListener("message", onMessage);
      monitor.stop();
    };
  }, [token, contentKey, breaker, bootTimeoutMs, stallTimeoutMs, run]);

  if (breaker.isOpen(contentKey)) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 p-8 text-center text-sm">
        <TriangleAlert aria-hidden className="size-6 text-red-500" />
        <p className="font-medium">Preview disabled</p>
        <p className="text-muted-foreground">
          This artifact stopped responding repeatedly, so it is no longer run.
        </p>
      </div>
    );
  }
  if (tripped !== null) {
    return (
      <div role="status" className="flex flex-col items-center gap-3 p-8 text-center text-sm">
        <TriangleAlert aria-hidden className="size-6 text-amber-500" />
        <p>{TRIP_MESSAGES[tripped]}</p>
        <Button size="sm" variant="outline" onClick={() => setRun((n) => n + 1)}>
          <RotateCcw aria-hidden className="size-3.5" />
          Run again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex size-full flex-col">
      {errors.length > 0 && (
        <div
          role="alert"
          aria-label="Runtime errors"
          className="border-b bg-red-500/5 px-4 py-2 font-mono text-xs text-red-700 dark:text-red-300"
        >
          {errors.map((message, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same message may repeat.
            <p key={index}>{message}</p>
          ))}
        </div>
      )}
      <iframe
        key={run}
        ref={frame}
        title={title}
        sandbox={RUNNER_IFRAME_SANDBOX}
        srcDoc={document}
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}

export interface ArtifactPreviewProps extends PreviewInput {
  title: string;
  /** Watchdog timeouts (tests shorten them). */
  bootTimeoutMs?: number;
  stallTimeoutMs?: number;
  breaker?: CircuitBreaker;
}

/**
 * Renders the preview plan for a sealed artifact. Executable previews run in an iframe
 * sandboxed to `allow-scripts` only (opaque origin, no access to the studio) with a
 * per-render nonce CSP from the Phase 3 preprocessor.
 */
export function ArtifactPreview({
  type,
  language,
  content,
  title,
  bootTimeoutMs,
  stallTimeoutMs,
  breaker = runnerCircuitBreaker,
}: ArtifactPreviewProps) {
  const [plan, setPlan] = useState<PreviewPlan | null>(null);

  useEffect(() => {
    let current = true;
    setPlan(null);
    void buildPreview({ type, language, content }).then((next) => {
      if (current) setPlan(next);
    });
    return () => {
      current = false;
    };
  }, [type, language, content]);

  if (plan === null) {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Preparing preview…
      </p>
    );
  }

  switch (plan.kind) {
    case "iframe":
      return (
        <SandboxedFrame
          title={`${title} preview`}
          document={plan.document}
          token={plan.token}
          contentKey={`${type}:${contentHash(content)}`}
          breaker={breaker}
          bootTimeoutMs={bootTimeoutMs}
          stallTimeoutMs={stallTimeoutMs}
        />
      );
    case "image":
      return (
        <div className="grid size-full place-items-center overflow-auto bg-[length:16px_16px] bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] p-6">
          {/* biome-ignore lint/performance/noImgElement: a sanitized data: URI, not an optimizable asset. */}
          <img src={plan.src} alt={title} className="max-h-full max-w-full" />
        </div>
      );
    case "markdown":
      return <Markdown source={plan.source} className="mx-auto max-w-3xl p-6" />;
    case "unavailable":
      return (
        <div role="status" className="flex flex-col items-center gap-2 p-8 text-center text-sm">
          <TriangleAlert aria-hidden className="size-6 text-amber-500" />
          <p className="font-medium">Preview unavailable</p>
          <ul className="text-muted-foreground">
            {plan.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      );
  }
}
