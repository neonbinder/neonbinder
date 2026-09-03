/**
 * NEO-71-74 regression coverage — CardDetailPanel.
 *
 * This session:
 *   - Removed the old free-text "Autograph" input (bound to local
 *     `autographType` state, saved via `updateCard`).
 *   - Replaced it with an always-visible "Autographed" control using the
 *     shared `CardFeatureRow` (exported from CardFeaturesEditor.tsx) bound
 *     to `card.features?.autographed`, saved immediately via
 *     `setCardFeature({ cardChecklistId, key: "autographed", value })` —
 *     NOT part of this panel's dirty/Save cycle. Later (NEO-71-74) the
 *     control itself changed from a `<select>` dropdown to two mutually
 *     exclusive toggle pills ("Auto (On Card)"/"Auto (Sticker)" — the "Auto"
 *     prefix was added so the pills read unambiguously in the shared toggle
 *     row) — same `setCardFeature` wiring, same stored values ("On Card"/
 *     "Sticker/Label"), just a different control. `CardFeatureRow`'s
 *     checkbox-branch condition only
 *     checks `inputType === "checkbox"` (not "toggleOptions"), so Autographed
 *     still falls through to the same labeled-box "default" branch as
 *     before — the "Autographed" label above the control is unchanged, only
 *     the control is now 2 pills instead of a dropdown.
 *   - Replaced the read-only "Players" section with a full
 *     `<PlayerPicker value={playerIds} onChange={setPlayerIds} .../>`, with
 *     `playerIds` now part of this panel's dirty-tracking and `handleSave`'s
 *     `updateCard(...)` payload.
 *   - Renamed the "Variation / parallel" label to just "Variation".
 *
 * This file locks in:
 *   1. The Autographed control renders as two toggle pills ("Auto (On Card)" /
 *      "Auto (Sticker)"), NOT a <select> or a text input, and clicking a pill
 *      calls setCardFeature — never updateCard — and does NOT mark the
 *      panel dirty (the Save button stays enabled/disabled independent of
 *      it, and no discard-confirm appears on close after changing it).
 *   2. The Players picker renders with the card's playerIds; adding/removing
 *      a player marks the panel dirty; Save calls updateCard with the
 *      updated playerIds array.
 *   3. The Variation field's label reads "Variation" (not "Variation /
 *      parallel").
 *
 * --- Mocking strategy ---
 * convex/react's useMutation is module-mocked, routed by the (string-mocked)
 * mutation reference (mirrors CardFeaturesEditor.test.tsx / BaseMappingForm
 * .test.tsx). `./TeamPicker` and `./PlayerPicker` are mocked to simple stub
 * components — both already have their own dedicated test files
 * (TeamPicker.test.tsx, PlayerPicker.test.tsx) covering their internal
 * query/typeahead behavior, so this file only needs to verify CardDetailPanel
 * wires their value/onChange correctly into its own dirty-tracking and Save
 * payload, not re-exercise their popovers.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      updateCard: "updateCard",
      setCardFeature: "setCardFeature",
      // NEO-189: the "Variation of" control's mutation + the sibling lookup it
      // resolves a typed card number against.
      setCardVariationParent: "setCardVariationParent",
      getCardChecklist: "getCardChecklist",
    },
  },
}));

const mockUpdateCard = vi.fn();
const mockSetCardFeature = vi.fn();
const mockSetVariationParent = vi.fn();
// The checklist the panel resolves a typed card number against.
const mockSiblingCards = [
  { _id: "card-1", cardNumber: "1", cardName: "Fernando Tatis Jr." },
  { _id: "card-2", cardNumber: "2", cardName: "Roberto Osuna" },
];

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "updateCard") return mockUpdateCard;
    if (ref === "setCardFeature") return mockSetCardFeature;
    if (ref === "setCardVariationParent") return mockSetVariationParent;
    return vi.fn();
  },
  useQuery: (ref: string) =>
    ref === "getCardChecklist" ? mockSiblingCards : undefined,
}));

vi.mock("./TeamPicker", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
  }) => (
    <div aria-label="Team picker (stub)">
      <span>Teams: {value.join(",")}</span>
      <button onClick={() => onChange([...value, "team-new"])}>
        Stub add team
      </button>
    </div>
  ),
}));

vi.mock("./PlayerPicker", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
  }) => (
    <div aria-label="Player picker (stub)">
      <span>Players: {value.join(",")}</span>
      <button onClick={() => onChange([...value, "player-new"])}>
        Stub add player
      </button>
      <button onClick={() => onChange(value.slice(0, -1))}>
        Stub remove last player
      </button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import CardDetailPanel from "./CardDetailPanel";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

function makeCard(overrides: Partial<Parameters<typeof CardDetailPanel>[0]["card"]> = {}) {
  return {
    _id: CARD_ID,
    selectorOptionId: "vt-1" as unknown as Id<"selectorOptions">,
    cardNumber: "42",
    cardName: "Mike Trout",
    playerIds: ["player-1"] as unknown as Array<Id<"players">>,
    teamOnCardIds: [] as unknown as Array<Id<"teams">>,
    attributes: [],
    platformData: {},
    features: {},
    ...overrides,
  };
}

function renderPanel(
  props: Partial<Parameters<typeof CardDetailPanel>[0]> = {},
) {
  const onClose = vi.fn();
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const utils = render(
    <CardDetailPanel
      card={makeCard()}
      ancestorSport="Baseball"
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      hasPrev={false}
      hasNext={false}
      {...props}
    />,
  );
  return { ...utils, onClose, onPrev, onNext };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CardDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateCard.mockResolvedValue(undefined);
    mockSetCardFeature.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Autographed control: toggle pills, not a <select>; setCardFeature;
  // excluded from dirty-tracking.
  // -------------------------------------------------------------------------

  it("renders the Autographed control as toggle pills, not a <select>", () => {
    renderPanel({ card: makeCard({ features: { autographed: "On Card" } }) });

    // No <select> anymore — the base "Value for Autographed" aria-label is
    // no longer unique on its own (it's now a prefix shared by both pills:
    // "Value for Autographed: Auto (On Card)" / "Value for Autographed: Auto (Sticker)").
    expect(screen.queryByRole("combobox")).toBeNull();

    const onCardPill = screen.getByLabelText(
      "Value for Autographed: Auto (On Card)",
    );
    const stickerPill = screen.getByLabelText(
      "Value for Autographed: Auto (Sticker)",
    );
    expect(onCardPill.tagName).toBe("BUTTON");
    expect(stickerPill.tagName).toBe("BUTTON");
    expect(onCardPill.getAttribute("aria-pressed")).toBe("true");
    expect(stickerPill.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking the 'Auto (On Card)' pill calls setCardFeature (not updateCard) with the card id, key, and new value", async () => {
    renderPanel({ card: makeCard({ features: { autographed: "None" } }) });

    const onCardPill = screen.getByLabelText(
      "Value for Autographed: Auto (On Card)",
    );
    await act(async () => {
      fireEvent.click(onCardPill);
    });

    await waitFor(() => {
      expect(mockSetCardFeature).toHaveBeenCalledWith({
        cardChecklistId: CARD_ID,
        key: "autographed",
        value: "On Card",
      });
    });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("clicking the 'Auto (Sticker)' pill calls setCardFeature with the stored value 'Sticker/Label' (the display label differs, the stored value doesn't)", async () => {
    renderPanel({ card: makeCard({ features: { autographed: "None" } }) });

    const stickerPill = screen.getByLabelText(
      "Value for Autographed: Auto (Sticker)",
    );
    await act(async () => {
      fireEvent.click(stickerPill);
    });

    await waitFor(() => {
      expect(mockSetCardFeature).toHaveBeenCalledWith({
        cardChecklistId: CARD_ID,
        key: "autographed",
        value: "Sticker/Label",
      });
    });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("changing Autographed does NOT mark the panel dirty — the dirty-guarded close exits immediately, no discard-confirm", async () => {
    const { onClose } = renderPanel({
      card: makeCard({ features: { autographed: "None" } }),
    });

    const onCardPill = screen.getByLabelText(
      "Value for Autographed: Auto (On Card)",
    );
    await act(async () => {
      fireEvent.click(onCardPill);
    });
    await waitFor(() => {
      expect(mockSetCardFeature).toHaveBeenCalled();
    });

    // Use the header "×" close button, which routes through the dirty-guard
    // (`requestExit`) — unlike the footer "Cancel" button, which calls
    // `onClose` unconditionally regardless of dirty state. Only the
    // dirty-guarded path can actually prove autographed edits aren't
    // tracked in this panel's dirty state (they persist immediately,
    // independent of Save).
    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Players picker: renders with playerIds; dirty-tracking; Save payload.
  // -------------------------------------------------------------------------

  it("renders the Players picker seeded with the card's playerIds", () => {
    renderPanel({
      card: makeCard({ playerIds: ["player-1", "player-2"] as unknown as Array<Id<"players">> }),
    });

    expect(screen.getByText("Players: player-1,player-2")).toBeTruthy();
  });

  it("adding a player via the picker marks the panel dirty (dirty-guarded close now shows the discard-confirm bar)", () => {
    renderPanel({ card: makeCard({ playerIds: ["player-1"] as unknown as Array<Id<"players">> }) });

    fireEvent.click(screen.getByText("Stub add player"));
    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
  });

  it("removing a player via the picker marks the panel dirty", () => {
    renderPanel({
      card: makeCard({ playerIds: ["player-1", "player-2"] as unknown as Array<Id<"players">> }),
    });

    fireEvent.click(screen.getByText("Stub remove last player"));
    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
  });

  it("Save calls updateCard with the updated playerIds array", async () => {
    const { onClose } = renderPanel({
      card: makeCard({ playerIds: ["player-1"] as unknown as Array<Id<"players">> }),
    });

    fireEvent.click(screen.getByText("Stub add player"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Save card edit"));
    });

    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith(
        expect.objectContaining({
          id: CARD_ID,
          playerIds: ["player-1", "player-new"],
        }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("not touching the Players picker leaves the panel non-dirty (dirty-guarded close exits with no discard-confirm)", () => {
    const { onClose } = renderPanel();

    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Variation label (cosmetic rename from "Variation / parallel")
  // -------------------------------------------------------------------------

  it("labels the variation field 'Variation' (not 'Variation / parallel')", () => {
    renderPanel();

    expect(screen.getByText("Variation")).toBeTruthy();
    expect(screen.queryByText("Variation / parallel")).toBeNull();
    expect(screen.queryByText(/variation\s*\/\s*parallel/i)).toBeNull();
  });
});


/**
 * NEO-189 — the escape hatch for a variation the import could not derive, and
 * the only way a custom set gets variations at all.
 */
describe("CardDetailPanel — Variation of", () => {
  // The suite's other clearAllMocks lives inside the first describe block, so
  // this one needs its own or calls leak between tests.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a typed card number to a sibling and links it", async () => {
    renderPanel({ card: makeCard() });
    const input = screen.getByLabelText(
      "Card number this one is a variation of",
    );
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(mockSetVariationParent).toHaveBeenCalledWith(
        expect.objectContaining({ parentCardId: "card-1" }),
      ),
    );
  });

  it("reports a number that matches nothing rather than doing nothing", async () => {
    // A typo that silently no-ops is worse than one that says so.
    renderPanel({ card: makeCard() });
    const input = screen.getByLabelText(
      "Card number this one is a variation of",
    );
    fireEvent.change(input, { target: { value: "99999" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/No card #99999/),
    );
    expect(mockSetVariationParent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEO-208 — unresolved typed team names, read-only above the picker
//
// `pendingTeamNames` rendered nowhere in this drawer before this ticket: an
// operator opening a card whose team they had typed saw an empty Teams picker
// and no explanation.
//
// It sits ABOVE the picker rather than inside it because a `TeamPicker` chip is
// a real `teams._id` the rest of the product can act on; putting a bare string
// among them would be claiming a link that does not exist. And it is not part
// of the panel's draft state: the server retires it, derived from a real team
// write (`updateCard` clears it in the same patch as a non-empty
// `teamOnCardIds`), so there is nothing here to edit or delete by hand.
// ---------------------------------------------------------------------------

describe("CardDetailPanel — NEO-208 pending team names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateCard.mockResolvedValue(undefined);
    mockSetCardFeature.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows each unresolved name, marked", () => {
    renderPanel({
      card: makeCard({ pendingTeamNames: ["Savannah Bananas", "Yankees"] }),
    });

    expect(screen.getByText("Savannah Bananas")).toBeTruthy();
    expect(screen.getByText("Yankees")).toBeTruthy();
    expect(screen.getAllByText("(unconfirmed)")).toHaveLength(2);
  });

  it("says what will happen to the name — the two ways it resolves", () => {
    renderPanel({ card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }) });

    expect(
      screen.getByText(
        /resolves at the next sync, or pick a team to replace it/,
      ),
    ).toBeTruthy();
  });

  it("renders the names as TEXT — never an anchor or a button", () => {
    // There is no action to offer, so there is no control. Offering one would
    // imply a delete/edit path that does not exist server-side.
    renderPanel({ card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }) });
    const node = screen.getByText("Savannah Bananas");
    expect(node.closest("a")).toBeNull();
    expect(node.closest("button")).toBeNull();
  });

  it("renders them ABOVE the picker, not among its chips", () => {
    const { container } = renderPanel({
      card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }),
    });

    const pending = screen.getByText("Savannah Bananas");
    const picker = screen.getByLabelText("Team picker (stub)");
    // Document order: the read-only list precedes the picker.
    expect(
      pending.compareDocumentPosition(picker) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And it is genuinely outside the picker's subtree.
    expect(picker.contains(pending)).toBe(false);
    expect(container).toBeTruthy();
  });

  it("does not mark the panel dirty — it is not draft state", () => {
    // Nothing about a pending name is editable here, so merely opening a card
    // that has one must not arm the discard bar. Closing goes straight
    // through, exactly as it does on a card with no pending names.
    const { onClose } = renderPanel({
      card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }),
    });

    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("never sends pendingTeamNames back through updateCard", async () => {
    // The clear is DERIVED server-side from the team write. A client that sent
    // the field would be fabricating "the operator typed this", and the
    // mutation's validator rejects it outright.
    renderPanel({ card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }) });

    await act(async () => {
      fireEvent.click(screen.getByText("Stub add team"));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Save card edit"));
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard.mock.calls[0][0]).not.toHaveProperty(
      "pendingTeamNames",
    );
    // And the team write that retires it server-side did go out.
    expect(mockUpdateCard.mock.calls[0][0].teamOnCardIds).toEqual(["team-new"]);
  });

  it("shows nothing when there are no pending names", () => {
    renderPanel({ card: makeCard() });
    expect(screen.queryByText("(unconfirmed)")).toBeNull();
    expect(screen.queryByText(/resolves at the next sync/)).toBeNull();
  });

  it("renders duplicate pending names without a React key warning", () => {
    // `pendingTeamNames` is not deduplicated, and rows written before NEO-208
    // can carry the same typed name twice. The list was keyed on the name
    // itself, so React saw duplicate sibling keys — a dev-mode warning, and
    // mis-reconciliation of the second entry. The key is index-qualified now.
    //
    // Non-throwing spy deliberately: a spy that throws on console output turns
    // a warning into a worker-level failure in the shared fork pool.
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });

    try {
      renderPanel({
        card: makeCard({ pendingTeamNames: ["Yankees", "Yankees"] }),
      });

      expect(screen.getAllByText("Yankees")).toHaveLength(2);
      expect(screen.getAllByText("(unconfirmed)")).toHaveLength(2);
      expect(errors.filter((e) => e.includes("same key"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
