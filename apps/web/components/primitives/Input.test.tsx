/**
 * NEO-44 — Unit tests for the shared Input/Textarea primitives.
 *
 * These lock the four properties that make the primitive worth adopting:
 *
 *  1. **bare mode renders no chrome** — the migration contract. Existing markup
 *     swaps a raw `<input>` for `<Input bare>` without gaining a wrapper div, so
 *     layout and every `.maestro` selector are untouched.
 *  2. **auto marker class, unique per instance** — what makes maestro-web's
 *     `inputText` land on the field the test tapped instead of the first input
 *     sharing a Tailwind className (see `useFieldTestClass`).
 *  3. **never emits an `id` unless the caller passes one** — the single most
 *     load-bearing rule. Maestro sets `resource-id = node.id || node.ariaLabel`,
 *     so an auto-generated id would clobber the aria-label and silently break
 *     every `tapOn id: "<aria-label>"` selector in the suite.
 *  4. **reactive mode honours the NEO-39 focus-guard** — the same invariant
 *     `useReactiveField.test.tsx` proves for the hook, asserted end-to-end
 *     through the component so a wiring mistake in the wrapper can't slip past.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "./Input";
import { Textarea } from "./Textarea";

const field = () => screen.getByLabelText("field") as HTMLInputElement;

describe("Input — bare mode", () => {
  it("renders the input as the only element, with no wrapper", () => {
    const { container } = render(<Input bare aria-label="field" />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe("INPUT");
  });

  it("ignores label/helperText chrome in bare mode", () => {
    render(<Input bare aria-label="field" label="Nope" helperText="Nope" />);
    expect(screen.queryByText("Nope")).toBeNull();
  });

  it("passes native props straight through", () => {
    render(
      <Input
        bare
        aria-label="field"
        id="pub-paypal"
        type="url"
        placeholder="https://"
        disabled
      />,
    );
    const el = field();
    expect(el.id).toBe("pub-paypal");
    expect(el.type).toBe("url");
    expect(el.placeholder).toBe("https://");
    expect(el.disabled).toBe(true);
  });

  it("is w-full by default but omits it when fullWidth is false", () => {
    // Tailwind resolves conflicting widths by stylesheet order, so a caller's
    // `w-28` cannot beat a baked-in `w-full` — it must not be emitted at all.
    const { rerender } = render(<Input bare aria-label="field" />);
    expect(field().className).toContain("w-full");

    rerender(<Input bare aria-label="field" fullWidth={false} className="w-28" />);
    expect(field().className).not.toContain("w-full");
    expect(field().className).toContain("w-28");
  });

  it("keeps the caller's className alongside the marker class", () => {
    render(<Input bare aria-label="field" className="w-full custom-thing" />);
    const el = field();
    expect(el.className).toContain("custom-thing");
    expect(el.className).toMatch(/mb-field-/);
  });
});

describe("Input — Maestro targeting contract", () => {
  it("applies a mb-field-* marker class automatically", () => {
    render(<Input bare aria-label="field" />);
    expect(field().className).toMatch(/mb-field-/);
  });

  it("gives two instances different marker classes", () => {
    render(
      <>
        <Input bare aria-label="one" />
        <Input bare aria-label="two" />
      </>,
    );
    const classOf = (label: string) =>
      (screen.getByLabelText(label).className.match(/mb-field-\S+/) ?? [])[0];
    expect(classOf("one")).toBeTruthy();
    expect(classOf("one")).not.toBe(classOf("two"));
  });

  it("NEVER emits an id of its own — resource-id must stay the aria-label", () => {
    // A generated id would make Maestro's resource-id the id instead of the
    // aria-label, breaking every `tapOn id: "<aria-label>"` in .maestro/flows.
    render(<Input bare aria-label="field" />);
    expect(field().getAttribute("id")).toBeNull();
  });

  it("emits no id in labelled (non-bare) mode either", () => {
    const { container } = render(<Input aria-label="field" label="Tagline" />);
    expect(container.querySelector("[id]")).toBeNull();
    // ...but the label is still associated, via wrapping.
    expect(field().closest("label")).not.toBeNull();
  });

  it("uses htmlFor when the caller supplies an id", () => {
    const { container } = render(
      <Input aria-label="field" id="pub-tagline" label="Tagline" />,
    );
    const label = container.querySelector("label");
    expect(label?.getAttribute("for")).toBe("pub-tagline");
    expect(field().id).toBe("pub-tagline");
  });
});

describe("Input — reactive mode (NEO-39 focus-guard)", () => {
  const setup = (value: string, onSave = vi.fn()) => {
    const view = render(
      <Input bare aria-label="field" reactive={{ value, onSave }} />,
    );
    return { view, onSave };
  };

  it("is uncontrolled — seeds from value, no React value binding", () => {
    setup("server");
    expect(field().value).toBe("server");
  });

  it("mirrors an external push while idle", () => {
    const onSave = vi.fn();
    const { view } = setup("server", onSave);
    view.rerender(
      <Input bare aria-label="field" reactive={{ value: "pushed", onSave }} />,
    );
    expect(field().value).toBe("pushed");
  });

  it("IGNORES an external push while the field is focused", () => {
    const onSave = vi.fn();
    const { view } = setup("server", onSave);
    const el = field();
    el.focus();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: "user typing" } });

    view.rerender(
      <Input bare aria-label="field" reactive={{ value: "pushed", onSave }} />,
    );

    expect(field().value).toBe("user typing");
  });

  it("commits the LIVE DOM value on blur, not a lagged copy", async () => {
    const onSave = vi.fn();
    setup("server", onSave);
    const el = field();
    el.focus();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: "  typed  " } });
    await act(async () => {
      fireEvent.blur(el);
    });
    expect(onSave).toHaveBeenCalledWith("typed");
  });

  it("commits on Enter", async () => {
    const onSave = vi.fn();
    setup("server", onSave);
    const el = field();
    el.focus();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: "via enter" } });
    await act(async () => {
      fireEvent.keyDown(el, { key: "Enter" });
    });
    expect(onSave).toHaveBeenCalledWith("via enter");
  });

  it("does not commit an unchanged value", async () => {
    const onSave = vi.fn();
    setup("server", onSave);
    const el = field();
    el.focus();
    fireEvent.focus(el);
    await act(async () => {
      fireEvent.blur(el);
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("still applies the marker class in reactive mode", () => {
    setup("server");
    expect(field().className).toMatch(/mb-field-/);
  });
});

describe("Textarea", () => {
  it("renders bare with a marker class and no id", () => {
    const { container } = render(<Textarea bare aria-label="field" />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe("TEXTAREA");
    expect(field().className).toMatch(/mb-field-/);
    expect(field().getAttribute("id")).toBeNull();
  });

  it("associates a label by wrapping when no id is given", () => {
    render(<Textarea aria-label="field" label="Description" />);
    expect(field().closest("label")).not.toBeNull();
  });

  it("uses htmlFor when the caller supplies an id", () => {
    const { container } = render(
      <Textarea aria-label="field" id="desc" label="Description" />,
    );
    expect(container.querySelector("label")?.getAttribute("for")).toBe("desc");
  });
});
