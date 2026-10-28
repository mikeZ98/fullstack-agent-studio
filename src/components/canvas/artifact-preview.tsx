"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { RUNNER_IFRAME_SANDBOX } from "@/lib/core/sandbox-preprocessor";
import { buildPreview, type PreviewInput, type PreviewPlan } from "@/lib/runner/preview";

import { Markdown } from "../markdown";

export interface ArtifactPreviewProps extends PreviewInput {
  title: string;
}

/**
 * Renders the preview plan for a sealed artifact. Executable previews run in an iframe
 * sandboxed to `allow-scripts` only (opaque origin, no access to the studio) with a
 * per-render nonce CSP from the Phase 3 preprocessor.
 */
export function ArtifactPreview({ type, language, content, title }: ArtifactPreviewProps) {
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
        <iframe
          title={`${title} preview`}
          sandbox={RUNNER_IFRAME_SANDBOX}
          srcDoc={plan.document}
          referrerPolicy="no-referrer"
          className="size-full border-0 bg-white"
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
