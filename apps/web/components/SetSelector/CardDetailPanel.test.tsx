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
    },
  },
}));

const mockUpdateCard = vi.fn();
const mockSetCardFeature = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "updateCard") return mockUpdateCard;
    if (ref === "setCardFeature") return mockSetCardFeature;
    return vi.fn();
  },
  useQuery: () => undefined,
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
