import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { MovePanel, sellPriceToStore } from "./CardDetail";
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

/**
 * NEO-479 — Sell asks the card's own price: prefilled from the copy's own
 * price, else the variant's common price; required when there is neither;
 * an untouched prefill sends nothing. The panel never writes a common price
 * (it has no way to: it only calls `onMove`).
 */
const BOX = { id: "box-show", name: "Show box", kind: "box" } as unknown as Container;
const BINDER = { id: "binder-main", name: "Main", kind: "binder" } as unknown as Container;

type SellOver = {
  copy?: Partial<Copy>;
  shift?: "sell" | "move";
  homes?: readonly Container[];
  price?: { common: number | null | undefined } | "none";
  onMove?: ReturnType<typeof vi.fn>;
};
function sellPanel({ copy: over = {}, shift = "sell", homes = [BOX], price = { common: null }, onMove = vi.fn() }: SellOver = {}) {
  return (
    <Theme>
      <MovePanel
        copy={{ id: "copy-1", quantity: 1, homeKind: "binder", ...over } as unknown as Copy}
        line="Raw"
        shift={shift}
        homes={homes}
        price={price === "none" ? undefined : price}
        onMove={onMove}
        onCancel={vi.fn()}
      />
    </Theme>
  );
}
const priceField = () => screen.getByRole("textbox", { name: "Price" }) as HTMLInputElement;
const sell = () => screen.getByRole("button", { name: "Put it up for sale" });
const typePrice = (v: string) => fireEvent.change(priceField(), { target: { value: v } });
const form = () => screen.getByRole("form", { name: "Sell Raw" });

describe("sellPriceToStore", () => {
  it("a blank field is not a price", () => {
    expect(sellPriceToStore("", null)).toEqual({ ok: false, reason: "blank" });
    expect(sellPriceToStore("   ", 0.25)).toEqual({ ok: false, reason: "blank" });
  });

  it.each(["abc", "1.234", "-1", "1,50"])("%s is invalid", (text) => {
    expect(sellPriceToStore(text, null)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a price past the server's cap and accepts the cap itself", () => {
    expect(sellPriceToStore("100000000.01", null)).toEqual({ ok: false, reason: "tooHigh" });
    expect(sellPriceToStore("100000000.00", null)).toEqual({ ok: true, minPrice: 100_000_000 });
  });

  it("the prefill untouched sends nothing, however it is spelled", () => {
    expect(sellPriceToStore("0.50", 0.5)).toEqual({ ok: true, minPrice: undefined });
    expect(sellPriceToStore("0.5", 0.5)).toEqual({ ok: true, minPrice: undefined });
    expect(sellPriceToStore("$.5", 0.5)).toEqual({ ok: true, minPrice: undefined });
  });

  it("an edited price is the card's own price, in dollars", () => {
    expect(sellPriceToStore("0.40", 0.25)).toEqual({ ok: true, minPrice: 0.4 });
    expect(sellPriceToStore("0.29", 0.25)).toEqual({ ok: true, minPrice: 0.29 });
  });

  it("with no prefill (none, or still loading) any valid price is sent, even 0", () => {
    expect(sellPriceToStore("1.50", null)).toEqual({ ok: true, minPrice: 1.5 });
    expect(sellPriceToStore("1.50", undefined)).toEqual({ ok: true, minPrice: 1.5 });
    expect(sellPriceToStore("0", null)).toEqual({ ok: true, minPrice: 0 });
  });
});

describe("MovePanel's Price field", () => {
  it("shows on Sell into a box", () => {
    render(sellPanel());
    expect(priceField()).toBeTruthy();
  });

  it.each([
    ["Move into a binder", { shift: "move" as const, homes: [BINDER] }],
    ["a panel given no price prop", { price: "none" as const }],
    ["a copy already in a box", { copy: { homeKind: "box" as const } }],
    ["Sell whose pick is a binder", { homes: [BINDER] }],
  ])("does not show on %s", (_n, over) => {
    render(sellPanel(over as SellOver));
    expect(screen.queryByRole("textbox", { name: "Price" })).toBeNull();
  });

  it("with no price field the submit goes on quantity alone", () => {
    const onMove = vi.fn();
    render(sellPanel({ shift: "move", homes: [BINDER], onMove }));
    fireEvent.click(screen.getByRole("button", { name: "Move it" }));
    expect(onMove).toHaveBeenCalledWith("binder-main", 1);
  });

  it("prefills the variant's common price and says where it came from", () => {
    render(sellPanel({ price: { common: 0.25 } }));
    expect(priceField().value).toBe("0.25");
    expect(screen.getByText(/Your common price, \$0\.25\. Change it to price just this card/)).toBeTruthy();
  });

  it("prefills the copy's own price over the common price", () => {
    render(sellPanel({ copy: { minPrice: 0.5 }, price: { common: 0.25 } }));
    expect(priceField().value).toBe("0.50");
    expect(screen.getByText("This card's own price.")).toBeTruthy();
  });

  it("a common price that arrives after the panel opened fills the field without remounting it", () => {
    const { rerender } = render(sellPanel({ price: { common: undefined } }));
    const input = priceField();
    expect(input.value).toBe("");
    expect(sell().getAttribute("aria-busy")).toBe("true");
    expect(sell().getAttribute("aria-disabled")).toBe("true");
    rerender(sellPanel({ price: { common: 0.25 } }));
    expect(priceField()).toBe(input);
    expect(input.value).toBe("0.25");
    expect(sell().hasAttribute("aria-busy")).toBe(false);
    expect(sell().hasAttribute("aria-disabled")).toBe(false);
  });

  it("what the collector typed survives a late common price", () => {
    const { rerender } = render(sellPanel({ price: { common: undefined } }));
    typePrice("3.00");
    rerender(sellPanel({ price: { common: 0.25 } }));
    expect(priceField().value).toBe("3.00");
  });

  it("with no price to start from the field is blank, the submit is aria-disabled and Enter calls nothing", () => {
    const onMove = vi.fn();
    render(sellPanel({ onMove }));
    expect(priceField().value).toBe("");
    expect(screen.getByText("No common price for this card yet. Give it a price to put it up for sale.")).toBeTruthy();
    expect(sell().getAttribute("aria-disabled")).toBe("true");
    fireEvent.submit(form());
    fireEvent.click(sell());
    expect(onMove).not.toHaveBeenCalled();
  });

  it.each([["abc"], ["1.234"]])("%s shows the dollars-and-cents error and blocks the submit", (text) => {
    const onMove = vi.fn();
    render(sellPanel({ onMove }));
    typePrice(text);
    expect(screen.getByText("Dollars and cents, like 1.50.")).toBeTruthy();
    expect(priceField().getAttribute("aria-invalid")).toBe("true");
    expect(sell().getAttribute("aria-disabled")).toBe("true");
    fireEvent.submit(form());
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a price past the cap shows the limit and blocks the submit", () => {
    const onMove = vi.fn();
    render(sellPanel({ onMove }));
    typePrice("100000000.01");
    expect(screen.getByText(/past the \$100,000,000\.00 limit/)).toBeTruthy();
    fireEvent.submit(form());
    expect(onMove).not.toHaveBeenCalled();
  });

  it("clearing a prefilled field asks for a price and blocks the submit", () => {
    const onMove = vi.fn();
    render(sellPanel({ price: { common: 0.25 }, onMove }));
    typePrice("");
    expect(screen.getByText("Give it a price, like 1.50.")).toBeTruthy();
    fireEvent.submit(form());
    expect(onMove).not.toHaveBeenCalled();
  });

  it.each([["0.25"], ["$0.25"], [".25"]])("the prefill untouched or respelled (%s) moves with no price", (text) => {
    const onMove = vi.fn();
    render(sellPanel({ price: { common: 0.25 }, onMove }));
    typePrice(text);
    fireEvent.click(sell());
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]).toEqual(["box-show", 1]);
  });

  it("0.5 against a 0.50 prefill is unchanged", () => {
    const onMove = vi.fn();
    render(sellPanel({ copy: { minPrice: 0.5 }, onMove }));
    typePrice("0.5");
    fireEvent.click(sell());
    expect(onMove.mock.calls[0]).toEqual(["box-show", 1]);
  });

  it("an edited price goes as the card's own price", () => {
    const onMove = vi.fn();
    render(sellPanel({ price: { common: 0.25 }, onMove }));
    typePrice("0.4");
    fireEvent.click(sell());
    expect(onMove).toHaveBeenCalledWith("box-show", 1, 0.4);
  });

  it("a typed price with no common price goes as the card's own price", () => {
    const onMove = vi.fn();
    render(sellPanel({ onMove }));
    typePrice("1.50");
    fireEvent.submit(form());
    expect(onMove).toHaveBeenCalledWith("box-show", 1, 1.5);
  });
});
