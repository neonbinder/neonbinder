import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { MovePanel } from "./CardDetail";
import type { Container, Copy } from "./data/types";

/**
 * NEO-364 — the drawer's Move / Sell / Take off sale panel picks its home
 * from what it is given on every render until the collector picks one, so
 * homes that arrive after it opens are not left showing one home while the
 * submit waits on none.
 */
const copy = { id: "copy-1", quantity: 1 } as unknown as Copy;
const home = (id: string, name: string) => ({ id, name }) as unknown as Container;
const MAIN = home("binder-main", "Main");
const SLABS = home("binder-slab-case", "Slab case");

afterEach(cleanup);

function panel(homes: readonly Container[], defaultTo?: string, onMove = vi.fn()) {
  return (
    <Theme>
      <MovePanel
        copy={copy}
        line="Raw"
        shift="unsell"
        homes={homes}
        defaultTo={defaultTo}
        onMove={onMove}
        onCancel={vi.fn()}
      />
    </Theme>
  );
}

const select = () => screen.getByRole("combobox", { name: "Back into" }) as HTMLSelectElement;
const go = () => screen.getByRole("button", { name: "Take it off sale" });

describe("MovePanel's pick", () => {
  it("homes that arrive after it opens: the default is picked and the submit goes", () => {
    const onMove = vi.fn();
    const { rerender } = render(panel([], "binder-slab-case", onMove));
    expect(go().getAttribute("aria-disabled")).toBe("true");
    rerender(panel([MAIN, SLABS], "binder-slab-case", onMove));
    expect(select().value).toBe("binder-slab-case");
    expect(go().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(go());
    expect(onMove).toHaveBeenCalledWith("binder-slab-case", 1);
  });

  it("with no default, the first home that arrives is the pick", () => {
    const { rerender } = render(panel([]));
    rerender(panel([MAIN, SLABS]));
    expect(select().value).toBe("binder-main");
    expect(go().hasAttribute("aria-disabled")).toBe(false);
  });

  it("an explicit pick holds through a re-render, and falls back once that home is gone", () => {
    const onMove = vi.fn();
    const { rerender } = render(panel([MAIN, SLABS], undefined, onMove));
    fireEvent.change(select(), { target: { value: "binder-slab-case" } });
    rerender(panel([MAIN, SLABS], undefined, onMove));
    expect(select().value).toBe("binder-slab-case");
    rerender(panel([MAIN], undefined, onMove));
    expect(select().value).toBe("binder-main");
    fireEvent.click(go());
    expect(onMove).toHaveBeenCalledWith("binder-main", 1);
  });
});
