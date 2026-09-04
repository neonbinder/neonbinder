/**
 * CardDetailPanel — adversarial pass on top of CardDetailPanel.test.tsx
 * (NEO-216/217, 2026-09-04).
 *
 * `CardDetailPanel.test.tsx` already locks in the primary NEO-36 race (typed
 * text survives an external patch while focused, the picker shows the new
 * team, the commit sends the typed value) and the basic printRun/attribute
 * chip contracts. This file goes after what that pass does not reach:
 *
 *   1. The INVERSE race: a commit already IN FLIGHT (busy, promise
 *      unresolved) when an external patch lands — the field must not be
 *      reset mid-save, and must mirror correctly once the save resolves and
 *      the live row catches up.
 *   2. Escape while a commit is in flight: the drawer closes immediately
 *      (nothing left to discard) but the mutation itself is left to land —
 *      it is not, and cannot be, aborted.
 *   3. A rejected attribute-chip write: there is no optimistic chip state to
 *      "revert" (the chips render straight from `card.attributes`), so the
 *      real contract is "the error shows, the chip never visually flips, and
 *      a retry after the error still works".
 *   4. Removing the LAST team sends an explicit `teamOnCardIds: []` — the
 *      shared TeamPicker stub in the sibling file has no "clear" affordance,
 *      so this file defines its own.
 *   5. Print run boundary strings a person or a paste could produce
 *      ("099", " 99 ", "1e2", "99.0", "-0", a very large value) — pinning
 *      exactly what gets sent (or refused) at the CLIENT layer, to be read
 *      alongside the server-side pins in
 *      convex/updateCardChecklistFields.test.ts's "boundary values" block so
 *      the two layers can't silently disagree.
 *   6. Committing the SAME value twice, with the live row caught up in
 *      between (simulating the server echo a real reactive query would
 *      deliver) — the second commit must be a no-op.
 *
 * Mocking strategy matches CardDetailPanel.test.tsx exactly (module-mocked
 * `convex/react`, string-keyed mutation refs) — duplicated here rather than
 * shared because vi.mock factories are hoisted per-file and cannot be
 * imported across test files.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      updateCard: "updateCard",
      setCardFeature: "setCardFeature",
      setCardVariationParent: "setCardVariationParent",
      getCardChecklist: "getCardChecklist",
    },
  },
}));

const mockUpdateCard = vi.fn();
const mockSetCardFeature = vi.fn();
const mockSetVariationParent = vi.fn();
const mockSiblingCards: Array<{ _id: string; cardNumber: string; cardName: string }> = [];

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

// A richer TeamPicker stub than the sibling file's — this one can drive the
// array down to empty, which is exactly the case under test in §4.
vi.mock("./TeamPicker", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
  }) => (
    <div aria-label="Team picker (stub)">
      <span>Teams: {value.join(",") || "(none)"}</span>
      <button onClick={() => onChange([...value, "team-new"])}>
        Stub add team
      </button>
      <button onClick={() => onChange([])}>Stub clear all teams</button>
    </div>
  ),
}));

vi.mock("./PlayerPicker", () => ({
  default: ({
    value,
  }: {
    value: string[];
  }) => <div aria-label="Player picker (stub)">Players: {value.join(",")}</div>,
}));

import CardDetailPanel from "./CardDetailPanel";
import type { Id } from "../../convex/_generated/dataModel";

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

function makeCard(overrides: Partial<Parameters<typeof CardDetailPanel>[0]["card"]> = {}) {
  return {
    _id: CARD_ID,
    selectorOptionId: "vt-1" as unknown as Id<"selectorOptions">,
    cardNumber: "42",
    cardName: "Mike Trout",
    playerIds: [] as unknown as Array<Id<"players">>,
    teamOnCardIds: [] as unknown as Array<Id<"teams">>,
    attributes: [],
    platformData: {},
    features: {},
    ...overrides,
  };
}

const baseProps = () => ({
  ancestorSport: "Baseball",
  onClose: vi.fn(),
  onPrev: vi.fn(),
  onNext: vi.fn(),
  hasPrev: false,
  hasNext: false,
});

function focusField(el: HTMLElement): void {
  el.focus();
  fireEvent.focus(el);
}
function blurField(el: HTMLElement): void {
  el.blur();
  fireEvent.blur(el);
}
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  fireEvent.change(el, { target: { value: text } });
}
const nameInput = () => screen.getByLabelText("Card name") as HTMLInputElement;
const printRunInput = () => screen.getByLabelText("Print run") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCard.mockResolvedValue(undefined);
  mockSetCardFeature.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The INVERSE race — an external patch lands WHILE a commit is in flight.
// ---------------------------------------------------------------------------

describe("CardDetailPanel — commit-in-flight vs external patch (adversarial)", () => {
  it("keeps the committed value on screen while the save is in flight, then mirrors correctly once the live row catches up", async () => {
    let resolveUpdate!: () => void;
    mockUpdateCard.mockImplementation(
      () => new Promise<void>((resolve) => (resolveUpdate = resolve)),
    );
    const props = baseProps();
    const { rerender } = render(
      <CardDetailPanel card={makeCard({ cardName: "Mike Trout" })} {...props} />,
    );

    await act(async () => {
      focusField(nameInput());
      typeInto(nameInput(), "Shohei Ohtani");
      blurField(nameInput()); // commit fires, mockUpdateCard's promise is pending
    });

    // The commit is in flight — field is read-only and busy is announced.
    expect(nameInput().readOnly).toBe(true);
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);

    // An UNRELATED external patch (the BSC queue filling in a team) lands
    // while the name commit is still pending. Because the field is neither
    // focused NOR idle (it's busy), the mirror effect must bail regardless of
    // whether cardName itself changed in this push.
    await act(async () => {
      rerender(
        <CardDetailPanel
          card={makeCard({
            cardName: "Mike Trout", // stale — server hasn't echoed the commit yet
            teamOnCardIds: ["team-from-sync"] as unknown as Array<Id<"teams">>,
          })}
          {...props}
        />,
      );
    });
    expect(nameInput().value).toBe("Shohei Ohtani");
    expect(screen.getByText("Teams: team-from-sync")).toBeTruthy();

    // The save resolves.
    await act(async () => {
      resolveUpdate();
    });
    await waitFor(() => expect(nameInput().readOnly).toBe(false));
    // Nothing pushed cardName during the busy window, so it's still exactly
    // what the operator typed and committed.
    expect(nameInput().value).toBe("Shohei Ohtani");

    // NOW the live row catches up (the server echo the real reactive query
    // would deliver) — the field is idle, so this mirrors normally.
    await act(async () => {
      rerender(
        <CardDetailPanel
          card={makeCard({
            cardName: "Shohei Ohtani",
            teamOnCardIds: ["team-from-sync"] as unknown as Array<Id<"teams">>,
          })}
          {...props}
        />,
      );
    });
    expect(nameInput().value).toBe("Shohei Ohtani");
  });
});

// ---------------------------------------------------------------------------
// 2. Escape while a commit is in flight.
// ---------------------------------------------------------------------------

describe("CardDetailPanel — Escape while a commit is in flight", () => {
  it("closes immediately, and the in-flight mutation is left to land rather than aborted", async () => {
    let resolveUpdate!: () => void;
    mockUpdateCard.mockImplementation(
      () => new Promise<void>((resolve) => (resolveUpdate = resolve)),
    );
    const props = baseProps();
    render(<CardDetailPanel card={makeCard({ cardName: "Mike Trout" })} {...props} />);

    await act(async () => {
      focusField(nameInput());
      typeInto(nameInput(), "Shohei Ohtani");
      blurField(nameInput());
    });
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    // The mutation is still allowed to resolve after close — no throw, no
    // second onClose call triggered by the resolution.
    await act(async () => {
      resolveUpdate();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Attribute chip rejection.
// ---------------------------------------------------------------------------

describe("CardDetailPanel — attribute chip write rejection", () => {
  it("shows the error and leaves the chip exactly as the live row says (there is no optimistic state to revert)", async () => {
    mockUpdateCard.mockRejectedValueOnce(
      new ConvexError("Could not save attributes right now."),
    );
    render(
      <CardDetailPanel card={makeCard({ attributes: [] })} {...baseProps()} />,
    );

    const rcChip = screen.getByLabelText("Toggle RC");
    await act(async () => {
      fireEvent.click(rcChip);
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not save attributes right now.");
    // Nothing ever set the chip to "pressed" — chips render straight off
    // `card.attributes`, which the rejected write never changed.
    expect(rcChip.getAttribute("aria-pressed")).toBe("false");

    // A retry after the failure must not be wedged by the busy guard.
    mockUpdateCard.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(rcChip);
    });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(2));
    expect(mockUpdateCard).toHaveBeenLastCalledWith({
      id: CARD_ID,
      attributes: ["RC"],
      isRookie: true,
      isRelic: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Removing the last team.
// ---------------------------------------------------------------------------

describe("CardDetailPanel — removing the last team", () => {
  it("sends an explicit teamOnCardIds: []", async () => {
    render(
      <CardDetailPanel
        card={makeCard({ teamOnCardIds: ["team-a"] as unknown as Array<Id<"teams">> })}
        {...baseProps()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Stub clear all teams"));
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      teamOnCardIds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Print run boundary strings.
// ---------------------------------------------------------------------------

describe("CardDetailPanel — print run boundary values", () => {
  it.each([
    ["099", 99],
    [" 99 ", 99], // the hook trims before Number() ever sees it
    ["1e2", 100], // <input type=number> accepts exponent notation
    ["99.0", 99], // Number.isInteger(99) is true; the ".0" is silently dropped
  ])("accepts %p and sends printRun: %p", async (typed, expected) => {
    render(<CardDetailPanel card={makeCard()} {...baseProps()} />);

    await act(async () => {
      focusField(printRunInput());
      typeInto(printRunInput(), typed);
      blurField(printRunInput());
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({ id: CARD_ID, printRun: expected });
  });

  it("refuses '-0' client-side, matching the server's own rejection of it", async () => {
    render(<CardDetailPanel card={makeCard()} {...baseProps()} />);

    await act(async () => {
      focusField(printRunInput());
      typeInto(printRunInput(), "-0");
      blurField(printRunInput());
    });

    const alert = await screen.findByRole("alert");
    // Updated alongside CardDetailPanel.tsx's PRINT_RUN_MESSAGE, which now
    // states the 1,000,000 ceiling added concurrently with this pass (see the
    // "very large print run" tests below).
    expect(alert.textContent).toBe(
      "Print run must be a whole number between 1 and 1,000,000.",
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("a very large print run is refused client-side, matching the server's 1,000,000 ceiling", async () => {
    // This used to be the "no upper bound at either layer" finding from this
    // same adversarial pass — both CardDetailPanel.tsx's PRINT_RUN_MAX and
    // updateCard's server-side bound were added concurrently (see
    // convex/updateCardChecklistFields.test.ts's "boundary values" +
    // "accepts exactly 1,000,000" / "rejects 1,000,001" tests), closing the
    // gap. Re-pinned as a refusal so the two layers can't silently diverge.
    render(<CardDetailPanel card={makeCard()} {...baseProps()} />);
    const huge = "999999999999999999999"; // parses to 1e21, Number.isInteger → true

    await act(async () => {
      focusField(printRunInput());
      typeInto(printRunInput(), huge);
      blurField(printRunInput());
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Print run must be a whole number between 1 and 1,000,000.",
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("accepts exactly the 1,000,000 ceiling and refuses one past it — client-side inclusive-bound pin", async () => {
    const props = baseProps();
    const { rerender } = render(<CardDetailPanel card={makeCard()} {...props} />);

    await act(async () => {
      focusField(printRunInput());
      typeInto(printRunInput(), "1000000");
      blurField(printRunInput());
    });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      printRun: 1_000_000,
    });

    // Live row catches up, then try one past the bound.
    await act(async () => {
      rerender(
        <CardDetailPanel card={makeCard({ printRun: 1_000_000 })} {...props} />,
      );
    });
    await act(async () => {
      focusField(printRunInput());
      typeInto(printRunInput(), "1000001");
      blurField(printRunInput());
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Print run must be a whole number between 1 and 1,000,000.",
    );
    // Still just the one call from the accepted 1,000,000 commit.
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);
  });

  it("committing the same print run twice, with the live row caught up in between, sends only once", async () => {
    const props = baseProps();
    const { rerender } = render(<CardDetailPanel card={makeCard()} {...props} />);

    await act(async () => {
      focusField(printRunInput());
      typeInto(printRunInput(), "99");
      blurField(printRunInput());
    });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({ id: CARD_ID, printRun: 99 });

    // The live row catches up (server echo) — the field is idle, so it
    // mirrors, and its compareBaseline is now "99".
    await act(async () => {
      rerender(<CardDetailPanel card={makeCard({ printRun: 99 })} {...props} />);
    });
    expect(printRunInput().value).toBe("99");

    // Re-focus and blur without changing anything — a genuine no-op commit.
    await act(async () => {
      focusField(printRunInput());
      blurField(printRunInput());
    });
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);
  });
});
