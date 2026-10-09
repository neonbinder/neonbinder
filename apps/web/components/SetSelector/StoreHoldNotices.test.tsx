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
import StoreHoldNotices, {
  RENAME_CLASH_FIX,
  RENAME_INVALID_FIX,
  SIBLING_FIX,
  SIBLING_REASON_LINE,
  UNCHECKED_FIX,
  refusedRenameLine,
  refusedRenameSummary,
  siblingFamily,
  siblingHoldSummary,
  type SiblingFamily,
} from "./StoreHoldNotices";
import type { SiblingHold, RefusedRename, StoreHolds } from "./held-elsewhere";
import type { SiblingWithholdReason } from "../../convex/selectorSyncMatch";
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
    withheld: NonNullable<Parameters<typeof StoreHoldNotices>[0]["holds"]>["withheld"],
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
    // NEO-325: the regions are always mounted; only one has words in it.
    expect(
      screen.getAllByRole("status").filter((el) => el.textContent),
    ).toHaveLength(1);
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
    const [notice, ...others] = screen
      .getAllByRole("status")
      .filter((el) => el.textContent);
    expect(others).toHaveLength(0);
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

/**
 * NEO-325 — the two boxes for what the store did NOT save under this parent:
 * lines withheld against its own rows, and title edits it refused. They share
 * the shape of the withheld box: the summary and the fixes are live, the list
 * sits beside the region.
 */
describe("StoreHoldNotices — mounted before it has anything to say (NEO-325 a11y)", () => {
  const empty: StoreHolds = { withheld: [], withheldTotal: 0, subtreeWalkSkipped: false };
  const liveRegions = () => screen.getAllByRole("status");

  test("with no holds it renders four bare status regions and no text", () => {
    const { container } = render(<StoreHoldNotices holds={null} />);

    expect(liveRegions()).toHaveLength(4);
    for (const region of liveRegions()) {
      expect(region.textContent).toBe("");
      expect(region.hasAttribute("class")).toBe(false);
    }
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("group")).toBeNull();
  });

  test("holds with nothing in them render the same bare regions", () => {
    const { container } = render(<StoreHoldNotices holds={empty} />);

    expect(liveRegions()).toHaveLength(4);
    expect(container.textContent).toBe("");
    // No amber box around nothing.
    expect(container.querySelector(".bg-amber-400\\/10")).toBeNull();
  });

  test("the regions are the SAME elements when the answer arrives, so it is announced", () => {
    const { rerender } = render(<StoreHoldNotices holds={null} />);
    const before = liveRegions();

    rerender(
      <StoreHoldNotices
        holds={{
          ...empty,
          siblings: [{ label: "Anime", reason: "nameSharedBySiblings", rows: [] }],
          siblingsTotal: 1,
          renames: [{ label: "Alpha", requested: "Beta", reason: "clash", clashWith: "Beta" }],
          renamesTotal: 1,
          subtreeWalkSkipped: true,
        }}
      />,
    );

    const after = liveRegions();
    expect(after).toHaveLength(before.length);
    after.forEach((region, i) => expect(region).toBe(before[i]));
    // Each box that has something to say now says it in its own region.
    expect(after.filter((r) => r.textContent).length).toBe(3);
  });
});

describe("StoreHoldNotices — lines withheld against the parent's own rows (NEO-325)", () => {
  const hold = (
    label: string,
    reason: SiblingWithholdReason,
    rows: Array<{ id: string; value: string }> = [],
  ): SiblingHold => ({ label, reason, rows });
  const renderSiblings = (siblings: SiblingHold[], total = siblings.length) =>
    render(
      <StoreHoldNotices
        holds={{
          withheld: [],
          withheldTotal: 0,
          subtreeWalkSkipped: false,
          siblings,
          siblingsTotal: total,
        }}
      />,
    );
  const summaryRegion = (total: number) =>
    screen.getByText(siblingHoldSummary(total)).closest('[role="status"]') as HTMLElement;

  test("the summary and one fix per kind are live; the list is beside the region, not in it", () => {
    renderSiblings([
      hold("Anime", "nameSharedBySiblings", [{ id: "r1", value: "Anime" }]),
      hold("Gold", "idOnManySiblings"),
    ]);

    const live = summaryRegion(2);
    expect(live.textContent).toContain(SIBLING_FIX.name);
    expect(live.textContent).toContain(SIBLING_FIX.link);
    expect(live.textContent).not.toContain(SIBLING_FIX.twice);
    expect(live.textContent).not.toContain(SIBLING_FIX.split);
    // Kinds appear in the fixed order, however the store listed them.
    expect(live.textContent!.indexOf(SIBLING_FIX.name)).toBeLessThan(
      live.textContent!.indexOf(SIBLING_FIX.link),
    );
    const list = screen.getByRole("list", { name: siblingHoldSummary(2) });
    expect(live.contains(list)).toBe(false);
  });

  test("each item says its kind of reason, then the rows it clashed with by NB name", () => {
    renderSiblings([
      hold("Anime", "nameSharedBySiblings", [
        { id: "r1", value: "Anime" },
        { id: "r2", value: "Anime" },
      ]),
      hold("Gold", "idsPointAtDifferentRows"),
    ]);

    const list = screen.getByRole("list", { name: siblingHoldSummary(2) });
    const items = within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Anime");
    expect(items[0].textContent).toContain(SIBLING_REASON_LINE.name);
    expect(within(items[0]).getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      "Anime",
      "Anime",
    ]);
    expect(items[1].textContent).toContain(SIBLING_REASON_LINE.split);
    expect(within(items[1]).queryAllByRole("listitem")).toHaveLength(0);
  });

  test("past the store's cap the true count leads and '+ N more' closes the list", () => {
    renderSiblings([hold("Anime", "nameSharedBySiblings")], 9);

    expect(screen.getByText(siblingHoldSummary(9))).toBeTruthy();
    expect(screen.getByText("+ 8 more")).toBeTruthy();
  });

  test("a store that sent only a count reads as the commonest case, a name already taken", () => {
    render(
      <StoreHoldNotices
        holds={{
          withheld: [],
          withheldTotal: 0,
          subtreeWalkSkipped: false,
          siblings: [],
          siblingsTotal: 3,
        }}
      />,
    );

    const live = summaryRegion(3);
    expect(live.textContent).toContain(SIBLING_FIX.name);
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("one set and many sets read differently", () => {
    expect(siblingHoldSummary(1)).not.toBe(siblingHoldSummary(2));
    expect(siblingHoldSummary(1)).toContain("1 set ");
    expect(siblingHoldSummary(4)).toContain("4 sets");
  });

  test("the verbs in the fixes are the controls' own, never 'link' or 'move'", () => {
    for (const fix of Object.values(SIBLING_FIX)) {
      expect(fix).not.toMatch(/\blink(ed|s)?\b|take off|\bmove\b/i);
    }
    expect(SIBLING_FIX.link).toContain("Detach");
    expect(SIBLING_FIX.split).toContain("Attach");
  });

  test.each<[SiblingWithholdReason, SiblingFamily]>([
    ["nameSharedBySiblings", "name"],
    ["nameLinkedToOtherSet", "name"],
    ["noIdToAttach", "name"],
    ["existingIdClaimed", "twice"],
    ["idClaimedTwice", "twice"],
    ["nameClaimedTwice", "twice"],
    ["rowClaimedInBatch", "twice"],
    ["idOnManySiblings", "link"],
    ["idsPointAtDifferentRows", "split"],
    ["nameSharedInBatch", "name"],
  ])("%s is the %s kind", (reason, family) => {
    expect(siblingFamily(reason)).toBe(family);
  });

  test("an unknown reason from a newer store reads as a name already taken, not a crash", () => {
    expect(siblingFamily("somethingNew" as SiblingWithholdReason)).toBe("name");
  });
});

describe("StoreHoldNotices — title edits the store refused (NEO-325)", () => {
  const rename = (over: Partial<RefusedRename> = {}): RefusedRename => ({
    label: "Alpha",
    requested: "Beta",
    reason: "clash",
    clashWith: "Beta",
    ...over,
  });
  const renderRenames = (renames: RefusedRename[], total = renames.length) =>
    render(
      <StoreHoldNotices
        holds={{
          withheld: [],
          withheldTotal: 0,
          subtreeWalkSkipped: false,
          renames,
          renamesTotal: total,
        }}
      />,
    );
  const summaryRegion = (total: number) =>
    screen.getByText(refusedRenameSummary(total)).closest('[role="status"]') as HTMLElement;

  test("a clash and an invalid name each get their fix line, once, in the live region", () => {
    renderRenames([
      rename(),
      rename({ label: "Gamma", requested: "x", reason: "invalid", clashWith: undefined }),
      rename({ label: "Delta", requested: "Beta" }),
    ]);

    const live = summaryRegion(3);
    expect(live.textContent).toContain(RENAME_CLASH_FIX);
    expect(live.textContent).toContain(RENAME_INVALID_FIX);
    expect(live.textContent!.split(RENAME_CLASH_FIX)).toHaveLength(2);
  });

  test("only the kinds present get a fix", () => {
    renderRenames([rename({ reason: "invalid", clashWith: undefined })]);

    const live = summaryRegion(1);
    expect(live.textContent).toContain(RENAME_INVALID_FIX);
    expect(live.textContent).not.toContain(RENAME_CLASH_FIX);
  });

  test("each line names the set that kept its name and what was asked for", () => {
    const clash = rename();
    const invalid = rename({ label: "Gamma", requested: "bad", reason: "invalid", clashWith: undefined });
    renderRenames([clash, invalid]);

    const list = screen.getByRole("list", { name: refusedRenameSummary(2) });
    expect(within(list).getByText("Alpha")).toBeTruthy();
    expect(within(list).getByText(refusedRenameLine(clash))).toBeTruthy();
    expect(within(list).getByText(refusedRenameLine(invalid))).toBeTruthy();
    expect(refusedRenameLine(clash)).toContain("Beta");
    expect(refusedRenameLine(invalid)).toContain("bad");
    // The list is beside the live region.
    expect(summaryRegion(2).contains(list)).toBe(false);
  });

  test("a clash with no named holder still reads, and a count past the cap closes with '+ N more'", () => {
    expect(refusedRenameLine(rename({ clashWith: undefined }))).toContain("another set");
    renderRenames([rename()], 5);

    expect(screen.getByText(refusedRenameSummary(5))).toBeTruthy();
    expect(screen.getByText("+ 4 more")).toBeTruthy();
  });

  test("a store that sent only a count reads as a clash", () => {
    render(
      <StoreHoldNotices
        holds={{
          withheld: [],
          withheldTotal: 0,
          subtreeWalkSkipped: false,
          renames: [],
          renamesTotal: 2,
        }}
      />,
    );

    expect(summaryRegion(2).textContent).toContain(RENAME_CLASH_FIX);
    expect(summaryRegion(2).textContent).not.toContain(RENAME_INVALID_FIX);
  });

  test("the sets and their links were saved is said, so nobody redoes the sync", () => {
    expect(refusedRenameSummary(1)).toMatch(/saved/);
    expect(refusedRenameSummary(3)).toMatch(/saved/);
    expect(refusedRenameSummary(1)).not.toBe(refusedRenameSummary(3));
  });
});
