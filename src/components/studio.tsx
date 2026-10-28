"use client";

import type { ChatTransport } from "ai";

import type { StudioUIMessage } from "@/lib/schemas";

import { StudioLayout } from "./studio-layout";
import { StudioProvider } from "./studio-provider";

export interface StudioProps {
  transport?: ChatTransport<StudioUIMessage>;
}

/** The whole studio: chat session, artifact and canvas state, and the split-pane UI. */
export function Studio({ transport }: StudioProps) {
  return (
    <StudioProvider {...(transport === undefined ? {} : { transport })}>
      <StudioLayout />
    </StudioProvider>
  );
}
