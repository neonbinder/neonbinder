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
import { render, screen, within } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";
import StoreHoldNotices, { UNCHECKED_FIX } from "./StoreHoldNotices";
import {
  ATTACH_MORE_LABEL,
  CUSTOM_BUTTON_LABEL,
  MULTI_SOURCE_HEADING,
} from "./control-labels";

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

/**
 * NEO-312 — the store now walks the whole set and the brand, so a holder can
 * be in another variant type or another set. Named by its value alone it read
 * as a bare "Base" or "Red Ink"; it now carries the NB path down to it.
 */
describe("StoreHoldNotices — where a holder lives (NEO-312)", () => {
  const holder = (
    id: string,
    value: string,
    level: "setName" | "variantType" | "insert" | "parallel",
    parentValue: string,
    path?: string[],
  ) => ({
    id: id as Id<"selectorOptions">,
    value,
    level,
    parentId: `parent-${id}` as Id<"selectorOptions">,
    parentValue,
    ...(path ? { path } : {}),
  });

  function renderWithheld(
    withheld: Parameters<typeof StoreHoldNotices>[0]["holds"]["withheld"],
    subtreeWalkSkipped = false,
  ) {
    render(
      <StoreHoldNotices
        holds={{ withheld, withheldTotal: withheld.length, subtreeWalkSkipped }}
      />,
    );
  }

  const itemLines = () =>
    within(screen.getByRole("group"))
      .getAllByRole("listitem")
      .filter((li) => li.querySelector("ul") === null)
      .map((li) => li.textContent);

  test("a holder in another variant type reads as a breadcrumb down to it", () => {
    renderWithheld([
      {
        label: "Red Ink",
        reason: "heldByMany",
        holders: [
          holder("p1", "Red Ink", "parallel", "All-America Game Autos", [
            "Bowman",
            "Insert",
            "All-America Game Autos",
          ]),
          holder("i1", "Red Ink", "insert", "Parallels", ["Bowman", "Parallels"]),
        ],
      },
    ]);

    expect(itemLines()).toEqual([
      "Bowman › Insert › All-America Game Autos › Red Ink",
      "Bowman › Parallels › Red Ink",
    ]);
  });

  test("a holder in another set names that set; a set holder is named on its own", () => {
    renderWithheld([
      {
        label: "Blue",
        reason: "heldByMany",
        holders: [
          holder("vt1", "Base", "variantType", "Bowman Blue", ["Bowman Blue"]),
          holder("s1", "Bowman Blue", "setName", "Bowman", []),
        ],
      },
    ]);

    expect(itemLines()).toEqual(["Bowman Blue › Base", "Bowman Blue"]);
  });

  test("an older result with no path keeps the parallel → insert line", () => {
    renderWithheld([
      {
        label: "Kanji",
        reason: "idsDisagree",
        holders: [holder("p2", "Anime Kanji", "parallel", "Anime")],
      },
    ]);
    expect(itemLines()).toEqual(["Anime Kanji→grouped under Anime"]);
  });

  test("notChecked: its own line, no rows under it, and the by-hand fix", () => {
    renderWithheld([{ label: "Gold Refractor", reason: "notChecked", holders: [] }]);

    const live = screen.getByText(
      "Hold up: 1 not added. This set is too big to check new links automatically.",
    ).closest('[role="status"]') as HTMLElement;
    expect(live.textContent).toContain(
      "You can still add it by hand: pick its row, or make one with + Custom, then use Attach more… under Multi-source sets.",
    );
    // Nothing clashes, so the clash fix is not offered. And no retry: past
    // the set bound a retry hits the same bound (security audit N2).
    expect(live.textContent).not.toContain("Delete or ungroup");
    expect(live.textContent).not.toMatch(/try again|ask for help/i);
    const list = screen.getByRole("group");
    expect(list.textContent).toContain(
      "Not added: this set is too big to check new links automatically.",
    );
    expect(list.textContent).not.toContain("Points at a row linked to a different set:");
    // No empty holder list under it.
    expect(list.querySelectorAll("ul ul")).toHaveLength(0);
  });

  test("clashes and unchecked items together: a plain count and both fixes", () => {
    renderWithheld([
      { label: "Gold", reason: "notChecked", holders: [] },
      {
        label: "Red Ink",
        reason: "heldByMany",
        holders: [holder("p1", "Red Ink", "parallel", "Chrome", ["Bowman", "Insert", "Chrome"])],
      },
    ]);

    const live = screen.getByText("Hold up: 2 not added.").closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(live.textContent).toContain("Delete or ungroup the extra row, then sync again.");
    expect(live.textContent).toContain("You can still add it by hand: pick its row, or make one with + Custom, then use Attach more… under Multi-source sets.");
  });

  test("clashes alone keep the clash summary and fix, wherever the holder is", () => {
    renderWithheld([
      {
        label: "Red Ink",
        reason: "heldByMany",
        holders: [holder("p1", "Red Ink", "parallel", "Chrome", ["Bowman", "Insert", "Chrome"])],
      },
    ]);
    const live = screen.getByText("Hold up: 1 not added. It clashes with existing rows.")
      .closest('[role="status"]') as HTMLElement;
    expect(live.textContent).toContain("Delete or ungroup the extra row, then sync again.");
    expect(live.textContent).not.toContain("by hand");
  });

  test("a skipped walk with its unchecked items listed says it once, in the withheld box", () => {
    renderWithheld([{ label: "Gold", reason: "notChecked", holders: [] }], true);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText(/^Heads up:/)).toBeNull();
  });

  test("a skipped walk beside a clash still gets its own notice", () => {
    renderWithheld(
      [
        {
          label: "Red Ink",
          reason: "heldByMany",
          holders: [holder("p1", "Red Ink", "parallel", "Chrome", ["Bowman", "Insert", "Chrome"])],
        },
      ],
      true,
    );
    expect(
      screen.getByText(
        "Heads up: this set is too big to check new links automatically, so new ones weren't added.",
      ),
    ).toBeTruthy();
  });

  test("a skipped walk says new links were held back, not re-added", () => {
    render(
      <StoreHoldNotices
        holds={{ withheld: [], withheldTotal: 0, subtreeWalkSkipped: true }}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe(
      "Heads up: this set is too big to check new links automatically, so new ones weren't added.",
    );
    expect(notice.textContent).not.toMatch(/re-added|doubles/);
  });
});

describe("StoreHoldNotices — a link left on the row that had it (NEO-312)", () => {
  test("names where the link lives, with its path, and how to move it if wanted", () => {
    render(
      <StoreHoldNotices
        holds={{
          withheld: [
            {
              label: "Blue",
              reason: "linkHeldElsewhere",
              holders: [
                {
                  id: "p1" as Id<"selectorOptions">,
                  value: "Blue",
                  level: "parallel",
                  parentId: "i1" as Id<"selectorOptions">,
                  parentValue: "Chrome",
                  path: ["Bowman", "Insert", "Chrome"],
                },
              ],
            },
          ],
          withheldTotal: 1,
          subtreeWalkSkipped: false,
        }}
      />,
    );
    const live = screen.getByText(
      "Hold up: 1 link not added. It's already on another row.",
    ).closest('[role="status"]') as HTMLElement;
    expect(live.textContent).toContain(
      "If a link belongs here instead, take it off the other row, then sync again.",
    );
    // Nothing clashes and nothing went unchecked: neither of those fixes.
    expect(live.textContent).not.toContain("Delete or ungroup");
    expect(live.textContent).not.toContain("by hand");
    const list = screen.getByRole("group");
    expect(list.textContent).toContain(
      "Its link is already on this row, so it stayed there:",
    );
    expect(list.textContent).toContain("Bowman › Insert › Chrome › Blue");
  });
});

describe("StoreHoldNotices — the by-hand fix names real controls (NEO-312)", () => {
  test("built from the labels EntityColumn and MultiSourcePanel render", () => {
    // A rename in control-labels moves the button and this sentence together.
    expect(UNCHECKED_FIX).toContain(CUSTOM_BUTTON_LABEL);
    expect(UNCHECKED_FIX).toContain(ATTACH_MORE_LABEL);
    expect(UNCHECKED_FIX).toContain(MULTI_SOURCE_HEADING);
    // And the labels are the ones the operator sees today, byte for byte.
    expect([CUSTOM_BUTTON_LABEL, ATTACH_MORE_LABEL, MULTI_SOURCE_HEADING]).toEqual([
      "+ Custom",
      "Attach more…",
      "Multi-source sets",
    ]);
  });
});
