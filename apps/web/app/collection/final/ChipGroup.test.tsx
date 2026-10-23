import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ChipGroup from "./ChipGroup";

/**
 * NEO-358 — mutually exclusive chips are a radio group: one Tab stop on the
 * checked chip, arrows move and pick (wrapping), Home and End jump to the
 * ends, and the state is aria-checked, never the name.
 */
function Harness({ start = "all" as "all" | "have" | "need" }) {
  const [value, setValue] = useState(start);
  return (
    <ChipGroup
      label="Show"
      value={value}
      options={[
        { value: "all", label: "All" },
        { value: "have", label: "Haves" },
        { value: "need", label: "Needs" },
      ]}
      onChange={setValue}
    />
  );
}

const group = () => screen.getByRole("radiogroup", { name: "Show" });
const radio = (name: string) => within(group()).getByRole("radio", { name });
const checked = () => within(group()).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");

afterEach(cleanup);

describe("ChipGroup", () => {
  it("has one Tab stop, on the checked chip", () => {
    render(<Harness start="have" />);
    expect(checked()).toEqual([radio("Haves")]);
    expect(within(group()).getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("arrows move and pick, wrapping at the ends; Home and End jump", () => {
    render(<Harness />);
    radio("All").focus();
    fireEvent.keyDown(radio("All"), { key: "ArrowRight" });
    expect(checked()).toEqual([radio("Haves")]);
    expect(document.activeElement).toBe(radio("Haves"));

    fireEvent.keyDown(radio("Haves"), { key: "ArrowDown" });
    fireEvent.keyDown(radio("Needs"), { key: "ArrowRight" });
    expect(checked()).toEqual([radio("All")]);
    expect(document.activeElement).toBe(radio("All"));

    fireEvent.keyDown(radio("All"), { key: "ArrowLeft" });
    expect(checked()).toEqual([radio("Needs")]);
    fireEvent.keyDown(radio("Needs"), { key: "Home" });
    expect(checked()).toEqual([radio("All")]);
    fireEvent.keyDown(radio("All"), { key: "End" });
    expect(checked()).toEqual([radio("Needs")]);
    expect(radio("Needs").tabIndex).toBe(0);
  });

  it("a click picks; the names never change", () => {
    render(<Harness />);
    fireEvent.click(radio("Needs"));
    expect(checked()).toEqual([radio("Needs")]);
    expect(within(group()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All", "Haves", "Needs"]);
  });
});
