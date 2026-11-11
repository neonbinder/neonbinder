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

/** NEO-464 — the opener can leave the page while the panel is open (the card it named was fixed in there). */
describe("Overlay focus on close, when the opener is gone", () => {
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  function Page({ open, keepOpener, home = false }: { open: boolean; keepOpener: boolean; home?: boolean }) {
    const opener = keepOpener ? (
      <button type="button">Open card</button>
    ) : null;
    return (
      <main>
        <h1>Welcome back</h1>
        <section aria-labelledby="sec">
          <h2 id="sec">Sync status</h2>
          <article aria-labelledby="set">
            <h3 id="set">1993 Topps Finest</h3>
            {home ? <div data-focus-home="" aria-label="Held back">{opener}</div> : opener}
          </article>
        </section>
        {open && (
          <Overlay labelledBy="t" onClose={() => {}}>
            {heading}
          </Overlay>
        )}
      </main>
    );
  }

  function openFrom(home = false) {
    const view = render(<Page open={false} keepOpener home={home} />);
    screen.getByRole("button", { name: "Open card" }).focus();
    view.rerender(<Page open keepOpener home={home} />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Title" }));
    return view;
  }

  it("goes back to the opener when it is still there", async () => {
    const view = openFrom();
    view.rerender(<Page open={false} keepOpener />);
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open card" }));
  });

  it("with the opener gone, goes to the heading of the nearest labelled article, made focusable but no tab stop", async () => {
    const view = openFrom();
    view.rerender(<Page open keepOpener={false} />);
    view.rerender(<Page open={false} keepOpener={false} />);
    await frame();
    const set = screen.getByRole("heading", { name: "1993 Topps Finest" });
    expect(document.activeElement).toBe(set);
    expect(set.getAttribute("tabindex")).toBe("-1");
  });

  it("a data-focus-home nearer than the heading wins", async () => {
    const view = openFrom(true);
    view.rerender(<Page open keepOpener={false} home />);
    view.rerender(<Page open={false} keepOpener={false} home />);
    await frame();
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Held back");
  });

  it("when the article went too, the section's heading; with no labelled heading left, the page's h1", async () => {
    const view = openFrom();
    view.rerender(<Page open keepOpener={false} />);
    view.rerender(<Page open={false} keepOpener={false} />);
    document.querySelector("article")?.remove();
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Sync status" }));
    view.unmount();

    const again = render(
      <div>
        <h1>Top</h1>
        <section aria-labelledby="gone">
          <button type="button">Opener two</button>
        </section>
      </div>,
    );
    screen.getByRole("button", { name: "Opener two" }).focus();
    again.rerender(
      <div>
        <h1>Top</h1>
        <section aria-labelledby="gone">
          <button type="button">Opener two</button>
        </section>
        <Overlay labelledBy="t" onClose={() => {}}>
          {heading}
        </Overlay>
      </div>,
    );
    again.rerender(
      <div>
        <h1>Top</h1>
      </div>,
    );
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Top" }));
  });

  it("leaves focus alone when the page already put it somewhere", async () => {
    const view = openFrom();
    view.rerender(<Page open keepOpener={false} />);
    view.rerender(<Page open={false} keepOpener={false} />);
    const h1 = screen.getByRole("heading", { name: "Welcome back" });
    h1.tabIndex = -1;
    h1.focus();
    await frame();
    expect(document.activeElement).toBe(h1);
  });

  it("moves nothing when nothing had focus at open (a link opened it)", async () => {
    const view = render(<Page open={false} keepOpener />);
    (document.activeElement as HTMLElement | null)?.blur();
    view.rerender(<Page open keepOpener />);
    view.rerender(<Page open={false} keepOpener={false} />);
    await frame();
    expect(document.activeElement).toBe(document.body);
  });
});
