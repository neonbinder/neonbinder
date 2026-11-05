import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Overlay from "./Overlay";

/** NEO-444 — focus can sit on something that is no tab stop, and it still has to stay in here. */

// happy-dom lays nothing out, so no element has an offsetParent.
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
});
afterEach(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "offsetParent", original);
});

function open(body: React.ReactNode, onClose = vi.fn()) {
  render(
    <Overlay labelledBy="t" onClose={onClose} variant="stage">
      {body}
    </Overlay>,
  );
  return { onClose, panel: screen.getByRole("dialog") };
}

const heading = (
  <h2 id="t" tabIndex={-1}>
    Title
  </h2>
);
const tab = (from: Element, shiftKey = false) => !fireEvent.keyDown(from, { key: "Tab", shiftKey });

describe("Overlay", () => {
  it("the panel can hold focus without being a tab stop, and Escape closes from there", () => {
    const { onClose, panel } = open(heading);
    expect(panel.getAttribute("tabindex")).toBe("-1");
    expect(panel.className).toContain("outline-none");
    panel.focus();
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Tab from the heading with no stop after it wraps to the first stop", () => {
    open(
      <>
        <button type="button">Close</button>
        {heading}
      </>,
    );
    const title = screen.getByRole("heading");
    expect(document.activeElement).toBe(title);
    expect(tab(title)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("Shift+Tab from the heading with no stop before it wraps to the last stop", () => {
    open(
      <>
        {heading}
        <button type="button">Back</button>
        <button type="button">Full size</button>
      </>,
    );
    const title = screen.getByRole("heading");
    expect(tab(title, true)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Full size" }));
  });

  it("from the heading with a stop that way, the browser's own Tab moves on", () => {
    open(
      <>
        <button type="button">Close</button>
        {heading}
        <button type="button">Back</button>
      </>,
    );
    const title = screen.getByRole("heading");
    expect(tab(title)).toBe(false);
    expect(tab(title, true)).toBe(false);
    expect(document.activeElement).toBe(title);
  });

  it("from the panel itself, Shift+Tab goes to the last stop rather than out", () => {
    const { panel } = open(
      <>
        <button type="button">Close</button>
        {heading}
      </>,
    );
    panel.focus();
    expect(tab(panel, true)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("with focus outside the panel, Tab wraps to the first stop", () => {
    const { panel } = open(
      <>
        <button type="button">Close</button>
        {heading}
        <button type="button">Back</button>
      </>,
    );
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    expect(tab(panel)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("wraps at both ends, and a lone stop stays put", () => {
    open(
      <>
        <button type="button">One</button>
        {heading}
        <button type="button">Two</button>
      </>,
    );
    const one = screen.getByRole("button", { name: "One" });
    const two = screen.getByRole("button", { name: "Two" });
    two.focus();
    expect(tab(two)).toBe(true);
    expect(document.activeElement).toBe(one);
    expect(tab(one, true)).toBe(true);
    expect(document.activeElement).toBe(two);
  });
});
