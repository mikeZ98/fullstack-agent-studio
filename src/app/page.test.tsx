import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the split-pane shell with chat and canvas regions", () => {
    render(<HomePage />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chat" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Canvas" })).toBeVisible();
  });
});
