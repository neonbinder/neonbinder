/**
 * NEO-300 — the store-hold notices carry no DOM id on anything focusable.
 *
 * maestro-web reports an element's resource-id as `id || aria-label`, so a
 * DOM id on a focusable element hides its accessible name from every flow.
 * The withheld list is a focusable scroll group (so the keyboard can scroll
 * it), named by the summary sentence through aria-labelledby: the id belongs
 * on that sentence, never on the group.
 */
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";
import StoreHoldNotices from "./StoreHoldNotices";

const row = (id: string, value: string) => ({
  id: id as Id<"selectorOptions">,
  value,
  level: "insert" as const,
  parentId: "vt" as Id<"selectorOptions">,
  parentValue: "Inserts",
});

describe("StoreHoldNotices", () => {
  test("the withheld list is named by its summary and carries no DOM id", () => {
    render(
      <StoreHoldNotices
        variantsLabel="Inserts"
        holds={{
          withheld: [
            {
              label: "Anime Gold",
              reason: "heldByMany",
              holders: [row("a", "Anime Gold"), row("b", "Anime Gold Refractor")],
            },
          ],
          withheldTotal: 1,
          subtreeWalkSkipped: false,
        }}
      />,
    );
    const list = screen.getByRole("group");
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(list.getAttribute("id")).toBeNull();
    // The name still resolves: aria-labelledby points at the summary <p>.
    const summary = document.getElementById(
      list.getAttribute("aria-labelledby")!,
    );
    expect(summary?.tagName).toBe("P");
    expect(screen.getByRole("group", { name: summary!.textContent! })).toBe(list);
  });
});
