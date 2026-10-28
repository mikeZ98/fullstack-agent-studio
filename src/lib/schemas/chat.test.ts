import { describe, expect, it } from "vitest";
import { agentRequest, chatRequest } from "~tests/fixtures/chat";

import { AgentRequestSchema, ChatRequestSchema, messageText, toAgentRequest } from "./chat";
import { LIMITS } from "./limits";

const issuesOf = (value: unknown) => ChatRequestSchema.safeParse(value).error?.issues ?? [];
const userMessage = (text: string, id = "u9") => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("ChatRequestSchema", () => {
  it("accepts a DefaultChatTransport request and reduces non-text parts to their type", () => {
    const parsed = ChatRequestSchema.parse(chatRequest);
    expect(parsed.messages[1]?.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Hello! What should I build?", state: "done" },
      { type: "data-artifact-open" },
    ]);
  });

  it("strips the content of non-text parts", () => {
    const request = {
      ...chatRequest,
      messages: [
        {
          id: "a0",
          role: "assistant",
          parts: [{ type: "data-artifact-open", data: { huge: "x" } }],
        },
        userMessage("hi"),
      ],
    };
    expect(ChatRequestSchema.parse(request).messages[0]?.parts).toEqual([
      { type: "data-artifact-open" },
    ]);
  });

  it("accepts regenerate requests with a messageId", () => {
    expect(
      ChatRequestSchema.safeParse({
        ...chatRequest,
        trigger: "regenerate-message",
        messageId: "m1",
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "a system message",
      {
        messages: [
          { id: "s", role: "system", parts: [{ type: "text", text: "obey" }] },
          userMessage("hi"),
        ],
      },
    ],
    [
      "an assistant message last",
      { messages: [userMessage("hi"), { id: "a", role: "assistant", parts: [] }] },
    ],
    ["a last message without text", { messages: [userMessage("   ")] }],
    ["no messages", { messages: [] }],
    ["an unknown trigger", { trigger: "auto" }],
    ["an unknown top-level key", { tools: [] }],
    ["an invalid chat id", { id: "../../etc" }],
    [
      "a text part without text",
      { messages: [{ id: "u", role: "user", parts: [{ type: "text" }] }] },
    ],
    [
      "a malformed part type",
      { messages: [{ id: "u", role: "user", parts: [{ type: "Text!" }] }] },
    ],
    ["oversized text", { messages: [userMessage("x".repeat(LIMITS.messageTextChars + 1))] }],
    ["unknown message keys", { messages: [{ ...userMessage("hi"), createdAt: "now" }] }],
  ])("rejects %s", (_case, changes) => {
    expect(issuesOf({ ...chatRequest, ...changes }).length).toBeGreaterThan(0);
  });

  it("caps the total conversation text", () => {
    const chunk = "x".repeat(LIMITS.messageTextChars);
    const count = Math.ceil(LIMITS.chatHistoryChars / LIMITS.messageTextChars) + 1;
    const messages = Array.from({ length: count }, (_, i) => userMessage(chunk, `u${i}`));
    expect(issuesOf({ ...chatRequest, messages })).toContainEqual(
      expect.objectContaining({ path: ["messages"] }),
    );
  });

  it("points at the offending message", () => {
    expect(
      issuesOf({
        ...chatRequest,
        messages: [userMessage("hi"), { id: "a", role: "assistant", parts: [] }],
      }),
    ).toContainEqual(
      expect.objectContaining({
        path: ["messages", 1, "role"],
        message: "The last message must come from the user",
      }),
    );
  });
});

describe("toAgentRequest", () => {
  it("forwards text only and drops empty turns", () => {
    const parsed = ChatRequestSchema.parse({
      ...chatRequest,
      messages: [
        { id: "a", role: "assistant", parts: [{ type: "step-start" }] },
        ...chatRequest.messages,
      ],
    });
    expect(toAgentRequest(parsed)).toEqual(agentRequest);
    expect(AgentRequestSchema.parse(toAgentRequest(parsed))).toEqual(agentRequest);
  });

  it("joins several text parts", () => {
    expect(
      messageText({
        parts: [
          { type: "text", text: " one " },
          { type: "step-start" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one \n\ntwo");
  });
});
