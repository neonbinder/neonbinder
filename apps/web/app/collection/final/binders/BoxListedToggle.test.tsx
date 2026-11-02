import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import BoxListedToggle, { listedToast } from "./BoxListedToggle";
import { stubListing } from "../inventory/listing/stubListing";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import type { Container } from "../data/types";

/**
 * NEO-370 Rev 4 — a box's "Listed on marketplaces": on by default (an
 * existing box with no setting reads as on), off = in-person only. Saves as
 * it is flipped, says so on the status line, puts itself back on a refusal.
 */

const BOX: Container = { id: "box1", kind: "box", name: "Show box", count: { copies: 4 } } as Container;

function draw(box: Container, setContainerListed = vi.fn(async () => {})) {
  const notify = vi.fn();
  const listing = stubListing({ setContainerListed });
  const tree = (b: Container) => (
    <Theme>
      <BoxListedToggle box={b} listing={listing} notify={notify} />
    </Theme>
  );
  const view = render(tree(box));
  return { view, notify, setContainerListed, rerender: (b: Container = box) => view.rerender(tree(b)) };
}

const box = () => screen.getByRole("checkbox", { name: "Listed on marketplaces" }) as HTMLInputElement;
const flush = () => act(async () => {});

afterEach(cleanup);

describe("a box's Listed on marketplaces", () => {
  it("a box with no setting reads as listed, and says what that means", () => {
    draw(BOX);
    expect(box().checked).toBe(true);
    expect(document.getElementById(box().getAttribute("aria-describedby")!)?.textContent).toBe(
      "Everything in this box lists on the marketplaces you sell on.",
    );
  });

  it("switching it off saves false and says the box is in-person only", async () => {
    const { notify, setContainerListed } = draw(BOX);
    fireEvent.click(box());
    expect(setContainerListed).toHaveBeenCalledWith("box1", false);
    // Shows the new state at once, and ignores presses until it lands.
    expect(box().checked).toBe(false);
    expect(box().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(box());
    expect(setContainerListed).toHaveBeenCalledTimes(1);
    await flush();
    expect(notify).toHaveBeenCalledWith(listedToast("Show box", false));
    expect(listedToast("Show box", false)).toBe(
      "Show box is in-person only now. Its cards come off your marketplaces on the next sync.",
    );
  });

  it("an in-person box shows off, and switching it on saves true", async () => {
    const { notify, setContainerListed } = draw({ ...BOX, listedOnMarketplaces: false });
    expect(box().checked).toBe(false);
    expect(document.getElementById(box().getAttribute("aria-describedby")!)?.textContent).toMatch(/^In-person only\./);
    fireEvent.click(box());
    expect(setContainerListed).toHaveBeenCalledWith("box1", true);
    await flush();
    expect(notify).toHaveBeenCalledWith("Show box lists on your marketplaces again. Its cards go up on the next sync.");
  });

  it("the whole row is the hit area: a press on its description flips it too", async () => {
    const { setContainerListed } = draw(BOX);
    const note = document.getElementById(box().getAttribute("aria-describedby")!)!;
    expect(box().closest("label")?.contains(note)).toBe(true);
    // The name is the title alone, never the description.
    expect(box().getAttribute("aria-labelledby")).toBeTruthy();
    fireEvent.click(note);
    expect(setContainerListed).toHaveBeenCalledWith("box1", false);
    await flush();
  });

  it("a refusal puts it back and says why", async () => {
    const { notify } = draw(
      BOX,
      vi.fn(async () => {
        throw new Error("Only a box can be listed");
      }),
    );
    fireEvent.click(box());
    await flush();
    expect(box().checked).toBe(true);
    expect(String(notify.mock.calls[0][0])).toMatch(/Only a box can be listed/);
  });

  it("passes axe in light and dark, on and off", async () => {
    const on = draw(BOX);
    await expectAccessibleInBothModes(on.view.container, { label: "box listed, on", rerender: () => on.rerender() });
    cleanup();
    const off = draw({ ...BOX, listedOnMarketplaces: false });
    await expectAccessibleInBothModes(off.view.container, { label: "box listed, off", rerender: () => off.rerender() });
  });
});
