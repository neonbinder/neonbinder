/**
 * NEO-313 — coverage for `SportSwitch`, the quiet per-row sport override used
 * by the entity review wizard and the card pickers. No test file existed for
 * this component before this session.
 *
 * Mocking strategy mirrors `TeamPicker.test.tsx`: `convex/react`'s `useQuery`
 * is module-mocked and routed by the (string-mocked) query reference, so the
 * component never talks to a real Convex deployment. No jest-dom matchers in
 * this repo (see `TeamPicker.test.tsx`) — assertions use plain DOM checks
 * (`document.activeElement`, `getAttribute`, `.toBeTruthy()`/`.toBeNull()`).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SportSwitch from "./SportSwitch";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: { getSelectorOptions: "selectorOptions.getSelectorOptions" },
  },
}));

let currentSports: unknown = [];

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "selectorOptions.getSelectorOptions") return currentSports;
    return undefined;
  },
}));

const sid = (n: string) => n as unknown as Id<"selectorOptions">;

const BASEBALL = sid("sport_baseball");
const FOOTBALL = sid("sport_football");
const BASKETBALL = sid("sport_basketball");

function seedSports() {
  currentSports = [
    { _id: BASEBALL, value: "Baseball" },
    { _id: FOOTBALL, value: "Football" },
    { _id: BASKETBALL, value: "Basketball" },
  ];
}

beforeEach(() => {
  currentSports = [];
});

function trigger() {
  return screen.getByRole("button", { name: /Sport for this name:/ });
}

describe("SportSwitch", () => {
  test("shows the current sport's name in the trigger's accessible name", () => {
    seedSports();
    render(<SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Sport for this name: Baseball" }),
    ).toBeTruthy();
  });

  test("orders the set's sport first, then the rest alphabetically", () => {
    seedSports();
    render(<SportSwitch value={FOOTBALL} setSportId={BASEBALL} onChange={vi.fn()} />);
    fireEvent.click(trigger());

    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    // Baseball (the set's sport) leads even though Basketball sorts first
    // alphabetically; Basketball then Football follow in name order.
    expect(options[0]).toContain("Baseball");
    expect(options[1]).toContain("Basketball");
    expect(options[2]).toContain("Football");
  });

  test("ArrowDown on the closed trigger opens the list with focus on the current sport", () => {
    seedSports();
    render(<SportSwitch value={FOOTBALL} setSportId={BASEBALL} onChange={vi.fn()} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });

    expect(screen.getByRole("listbox")).toBeTruthy();
    const footballOption = screen.getByRole("option", { name: /Football/ });
    expect(document.activeElement).toBe(footballOption);
  });

  test("ArrowDown/ArrowUp move the active option, clamped at the ends", () => {
    seedSports();
    render(<SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} />);
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox");

    // Baseball (index 0) is active first.
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Baseball/ }));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Basketball/ }));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Baseball/ }));
    // Clamped: ArrowUp again does not wrap past the first option.
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Baseball/ }));
  });

  test("Home and End jump to the first and last option", () => {
    seedSports();
    render(<SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} />);
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox");

    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Football/ }));
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Baseball/ }));
  });

  test("typing a letter jumps focus to the sport starting with it", () => {
    seedSports();
    render(<SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} />);
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox");

    fireEvent.keyDown(list, { key: "f" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Football/ }));
  });

  test("Escape closes the list, returns focus to the trigger, and does not bubble", () => {
    seedSports();
    const onParentKeyDown = vi.fn();
    render(
      <div onKeyDown={onParentKeyDown}>
        <SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox");

    fireEvent.keyDown(list, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    // The whole reason Escape is intercepted here: a host dialog's own
    // Escape-to-cancel handler must never fire because this list was open.
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  test("clicking an option picks it, closes the list and calls onChange", () => {
    seedSports();
    const onChange = vi.fn();
    render(<SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: /Football/ }));

    expect(onChange).toHaveBeenCalledWith(FOOTBALL);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("re-picking the current sport does not call onChange", () => {
    seedSports();
    const onChange = vi.fn();
    render(<SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: /Baseball/ }));

    expect(onChange).not.toHaveBeenCalled();
  });

  test("aria-disabled refuses to open, and carries the attribute rather than native disabled", () => {
    seedSports();
    render(
      <SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} disabled />,
    );
    const button = trigger();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // Never native `disabled` — a keyboard operator parked here must stay in
    // the tab order for the length of a round trip.
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("a value that differs from the set's sport is marked overridden (neon-yellow)", () => {
    seedSports();
    const { container } = render(
      <SportSwitch value={FOOTBALL} setSportId={BASEBALL} onChange={vi.fn()} />,
    );
    const nameSpan = container.querySelector('span[class*="FFE600"]');
    expect(nameSpan).not.toBeNull();
    expect(nameSpan?.textContent).toBe("Football");
  });

  test("a value matching the set's sport carries no override styling", () => {
    seedSports();
    const { container } = render(
      <SportSwitch value={BASEBALL} setSportId={BASEBALL} onChange={vi.fn()} />,
    );
    expect(container.querySelector('span[class*="FFE600"]')).toBeNull();
  });
});
