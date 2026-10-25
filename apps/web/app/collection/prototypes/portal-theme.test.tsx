import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import Overlay from "./p1/Overlay";
import Modal from "./p2/Modal";
import P3Dialog from "./p3/Dialog";

/**
 * NEO-359 — the collection's portalled layers render on <body>, outside the
 * app's root <Theme>, so without a Theme of their own every Radix CSS variable
 * (spacing, radius, font size) is undefined in them and a NeonButton loses its
 * padding. Each layer must sit inside a nested `.radix-themes` that follows
 * the app's appearance, while staying a direct child of <body> so
 * `inertBackground` still inerts the app behind it.
 */

const layers: [string, (close: () => void) => ReactNode][] = [
  [
    "p1 Overlay (card drawer)",
    (close) => (
      <Overlay labelledBy="layer-title" onClose={close}>
        <h2 id="layer-title">Layer</h2>
      </Overlay>
    ),
  ],
  [
    "p2 Modal (binder dialogs)",
    (close) => (
      <Modal labelledBy="layer-title" onClose={close}>
        <h2 id="layer-title">Layer</h2>
      </Modal>
    ),
  ],
  [
    "p3 Dialog (set picker)",
    (close) => (
      <P3Dialog title="Layer" onClose={close}>
        <p>Body</p>
      </P3Dialog>
    ),
  ],
];

afterEach(cleanup);

describe.each(layers)("%s portal", (_name, layer) => {
  function App({ mode }: { mode: "light" | "dark" }) {
    return (
      <Theme appearance={mode}>
        <main>{layer(() => {})}</main>
      </Theme>
    );
  }

  it("mounts inside a nested Radix Theme that is a direct child of <body>", () => {
    const { container } = render(<App mode="dark" />);
    const dialog = screen.getByRole("dialog");
    const theme = dialog.closest(".radix-themes");
    expect(theme).not.toBeNull();
    expect(theme?.getAttribute("data-is-root-theme")).toBe("false");
    // A nested Theme never paints its own background over the scrim.
    expect(theme?.getAttribute("data-has-background")).toBe("false");
    expect(theme?.parentElement).toBe(document.body);
    // The app root is NOT the portal's ancestor, so the app goes inert.
    expect(container.contains(dialog)).toBe(false);
    expect(container.hasAttribute("inert")).toBe(true);
  });

  it("follows the app's light/dark appearance live", () => {
    const { rerender } = render(<App mode="dark" />);
    const theme = () => screen.getByRole("dialog").closest(".radix-themes");
    expect(theme()?.classList.contains("dark")).toBe(true);
    rerender(<App mode="light" />);
    expect(theme()?.classList.contains("light")).toBe(true);
    expect(theme()?.classList.contains("dark")).toBe(false);
  });
});
