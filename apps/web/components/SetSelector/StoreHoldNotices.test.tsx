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

  test("notChecked: its own line, no rows under it, and try-again guidance", () => {
    renderWithheld([{ label: "Gold Refractor", reason: "notChecked", holders: [] }]);

    const live = screen.getByText(
      "Hold up: 1 not added. It couldn't be checked against the rest of the set.",
    ).closest('[role="status"]') as HTMLElement;
    expect(live.textContent).toContain(
      "Try again, or ask for help if it keeps happening.",
    );
    // Nothing clashes, so the clash fix is not offered.
    expect(live.textContent).not.toContain("Delete or ungroup");
    const list = screen.getByRole("group");
    expect(list.textContent).toContain(
      "Couldn't check this link against the rest of the set, so it wasn't added.",
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
    expect(live.textContent).toContain("Try again, or ask for help if it keeps happening.");
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
    expect(live.textContent).not.toContain("Try again");
  });

  test("a skipped walk says new links were held back, not re-added", () => {
    render(
      <StoreHoldNotices
        holds={{ withheld: [], withheldTotal: 0, subtreeWalkSkipped: true }}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe(
      "Heads up: this set is too big to check new links against, so new ones weren't added.",
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
    expect(live.textContent).not.toContain("Try again");
    const list = screen.getByRole("group");
    expect(list.textContent).toContain(
      "Its link is already on this row, so it stayed there:",
    );
    expect(list.textContent).toContain("Bowman › Insert › Chrome › Blue");
  });
});
