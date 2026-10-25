import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { CopyList } from "./CardDetail";
import type { Container, Copy } from "./data/types";
import { carryLineKeys, NO_LINE_KEYS, OPTIMISTIC_ID_PREFIX } from "./lineKeys";

/**
 * NEO-359 — a line keeps its React identity across the store's
 * optimistic→real id swap. An undo of a fold re-splits a line under an
 * `optimistic:` id; when the server answers, the id becomes the server's. A
 * Move panel the collector opened on that line in between must stay open,
 * and the row must not remount (its buttons would detach mid-click).
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
vi.mock("convex/react", () => ({}));

const LINE: Copy = {
  id: "copy-1",
  cardId: "c-1",
  variantId: "vt-base",
  setId: "set-chrome",
  homeId: "main",
  homeKind: "binder",
  homeName: "Main",
  upForTrade: false,
  quantity: 2,
  acquiredAt: "2026-10-01",
  notes: "",
};
/** The line an undo re-split back out of the stack, as the store draws it ahead of the server. */
const DRAWN: Copy = { ...LINE, id: `${OPTIMISTIC_ID_PREFIX}7`, homeId: "binder-rainbow", homeName: "Ohtani rainbow", quantity: 1 };
/** The same line once the server answers. */
const LANDED: Copy = { ...DRAWN, id: "copy-9" };

const HOMES: Container[] = [
  { id: "main", kind: "binder", system: "main", name: "Main", count: null },
  { id: "binder-rainbow", kind: "binder", name: "Ohtani rainbow", count: null },
  { id: "binder-pc", kind: "binder", name: "PC binder", count: null },
];

afterEach(cleanup);

describe("carryLineKeys", () => {
  it("keys a line by its own id to start, and keeps that key while the id stays", () => {
    const first = carryLineKeys(NO_LINE_KEYS, [LINE, LANDED]);
    expect([...first.values()]).toEqual(["copy-1", "copy-9"]);
    const again = carryLineKeys({ lines: [LINE, LANDED], keys: first }, [{ ...LINE, quantity: 5 }, LANDED]);
    expect([...again.values()]).toEqual(["copy-1", "copy-9"]);
  });

  it("hands a drawn line's key to the server's line that replaced it", () => {
    const before = carryLineKeys(NO_LINE_KEYS, [LINE, DRAWN]);
    const after = carryLineKeys({ lines: [LINE, DRAWN], keys: before }, [LANDED, LINE]);
    expect(after.get("copy-9")).toBe(DRAWN.id);
    expect(after.get("copy-1")).toBe("copy-1");
  });

  it("pairs by what the line is, so two lines swapping at once each keep their own", () => {
    const other: Copy = { ...DRAWN, id: `${OPTIMISTIC_ID_PREFIX}8`, homeId: "binder-pc", homeName: "PC binder" };
    const keys = carryLineKeys(NO_LINE_KEYS, [DRAWN, other]);
    const after = carryLineKeys({ lines: [DRAWN, other], keys }, [
      { ...other, id: "copy-pc" },
      { ...DRAWN, id: "copy-rainbow" },
    ]);
    expect(after.get("copy-rainbow")).toBe(DRAWN.id);
    expect(after.get("copy-pc")).toBe(other.id);
  });

  it("pairs the one left over when the server filled in a field the drawing could not know", () => {
    const keys = carryLineKeys(NO_LINE_KEYS, [DRAWN]);
    const after = carryLineKeys({ lines: [DRAWN], keys }, [{ ...LANDED, acquiredAt: "2026-10-24" }]);
    expect(after.get("copy-9")).toBe(DRAWN.id);
  });

  it("never carries a real line's key to another: only a drawn line hands its key on", () => {
    const keys = carryLineKeys(NO_LINE_KEYS, [LINE]);
    const after = carryLineKeys({ lines: [LINE], keys }, [{ ...LINE, id: "copy-2" }]);
    expect(after.get("copy-2")).toBe("copy-2");
  });
});

describe("CopyList through the id swap", () => {
  function List({ copies }: { copies: Copy[] }) {
    return (
      <MemoryRouter>
        <CopyList
          name="#1 Shohei Ohtani"
          copies={copies}
          names={copies.map((c) => (c.homeId === "main" ? "Raw ×2" : "Raw"))}
          homes={HOMES}
          onMove={async () => null}
          onRemove={() => {}}
        />
      </MemoryRouter>
    );
  }

  it("an open Move panel on a drawn line stays open, and the row stays the same row, when the server's id arrives", () => {
    const { rerender } = render(<List copies={[LINE, DRAWN]} />);
    const region = () => within(screen.getByRole("region", { name: "Your copies of #1 Shohei Ohtani" }));
    const move = region().getByRole("button", { name: "Move #1 Shohei Ohtani, Raw" });
    const row = move.closest("li")!;
    fireEvent.click(move);
    const panel = region().getByRole("form", { name: "Move Raw" });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "binder-pc" } });

    act(() => rerender(<List copies={[LINE, LANDED]} />));

    const after = region().getByRole("button", { name: "Move #1 Shohei Ohtani, Raw" });
    expect(after).toBe(move);
    expect(after.isConnected).toBe(true);
    expect(after.closest("li")).toBe(row);
    expect(after.getAttribute("data-copy-move")).toBe("copy-9");
    expect(after.getAttribute("aria-expanded")).toBe("true");
    // The same panel, with what the collector had picked in it.
    const still = region().getByRole("form", { name: "Move Raw" });
    expect(still).toBe(panel);
    expect((within(still).getByRole("combobox", { name: "Move to" }) as HTMLSelectElement).value).toBe("binder-pc");
  });
});
