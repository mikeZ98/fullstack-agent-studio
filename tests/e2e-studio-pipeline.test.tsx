// Golden workflows through the production request path: <Studio> → useChat →
// DefaultChatTransport → /api/chat handler → agent client → upstream agent → stream bridge →
// UI message stream → artifact and canvas stores. Everything runs in memory.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Studio } from "@/components/studio";
import { createMockAgentServer, type MockArtifact } from "@/lib/tools/mock-agent-provider";
import { holdAt, scriptedAgent, scriptedReply, trackBodies } from "~tests/fixtures/agent";
import { type RoutePipeline, routePipeline } from "~tests/fixtures/pipeline";

const COUNTER: MockArtifact = {
  title: "Counter",
  language: "tsx",
  content: `import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Clicked {count} times
    </button>
  );
}`,
};

const ARCHITECTURE: MockArtifact = {
  title: "Architecture",
  language: "mermaid",
  content: `flowchart LR
  Browser -->|POST /api/chat| Gateway
  Gateway -->|SSE| Agent`,
};

const API_GUIDE: MockArtifact = {
  title: "API guide",
  language: "html",
  content: `<!doctype html>
<html lang="en">
<head><title>API guide</title></head>
<body><h1>API guide</h1><p>POST /api/chat answers with a UI message stream.</p></body>
</html>`,
};

const chat = () => screen.getByRole("region", { name: "Chat" });
const canvas = () => screen.getByRole("region", { name: "Canvas" });
const assistantTurns = () => within(chat()).queryAllByRole("article", { name: "Assistant" });
const openTabs = () =>
  within(screen.getByRole("tablist", { name: "Open artifacts" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
const selectedTab = () =>
  within(screen.getByRole("tablist", { name: "Open artifacts" })).getByRole("tab", {
    selected: true,
  });

function renderStudio(pipeline: RoutePipeline) {
  const user = userEvent.setup();
  render(<Studio transport={pipeline.transport} />);
  async function send(text: string) {
    const turns = assistantTurns().length;
    await user.type(screen.getByRole("textbox", { name: "Message" }), `${text}{Enter}`);
    // A turn is over when its reply exists and the composer is idle again.
    await waitFor(() => {
      expect(assistantTurns()).toHaveLength(turns + 1);
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    });
  }
  return { user, send };
}

describe("golden workflow — one full round trip", () => {
  it("streams prompt → route → agent → bridge → chat and canvas, live and then sealed", async () => {
    const server = createMockAgentServer({ toolSteps: 1, artifacts: { react: COUNTER } });
    const tracked = trackBodies(server.fetch);
    // Freeze the upstream right before the third artifact delta.
    const held = holdAt(tracked.fetch, '"seq":2,');
    const pipeline = routePipeline({ upstream: held.fetch });
    const user = userEvent.setup();
    render(<Studio transport={pipeline.transport} />);

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Build a React counter component{Enter}",
    );
    await held.reached;

    // Mid-stream: the reply is streaming, tools ran, and the canvas docked itself.
    const card = await within(chat()).findByRole("button", { name: "Open Counter in canvas" });
    await waitFor(() => expect(within(card).getByText("Generating")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();
    const reply = within(chat()).getByRole("article", { name: "Assistant" });
    expect(reply).toHaveTextContent('Working on: "Build a React counter component"');
    expect(within(reply).getByText("search_docs")).toBeInTheDocument();
    expect(reply).not.toHaveTextContent("All artifacts are ready.");

    expect(selectedTab()).toHaveTextContent("Counter");
    expect(within(selectedTab()).getByLabelText("Generating")).toBeInTheDocument();
    const panel = within(canvas()).getByRole("tabpanel");
    await waitFor(() => expect(panel.textContent).toContain("export default function Counter"));
    expect(panel.textContent).not.toContain("Clicked {count} times");
    expect(within(canvas()).getByRole("status")).toHaveTextContent("Generating…");
    expect(within(canvas()).queryByTitle("Counter preview")).not.toBeInTheDocument();

    held.release();

    // Sealed: the artifact is ready, previewed in the sandbox, and the turn is closed.
    await waitFor(() => expect(within(card).getByText("Ready")).toBeInTheDocument());
    await waitFor(() => expect(reply).toHaveTextContent("All artifacts are ready."));
    const frame = await within(canvas()).findByTitle("Counter preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(within(selectedTab()).queryByLabelText("Generating")).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Send message" });

    expect(pipeline.exchanges).toEqual([{ status: 200, retryAfter: null }]);
    expect(pipeline.outcomes.map((o) => o.status)).toEqual(["done"]);
    expect(server.stats.requests).toHaveLength(1);
    expect(server.stats.requests[0]?.messages).toEqual([
      { role: "user", content: "Build a React counter component" },
    ]);
    // [DONE] ends consumption: the dispatcher cancels whatever the upstream might still send.
    expect(tracked.open()).toBe(0);
    expect(tracked.settled).toEqual({ done: 0, cancelled: 1, errored: 0 });
  });

  it("manages the docked tab: close hides the canvas, the chat card brings it back", async () => {
    const server = createMockAgentServer({ toolSteps: 0, artifacts: { react: COUNTER } });
    const { user, send } = renderStudio(routePipeline({ upstream: server.fetch }));
    await send("Build a React counter component");
    expect(openTabs()).toEqual(["Counter"]);

    await user.click(within(canvas()).getByRole("button", { name: "Close Counter" }));
    expect(screen.queryByRole("tablist", { name: "Open artifacts" })).not.toBeInTheDocument();

    await user.click(within(chat()).getByRole("button", { name: "Open Counter in canvas" }));
    expect(openTabs()).toEqual(["Counter"]);
    expect(selectedTab()).toHaveTextContent("Counter");
  });
});

describe("golden workflow — multi-turn, multiple artifacts", () => {
  it("keeps one tab per artifact across turns and moves focus to the newest", async () => {
    const server = createMockAgentServer({
      toolSteps: 0,
      artifacts: { react: COUNTER, mermaid: ARCHITECTURE, html: API_GUIDE },
    });
    const { user, send } = renderStudio(routePipeline({ upstream: server.fetch }));

    await send("Build a React counter component");
    expect(openTabs()).toEqual(["Counter"]);
    expect(selectedTab()).toHaveTextContent("Counter");

    await send("Now draw a mermaid architecture diagram");
    expect(openTabs()).toEqual(["Counter", "Architecture"]);
    expect(selectedTab()).toHaveTextContent("Architecture");

    await send("And write an HTML page for the API");
    expect(openTabs()).toEqual(["Counter", "Architecture", "API guide"]);
    expect(selectedTab()).toHaveTextContent("API guide");
    expect(await within(canvas()).findByTitle("API guide preview")).toBeInTheDocument();

    // Every artifact is sealed and owned by the turn that produced it.
    const turns = assistantTurns();
    expect(turns).toHaveLength(3);
    for (const [turn, title] of [
      [turns[0], "Counter"],
      [turns[1], "Architecture"],
      [turns[2], "API guide"],
    ] as const) {
      const card = within(turn as HTMLElement).getByRole("button", {
        name: `Open ${title} in canvas`,
      });
      expect(within(card).getByText("Ready")).toBeInTheDocument();
    }

    // The conversation history travels upstream on every turn.
    expect(server.stats.requests.map((r) => r.messages.length)).toEqual([1, 3, 5]);
    expect(server.stats.requests[2]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);

    // Focus from chat, then keyboard tab management, without reordering tabs.
    await user.click(within(chat()).getByRole("button", { name: "Open Counter in canvas" }));
    expect(selectedTab()).toHaveTextContent("Counter");
    expect(openTabs()).toEqual(["Counter", "Architecture", "API guide"]);

    selectedTab().focus();
    await user.keyboard("{ArrowRight}");
    expect(selectedTab()).toHaveTextContent("Architecture");
    expect(selectedTab()).toHaveFocus();
    await user.keyboard("{End}");
    expect(selectedTab()).toHaveTextContent("API guide");

    await user.keyboard("{Delete}");
    expect(openTabs()).toEqual(["Counter", "Architecture"]);
    expect(selectedTab()).toHaveTextContent("Architecture");
  });
});

describe("golden workflow — revision time travel", () => {
  const notes = (revision: number) => ({
    id: "art_notes",
    type: "markdown" as const,
    title: "Release notes",
    revision,
    content: `# Release notes v${revision}\n\nRevision ${revision} of the notes.`,
  });
  const turn = (revision: number) =>
    scriptedReply(`msg_${revision}`, {
      text: `Revision ${revision} is ready.`,
      artifacts: [notes(revision)],
    });

  it("pins an older revision, keeps it while new ones arrive, and unpins to the live one", async () => {
    const agent = scriptedAgent([turn(1), turn(2), turn(3), turn(4)]);
    const { user, send } = renderStudio(routePipeline({ upstream: agent.fetch }));
    const revisionPicker = () => screen.getByRole("combobox", { name: "Revision" });
    const heading = () => within(canvas()).getByRole("heading", { level: 1 });
    const toolbarVersion = () =>
      within(canvas()).getByText(/^v\d+( \(pinned\))?$/, { selector: "span" });

    await send("Write release notes");
    await send("Add a section about fixes");
    await send("Tighten the wording");
    expect(openTabs()).toEqual(["Release notes"]);
    expect(heading()).toHaveTextContent("Release notes v3");
    expect(toolbarVersion()).toHaveTextContent("v3");
    expect(
      within(revisionPicker())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Latest (v3)", "v3", "v2", "v1"]);

    // Travel back to v1: the canvas shows that snapshot.
    await user.selectOptions(revisionPicker(), "1");
    expect(heading()).toHaveTextContent("Release notes v1");
    expect(toolbarVersion()).toHaveTextContent("v1 (pinned)");
    expect(within(canvas()).queryByText("Ready")).not.toBeInTheDocument();

    // A new revision streams in while pinned: the pin holds.
    await send("Add a summary at the top");
    expect(heading()).toHaveTextContent("Release notes v1");
    expect(within(revisionPicker()).getByRole("option", { name: "Latest (v4)" })).toBeVisible();

    // Hop to v2, then back to the live revision.
    await user.selectOptions(revisionPicker(), "2");
    expect(heading()).toHaveTextContent("Release notes v2");
    await user.selectOptions(revisionPicker(), "latest");
    expect(heading()).toHaveTextContent("Release notes v4");
    expect(toolbarVersion()).toHaveTextContent("v4");
    expect(revisionPicker()).toHaveValue("latest");
    expect(agent.requests).toHaveLength(4);
  });
});
