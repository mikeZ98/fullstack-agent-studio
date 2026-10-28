"use client";

import type { ChatTransport } from "ai";

import type { StudioUIMessage } from "@/lib/schemas";

import { StudioLayout } from "./studio-layout";
import { StudioProvider } from "./studio-provider";

export interface StudioProps {
  transport?: ChatTransport<StudioUIMessage>;
  /** Ask the agent to fix rejected artifacts automatically (bounded). Default: on. */
  autoRepair?: boolean;
}

/** The whole studio: chat session, artifact and canvas state, and the split-pane UI. */
export function Studio({ transport, autoRepair = true }: StudioProps) {
  return (
    <StudioProvider autoRepair={autoRepair} {...(transport === undefined ? {} : { transport })}>
      <StudioLayout />
    </StudioProvider>
  );
}
