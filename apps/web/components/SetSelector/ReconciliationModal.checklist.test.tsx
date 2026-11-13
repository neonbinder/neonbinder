/**
 * NEO-496 (C1b) — the set's uploaded publisher checklist as a third source in
 * the Reconcile dialog.
 *
 * The rules these lock down:
 *  - The column lists the sections no row links, opening on the ones that fit
 *    the dialog (`scope`); "Show all checklist sections" shows the rest.
 *  - A section is placed exactly like a marketplace item: Pending, pair, "Make
 *    its own set", Keep all. Nothing is created by default.
 *  - The server's auto-matches join the set their target is, several sections
 *    to one set when they say so.
 *  - Save sends `checklistSectionKeys` only when it must, and never for a saved
 *    row whose links the dialog could not see (losing a link is a bug).
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReconciliationModal, {
  checklistRefusal,
  type PlatformItem,
  type ReconcileChecklist,
  type ReconcileChecklistSection,
} from "./ReconciliationModal";
import { checklistSetTitle } from "./reconciliation-sources";
import type { Id } from "../../convex/_generated/dataModel";

type Props = Parameters<typeof ReconciliationModal>[0];
type InitialData = Props["initialData"];
type SavedItem = {
  existingId?: string;
  value: string;
  platformData: { bsc?: string[]; sportlots?: string[] };
  identityOnly?: true;
  checklistSectionKeys?: string[];
};

const rowId = (id: string) => id as unknown as Id<"selectorOptions">;

const section = (
  name: string,
  kind: ReconcileChecklistSection["kind"] = "other",
): ReconcileChecklistSection => ({
  sectionKey: name.toLowerCase(),
  name,
  rowCount: 10,
  kind,
});

const FUTURE = section("FUTURE STARS");
const BOMB = section("Bomb Squad");
const BASE_RED = section("Base Red", "base-child");
const BASE_RP_RED = section("Base Rated Prospects Red", "base-child");

const BSC_BOMB: PlatformItem = { value: "Bomb Squad", platformValue: "bomb-squad" };
const BSC_RED: PlatformItem = { value: "Red", platformValue: "red" };
const SL_RED: PlatformItem = { value: "2026 Donruss Red", platformValue: "77001" };

function pending(bsc: PlatformItem[] = [], sl: PlatformItem[] = []): InitialData {
  return { autoMatched: [], unmatchedBsc: bsc, unmatchedSl: sl, slCandidates: [] };
}

function checklistOf(
  sections: ReconcileChecklistSection[],
  extra: Partial<ReconcileChecklist> = {},
): ReconcileChecklist {
  return { sections, matches: [], scope: "other", rowLinks: [], ...extra };
}

function renderModal(
  initialData: InitialData,
  extra: Partial<Props> = {},
) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      initialData={initialData}
      {...extra}
    />,
  );
  return { onConfirm };
}

async function save(onConfirm: ReturnType<typeof vi.fn>): Promise<SavedItem[]> {
  fireEvent.click(screen.getByText(/^Save \d+ sets$/));
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  return onConfirm.mock.calls[0][0].items as SavedItem[];
}

const readyRegion = () => screen.getByText(/^Ready \(/).parentElement as HTMLElement;

describe("checklistSetTitle", () => {
  test("title-cases a name printed in capitals", () => {
    expect(checklistSetTitle("TOPPS CHROME RADIATING ROOKIES")).toBe(
      "Topps Chrome Radiating Rookies",
    );
    expect(checklistSetTitle("ALL-STAR 1ST EDITION")).toBe("All-Star 1st Edition");
  });

  test("keeps the publisher's own casing when any letter is lower case", () => {
    expect(checklistSetTitle("Exposé")).toBe("Exposé");
    expect(checklistSetTitle("Base RC Red")).toBe("Base RC Red");
  });
});

describe("ReconciliationModal — checklist column", () => {
  test("without a checklist the dialog has no checklist column at all", () => {
    renderModal(pending([BSC_BOMB]));
    expect(screen.queryByLabelText("Filter checklist sections")).toBeNull();
    expect(screen.queryByLabelText("Show all checklist sections")).toBeNull();
    expect(
      screen.getByText(/Each set can map to any number of BSC and SportLots sets\.$/),
    ).toBeTruthy();
  });

  test("lists the sections of the dialog's kind; Show all lists the rest", () => {
    renderModal(pending(), {
      checklist: checklistOf([FUTURE, BASE_RED, BOMB]),
    });
    expect(screen.getByLabelText("Filter checklist sections")).toBeTruthy();
    expect(
      screen.getByText(/any number of BSC and SportLots sets and checklist sections\./),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Make its own set from checklist section: FUTURE STARS"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Make its own set from checklist section: Base Red"),
    ).toBeNull();

    fireEvent.click(screen.getByLabelText("Show all checklist sections"));
    expect(
      screen.getByLabelText("Make its own set from checklist section: Base Red"),
    ).toBeTruthy();
  });

  test("a Parallels dialog opens on the Base's runs only", () => {
    renderModal(pending(), {
      checklist: checklistOf([FUTURE, BASE_RED], { scope: "base-child" }),
    });
    expect(
      screen.getByLabelText("Make its own set from checklist section: Base Red"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Make its own set from checklist section: FUTURE STARS"),
    ).toBeNull();
  });

  test("says so when no section fits until Show all", () => {
    renderModal(pending(), {
      checklist: checklistOf([BASE_RED], { scope: "other" }),
    });
    expect(
      screen.getByText(
        "No sections fit here. Tick Show all checklist sections to see the rest.",
      ),
    ).toBeTruthy();
  });

  test("a section and a BSC set with one name have distinct controls", () => {
    renderModal(pending([BSC_BOMB]), { checklist: checklistOf([BOMB]) });
    expect(screen.getAllByLabelText("Make its own set: Bomb Squad")).toHaveLength(1);
    expect(
      screen.getAllByLabelText("Make its own set from checklist section: Bomb Squad"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Keep all, checklist sections" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep all, BSC sets" })).toBeTruthy();
    expect(screen.getByLabelText("Show checklist sections already mapped")).toBeTruthy();
    expect(screen.getByLabelText("Show BSC sets already mapped")).toBeTruthy();
  });

  test("nothing is created by default: every section waits in Pending", () => {
    renderModal(pending([BSC_BOMB]), { checklist: checklistOf([FUTURE, BOMB]) });
    expect(screen.getByText(/^Ready \(0\)/)).toBeTruthy();
    expect(screen.getByText(/^Pending \(3\)/)).toBeTruthy();
  });

  test("N1: a Ready set with no section carries no checklist note", () => {
    renderModal(pending([BSC_BOMB]), { checklist: checklistOf([FUTURE]) });
    fireEvent.click(screen.getByLabelText("Make its own set: Bomb Squad"));
    // The row's links line: its BSC chip and the marketplaces' no-mapping
    // note, and nothing at all for the checklist.
    const links = within(readyRegion()).getByText("no SL mapping").parentElement as HTMLElement;
    expect(within(links).getByText("Bomb Squad")).toBeTruthy();
    expect(links.textContent).not.toMatch(/checklist/i);
  });

  test("a paused SportLots column says so in place of its search box, toggles and empty line", () => {
    renderModal(pending([BSC_BOMB]), {
      checklist: checklistOf([FUTURE]),
      pausedSides: ["sportlots"],
    });
    expect(
      screen.getByText(
        "SportLots is on pause — no SportLots sets to pick from right now. Your existing SportLots links stay put.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Search SportLots items")).toBeNull();
    expect(screen.queryByLabelText("Show all SportLots items")).toBeNull();
    expect(screen.queryByText("Nothing pending on SportLots")).toBeNull();
    // The other columns are untouched.
    expect(screen.getByLabelText("Filter checklist sections")).toBeTruthy();
    expect(screen.getByLabelText("Make its own set: Bomb Squad")).toBeTruthy();
  });

  test("a SportLots column the fetch never asked says so in place of its search, toggles and empty line", () => {
    renderModal(pending([BSC_BOMB]), {
      checklist: checklistOf([FUTURE]),
      setName: "2026 Donruss",
      skippedSides: ["sportlots"],
    });
    expect(
      screen.getByText("SportLots wasn't asked: 2026 Donruss has no SportLots link."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Search SportLots items")).toBeNull();
    expect(screen.queryByLabelText("Show all SportLots items")).toBeNull();
    expect(screen.queryByLabelText("Show SportLots sets already mapped")).toBeNull();
    expect(screen.queryByText("Nothing pending on SportLots")).toBeNull();
    // BSC was asked: its column is whole.
    expect(screen.getByLabelText("Filter BSC items")).toBeTruthy();
    expect(screen.getByLabelText("Make its own set: Bomb Squad")).toBeTruthy();
    // Nothing to keep on a side nobody asked: no Keep all there.
    expect(screen.queryByRole("button", { name: /^Keep all.*, SportLots/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Keep all.*, BSC sets?$/ })).toBeTruthy();
    // A Ready row says nothing about the side nobody asked.
    fireEvent.click(screen.getByLabelText("Make its own set: Bomb Squad"));
    // The row's links line: the BSC chip, and no note for SportLots.
    const links = screen.getByRole("button", { name: /^Remove Bomb Squad from / }).parentElement
      ?.parentElement as HTMLElement;
    expect(links.textContent).toContain("Bomb Squad");
    expect(links.textContent).not.toMatch(/mapping/);
  });

  test("a paused side has no Keep all and no 'no mapping' note on a Ready row", () => {
    renderModal(pending([BSC_BOMB]), {
      checklist: checklistOf([FUTURE]),
      pausedSides: ["sportlots"],
    });
    expect(screen.queryByRole("button", { name: /^Keep all.*, SportLots/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("Make its own set: Bomb Squad"));
    expect(within(readyRegion()).queryByText("no SL mapping")).toBeNull();
  });

  test("an asked side with nothing mapped keeps its note and its Keep all", () => {
    renderModal(pending([BSC_BOMB], [SL_RED]), { checklist: checklistOf([FUTURE]) });
    expect(screen.getByRole("button", { name: /^Keep all.*, SportLots/ })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Make its own set: Bomb Squad"));
    expect(within(readyRegion()).getByText("no SL mapping")).toBeTruthy();
  });

  test("on a phone a Ready set is two lines: its whole name, then chips with the percent, toggle and remove", () => {
    renderModal(pending([BSC_BOMB]), { checklist: checklistOf([FUTURE]), showMetadata: true });
    fireEvent.click(screen.getByLabelText("Make its own set: Bomb Squad"));
    const name = screen.getByLabelText("NeonBinder set name for Bomb Squad");
    const row = name.parentElement as HTMLElement;
    // One wrapping row holds the name, the chips and the row's controls.
    expect(row.className).toContain("flex-wrap");
    expect(name.className).toContain("max-sm:basis-full");
    expect(name.className).toContain("sm:order-1");
    const chips = screen.getByRole("button", { name: /^Remove Bomb Squad from / }).parentElement
      ?.parentElement as HTMLElement;
    expect(chips.parentElement).toBe(row);
    // Side by side the chips take their own last line (sm:order-4); on a phone
    // they share one with the controls, which follow them at a 44px target.
    expect(chips.className).toContain("basis-full");
    expect(chips.className).toContain("sm:order-4");
    expect(chips.className).toContain("max-sm:flex-1");
    expect(chips.className).not.toMatch(/max-sm:order-/);
    const controls = [
      screen.getByRole("button", { name: "Toggle details for Bomb Squad" }),
      screen.getByRole("button", { name: "Remove set Bomb Squad" }),
    ];
    for (const control of controls) {
      expect(control.parentElement).toBe(row);
      // Back on the name's line side by side; DOM order on a phone.
      expect(control.className).toContain("sm:order-2");
      expect(control.className).not.toMatch(/max-sm:order-/);
      expect(control.className).toContain("max-sm:min-h-11");
      expect(control.className).toContain("max-sm:min-w-11");
    }
    // NEO-496 (a11y audit): the DOM order (so the tab order) is the phone's
    // order: name, chips, then toggle and remove.
    const order = [name, chips, ...controls];
    const at = order.map((el) => Array.from(row.children).indexOf(el));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // A long chip name wraps inside its chip rather than overflowing the row.
    const chip = screen.getByRole("button", { name: /^Remove Bomb Squad from / })
      .parentElement as HTMLElement;
    expect(chip.className).toContain("max-w-full");
    expect((chip.querySelector(".break-words") as HTMLElement).className).toContain("min-w-0");
  });

  test("a skipped BSC column says BSC wasn't asked", () => {
    renderModal(pending([], [SL_RED]), {
      checklist: checklistOf([FUTURE]),
      setName: "2026 Donruss",
      skippedSides: ["bsc"],
    });
    expect(screen.getByText("BSC wasn't asked: 2026 Donruss has no BSC link.")).toBeTruthy();
    expect(screen.queryByLabelText("Filter BSC items")).toBeNull();
    expect(screen.getByLabelText("Search SportLots items")).toBeTruthy();
  });

  test("a side both paused and skipped shows the pause sentence, not the wasn't-asked line", () => {
    renderModal(pending([BSC_BOMB]), {
      checklist: checklistOf([FUTURE]),
      setName: "2026 Donruss",
      pausedSides: ["sportlots"],
      skippedSides: ["sportlots"],
    });
    expect(screen.getByText(/^SportLots is on pause/)).toBeTruthy();
    expect(screen.queryByText(/wasn't asked/)).toBeNull();
  });
});

describe("ReconciliationModal — placing a section", () => {
  test("Make its own set: a Title Case set saved with only its section", async () => {
    const { onConfirm } = renderModal(pending(), {
      checklist: checklistOf([FUTURE]),
    });
    fireEvent.click(
      screen.getByLabelText("Make its own set from checklist section: FUTURE STARS"),
    );
    expect(screen.getByLabelText("NeonBinder set name for Future Stars")).toBeTruthy();
    expect(screen.getByText("Nothing pending on the checklist")).toBeTruthy();

    const items = await save(onConfirm);
    expect(items).toEqual([
      expect.objectContaining({
        value: "Future Stars",
        platformData: {},
        identityOnly: true,
        checklistSectionKeys: ["future stars"],
      }),
    ]);
  });

  test("Keep all makes each listed section its own set", async () => {
    const { onConfirm } = renderModal(pending(), {
      checklist: checklistOf([FUTURE, BOMB, BASE_RED]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep all 2, checklist sections" }));
    const items = await save(onConfirm);
    expect(items.map((i) => [i.value, i.checklistSectionKeys])).toEqual([
      ["Future Stars", ["future stars"]],
      ["Bomb Squad", ["bomb squad"]],
    ]);
  });

  test("a section paired with a BSC set: one set, BSC's title, both links", async () => {
    const { onConfirm } = renderModal(pending([BSC_BOMB]), {
      checklist: checklistOf([BOMB]),
    });
    // The rows' handles read badge then name: "Checklist Bomb Squad".
    fireEvent.click(screen.getByRole("button", { name: "Checklist Bomb Squad" }));
    fireEvent.click(screen.getByRole("button", { name: "BSC Bomb Squad" }));
    expect(screen.getByText(/^Ready \(1\)/)).toBeTruthy();

    const items = await save(onConfirm);
    expect(items).toEqual([
      expect.objectContaining({
        value: "Bomb Squad",
        platformData: { bsc: ["bomb-squad"] },
        checklistSectionKeys: ["bomb squad"],
      }),
    ]);
    expect(items[0].identityOnly).toBeUndefined();
  });
});

describe("ReconciliationModal — auto-matched sections", () => {
  test("two sections matched to one BSC item become one set with both", async () => {
    const { onConfirm } = renderModal(pending([BSC_RED]), {
      checklist: checklistOf([BASE_RED, BASE_RP_RED], {
        scope: "base-child",
        matches: [
          {
            sectionKey: BASE_RED.sectionKey,
            target: { kind: "item", side: "bsc", platformValue: "red" },
            confidence: 0.95,
          },
          {
            sectionKey: BASE_RP_RED.sectionKey,
            target: { kind: "item", side: "bsc", platformValue: "red" },
            confidence: 0.9,
          },
        ],
      }),
    });
    expect(screen.getByText(/^Ready \(1\)/)).toBeTruthy();
    expect(
      screen.getByLabelText("Remove checklist section Base Red from Red"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Remove checklist section Base Rated Prospects Red from Red"),
    ).toBeTruthy();
    expect(screen.getByText("Nothing pending on the checklist")).toBeTruthy();

    const items = await save(onConfirm);
    expect(items).toEqual([
      expect.objectContaining({
        value: "Red",
        platformData: { bsc: ["red"] },
        checklistSectionKeys: ["base red", "base rated prospects red"],
      }),
    ]);
  });

  test("a section matched to an auto-matched pair joins that pair's set", async () => {
    const { onConfirm } = renderModal(
      {
        autoMatched: [{ displayName: "Red", bsc: BSC_RED, sl: SL_RED, confidence: 0.9 }],
        unmatchedBsc: [],
        unmatchedSl: [],
      },
      {
        checklist: checklistOf([BASE_RED], {
          scope: "base-child",
          matches: [
            {
              sectionKey: BASE_RED.sectionKey,
              target: { kind: "pair", bsc: "red", sportlots: "77001" },
              confidence: 0.92,
            },
          ],
        }),
      },
    );
    const items = await save(onConfirm);
    expect(items).toEqual([
      expect.objectContaining({
        value: "Red",
        platformData: { bsc: ["red"], sportlots: ["77001"] },
        checklistSectionKeys: ["base red"],
      }),
    ]);
  });

  test("a section matched to a saved row joins it, even a row with no ids", async () => {
    const { onConfirm } = renderModal(pending(), {
      existingRows: [
        { existingId: rowId("row-fs"), value: "Future Stars", platformData: {} },
      ],
      checklist: checklistOf([FUTURE], {
        matches: [
          {
            sectionKey: FUTURE.sectionKey,
            target: { kind: "row", rowId: rowId("row-fs") },
            confidence: 1,
          },
        ],
      }),
    });
    expect(
      screen.getByLabelText("Remove checklist section FUTURE STARS from Future Stars"),
    ).toBeTruthy();
    const items = await save(onConfirm);
    expect(items).toEqual([
      expect.objectContaining({
        existingId: "row-fs",
        value: "Future Stars",
        platformData: {},
        checklistSectionKeys: ["future stars"],
      }),
    ]);
    expect(items[0].identityOnly).toBeUndefined();
  });

  test("a match whose target is not here stays in Pending", () => {
    renderModal(pending(), {
      checklist: checklistOf([FUTURE], {
        matches: [
          {
            sectionKey: FUTURE.sectionKey,
            target: { kind: "item", side: "bsc", platformValue: "gone" },
            confidence: 1,
          },
        ],
      }),
    });
    expect(screen.getByText(/^Ready \(0\)/)).toBeTruthy();
    expect(
      screen.getByLabelText("Make its own set from checklist section: FUTURE STARS"),
    ).toBeTruthy();
  });
});

describe("ReconciliationModal — saved rows' checklist links", () => {
  const savedRow = {
    existingId: rowId("row-bomb"),
    value: "Bomb Squad",
    platformData: { bsc: "bomb-squad" },
  };

  test("a saved row shows its links, and an untouched row sends none", async () => {
    const { onConfirm } = renderModal(pending([BSC_BOMB]), {
      existingRows: [savedRow],
      checklist: checklistOf([FUTURE], {
        rowLinks: [
          {
            rowId: rowId("row-bomb"),
            sections: [{ sectionKey: "bomb squad", name: "Bomb Squad" }],
          },
        ],
      }),
    });
    expect(
      screen.getByLabelText("Remove checklist section Bomb Squad from Bomb Squad"),
    ).toBeTruthy();
    const items = await save(onConfirm);
    expect(items).toHaveLength(1);
    expect(items[0].checklistSectionKeys).toBeUndefined();
  });

  test("a section added to a saved row sends all of its keys", async () => {
    const { onConfirm } = renderModal(pending([BSC_BOMB]), {
      existingRows: [savedRow],
      checklist: checklistOf([FUTURE], {
        rowLinks: [
          {
            rowId: rowId("row-bomb"),
            // A key the current checklist no longer holds is echoed unchanged.
            sections: [{ sectionKey: "old bomb", name: "old bomb" }],
          },
        ],
      }),
    });
    fireEvent.click(screen.getByText("FUTURE STARS", { selector: "span" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add FUTURE STARS to this set, Bomb Squad" }),
    );
    const items = await save(onConfirm);
    expect(items[0].checklistSectionKeys).toEqual(["old bomb", "future stars"]);
  });

  test("removing a saved row's only section sends an empty list", async () => {
    const { onConfirm } = renderModal(pending([BSC_BOMB]), {
      existingRows: [savedRow],
      checklist: checklistOf([], {
        rowLinks: [
          {
            rowId: rowId("row-bomb"),
            sections: [{ sectionKey: "bomb squad", name: "Bomb Squad" }],
          },
        ],
      }),
    });
    fireEvent.click(
      screen.getByLabelText("Remove checklist section Bomb Squad from Bomb Squad"),
    );
    const items = await save(onConfirm);
    expect(items[0].checklistSectionKeys).toEqual([]);
  });

  test("unknown links: no section may join the row, and Save sends none", async () => {
    const { onConfirm } = renderModal(pending([BSC_BOMB]), {
      existingRows: [savedRow],
      checklist: { sections: [FUTURE], matches: [], scope: "other" },
    });
    fireEvent.click(screen.getByText("FUTURE STARS", { selector: "span" }));
    expect(
      screen.queryByRole("button", { name: /Add FUTURE STARS to this set/ }),
    ).toBeNull();
    expect(within(readyRegion()).getByText(checklistRefusal("Bomb Squad"))).toBeTruthy();

    const items = await save(onConfirm);
    expect(items).toHaveLength(1);
    expect(items[0].checklistSectionKeys).toBeUndefined();
  });
});
