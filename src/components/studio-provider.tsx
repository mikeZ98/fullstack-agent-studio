"use client";

import { type UseChatHelpers, useChat } from "@ai-sdk/react";
import { type ChatTransport, type DataUIPart, DefaultChatTransport } from "ai";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  type ArtifactStoreState,
  artifactReducer,
  INITIAL_ARTIFACT_STORE,
  selectArtifact,
  selectArtifacts,
} from "@/lib/core/artifact-reducer";
import {
  type CanvasAction,
  type CanvasModel,
  canvasReducer,
  INITIAL_CANVAS_MODEL,
} from "@/lib/core/canvas-reducer";
import {
  type ArtifactInspection,
  inspectArtifact,
  inspectionToProblem,
} from "@/lib/guardrails/artifact-guardrails";
import { EMPTY_REPAIR_LEDGER, planRepair, type RepairLedger } from "@/lib/guardrails/critic-loop";
import { assessInput, type InputAssessment } from "@/lib/guardrails/input-guardrails";
import {
  MessageMetadataSchema,
  SPLIT_RATIO_BOUNDS,
  type StudioDataParts,
  type StudioUIMessage,
  studioDataPartSchemas,
} from "@/lib/schemas";

export interface StudioContextValue {
  chat: UseChatHelpers<StudioUIMessage>;
  artifacts: ArtifactStoreState;
  canvas: CanvasModel;
  dispatchCanvas: Dispatch<CanvasAction>;
  /** Open (or focus) an artifact's tab and reveal the canvas. */
  activateArtifact: (artifactId: string) => void;
  /** Security inspection verdicts, keyed by `inspectionKey(id, revision)`. */
  inspections: Readonly<Record<string, ArtifactInspection>>;
  /** Screen a message the user wrote and send it if allowed. Returns the verdict. */
  sendUserMessage: (text: string) => InputAssessment;
}

export function inspectionKey(artifactId: string, revision: number): string {
  return `${artifactId}@${revision}`;
}

/** Exported for composition and tests; app code uses <StudioProvider> and useStudio(). */
export const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (value === null) throw new Error("useStudio must be used inside <StudioProvider>");
  return value;
}

export const SPLIT_RATIO_STORAGE_KEY = "agent-studio:split-ratio";

/** Stored split ratio, or null when absent, invalid, out of bounds or storage is blocked. */
export function readStoredSplitRatio(): number | null {
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    const ratio = raw === null ? Number.NaN : Number(raw);
    return ratio >= SPLIT_RATIO_BOUNDS.min && ratio <= SPLIT_RATIO_BOUNDS.max ? ratio : null;
  } catch {
    return null;
  }
}

export function writeStoredSplitRatio(ratio: number): void {
  try {
    window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(Math.round(ratio * 1000) / 1000));
  } catch {
    // Private mode or blocked storage: the ratio simply is not remembered.
  }
}

export interface StudioProviderProps {
  children: ReactNode;
  /** Chat transport; POSTs to /api/chat by default. Tests inject an in-memory one. */
  transport?: ChatTransport<StudioUIMessage>;
  /** Ask the agent to fix rejected artifacts automatically (bounded). Default: on. */
  autoRepair?: boolean;
}

/**
 * Owns the chat session and the Phase 3 stores. Artifact data parts from the stream are
 * dispatched into the artifact reducer (lifecycle, ordering, integrity) and the canvas
 * reducer (tabs), so chat bubbles and the canvas render from the same state.
 */
export function StudioProvider({ children, transport, autoRepair = true }: StudioProviderProps) {
  const [artifacts, dispatchArtifacts] = useReducer(artifactReducer, INITIAL_ARTIFACT_STORE);
  const [canvas, dispatchCanvas] = useReducer(canvasReducer, INITIAL_CANVAS_MODEL);
  const [defaultTransport] = useState(
    () => new DefaultChatTransport<StudioUIMessage>({ api: "/api/chat" }),
  );

  const onData = useCallback((part: DataUIPart<StudioDataParts>) => {
    switch (part.type) {
      case "data-artifact-open":
        dispatchArtifacts({ type: "artifact-open", ...part.data });
        dispatchCanvas({
          type: "open-tab",
          artifactId: part.data.artifactId,
          artifactType: part.data.artifactType,
        });
        break;
      case "data-artifact-delta":
        dispatchArtifacts({ type: "artifact-delta", ...part.data });
        break;
      case "data-artifact-close":
        dispatchArtifacts({ type: "artifact-close", ...part.data });
        break;
    }
  }, []);

  const chat = useChat<StudioUIMessage>({
    transport: transport ?? defaultTransport,
    dataPartSchemas: studioDataPartSchemas,
    messageMetadataSchema: MessageMetadataSchema,
    onData,
    // Whatever is still streaming when a response ends (normally, aborted or failed) can
    // never complete: let the reducer mark it interrupted.
    onFinish: () => dispatchArtifacts({ type: "stream-aborted" }),
  });

  // Artifact guardrails: inspect every sealed revision once; unsafe ones fail closed.
  const [inspections, setInspections] = useState<Record<string, ArtifactInspection>>({});
  const inspected = useRef(new Set<string>());
  useEffect(() => {
    for (const record of selectArtifacts(artifacts)) {
      const key = inspectionKey(record.id, record.revision);
      if (record.state !== "complete" || inspected.current.has(key)) continue;
      inspected.current.add(key);
      const { id, revision, type, language, content } = record;
      void inspectArtifact({ type, language, content }).then((inspection) => {
        setInspections((current) => ({ ...current, [key]: inspection }));
        if (!inspection.passed) {
          const problem = inspectionToProblem(inspection);
          dispatchArtifacts({ type: "artifact-quarantined", artifactId: id, revision, problem });
        }
      });
    }
  }, [artifacts]);

  // Critic loop: once a response is over, ask the agent to repair one rejected artifact,
  // within the repair budget. The ledger makes this idempotent per artifact revision.
  const ledger = useRef<RepairLedger>(EMPTY_REPAIR_LEDGER);
  const { status, sendMessage } = chat;
  useEffect(() => {
    if (!autoRepair || status !== "ready") return;
    for (const record of selectArtifacts(artifacts)) {
      const inspection = inspections[inspectionKey(record.id, record.revision)];
      if (record.error?.code !== "artifact_rejected" || inspection === undefined) continue;
      const decision = planRepair(ledger.current, record, inspection);
      ledger.current = decision.ledger;
      if (decision.action === "repair") {
        void sendMessage({ text: decision.message });
        return;
      }
    }
  }, [autoRepair, status, artifacts, inspections, sendMessage]);

  const sendUserMessage = useCallback(
    (text: string) => {
      const assessment = assessInput(text);
      if (assessment.allowed) {
        // A message the user wrote starts a fresh repair budget.
        ledger.current = EMPTY_REPAIR_LEDGER;
        void sendMessage({ text: assessment.sanitizedText });
      }
      return assessment;
    },
    [sendMessage],
  );

  // Restore the remembered split after mount (storage is unavailable during SSR). The
  // initial default is never written, so it cannot overwrite the stored value.
  useEffect(() => {
    const stored = readStoredSplitRatio();
    if (stored !== null) dispatchCanvas({ type: "set-split-ratio", ratio: stored });
  }, []);
  const { splitRatio } = canvas.canvas;
  const initialRatio = useRef(splitRatio);
  useEffect(() => {
    if (splitRatio !== initialRatio.current) writeStoredSplitRatio(splitRatio);
  }, [splitRatio]);

  const activateArtifact = useCallback(
    (artifactId: string) => {
      const record = selectArtifact(artifacts, artifactId);
      if (record !== undefined) {
        dispatchCanvas({ type: "open-tab", artifactId, artifactType: record.type });
      }
    },
    [artifacts],
  );

  const value = useMemo(
    () => ({
      chat,
      artifacts,
      canvas,
      dispatchCanvas,
      activateArtifact,
      inspections,
      sendUserMessage,
    }),
    [chat, artifacts, canvas, activateArtifact, inspections, sendUserMessage],
  );
  return <StudioContext value={value}>{children}</StudioContext>;
}
