/**
 * NEO-137 — the reconcile modal builds NeonBinder SETS, not marketplace pairs.
 *
 * The model: NB owns the set and its title. A set maps to 0-N BSC sets and
 * 0-N SportLots sets, the two sides completely independent. A marketplace id
 * records how that marketplace carves up the same cards — it is not exclusive,
 * so any number of NB sets may map to the same id.
 *
 * This replaced a pair-shaped modal (`{bsc, sl}`, one id per side). Everything
 * awkward about that model came from treating a marketplace set as a scarce
 * resource: an item with no partner needed a "keep as platform-only" shelf, and
 * a set wanted by two rows produced a winner and a loser that then needed
 * "link shared" escape hatches to undo.
 *
 * The motivating case is 1996 Score: BSC splits Dugout Collection Artist's
 * Proofs into Series 1 and Series 2, SportLots carries one combined set. Both
 * answers must be expressible — ONE NB set mapping to both BSC sets, or TWO NB
 * sets each mapping to the shared SL set — because which one is right is a
 * judgement about our catalogue, not about the marketplaces.
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReconciliationModal, {
  type PlatformItem,
} from "./ReconciliationModal";
import type { Id } from "../../convex/_generated/dataModel";
import { keyboardDrag, stubLayout } from "../../lib/testing/keyboard-drag";

const BSC_S1: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 1",
  platformValue: "dcap-series-1",
};
const BSC_S2: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 2",
  platformValue: "dcap-series-2",
};
const SL_COMBINED: PlatformItem = {
  value: "Dugout Collection Artists Proofs",
  platformValue: "884412",
};

type InitialData = Parameters<typeof ReconciliationModal>[0]["initialData"];

function renderModal(initialData: InitialData, extra?: { showMetadata?: boolean }) {
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

/** Nothing auto-matched: two BSC sets and one SL set, all pending. */
function allPending(): InitialData {
  return {
    autoMatched: [],
    unmatchedBsc: [BSC_S1, BSC_S2],
    unmatchedSl: [SL_COMBINED],
    slCandidates: [],
  };
}

async function itemsFromConfirm(onConfirm: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  return onConfirm.mock.calls[0][0].items as Array<{
    value: string;
    platformData: { bsc?: string[]; sportlots?: string[] };
    platformLabels?: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    };
  }>;
}

/** Select a pending item, then click a Ready set's "add" button. */
function attachToFirstSet(pendingLabel: string) {
  fireEvent.click(screen.getByText(pendingLabel));
  const add = screen
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-label")?.startsWith(`Add ${pendingLabel} to `));
  expect(add).toBeTruthy();
  fireEvent.click(add!);
}

describe("ReconciliationModal — NB sets with 0-N mappings per side", () => {
  test("pairing two pending items makes ONE set — the 1:1 case stays one gesture", async () => {
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(BSC_S1.value);
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
  });

  test("ONE set can map to TWO BSC sets and one SL set", async () => {
    const { onConfirm } = renderModal(allPending());

    // Series 1 + the SL set become a set...
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));
    // ...then Series 2 joins that same set rather than starting its own.
    attachToFirstSet(BSC_S2.value);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].platformData.bsc).toEqual([
      "dcap-series-1",
      "dcap-series-2",
    ]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
    // Each id carries the marketplace's own name so the slots stay tellable
    // apart once there is more than one on a side.
    expect(items[0].platformLabels?.bsc).toEqual({
      "dcap-series-1": BSC_S1.value,
      "dcap-series-2": BSC_S2.value,
    });
  });

  test("the set title is OURS — editable, and it is what gets saved", async () => {
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    const title = screen.getByLabelText(
      `NeonBinder set name for ${BSC_S1.value}`,
    );
    fireEvent.change(title, {
      target: { value: "Dugout Collection Artists Proofs" },
    });
    // Committed on blur, not per keystroke — dispatching a reducer action per
    // character re-renders every row of the modal between characters, which is
    // how controlled inputs drop keystrokes here.
    fireEvent.blur(title);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items[0].value).toBe("Dugout Collection Artists Proofs");
    // Renaming must not disturb the mapping.
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
  });

  test("TWO sets may map to the SAME SL id — mapping does not consume it", async () => {
    // The 1996 Score answer when you want Series 1 and Series 2 to stay
    // SEPARATE NB sets. Both must reach the one SportLots set.
    //
    // This is the case the first cut of the Ready/Pending model could not
    // express: ATTACH looked its item up in Pending only, so the SL set became
    // unreachable the moment the first set mapped it — the exact exclusivity
    // the redesign was meant to delete, reintroduced one layer down.
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    // Series 2 becomes its own set...
    fireEvent.click(
      screen.getByLabelText(`Make its own set: ${BSC_S2.value}`),
    );

    // ...and the SL set, already mapped by set #1, is revealed and mapped again.
    fireEvent.click(
      screen.getByLabelText("Show SportLots sets already mapped"),
    );
    expect(screen.getByText(`mapped to ${BSC_S1.value}`)).toBeTruthy();

    // The name now appears twice — as set #1's chip and in the revealed list.
    // Only the latter is draggable, which is the one to select.
    const revealed = screen
      .getAllByText(SL_COMBINED.value)
      .find((el) => el.closest(".cursor-grab") !== null);
    fireEvent.click(revealed!);

    const add = screen
      .getAllByRole("button")
      .find((b) =>
        b
          .getAttribute("aria-label")
          ?.startsWith(`Add ${SL_COMBINED.value} to ${BSC_S2.value}`),
      );
    fireEvent.click(add!);

    fireEvent.click(screen.getByText(/Save 2 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(2);
    const s1 = items.find((i) => i.value === BSC_S1.value)!;
    const s2 = items.find((i) => i.value === BSC_S2.value)!;
    expect(s1.platformData.bsc).toEqual(["dcap-series-1"]);
    expect(s2.platformData.bsc).toEqual(["dcap-series-2"]);
    // BOTH carry the one SportLots id. Neither stole it from the other.
    expect(s1.platformData.sportlots).toEqual(["884412"]);
    expect(s2.platformData.sportlots).toEqual(["884412"]);
  });

  test("a set with no SL mapping is ordinary, not a platform-only special case", async () => {
    const { onConfirm } = renderModal(allPending());

    fireEvent.click(
      screen.getByLabelText(`Make its own set: ${BSC_S2.value}`),
    );
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items[0].platformData.bsc).toEqual(["dcap-series-2"]);
    expect(items[0].platformData.sportlots).toBeUndefined();
  });

  test("a lone item can become a set — there is no platform-only shelf", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [],
      unmatchedBsc: [BSC_S1],
      unmatchedSl: [],
      slCandidates: [],
    });

    fireEvent.click(
      screen.getByLabelText(`Make its own set: ${BSC_S1.value}`),
    );
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
    expect(items[0].platformData.sportlots).toBeUndefined();
  });

  test("detaching the last mapping removes the set rather than saving an empty one", () => {
    renderModal(allPending());

    fireEvent.click(
      screen.getByLabelText(`Make its own set: ${BSC_S1.value}`),
    );
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();

    fireEvent.click(
      screen.getByLabelText(`Remove ${BSC_S1.value} from ${BSC_S1.value}`),
    );

    // Save is disabled at zero sets, and the item is back in Pending.
    expect(screen.getByText(/Save 0 sets/)).toBeTruthy();
    expect(
      screen.getByLabelText(`Make its own set: ${BSC_S1.value}`),
    ).toBeTruthy();
  });

  test("auto-matches arrive as Ready sets, and pending items are NOT saved", async () => {
    const { onConfirm } = renderModal({
      autoMatched: [
        {
          displayName: BSC_S2.value,
          bsc: BSC_S2,
          sl: SL_COMBINED,
          confidence: 0.78,
        },
      ],
      unmatchedBsc: [BSC_S1],
      unmatchedSl: [],
      slCandidates: [],
    });

    expect(screen.getByText(/78%/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    // Only the auto-matched set is written; Series 1 sat in Pending untouched.
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(BSC_S2.value);
  });

});

describe("ReconciliationModal — restoring saved rows", () => {
  // The pair model kept only platformData.bsc[0] when seeding, silently
  // dropping operator-attached extras on every reopen — invisible, because a
  // row with one id still looks perfectly healthy.
  test("a saved row with two BSC ids comes back with both", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="insert"
        initialData={{
          autoMatched: [],
          unmatchedBsc: [],
          unmatchedSl: [],
          slCandidates: [],
        }}
        existingRows={[
          {
            value: "Dugout Collection Artists Proofs",
            platformData: {
              bsc: ["dcap-series-1", "dcap-series-2"],
              sportlots: ["884412"],
            },
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText(/Save 1 sets/));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const items = onConfirm.mock.calls[0][0].items as Array<{
      platformData: { bsc?: string[]; sportlots?: string[] };
    }>;

    expect(items[0].platformData.bsc).toEqual([
      "dcap-series-1",
      "dcap-series-2",
    ]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
  });

  test("removing a set returns EVERY mapping to Pending, not just one", () => {
    // Disband is the undo for a wrong auto-match. It has to release both sides
    // or the released set is stranded: invisible in Pending and unreachable to
    // re-pair, with the only recovery being Cancel and re-sync.
    renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(`Remove set ${BSC_S1.value}`));

    expect(screen.getByText(/Save 0 sets/)).toBeTruthy();
    // Both halves are pending again — each offers its solo affordance, which
    // only renders for a Pending item.
    expect(
      screen.getByLabelText(`Make its own set: ${BSC_S1.value}`),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(`Make its own set: ${SL_COMBINED.value}`),
    ).toBeTruthy();
  });

  test("the Ready list can be filtered by our title OR by a mapped marketplace name", () => {
    // Not cosmetic. The dialog body is its own scroller and Maestro — like a
    // user with a trackpad — cannot easily get past a long Ready list to the
    // Pending columns and Save below it. A real reconcile holds a dozen-plus
    // sets. Filtering is how both halves stay reachable.
    renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));
    fireEvent.click(
      screen.getByLabelText(`Make its own set: ${BSC_S2.value}`),
    );
    expect(screen.getByText(/Ready \(2\)/)).toBeTruthy();

    const filter = screen.getByLabelText("Filter NeonBinder sets");

    // By OUR title.
    fireEvent.change(filter, { target: { value: "Series 2" } });
    expect(screen.getByText(/Ready \(1 of 2\)/)).toBeTruthy();

    // By a MAPPED marketplace name — the SL set's name appears on neither
    // title, so this only matches if mappings are searched too.
    fireEvent.change(filter, { target: { value: "Artists Proofs" } });
    expect(screen.getByText(/Ready \(1 of 2\)/)).toBeTruthy();

    fireEvent.change(filter, { target: { value: "nothing matches this" } });
    expect(screen.getByText(/No sets match/)).toBeTruthy();
    // Filtering is a VIEW — it must not drop sets from what gets saved.
    expect(screen.getByText(/Save 2 sets/)).toBeTruthy();
  });

  test("an emptied title snaps back rather than saving a nameless set", () => {
    renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    const title = screen.getByLabelText(
      `NeonBinder set name for ${BSC_S1.value}`,
    );
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.blur(title);

    expect(
      screen.getByLabelText(`NeonBinder set name for ${BSC_S1.value}`),
    ).toHaveProperty("value", BSC_S1.value);
  });
});

/**
 * NEO-211 (plan E) — the modal carries the NB row's `_id`.
 *
 * Before this the modal had no notion of `_id` at all: `title` WAS the identity
 * on save, so editing a title in here was a delete of the old row plus an insert
 * of a new one. That took the row's children, its checklist, and every
 * cross-listing pointed at it — the "rename then re-sync loses the subtree"
 * failure the whole ticket exists to remove.
 */
describe("ReconciliationModal — carrying the NB row id (NEO-211)", () => {
  const ROW_ID = "selopt_abc" as Id<"selectorOptions">;

  function renderWithExistingRow(existingId?: Id<"selectorOptions">) {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="insert"
        initialData={{
          autoMatched: [],
          unmatchedBsc: [],
          unmatchedSl: [],
          slCandidates: [],
        }}
        existingRows={[
          {
            existingId,
            value: "Dugout Collection Artists Proofs",
            platformData: { bsc: ["dcap-series-1"], sportlots: ["884412"] },
          },
        ]}
      />,
    );
    return { onConfirm };
  }

  test("a saved row's id comes back out on save", async () => {
    const { onConfirm } = renderWithExistingRow(ROW_ID);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect((items[0] as { existingId?: unknown }).existingId).toBe(ROW_ID);
  });

  test("a RENAME inside the modal KEEPS the id — that is the whole point", async () => {
    // Without the id, this exact gesture was delete-and-insert on save.
    const { onConfirm } = renderWithExistingRow(ROW_ID);

    const title = screen.getByLabelText(
      "NeonBinder set name for Dugout Collection Artists Proofs",
    );
    fireEvent.change(title, { target: { value: "Dugout Collection APs" } });
    fireEvent.blur(title);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items[0].value).toBe("Dugout Collection APs");
    expect((items[0] as { existingId?: unknown }).existingId).toBe(ROW_ID);
  });

  test("a set built in the dialog carries no id, so the store matches it normally", async () => {
    const { onConfirm } = renderModal(allPending());
    fireEvent.click(screen.getByText(BSC_S1.value));
    fireEvent.click(screen.getByText(SL_COMBINED.value));

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect((items[0] as { existingId?: unknown }).existingId).toBeUndefined();
  });

  test("a caller that omits existingId still works — the prop is additive", async () => {
    const { onConfirm } = renderWithExistingRow(undefined);

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect((items[0] as { existingId?: unknown }).existingId).toBeUndefined();
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
  });
});

/**
 * NEO-300 — ids another NB row already holds (for Sync Inserts: the parallels
 * Group Parallels moved under an insert). The auto-match seeding used to hand
 * every one back as a fresh Ready set, which the save then stored as a
 * duplicate top-level insert.
 */
describe("ReconciliationModal — sets held elsewhere (NEO-300)", () => {
  const KANJI_BSC: PlatformItem = { value: "Anime Kanji", platformValue: "bsc-kanji" };
  const KANJI_SL: PlatformItem = { value: "Anime Kanji", platformValue: "sl-kanji" };
  const STARS_BSC: PlatformItem = { value: "Chrome Stars", platformValue: "bsc-stars" };
  const STARS_SL: PlatformItem = { value: "Chrome Stars", platformValue: "sl-stars" };
  const LOOSE_BSC: PlatformItem = { value: "Anime Gold", platformValue: "bsc-gold" };

  const heldElsewhere = {
    rows: [
      {
        key: "par-kanji",
        name: "Anime Kanji",
        parentName: "Anime",
        bsc: ["bsc-kanji"],
        sportlots: ["sl-kanji"],
      },
      {
        key: "par-gold",
        name: "Anime Gold",
        parentName: "Anime",
        bsc: ["bsc-gold"],
        sportlots: [],
      },
    ],
    summary: "2 already grouped as parallels. Leaving those be.",
    toggleLabel: "Show grouped",
  };

  function renderHeld(initialData: InitialData) {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="insert"
        initialData={initialData}
        heldElsewhere={heldElsewhere}
      />,
    );
    return { onConfirm };
  }

  test("a held pair is NOT seeded Ready, and a held loose item is NOT Pending", async () => {
    const { onConfirm } = renderHeld({
      autoMatched: [
        { displayName: "Anime Kanji", bsc: KANJI_BSC, sl: KANJI_SL, confidence: 0.95 },
        { displayName: "Chrome Stars", bsc: STARS_BSC, sl: STARS_SL, confidence: 0.95 },
      ],
      unmatchedBsc: [LOOSE_BSC],
      unmatchedSl: [],
      slCandidates: [],
    });

    // Header counts: one Ready, nothing Pending.
    expect(screen.getByText("1 ready")).toBeTruthy();
    expect(screen.getByText(/Pending \(0\)/)).toBeTruthy();
    expect(screen.queryByText(LOOSE_BSC.value)).toBeNull();

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items.map((i) => i.value)).toEqual(["Chrome Stars"]);
  });

  test("the header says how many were left alone, and names them on request", () => {
    renderHeld({
      autoMatched: [
        { displayName: "Anime Kanji", bsc: KANJI_BSC, sl: KANJI_SL, confidence: 0.95 },
      ],
      unmatchedBsc: [LOOSE_BSC],
      unmatchedSl: [],
      slCandidates: [],
    });

    expect(
      screen.getByText("2 already grouped as parallels. Leaving those be."),
    ).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show grouped" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // Our names only — the row and the insert it is grouped under.
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Anime Kanji→grouped under Anime",
      "Anime Gold→grouped under Anime",
    ]);
  });

  test("the unheld half of a half-held auto-match lands in Pending, not nowhere", () => {
    // Gold is held on BSC only. Its SL partner belongs to nobody, so it is an
    // ordinary unassigned set the operator may still want.
    const GOLD_SL: PlatformItem = { value: "Anime Gold", platformValue: "sl-gold" };
    renderHeld({
      autoMatched: [
        { displayName: "Anime Gold", bsc: LOOSE_BSC, sl: GOLD_SL, confidence: 0.9 },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
    });

    expect(screen.getByText("0 ready, 1 pending")).toBeTruthy();
    expect(screen.getByText(/SportLots \(1\)/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Make its own set: Anime Gold" }),
    ).toBeTruthy();
  });

  test("a restored row keeps an id a parallel also holds — our own rows come first", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="insert"
        initialData={{
          autoMatched: [],
          unmatchedBsc: [],
          unmatchedSl: [],
          slCandidates: [],
        }}
        heldElsewhere={heldElsewhere}
        existingRows={[
          { value: "Anime Gold Insert", platformData: { bsc: ["bsc-gold"] } },
        ]}
      />,
    );

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items[0].platformData.bsc).toEqual(["bsc-gold"]);
  });

  test("a long list scrolls inside its own bounded region, not the header", () => {
    // 2026 Bowman: 140+ grouped rows. The header does not scroll, so an
    // unbounded list pushed the body and the Save footer out of the panel.
    const rows = Array.from({ length: 140 }, (_, i) => ({
      key: `par-${i}`,
      name: `Parallel ${i}`,
      parentName: "Chrome",
      bsc: [`bsc-${i}`],
      sportlots: [],
    }));
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        level="insert"
        initialData={allPending()}
        heldElsewhere={{
          rows,
          summary: "140 already grouped as parallels. Leaving those be.",
          toggleLabel: "Show grouped",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show grouped" }));
    const region = screen.getByRole("group", {
      name: "140 already grouped as parallels. Leaving those be.",
    });
    // Bounded and scrollable, and reachable from the keyboard to scroll it.
    expect(region.className).toContain("max-h-40");
    expect(region.className).toContain("overflow-y-auto");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getAllByRole("listitem")).toHaveLength(140);
    // The toggle points at the region it opens (through a wrapper: the
    // focusable region itself carries no DOM id, which would hide its name
    // from maestro-web's resource-id — NEO-300).
    const controls = screen
      .getByRole("button", { name: "Show grouped" })
      .getAttribute("aria-controls");
    expect(document.getElementById(controls!)?.contains(region)).toBe(true);
    expect(region.getAttribute("id")).toBeNull();
    // Save is still in the footer, untouched by the list.
    expect(screen.getByText(/Save 0 sets/)).toBeTruthy();
  });

  test("the toggle meets the 24px target size and keeps its text (WCAG 2.5.8)", () => {
    renderHeld({ autoMatched: [], unmatchedBsc: [], unmatchedSl: [], slCandidates: [] });
    const toggle = screen.getByRole("button", { name: "Show grouped" });
    expect(toggle.textContent).toBe("Show grouped");
    // happy-dom has no layout; the classes are the contract.
    expect(toggle.className).toContain("min-h-6");
    expect(toggle.className).toContain("inline-block");
  });

  test("no held rows, no line", () => {
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        level="insert"
        initialData={allPending()}
        heldElsewhere={{ ...heldElsewhere, rows: [] }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Show grouped" })).toBeNull();
    expect(screen.queryByText(/already grouped/)).toBeNull();
  });
});

/**
 * NEO-300 — a KEYBOARD drag pairs two sets.
 *
 * A real one, through dnd-kit's KeyboardSensor and collision code, on stubbed
 * rectangles (happy-dom lays nothing out): Space on Series 1's handle, ten
 * ArrowRights (25px each) carry it across onto the SportLots set, Space
 * drops. Collision detection used to be bare `pointerWithin`, which finds
 * nothing without a pointer, so this drop landed nowhere and nothing paired.
 */
describe("ReconciliationModal — a keyboard drop lands", () => {
  test("Space, arrows, Space pairs a BSC set with a SportLots set", async () => {
    const { onConfirm } = renderModal(allPending());
    // The handle carries the listeners; the row around it is the sortable
    // node, which is what dnd-kit measures and what a drop lands on.
    const handle = screen.getByText(BSC_S1.value).parentElement!;
    const bscRow = handle.parentElement!;
    const slRow = screen.getByText(SL_COMBINED.value).parentElement!
      .parentElement!;
    const restore = stubLayout(
      new Map([
        [bscRow, { top: 100, left: 0, width: 300, height: 36 }],
        [slRow, { top: 100, left: 400, width: 300, height: 36 }],
      ]),
    );
    try {
      await keyboardDrag(handle, Array(10).fill("ArrowRight"));
    } finally {
      restore();
    }

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items).toHaveLength(1);
    expect(items[0].platformData.bsc).toEqual(["dcap-series-1"]);
    expect(items[0].platformData.sportlots).toEqual(["884412"]);
  });
});

/**
 * NEO-306 — an auto-match whose ONE half a restored row already holds.
 *
 * The SportLots review files "Blue" as a parallel holding its SportLots id.
 * The next Sync Parallels auto-matches BSC "Blue Refractor" with that same
 * SportLots id. The seeding used to skip any pair with either half already
 * mapped, so BSC Blue landed in neither Ready nor Pending: a link the operator
 * could never make. The free half now joins the row that holds its partner's
 * id — by id, never by name — or, with no single such row, goes to Pending.
 */
describe("ReconciliationModal — half an auto-match is already restored (NEO-306)", () => {
  const BLUE_ROW_ID = "selopt_blue" as Id<"selectorOptions">;
  const BSC_BLUE: PlatformItem = { value: "Blue Refractor", platformValue: "bsc-blue" };
  const SL_BLUE: PlatformItem = { value: "Blue Parallel", platformValue: "sl-blue" };
  const BLUE_PAIR = {
    displayName: "Blue Refractor",
    bsc: BSC_BLUE,
    sl: SL_BLUE,
    confidence: 0.9,
  };

  type ModalProps = Parameters<typeof ReconciliationModal>[0];

  function renderRestored(
    existingRows: NonNullable<ModalProps["existingRows"]>,
    extra: Partial<ModalProps> = {},
    autoMatched: InitialData["autoMatched"] = [BLUE_PAIR],
  ) {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="parallel"
        initialData={{
          autoMatched,
          unmatchedBsc: [],
          unmatchedSl: [],
          slCandidates: [],
        }}
        existingRows={existingRows}
        {...extra}
      />,
    );
    return { onConfirm };
  }

  test("a restored row holding the SL id takes the free BSC half, and saves it", async () => {
    const { onConfirm } = renderRestored([
      {
        existingId: BLUE_ROW_ID,
        value: "Blue",
        platformData: { sportlots: ["sl-blue"] },
      },
    ]);

    // One set, nothing pending: the BSC half is on the restored row, not lost.
    expect(screen.getByText("1 ready")).toBeTruthy();
    expect(screen.getByText(/Pending \(0\)/)).toBeTruthy();
    // An ordinary attached chip — the ✕ that sends it back to Pending.
    expect(
      screen.getByLabelText(`Remove ${BSC_BLUE.value} from Blue`),
    ).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items).toHaveLength(1);
    // Our row, our title, now carrying both links.
    expect((items[0] as { existingId?: unknown }).existingId).toBe(BLUE_ROW_ID);
    expect(items[0].value).toBe("Blue");
    expect(items[0].platformData.bsc).toEqual(["bsc-blue"]);
    expect(items[0].platformData.sportlots).toEqual(["sl-blue"]);
    expect(items[0].platformLabels?.bsc).toEqual({ "bsc-blue": BSC_BLUE.value });
  });

  test("the attached half is one ✕ from Pending, like any attach", () => {
    renderRestored([{ value: "Blue", platformData: { sportlots: ["sl-blue"] } }]);

    fireEvent.click(screen.getByLabelText(`Remove ${BSC_BLUE.value} from Blue`));

    expect(screen.getByText("1 ready, 1 pending")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Make its own set: ${BSC_BLUE.value}` }),
    ).toBeTruthy();
  });

  test("the reverse: a restored row holding the BSC id takes the free SL half", async () => {
    const { onConfirm } = renderRestored([
      { value: "Blue", platformData: { bsc: ["bsc-blue"] } },
    ]);

    expect(screen.getByText("1 ready")).toBeTruthy();
    expect(screen.getByLabelText(`Remove ${SL_BLUE.value} from Blue`)).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items).toHaveLength(1);
    expect(items[0].platformData.bsc).toEqual(["bsc-blue"]);
    expect(items[0].platformData.sportlots).toEqual(["sl-blue"]);
  });

  test("both halves already restored: nothing is duplicated", async () => {
    const { onConfirm } = renderRestored([
      { value: "Blue", platformData: { sportlots: ["sl-blue"] } },
      { value: "Blue Refractor", platformData: { bsc: ["bsc-blue"] } },
    ]);

    expect(screen.getByText("2 ready")).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 2 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items).toHaveLength(2);
    const blue = items.find((i) => i.value === "Blue")!;
    const refractor = items.find((i) => i.value === "Blue Refractor")!;
    // Each row keeps exactly what it had — no cross-attach, no third set.
    expect(blue.platformData.sportlots).toEqual(["sl-blue"]);
    expect(blue.platformData.bsc).toBeUndefined();
    expect(refractor.platformData.bsc).toEqual(["bsc-blue"]);
    expect(refractor.platformData.sportlots).toBeUndefined();
  });

  test("a free half held elsewhere is not attached, and stays out", async () => {
    const { onConfirm } = renderRestored(
      [{ value: "Blue", platformData: { sportlots: ["sl-blue"] } }],
      {
        heldElsewhere: {
          rows: [
            {
              key: "par-blue",
              name: "Blue Refractor",
              parentName: "Chrome",
              bsc: ["bsc-blue"],
              sportlots: [],
            },
          ],
          summary: "1 already grouped as parallels. Leaving those be.",
          toggleLabel: "Show grouped",
        },
      },
    );

    expect(screen.getByText("1 ready")).toBeTruthy();
    expect(screen.getByText(/Pending \(0\)/)).toBeTruthy();
    expect(
      screen.queryByLabelText(`Remove ${BSC_BLUE.value} from Blue`),
    ).toBeNull();

    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items[0].platformData.sportlots).toEqual(["sl-blue"]);
    expect(items[0].platformData.bsc).toBeUndefined();
  });

  test("two restored rows share the SL id: no single row to join, so Pending", async () => {
    const { onConfirm } = renderRestored([
      { value: "Blue", platformData: { sportlots: ["sl-blue"] } },
      { value: "Blue Wave", platformData: { sportlots: ["sl-blue"] } },
    ]);

    expect(screen.getByText("2 ready, 1 pending")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Make its own set: ${BSC_BLUE.value}` }),
    ).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 2 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items.every((i) => i.platformData.bsc === undefined)).toBe(true);
  });

  test("a half an earlier AUTO-MATCH placed is not joined: the free half goes to Pending", () => {
    // Two BSC sets the reconciler both paired with one SL set. The second
    // guess is not merged into the first guess's set.
    const BSC_BLUE_WAVE: PlatformItem = { value: "Blue Wave", platformValue: "bsc-wave" };
    renderRestored([], {}, [
      BLUE_PAIR,
      { displayName: "Blue Wave", bsc: BSC_BLUE_WAVE, sl: SL_BLUE, confidence: 0.7 },
    ]);

    expect(screen.getByText("1 ready, 1 pending")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Make its own set: ${BSC_BLUE_WAVE.value}` }),
    ).toBeTruthy();
  });

  test("a free half the caller says another level uses is not attached", async () => {
    const { onConfirm } = renderRestored(
      [{ value: "Blue", platformData: { sportlots: ["sl-blue"] } }],
      { usedBscPlatformValues: ["bsc-blue"] },
    );

    expect(
      screen.queryByLabelText(`Remove ${BSC_BLUE.value} from Blue`),
    ).toBeNull();
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items[0].platformData.bsc).toBeUndefined();
  });

  test("regression: an auto-match colliding with nothing is still its own Ready set", async () => {
    const { onConfirm } = renderRestored([
      { value: "Gold", platformData: { bsc: ["bsc-gold"], sportlots: ["sl-gold"] } },
    ]);

    expect(screen.getByText("2 ready")).toBeTruthy();
    expect(screen.getByText(/90%/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Save 2 sets/));
    const items = await itemsFromConfirm(onConfirm);
    expect(items).toHaveLength(2);
    const gold = items.find((i) => i.value === "Gold")!;
    const blue = items.find((i) => i.value === "Blue Refractor")!;
    expect(gold.platformData.bsc).toEqual(["bsc-gold"]);
    expect(gold.platformData.sportlots).toEqual(["sl-gold"]);
    expect(blue.platformData.bsc).toEqual(["bsc-blue"]);
    expect(blue.platformData.sportlots).toEqual(["sl-blue"]);
  });
});
