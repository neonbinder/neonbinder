/**
 * NEO-380 — Profile → Settings → Collection: the default card condition.
 *
 *   - six conditions, the saved one checked (Excellent when never picked);
 *   - nothing to pick while it loads;
 *   - a pick saves and says so; a failed save says the old default is back.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let current: string | null | undefined = "Excellent";
const save = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: () => current,
  useMutation: () => ({ withOptimisticUpdate: () => save }),
}));

import DefaultConditionSection from "./DefaultConditionSection";

const checked = () =>
  screen
    .getAllByRole("radio")
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map((r) => r.textContent);

beforeEach(() => {
  current = "Excellent";
  save.mockReset();
  save.mockResolvedValue(null);
});

describe("Settings → Collection", () => {
  it("offers the six conditions with the saved one checked", () => {
    render(<DefaultConditionSection />);
    expect(screen.getByRole("heading", { level: 2, name: "Collection" })).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Default card condition" });
    expect(Array.from(group.querySelectorAll("[role=radio]")).map((r) => r.textContent)).toEqual([
      "Mint",
      "Near Mint",
      "Excellent",
      "Very Good",
      "Good",
      "Poor",
    ]);
    expect(checked()).toEqual(["Excellent"]);
  });

  it("shows nothing to pick while the default loads", () => {
    current = undefined;
    render(<DefaultConditionSection />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("Loading your default…")).toBeTruthy();
  });

  it("saves a pick and says so", async () => {
    render(<DefaultConditionSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Near Mint" }));
    });
    expect(save).toHaveBeenCalledWith({ condition: "Near Mint" });
    expect(screen.getByRole("status").textContent).toBe("Saved.");
  });

  it("picking the saved one again does nothing", async () => {
    render(<DefaultConditionSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Excellent" }));
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("a failed save says the old default is back", async () => {
    save.mockRejectedValue(new Error("offline"));
    render(<DefaultConditionSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Good" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "That didn't save, so your old default is back. Give it another try.",
    );
  });
});
