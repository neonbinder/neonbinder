/**
 * NEO-291 — `CardPrefixRow`.
 *
 * Replaces the deleted `VariantMetadataEditor`'s checkbox-and-prefix box: the
 * prefix is now a plain row in the Attributes grid, hydrated and guarded the
 * same way every other text row is — through `FeatureValueControl` →
 * `useReactiveField`, not a hand-rolled effect. The reactive-stomp case below
 * is the NEO-111 regression `VariantMetadataEditor.test.tsx` used to pin
 * (ported here since that file and component are gone); `useReactiveField`
 * already carries the general-purpose coverage for the guard itself
 * (components/forms/useReactiveField.test.tsx) — this file only proves
 * CardPrefixRow is wired to it correctly.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import CardPrefixRow from "./CardPrefixRow";

const FIELD_LABEL = "Value for Card prefix";
const field = () => screen.getByLabelText(FIELD_LABEL) as HTMLInputElement;

function focusField(el: HTMLInputElement) {
  el.focus();
  fireEvent.focus(el);
}

function blurField(el: HTMLInputElement) {
  el.blur();
  fireEvent.blur(el);
}

describe("CardPrefixRow — hydration", () => {
  it("hydrates the input from `value`", () => {
    render(<CardPrefixRow value="DK-" onSave={vi.fn()} />);
    expect(field().value).toBe("DK-");
  });

  it("renders empty when `value` is undefined", () => {
    render(<CardPrefixRow value={undefined} onSave={vi.fn()} />);
    expect(field().value).toBe("");
  });

  it("carries the placeholder and the wrapper's aria-label", () => {
    render(<CardPrefixRow value={undefined} onSave={vi.fn()} />);
    expect(field().placeholder).toBe("e.g. DK-");
    // Same shape as every other Attributes-panel row: "Set feature {label}".
    expect(screen.getByLabelText("Set feature Card prefix")).toBeTruthy();
  });
});

describe("CardPrefixRow — commit", () => {
  it("Enter commits the trimmed live value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CardPrefixRow value="DK-" onSave={onSave} />);
    const input = field();

    await act(async () => {
      focusField(input);
      fireEvent.change(input, { target: { value: "  ZX-  " } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onSave).toHaveBeenCalledWith("ZX-");
  });

  it("blur commits the trimmed live value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CardPrefixRow value="DK-" onSave={onSave} />);
    const input = field();

    await act(async () => {
      focusField(input);
      fireEvent.change(input, { target: { value: "ZX-" } });
      blurField(input);
    });

    expect(onSave).toHaveBeenCalledWith("ZX-");
  });

  it("an empty commit calls onSave with \"\", not a no-op revert", async () => {
    // CardPrefixRow wires onEmptyCommit to onSave("") (NEO-217 spelling) —
    // without it, useReactiveField would just snap the field back to `value`.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CardPrefixRow value="DK-" onSave={onSave} />);
    const input = field();

    await act(async () => {
      focusField(input);
      fireEvent.change(input, { target: { value: "" } });
      blurField(input);
    });

    expect(onSave).toHaveBeenCalledWith("");
    expect(field().value).toBe("");
  });

  it("does not call onSave when the committed value equals the current one", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CardPrefixRow value="DK-" onSave={onSave} />);
    const input = field();

    await act(async () => {
      focusField(input);
      blurField(input);
    });

    expect(onSave).not.toHaveBeenCalled();
  });
});

/**
 * NEO-111 — the reactive-stomp guard, ported from the deleted
 * `VariantMetadataEditor.test.tsx`. There the component owned its own
 * `useQuery` hydration effect and had to re-implement the guard by hand; here
 * it is `value`/`onSave` props flowing straight into `useReactiveField`, so
 * the same behaviour is exercised by re-rendering with a new `value` prop —
 * exactly what a Convex reactive push into the parent panel looks like.
 */
describe("CardPrefixRow — reactive-stomp guard (NEO-111)", () => {
  it("does NOT overwrite an unsaved edit when `value` changes while the field is focused", () => {
    const { rerender } = render(<CardPrefixRow value="DK-" onSave={vi.fn()} />);
    const input = field();

    focusField(input);
    fireEvent.change(input, { target: { value: "MY-EDIT" } });

    // A concurrent push lands mid-edit.
    rerender(<CardPrefixRow value="ZX-" onSave={vi.fn()} />);

    expect(field().value).toBe("MY-EDIT");
  });

  it("DOES pick up the pushed value once the field is idle again (blurred)", async () => {
    const { rerender } = render(
      <CardPrefixRow value="DK-" onSave={vi.fn().mockResolvedValue(undefined)} />,
    );
    const input = field();

    await act(async () => {
      focusField(input);
      fireEvent.change(input, { target: { value: "MY-EDIT" } });
      blurField(input);
    });

    rerender(<CardPrefixRow value="ZX-" onSave={vi.fn()} />);

    expect(field().value).toBe("ZX-");
  });
});
