/**
 * CardDetailPanel — regression coverage.
 *
 * ## NEO-216 (2026-09-04): the drawer autosaves per field
 *
 * The panel used to seed a draft from the `card` prop and write the whole
 * draft back on Save. `card` is a row out of the LIVE `getCardChecklist`
 * query, so a full-replacement Save could (and did) overwrite fields the
 * server had patched underneath the draft — a `teamOnCardIds: []` sent a
 * moment after the BSC team queue filled it in was permanent, because that
 * queue never re-enqueues a card it has stamped.
 *
 * There is now no Save button, no draft, no `dirty`, and no discard bar. Each
 * control writes only its own field, immediately. What this file locks in:
 *
 *   1. No Save button is rendered, and closing never offers to discard.
 *   2. Editing the name and blurring calls `updateCard({ id, cardName })` —
 *      and NOTHING else. An untouched field never appears in a payload.
 *   3. **NEO-36 pin**: an external patch arriving while the name field is
 *      focused with typed text neither loses nor resets that text, the picker
 *      shows the newly-arrived team, and the commit sends the typed value.
 *   4. The attribute chips write `attributes` + the two derived booleans, and
 *      RC drives `isRookie` in BOTH directions (NEO-217 C — the old
 *      `|| card.isRookie` made RC a one-way switch).
 *   5. Print run: "99" → `printRun: 99`; cleared → `printRun: null`
 *      (NEO-217 B); a non-integer is refused inline and sends nothing.
 *   6. A rejected commit shows an inline error and keeps the typed value.
 *   7. Teams / players write their own array on change and read the live row.
 *
 * ## Still locked in from NEO-71-74
 *
 *   - The Autographed control renders as two toggle pills ("Auto (On Card)" /
 *     "Auto (Sticker)"), NOT a <select> or text input, and clicking a pill
 *     calls `setCardFeature` — never `updateCard`.
 *   - The Players picker renders with the card's playerIds.
 *   - The Variation field's label reads "Variation" (not "Variation /
 *     parallel").
 *
 * --- Mocking strategy ---
 * convex/react's useMutation is module-mocked, routed by the (string-mocked)
 * mutation reference (mirrors CardFeaturesEditor.test.tsx / BaseMappingForm
 * .test.tsx). `./TeamPicker` and `./PlayerPicker` are mocked to simple stub
 * components — both already have their own dedicated test files
 * (TeamPicker.test.tsx, PlayerPicker.test.tsx) covering their internal
 * query/typeahead behavior, so this file only needs to verify CardDetailPanel
 * wires their value/onChange into the right single-field write, not
 * re-exercise their popovers.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
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

/**
 * Focus a reactive field the way a person does.
 *
 * BOTH the real `.focus()` and the synthetic React event are required:
 * `useReactiveField` guards its mirroring effect on `document.activeElement`
 * (only the real call sets that) and guards the commit no-op on its own
 * `focusedRef` (only the synthetic event sets that). See
 * components/forms/useReactiveField.test.tsx.
 */
function focusField(el: HTMLElement): void {
  el.focus();
  fireEvent.focus(el);
}

function blurField(el: HTMLElement): void {
  el.blur();
  fireEvent.blur(el);
}

/**
 * Type into an UNCONTROLLED field.
 *
 * `fireEvent.change`, not a direct `el.value =` assignment: React keeps a
 * tracker of the last value it saw on the node, and assigning the property
 * updates that tracker, so the event that follows looks like a no-change and
 * React skips `onChange` — which some of these fields use to drive their live
 * character counter. `fireEvent.change` sets the value through the native
 * setter, which is the path the tracker does not swallow.
 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  fireEvent.change(el, { target: { value: text } });
}

/** Focus → type → blur, which is what commits a reactive field. */
async function editAndCommit(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): Promise<void> {
  await act(async () => {
    focusField(el);
    typeInto(el, text);
    blurField(el);
  });
}

const nameInput = () => screen.getByLabelText("Card name") as HTMLInputElement;
const printRunInput = () =>
  screen.getByLabelText("Print run") as HTMLInputElement;

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
  // Autographed control: toggle pills, not a <select>; setCardFeature.
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

  it("changing Autographed leaves the drawer closable with no discard prompt", async () => {
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

    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Players picker: renders from the live row; writes only playerIds.
  // -------------------------------------------------------------------------

  it("renders the Players picker seeded with the card's playerIds", () => {
    renderPanel({
      card: makeCard({ playerIds: ["player-1", "player-2"] as unknown as Array<Id<"players">> }),
    });

    expect(screen.getByText("Players: player-1,player-2")).toBeTruthy();
  });

  it("adding a player writes playerIds immediately — and nothing else", async () => {
    renderPanel({ card: makeCard({ playerIds: ["player-1"] as unknown as Array<Id<"players">> }) });

    await act(async () => {
      fireEvent.click(screen.getByText("Stub add player"));
    });

    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: CARD_ID,
        playerIds: ["player-1", "player-new"],
      });
    });
  });

  it("removing a player writes the shortened playerIds array", async () => {
    renderPanel({
      card: makeCard({ playerIds: ["player-1", "player-2"] as unknown as Array<Id<"players">> }),
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Stub remove last player"));
    });

    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: CARD_ID,
        playerIds: ["player-1"],
      });
    });
  });

  it("touching nothing writes nothing, and closing exits straight away", () => {
    const { onClose } = renderPanel();

    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(mockUpdateCard).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// NEO-216 — per-field autosave on the live row
// ---------------------------------------------------------------------------

describe("CardDetailPanel — per-field autosave (NEO-216)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateCard.mockResolvedValue(undefined);
    mockSetCardFeature.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders no Save button and no Cancel button", () => {
    renderPanel();

    expect(screen.queryByLabelText("Save card edit")).toBeNull();
    expect(screen.queryByLabelText("Cancel card edit")).toBeNull();
    // The rule is stated where the button used to be — nobody guesses that a
    // drawer without a Save button has already saved.
    expect(
      screen.getByText("Changes save as you leave each field."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Done editing card")).toBeTruthy();
  });

  it("editing the card name and blurring sends ONLY { id, cardName }", async () => {
    renderPanel({ card: makeCard({ cardName: "Mike Trout" }) });

    await editAndCommit(nameInput(), "Shohei Ohtani");

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      cardName: "Shohei Ohtani",
    });
  });

  it("an untouched field never appears in any payload", async () => {
    // The whole point of the change: a name edit must not carry a
    // `teamOnCardIds` the server filled in a second ago.
    renderPanel({
      card: makeCard({
        cardName: "Mike Trout",
        teamOnCardIds: ["team-a"] as unknown as Array<Id<"teams">>,
        printRun: 99,
        cardVariation: "Gold",
        listingTitle: "a title",
      }),
    });

    await editAndCommit(nameInput(), "Shohei Ohtani");

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    const payload = mockUpdateCard.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["cardName", "id"]);
  });

  it("committing an unchanged value writes nothing at all", async () => {
    renderPanel({ card: makeCard({ cardName: "Mike Trout" }) });

    await act(async () => {
      focusField(nameInput());
      blurField(nameInput());
    });

    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("confirms the save in a status region", async () => {
    renderPanel();

    await editAndCommit(nameInput(), "Shohei Ohtani");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Saved Card name");
  });

  /**
   * NEO-36 pin — the bug class this whole drawer was rebuilt around.
   *
   * A reactive push landing mid-edit must not reset, lose, or cross-wire the
   * text in the field, the picker must show what the server just sent, and the
   * commit must send what the operator typed — not the value the push carried.
   */
  it("keeps typed text when the live row is patched externally, shows the new team, and commits the typed value", async () => {
    const onClose = vi.fn();
    const props = {
      ancestorSport: "Baseball",
      onClose,
      onPrev: vi.fn(),
      onNext: vi.fn(),
      hasPrev: false,
      hasNext: false,
    };
    const { rerender } = render(
      <CardDetailPanel card={makeCard({ cardName: "Mike Trout" })} {...props} />,
    );

    const input = nameInput();
    await act(async () => {
      focusField(input);
      typeInto(input, "Shohei Ohtani");
    });

    // The BSC per-card team queue lands, and the server also renamed the card
    // from another surface. Both arrive as a fresh `card` prop while the
    // operator is still typing.
    await act(async () => {
      rerender(
        <CardDetailPanel
          card={makeCard({
            cardName: "Renamed By Sync",
            teamOnCardIds: ["team-from-sync"] as unknown as Array<Id<"teams">>,
          })}
          {...props}
        />,
      );
    });

    // 1. The typed text survives untouched.
    expect(nameInput().value).toBe("Shohei Ohtani");
    // 2. The picker reads the LIVE row, so the team the queue wrote is visible
    //    while the drawer is open (it used to sit behind a mount-time draft).
    expect(screen.getByText("Teams: team-from-sync")).toBeTruthy();
    // 3. The commit reads the DOM, not the pushed value.
    await act(async () => {
      blurField(nameInput());
    });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      cardName: "Shohei Ohtani",
    });
    // And it carried no teamOnCardIds to overwrite the queue's write with.
    expect(mockUpdateCard.mock.calls[0][0]).not.toHaveProperty("teamOnCardIds");
  });

  it("mirrors an external change into an idle field", async () => {
    const props = {
      ancestorSport: "Baseball",
      onClose: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      hasPrev: false,
      hasNext: false,
    };
    const { rerender } = render(
      <CardDetailPanel card={makeCard({ cardName: "Mike Trout" })} {...props} />,
    );

    // The drawer focuses Card name on mount (each remount is a new card), and
    // a focused field is deliberately NOT mirrored into — so step away first.
    // "Idle" is the state this test is about.
    await act(async () => {
      blurField(nameInput());
    });

    await act(async () => {
      rerender(
        <CardDetailPanel
          card={makeCard({ cardName: "Renamed By Sync" })}
          {...props}
        />,
      );
    });

    expect(nameInput().value).toBe("Renamed By Sync");
  });

  it("the description commits on blur and on Cmd/Ctrl+Enter, but not on a bare Enter", async () => {
    // A bare Enter here is a paragraph break the operator typed. Swallowing it
    // to save would make a multi-line description impossible to write.
    renderPanel({ card: makeCard({ listingDescription: "old copy" }) });

    const description = screen.getByLabelText(
      "Card description",
    ) as HTMLTextAreaElement;

    await act(async () => {
      focusField(description);
      typeInto(description, "line one");
      fireEvent.keyDown(description, { key: "Enter" });
    });
    expect(mockUpdateCard).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(description, { key: "Enter", metaKey: true });
    });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      listingDescription: "line one",
    });

    await act(async () => {
      typeInto(description, "line one\nline two");
      blurField(description);
    });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(2));
    expect(mockUpdateCard).toHaveBeenLastCalledWith({
      id: CARD_ID,
      listingDescription: "line one\nline two",
    });
  });

  it("the card variation writes only cardVariation", async () => {
    renderPanel({ card: makeCard({ cardVariation: "" }) });

    await editAndCommit(
      screen.getByLabelText("Card variation") as HTMLInputElement,
      "Gold Refractor",
    );

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      cardVariation: "Gold Refractor",
    });
  });

  // -------------------------------------------------------------------------
  // Attribute chips (NEO-217 C)
  // -------------------------------------------------------------------------

  it("toggling RC on writes attributes plus both derived booleans", async () => {
    renderPanel({ card: makeCard({ attributes: [] }) });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Toggle RC"));
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      attributes: ["RC"],
      isRookie: true,
      isRelic: false,
    });
  });

  it("toggling RC OFF sets isRookie back to false, even on a card already flagged rookie", async () => {
    // The old `isRookie: attributes.includes("RC") || card.isRookie === true`
    // made RC a one-way switch: unticking it left isRookie true and the
    // generated title kept its "RC" token forever.
    renderPanel({
      card: makeCard({ attributes: ["RC"], isRookie: true }),
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Toggle RC"));
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      attributes: [],
      isRookie: false,
      isRelic: false,
    });
  });

  it("preserves reconciliation tokens it does not render as chips", async () => {
    renderPanel({ card: makeCard({ attributes: ["unmatched-sl"] }) });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Toggle RELIC"));
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      attributes: ["unmatched-sl", "RELIC"],
      isRookie: false,
      isRelic: true,
    });
  });

  it("busy-guards the chip row so a second toggle cannot interleave with the first", async () => {
    // Both toggles would otherwise derive `attributes` from the same
    // pre-toggle array, and the second would silently undo the first.
    let release: (() => void) | undefined;
    mockUpdateCard.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    renderPanel({ card: makeCard({ attributes: [] }) });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Toggle RC"));
    });
    // In words, not only a dimmed pill.
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(
      (screen.getByLabelText("Toggle AU") as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Toggle AU"));
    });
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });
  });

  // -------------------------------------------------------------------------
  // Print run (NEO-217 B)
  // -------------------------------------------------------------------------

  it("saves a typed print run as a number", async () => {
    renderPanel({ card: makeCard() });

    await editAndCommit(printRunInput(), "99");

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      printRun: 99,
    });
  });

  it("clearing the print run sends null — the only spelling of 'not numbered'", async () => {
    renderPanel({ card: makeCard({ printRun: 99 }) });

    await editAndCommit(printRunInput(), "");

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      printRun: null,
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Cleared Print run");
  });

  it("refuses a non-integer print run inline and sends nothing", async () => {
    renderPanel({ card: makeCard() });

    await editAndCommit(printRunInput(), "2.5");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Print run must be a whole number of 1 or more.",
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
    // The rejected value stays put: it is corrected, never retyped.
    expect(printRunInput().value).toBe("2.5");
  });

  it("refuses a print run below 1", async () => {
    renderPanel({ card: makeCard({ printRun: 5 }) });

    await editAndCommit(printRunInput(), "0");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("whole number of 1 or more");
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it("a rejected commit shows an inline error and keeps the typed value", async () => {
    mockUpdateCard.mockRejectedValue(
      new ConvexError("That title is too long for eBay."),
    );
    renderPanel({ card: makeCard({ cardName: "Mike Trout" }) });

    await editAndCommit(nameInput(), "Shohei Ohtani");

    const alert = await screen.findByRole("alert");
    // A ConvexError's `data` is the message the backend chose for a person,
    // so it is shown verbatim rather than replaced by the fallback.
    expect(alert.textContent).toBe("That title is too long for eBay.");
    expect(nameInput().value).toBe("Shohei Ohtani");
    // The field is described by its own error, not merely followed by it.
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("falls back to a plain sentence when the failure carries no user-facing text", async () => {
    // Production redacts a plain Error to "Server Error", and `.message`
    // arrives wrapped in "[CONVEX M(...)] [Request ID: ...]" noise either way.
    mockUpdateCard.mockRejectedValue(new Error("Server Error"));
    renderPanel();

    await editAndCommit(nameInput(), "Shohei Ohtani");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not save that change");
  });

  // -------------------------------------------------------------------------
  // Exits
  // -------------------------------------------------------------------------

  it("Escape closes with no discard bar", () => {
    const { onClose } = renderPanel();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(screen.queryByLabelText("Keep editing")).toBeNull();
    expect(screen.queryByLabelText("Discard changes")).toBeNull();
  });

  it("Escape closes even mid-edit — there is nothing left to discard", async () => {
    const { onClose } = renderPanel();

    await act(async () => {
      focusField(nameInput());
      typeInto(nameInput(), "half a name");
    });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("the Done button closes the drawer", () => {
    const { onClose } = renderPanel();

    fireEvent.click(screen.getByLabelText("Done editing card"));

    expect(onClose).toHaveBeenCalledTimes(1);
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
// among them would be claiming a link that does not exist. And it is never
// edited here: the server retires it, derived from a real team write
// (`updateCard` clears it in the same patch as a non-empty `teamOnCardIds`), so
// there is nothing here to edit or delete by hand.
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

  it("merely opening a card that has one writes nothing", () => {
    const { onClose } = renderPanel({
      card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }),
    });

    fireEvent.click(screen.getByLabelText("Close card detail"));

    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never sends pendingTeamNames back through updateCard", async () => {
    // The clear is DERIVED server-side from the team write. A client that sent
    // the field would be fabricating "the operator typed this", and the
    // mutation's validator rejects it outright.
    renderPanel({ card: makeCard({ pendingTeamNames: ["Savannah Bananas"] }) });

    await act(async () => {
      fireEvent.click(screen.getByText("Stub add team"));
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard.mock.calls[0][0]).not.toHaveProperty(
      "pendingTeamNames",
    );
    // And the team write that retires it server-side did go out, on its own.
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      teamOnCardIds: ["team-new"],
    });
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
