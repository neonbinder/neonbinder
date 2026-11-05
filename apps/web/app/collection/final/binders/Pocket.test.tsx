import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import BinderDesk from "./BinderDesk";
import Pocket, { ReadOnlyPocket } from "./Pocket";
import type { PageModel, PocketModel } from "./model";
import type { Card, Copy } from "../data/types";

/**
 * NEO-444 — a visitor's pocket and binder. Nothing an owner can do is there to
 * reach: no drag, no aim, no add, no hint. And the owner's pocket is untouched.
 */

// Reduced motion: the card opens at once, with no lead-in to wait out.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const CARD = {
  id: "c1",
  cardNumber: "7",
  cardName: "Mickey Mantle",
  players: [{ id: "p1", name: "Mickey Mantle" }],
  teams: [],
  set: { id: "s1", season: "1952", name: "Topps" },
  variant: { id: "v1", kind: "base", name: "Base" },
  features: [],
  printRun: null,
  cardVariation: null,
  finish: { kind: "standard" },
} as unknown as Card;
const COPY = { id: "k1", cardId: "c1", quantity: 1, upForTrade: false, homeKind: "binder" } as Copy;
const have: PocketModel = { content: { kind: "have", card: CARD, copies: [COPY] } };

function renderReadOnly(pocket: PocketModel, onOpen = vi.fn()) {
  render(
    <Theme>
      <ReadOnlyPocket pocket={pocket} index={2} pageNumber={4} onOpen={onOpen} />
    </Theme>,
  );
  return onOpen;
}

describe("ReadOnlyPocket", () => {
  test("an empty pocket, even with a real slot, is inert and reads as empty", () => {
    renderReadOnly({ content: { kind: "empty" }, slot: { binderId: "b", page: 0, slot: 0 } });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Empty pocket")).toBeTruthy();
    expect(screen.queryByText("Fill")).toBeNull();
  });

  test("a need pocket is inert and says the binder still needs the card", () => {
    renderReadOnly({ content: { kind: "need", card: CARD } });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Mickey Mantle.*this binder still needs it/)).toBeTruthy();
    expect(screen.getByText("Need")).toBeTruthy();
  });

  test("a filled pocket opens its copies, and has no way to be moved", () => {
    const onOpen = renderReadOnly(have);
    const button = screen.getByRole("button", { name: /Mickey Mantle.*pocket 3 on page 4$/ });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.className).not.toContain("nb-sleeve--movable");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith([COPY]);
  });

  test("Alt+arrows on a filled pocket do nothing to the browser's Back", () => {
    renderReadOnly(have);
    const notCancelled = fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowLeft", altKey: true });
    expect(notCancelled).toBe(true);
  });

  test("never wears the smart binder's Outside the rule tag", () => {
    renderReadOnly({ ...have, outside: true });
    expect(screen.queryByText("Outside the rule")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).not.toContain("outside");
  });

  test("wears the Trade and For sale stickers, and the count", () => {
    renderReadOnly({
      content: { kind: "have", card: CARD, copies: [{ ...COPY, quantity: 2, upForTrade: true, homeKind: "box" }] },
    });
    expect(screen.getByText("Trade")).toBeTruthy();
    expect(screen.getByText("For sale")).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
  });

  test("a pocket's own photo wins, and without one the card is drawn", () => {
    const photos = { front: { imageUrl: "https://img.test/f.jpg", thumbUrl: "https://img.test/t.jpg" } };
    renderReadOnly({ ...have, photos });
    expect(screen.getByRole("button").querySelector("img")?.getAttribute("src")).toBe(photos.front.thumbUrl);
  });
});

describe("the owner's Pocket keeps its actions", () => {
  test("an empty pocket with a slot aims the pack", () => {
    const onAim = vi.fn();
    const slot = { binderId: "b", page: 0, slot: 0 };
    render(
      <Theme>
        <Pocket
          pocket={{ content: { kind: "empty" }, slot }}
          variant="binder"
          index={0}
          pageNumber={1}
          aimed={false}
          onOpen={vi.fn()}
          onAdd={vi.fn()}
          onAim={onAim}
        />
      </Theme>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Empty pocket 1 on page 1. Fill it from the pack" }));
    expect(onAim).toHaveBeenCalledExactlyOnceWith(slot);
  });

  test("a need pocket adds the card", () => {
    const onAdd = vi.fn();
    render(
      <Theme>
        <Pocket
          pocket={{ content: { kind: "need", card: CARD } }}
          variant="binder"
          index={0}
          pageNumber={1}
          aimed={false}
          onOpen={vi.fn()}
          onAdd={onAdd}
          onAim={vi.fn()}
        />
      </Theme>,
    );
    fireEvent.click(screen.getByRole("button", { name: /need\. Add it$/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("BinderDesk, read-only", () => {
  const page: PageModel = { section: null, pockets: [have, { content: { kind: "empty" } }] };

  test("renders with no DndContext, no move hint, and turns on a swipe", () => {
    const onTurn = vi.fn();
    render(
      <Theme>
        <BinderDesk
          readOnly
          pages={[page, page]}
          wide={false}
          at={0}
          onTurn={onTurn}
          vinyl="#123456"
          cover={null}
          reducedMotion
          name="Shared"
          onOpenCopies={vi.fn()}
        />
      </Theme>,
    );
    expect(document.getElementById("nb-pocket-move-hint")).toBeNull();
    const region = screen.getByRole("region", { name: "Shared, open" });
    fireEvent.touchStart(region, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(region, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    expect(onTurn).toHaveBeenCalledExactlyOnceWith(1);
  });

  test("the owner's desk still shows the move hint when it rearranges", () => {
    render(
      <Theme>
        <BinderDesk
          pages={[page]}
          wide={false}
          at={0}
          onTurn={vi.fn()}
          vinyl="#123456"
          cover={null}
          variant="binder"
          aimed={null}
          wholeBinderDrop={false}
          reducedMotion
          name="Mine"
          onOpen={vi.fn()}
          onAdd={vi.fn()}
          onAim={vi.fn()}
          rearrange
        />
      </Theme>,
    );
    expect(document.getElementById("nb-pocket-move-hint")).not.toBeNull();
  });
});
