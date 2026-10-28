import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the studio shell with chat and canvas regions", () => {
    render(<HomePage />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Agent Studio" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chat" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    // The canvas waits, hidden, until the first artifact opens.
    expect(screen.getByRole("region", { name: "Canvas", hidden: true })).not.toBeVisible();
  });

  it("does not contact the API before the user sends something", () => {
    render(<HomePage />);
    expect(screen.getByRole("list", { name: "Example prompts" })).toBeInTheDocument();
  });
});
