// The whole studio wired to the real useChat, driven by the mock agent through the real
// agent client and stream bridge (in memory, no network).
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MOCK_ARTIFACTS } from "@/lib/tools/mock-agent-provider";
import { mockTransport } from "~tests/fixtures/studio";

import { Studio } from "./studio";

async function ask(prompt: string, transport = mockTransport({ toolSteps: 1 })) {
  const user = userEvent.setup();
  render(<Studio transport={transport} />);
  await user.type(screen.getByRole("textbox", { name: "Message" }), `${prompt}{Enter}`);
  return { user, transport };
}

const canvas = () => screen.getByRole("region", { name: "Canvas" });
const chat = () => screen.getByRole("region", { name: "Chat" });

describe("Studio — end to end", () => {
  it("streams a reply, runs tools and opens the artifact in the canvas", async () => {
    const { transport } = await ask("Build a react component");

    expect(within(chat()).getByRole("article", { name: "You" })).toHaveTextContent(
      "Build a react component",
    );
    const card = await within(chat()).findByRole("button", { name: "Open Todo list in canvas" });
    await waitFor(() => expect(within(card).getByText("Ready")).toBeInTheDocument());

    const assistant = within(chat()).getByRole("article", { name: "Assistant" });
    expect(assistant).toHaveTextContent("All artifacts are ready.");
    expect(within(assistant).getByText("search_docs")).toBeInTheDocument();
    expect(within(assistant).getByText("Done")).toBeInTheDocument();

    const tab = within(canvas()).getByRole("tab", { name: /Todo list/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("separator", { name: "Resize chat and canvas" })).toBeInTheDocument();

    expect(transport.server.stats.requests).toHaveLength(1);
    expect(transport.server.stats.requests[0]?.messages).toEqual([
      { role: "user", content: "Build a react component" },
    ]);
  });

  it("shows the assembled source in Code view and a sandboxed preview", async () => {
    const { user } = await ask("Make an HTML landing page", mockTransport({ toolSteps: 0 }));
    await within(chat()).findByText("Ready");

    const viewer = within(canvas()).getByRole("tabpanel");
    const frame = await within(viewer).findByTitle("Counter page preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");

    await user.click(within(canvas()).getByRole("tab", { name: "Code" }));
    expect(within(canvas()).getByRole("tabpanel").textContent).toContain(
      '<button id="inc">Increment</button>',
    );
  });

  it("keeps several artifacts as tabs and focuses one from its chat card", async () => {
    const { user } = await ask("svg logo and python script", mockTransport({ toolSteps: 0 }));
    await waitFor(() => expect(within(chat()).getAllByText("Ready")).toHaveLength(2));

    const tabs = within(canvas()).getAllByRole("tab", { name: /Status badge|Fibonacci/ });
    expect(tabs).toHaveLength(2);
    expect(within(canvas()).getByRole("tab", { name: /Fibonacci/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(within(chat()).getByRole("button", { name: "Open Status badge in canvas" }));
    expect(within(canvas()).getByRole("tab", { name: /Status badge/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(canvas()).findByRole("img", { name: "Status badge" })).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/svg\+xml/),
    );
  });

  it("marks an artifact whose deltas were lost as failed in chat and canvas", async () => {
    await ask("html page", mockTransport({ toolSteps: 0, faults: { dropDeltaSeqs: [2] } }));
    await waitFor(() => expect(within(chat()).getByText("Failed")).toBeInTheDocument());
    expect(within(canvas()).getByRole("alert")).toHaveTextContent("Stream interrupted");
  });

  it("surfaces an upstream rejection as an RFC 9457 alert with Retry", async () => {
    const { user, transport } = await ask(
      "hello",
      mockTransport({ faults: { httpStatus: 429, failAttempts: 1, retryAfterSeconds: 60 } }),
    );
    const alert = await within(chat()).findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(within(chat()).getByRole("article", { name: "Assistant" })).toHaveTextContent(
        /Done\.$/,
      ),
    );
    expect(transport.server.stats.requests).toHaveLength(2);
    expect(within(chat()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stops a response mid-stream", async () => {
    const transport = mockTransport({ toolSteps: 0, frameDelayMs: 20 });
    const { user } = await ask("react component", transport);
    const stop = await screen.findByRole("button", { name: "Stop generating" });
    await user.click(stop);

    await screen.findByRole("button", { name: "Send message" });
    expect(transport.server.stats.cancelled + transport.server.stats.aborted).toBeGreaterThan(0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const card = within(chat()).queryByRole("button", { name: /Todo list/ });
    if (card !== null) expect(within(card).queryByText("Generating")).not.toBeInTheDocument();
  });

  it("starts from example prompts", async () => {
    const user = userEvent.setup();
    render(<Studio transport={mockTransport({ toolSteps: 0 })} />);
    await user.click(screen.getByRole("button", { name: "Build a React todo list component" }));
    await within(chat()).findByRole("button", { name: "Open Todo list in canvas" });
    expect(MOCK_ARTIFACTS.react.title).toBe("Todo list");
  });
});
