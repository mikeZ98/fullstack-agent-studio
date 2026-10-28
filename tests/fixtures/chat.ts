// Request bodies shaped exactly like the AI SDK's DefaultChatTransport sends them.
import type { AgentRequest, ChatRequest } from "@/lib/schemas";

export const chatRequest = {
  id: "chat_1",
  trigger: "submit-message",
  messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] },
    {
      id: "msg_a1",
      role: "assistant",
      metadata: { finishReason: "stop" },
      parts: [
        { type: "step-start" },
        { type: "text", text: "Hello! What should I build?", state: "done" },
        { type: "data-artifact-open" },
      ],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "Build a react component" }] },
  ],
} as const satisfies ChatRequest;

export const agentRequest: AgentRequest = {
  chatId: "chat_1",
  messages: [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello! What should I build?" },
    { role: "user", content: "Build a react component" },
  ],
};

export async function readText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream === null ? "" : new Response(stream).text();
}

export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) out.push(r.value);
  return out;
}
