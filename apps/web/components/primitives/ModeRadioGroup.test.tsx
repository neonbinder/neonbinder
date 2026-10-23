/**
 * NEO-356 — ModeRadioGroup's keyboard contract (WAI-ARIA radio group): one
 * tab stop on the checked option, arrows move and choose with wrap-around,
 * Home/End, Enter/Space; names are the labels, descriptions are descriptions.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModeRadioGroup } from "./ModeRadioGroup";

const OPTIONS = [
  { value: "light", label: "Light", description: "Bright" },
  { value: "dark", label: "Dark", description: "Neon" },
  { value: "system", label: "System", description: "Follows the device" },
] as const;

type Value = (typeof OPTIONS)[number]["value"];

function Harness({ onChange }: { onChange?: (v: Value) => void }) {
  const [value, setValue] = useState<Value>("dark");
  return (
    <ModeRadioGroup<Value>
      label="Theme"
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("ModeRadioGroup", () => {
  it("is a radiogroup named by its label, with label-named radios", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
    expect(radio("Light").getAttribute("aria-checked")).toBe("false");
    expect(radio("System").getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Follows the device").id).toBe(radio("System").getAttribute("aria-describedby"));
  });

  it("puts the one tab stop on the checked option", () => {
    render(<Harness />);
    expect(radio("Dark").tabIndex).toBe(0);
    expect(radio("Light").tabIndex).toBe(-1);
    expect(radio("System").tabIndex).toBe(-1);
  });

  it("arrows move focus and choose, wrapping at both ends", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(radio("Dark"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("system");
    expect(document.activeElement).toBe(radio("System"));
    expect(radio("System").tabIndex).toBe(0);

    fireEvent.keyDown(radio("System"), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("light");

    fireEvent.keyDown(radio("Light"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("system");

    fireEvent.keyDown(radio("System"), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("light");
    fireEvent.keyDown(radio("Light"), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("system");
  });

  it("Enter and Space choose; choosing the current value is not a change", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(radio("Dark"), { key: "Enter" });
    fireEvent.keyDown(radio("Dark"), { key: " " });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(radio("Light"));
    expect(onChange).toHaveBeenCalledWith("light");
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");
  });

  it("ignores keys it does not own (Tab leaves the group)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(radio("Dark"), { key: "Tab" });
    fireEvent.keyDown(radio("Dark"), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
