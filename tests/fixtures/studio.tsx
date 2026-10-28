// Test harness for the studio UI: an in-memory chat transport backed by the mock agent,
// and hand-built context values for rendering components in isolation.
import type { UseChatHelpers } from "@ai-sdk/react";
import { render } from "@testing-library/react";
import type { ChatTransport } from "ai";
import type { ReactElement } from "react";
import { vi } from "vitest";

import { StudioContext, type StudioContextValue } from "@/components/studio-provider";
import {
  type ArtifactStoreAction,
  artifactReducer,
  INITIAL_ARTIFACT_STORE,
} from "@/lib/core/artifact-reducer";
import { type CanvasAction, canvasReducer, INITIAL_CANVAS_MODEL } from "@/lib/core/canvas-reducer";
import type { ArtifactInspection } from "@/lib/guardrails/artifact-guardrails";
import { assessInput, guardChatRequest } from "@/lib/guardrails/input-guardrails";
import { ChatRequestSchema, type StudioUIMessage, toAgentRequest } from "@/lib/schemas";
import { createAgentClient } from "@/lib/tools/agent-client";
import { createMockAgentServer, type MockAgentOptions } from "@/lib/tools/mock-agent-provider";
import { bridgeAgentStream } from "@/lib/tools/stream-bridge";

export interface MockTransport extends ChatTransport<StudioUIMessage> {
  server: ReturnType<typeof createMockAgentServer>;
}

/**
 * Full client-to-agent pipeline without HTTP: each request is validated with the server's
 * ChatRequestSchema, sent through the real agent client to the mock agent, and bridged
 * back into UI message chunks exactly as /api/chat does.
 */
export function mockTransport(options: MockAgentOptions = {}): MockTransport {
  const server = createMockAgentServer(options);
  const client = createAgentClient({
    endpoint: "mock://agent",
    fetch: server.fetch,
    maxRetries: 0,
  });
  return {
    server,
    async sendMessages({ chatId, messages, trigger, messageId, abortSignal }) {
      const request = ChatRequestSchema.parse({
        id: chatId,
        messages,
        trigger,
        ...(messageId === undefined ? {} : { messageId }),
      });
      // Same gate as /api/chat.
      const guarded = guardChatRequest(request);
      if (!guarded.ok) throw new Error(JSON.stringify(guarded.problem));
      try {
        const upstream = await client.stream(
          toAgentRequest(guarded.request),
          abortSignal === undefined ? {} : { signal: abortSignal },
        );
        return bridgeAgentStream(
          upstream,
          abortSignal === undefined ? {} : { signal: abortSignal },
        );
      } catch (error) {
        // Mirror DefaultChatTransport: an HTTP failure surfaces as an Error carrying the body.
        if (error instanceof Error && "problem" in error)
          throw new Error(JSON.stringify(error.problem));
        throw error;
      }
    },
    reconnectToStream: async () => null,
  };
}

export function fakeChat(
  overrides: Partial<UseChatHelpers<StudioUIMessage>> = {},
): UseChatHelpers<StudioUIMessage> {
  return {
    id: "chat_test",
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: vi.fn(async () => undefined),
    regenerate: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setMessages: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  } as unknown as UseChatHelpers<StudioUIMessage>;
}

export interface StudioStateInit {
  artifactActions?: ArtifactStoreAction[];
  canvasActions?: CanvasAction[];
  chat?: Partial<UseChatHelpers<StudioUIMessage>>;
}

export function studioValue({
  artifactActions = [],
  canvasActions = [],
  chat,
  inspections = {},
}: StudioStateInit & {
  inspections?: Record<string, ArtifactInspection>;
} = {}): StudioContextValue {
  const fake = fakeChat(chat);
  return {
    chat: fake,
    artifacts: artifactActions.reduce(artifactReducer, INITIAL_ARTIFACT_STORE),
    canvas: canvasActions.reduce(canvasReducer, INITIAL_CANVAS_MODEL),
    dispatchCanvas: vi.fn(),
    activateArtifact: vi.fn(),
    inspections,
    // Same contract as the provider: screen, then send the sanitised text if allowed.
    sendUserMessage: vi.fn((text: string) => {
      const assessment = assessInput(text);
      if (assessment.allowed) void fake.sendMessage({ text: assessment.sanitizedText });
      return assessment;
    }),
  };
}

export function renderWithStudio(ui: ReactElement, value: StudioContextValue = studioValue()) {
  const wrap = (node: ReactElement) => <StudioContext value={value}>{node}</StudioContext>;
  const result = render(wrap(ui));
  // Keep the provider on rerender, or React would remount the whole subtree.
  return { ...result, value, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

/** Events that leave artifact `id` complete with `content` (and optional later revisions). */
export function sealedArtifact(
  id: string,
  content: string,
  extra: {
    type?: "html" | "react" | "code" | "markdown" | "svg" | "mermaid";
    language?: string;
    title?: string;
    revision?: number;
  } = {},
): ArtifactStoreAction[] {
  const revision = extra.revision ?? 1;
  const type = extra.type ?? "html";
  const defaultLanguage: Record<string, string> = { react: "tsx", code: "py" };
  return [
    {
      type: "artifact-open",
      messageId: "msg_1",
      artifactId: id,
      revision,
      title: extra.title ?? `Artifact ${id}`,
      artifactType: type,
      language: extra.language ?? defaultLanguage[type] ?? type,
    },
    ...(content === ""
      ? []
      : [
          {
            type: "artifact-delta" as const,
            messageId: "msg_1",
            artifactId: id,
            revision,
            seq: 0,
            delta: content,
          },
        ]),
    { type: "artifact-close", messageId: "msg_1", artifactId: id, revision },
  ];
}
