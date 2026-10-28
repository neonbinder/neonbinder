import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import CommonPrice, { parsePrice } from "./CommonPrice";
import { PageApiContext, type PageApi } from "../pageApi";
import { CollectionStoreContext, type CollectionActions, type CollectionData, type CollectionStoreValue } from "../data/store";
import { REAL_CAPABILITIES } from "../data/types";

/**
 * NEO-378 — a checklist's common price on the inventory side. The store is a
 * stub (one price, a spy for `setCommonPrice`); `run` calls the write the way
 * the page's does and hands back its result.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

function setup(prices: Record<string, number> | undefined) {
  const undo = vi.fn(async () => {});
  const setCommonPrice = vi.fn(async () => ({ undo }));
  const messages: string[] = [];
  const pageApi: PageApi = {
    openCard: vi.fn(),
    goToChecklists: vi.fn(),
    openSuggestion: vi.fn(),
    notify: vi.fn(),
    inform: vi.fn(),
    undoLast: vi.fn(),
    run: (async (write: () => Promise<{ undo: () => Promise<void> }>, message: (r: unknown) => string) => {
      const r = await write();
      messages.push(message(r));
      return r;
    }) as PageApi["run"],
  };
  const data = { useCommonPrices: () => prices } as unknown as CollectionData;
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data,
    actions: { setCommonPrice } as unknown as CollectionActions,
  } as CollectionStoreValue;
  render(
    <Theme>
      <CollectionStoreContext.Provider value={value}>
        <PageApiContext.Provider value={pageApi}>
          <CommonPrice variantId="base1" title="Base" />
        </PageApiContext.Provider>
      </CollectionStoreContext.Provider>
    </Theme>,
  );
  return { setCommonPrice, messages };
}

const flush = () => act(async () => {});

afterEach(cleanup);

describe("parsePrice", () => {
  it("reads dollars to the cent, blank as clear, and refuses the rest", () => {
    expect(parsePrice("0.25")).toBe(0.25);
    expect(parsePrice("$1.5")).toBe(1.5);
    expect(parsePrice(".18")).toBe(0.18);
    expect(parsePrice("3")).toBe(3);
    expect(parsePrice("  ")).toBeNull();
    expect(parsePrice("-1")).toBe("invalid");
    expect(parsePrice("0.255")).toBe("invalid");
    expect(parsePrice("abc")).toBe("invalid");
  });
});

describe("the common price line", () => {
  it("says when there is none yet, and sets one with Enter", async () => {
    const { setCommonPrice, messages } = setup({});
    expect(screen.getByText("No common price yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set a common price for Base" }));
    const field = screen.getByRole("textbox", { name: "Common price" });
    fireEvent.change(field, { target: { value: "0.25" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();
    expect(setCommonPrice).toHaveBeenCalledWith("base1", 0.25);
    expect(messages).toEqual(["Common price for Base is $0.25"]);
    expect(screen.queryByRole("textbox", { name: "Common price" })).toBeNull();
  });

  it("shows the price, and a blank field clears it", async () => {
    const { setCommonPrice, messages } = setup({ base1: 0.18 });
    expect(screen.getByText("$0.18")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change the common price for Base" }));
    const field = screen.getByRole("textbox", { name: "Common price" }) as HTMLInputElement;
    expect(field.value).toBe("0.18");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await flush();
    expect(setCommonPrice).toHaveBeenCalledWith("base1", null);
    expect(messages).toEqual(["Cleared the common price for Base"]);
  });

  it("refuses what is not a price without writing, and Escape cancels", async () => {
    const { setCommonPrice } = setup({});
    fireEvent.click(screen.getByRole("button", { name: "Set a common price for Base" }));
    const field = screen.getByRole("textbox", { name: "Common price" });
    fireEvent.change(field, { target: { value: "cheap" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/isn't a price/);
    expect(setCommonPrice).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Common price" })).toBeNull();
  });

  it("saves nothing when the price did not change", async () => {
    const { setCommonPrice } = setup({ base1: 0.25 });
    fireEvent.click(screen.getByRole("button", { name: "Change the common price for Base" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Common price" }), { key: "Enter" });
    await flush();
    expect(setCommonPrice).not.toHaveBeenCalled();
  });
});
