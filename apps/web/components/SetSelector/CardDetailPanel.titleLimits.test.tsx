/**
 * NEO-101 — the card detail drawer's title length limits.
 *
 * Kept out of `CardDetailPanel.test.tsx` because it needs a `useQuery` mock
 * that answers `previewListingTitle` and, critically, honours `"skip"`: the
 * Regenerate button's whole point is that nothing is fetched until it is
 * pressed, and a mock that returns a preview regardless would make the lazy
 * path untestable while still passing every other assertion here.
 *
 * What this file locks in:
 *   1. Over the 80-character cap the title REFUSES TO COMMIT and says why,
 *      keeping the over-length text in the field so it can be shortened. The
 *      refusal used to belong to a Save button; NEO-216 removed that button
 *      (the drawer autosaves per field on blur/Enter), so the cap is enforced
 *      at commit instead — same constant, same wording, same server backstop.
 *   2. The soft bands are WORDS, not just colours, at 55 and 70. This is the
 *      accessibility requirement, so it is asserted on the text. They are
 *      display truncation, not a rule: a title in either band still saves.
 *   3. Regenerate replaces the field with the server's title, PERSISTS it
 *      through the same single-field path, and shows the facts it was built
 *      from — and asks twice before discarding an edit.
 *   4. A row whose auto-title was cut short says so.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      updateCard: "updateCard",
      setCardFeature: "setCardFeature",
      setCardVariationParent: "setCardVariationParent",
      getCardChecklist: "getCardChecklist",
      previewListingTitle: "previewListingTitle",
    },
  },
}));

const mockUpdateCard = vi.fn();

/** What `previewListingTitle` answers. Reassigned per test. */
let previewResult: unknown;

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "updateCard") return mockUpdateCard;
    return vi.fn();
  },
  useQuery: (ref: string, args: unknown) => {
    if (ref === "getCardChecklist") return [];
    // The lazy contract: `"skip"` until the operator asks for a preview.
    if (ref === "previewListingTitle") {
      return args === "skip" ? undefined : previewResult;
    }
    return undefined;
  },
}));

vi.mock("./TeamPicker", () => ({ default: () => <div>Team picker (stub)</div> }));
vi.mock("./PlayerPicker", () => ({ default: () => <div>Player picker (stub)</div> }));

import CardDetailPanel from "./CardDetailPanel";
import type { Id } from "../../convex/_generated/dataModel";

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

/** A title of exactly `n` characters. */
const titleOfLength = (n: number) => "x".repeat(n);

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    _id: CARD_ID,
    selectorOptionId: "vt-1" as unknown as Id<"selectorOptions">,
    cardNumber: "300b",
    cardName: "Julio Rodriguez",
    attributes: [],
    platformData: {},
    features: {},
    ...overrides,
  } as Parameters<typeof CardDetailPanel>[0]["card"];
}

function renderPanel(card = makeCard()) {
  const onClose = vi.fn();
  render(
    <CardDetailPanel
      card={card}
      ancestorSport="Baseball"
      onClose={onClose}
      onPrev={vi.fn()}
      onNext={vi.fn()}
      hasPrev={false}
      hasNext={false}
    />,
  );
  return { onClose };
}

const titleInput = () =>
  screen.getByLabelText("Card title") as HTMLInputElement;

/**
 * Focus a reactive field the way a person does. BOTH the real `.focus()` and
 * the synthetic React event are needed — see the note in
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
 * Type into the uncontrolled field, then blur — which is what commits it.
 *
 * `fireEvent.change` rather than assigning `el.value` by hand: React tracks
 * the last value it saw on the node, and a direct property assignment updates
 * that tracker, so the subsequent event looks like a no-change and React skips
 * `onChange` — which is what drives the live character counter here.
 */
async function editAndCommit(el: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    focusField(el);
    fireEvent.change(el, { target: { value: text } });
    blurField(el);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCard.mockResolvedValue(undefined);
  previewResult = {
    title: "2024 Topps Chrome Julio Rodriguez #300b",
    coreFits: true,
    dropped: [],
    inputs: {
      cardNumber: "300b",
      playerNames: ["Julio Rodriguez"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Topps Chrome",
      shortPrint: "SP",
      cardVariation: "Image Variation; Wearing sunglasses",
      teamNames: ["Seattle Mariners"],
      sport: "Baseball",
    },
  };
});

describe("CardDetailPanel — listing title length limits (NEO-101)", () => {
  it("counts against the cap and stays silent inside the safe band", () => {
    renderPanel(makeCard({ listingTitle: titleOfLength(40) }));

    expect(screen.getByText("40/80")).toBeTruthy();
    expect(screen.queryByText("may clip on mobile")).toBeNull();
    expect(screen.queryByText("may clip in search")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns in words, not only colour, at the 55-character mobile band", () => {
    renderPanel(makeCard({ listingTitle: titleOfLength(55) }));

    expect(screen.getByText("55/80")).toBeTruthy();
    expect(screen.getByText("may clip on mobile")).toBeTruthy();
    // Still saveable: the soft bands are display truncation, not a rule.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns in words at the 70-character search band", () => {
    renderPanel(makeCard({ listingTitle: titleOfLength(70) }));

    expect(screen.getByText("70/80")).toBeTruthy();
    expect(screen.getByText("may clip in search")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("exactly 80 characters (at the cap) does not alert and still commits", async () => {
    renderPanel(makeCard({ listingTitle: "short" }));

    await editAndCommit(titleInput(), titleOfLength(80));

    expect(screen.getByText("80/80")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
  });

  it("exactly 81 characters (one past the cap) alerts", () => {
    renderPanel(makeCard({ listingTitle: titleOfLength(81) }));

    expect(screen.getByText("81/80")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("1 over the 80-character limit");
  });

  it("refuses to commit over the cap, explains why, and keeps the text so it can be shortened", async () => {
    renderPanel(makeCard({ listingTitle: "short" }));

    await editAndCommit(titleInput(), titleOfLength(84));

    // The counter row and the alert below the input both say it, in words.
    expect(screen.getByText("84/80")).toBeTruthy();
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.some((t) => t.includes("84 characters"))).toBe(true);
    expect(
      alerts.some((t) => t.includes("4 over the 80-character limit")),
    ).toBe(true);

    // Nothing was sent, and nothing was thrown away either: the over-length
    // title an operator cannot SEE is one they cannot fix.
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(titleInput().value.length).toBe(84);

    // The input itself points at the explanation.
    const capAlert = screen
      .getAllByRole("alert")
      .find((a) => (a.textContent ?? "").includes("over the 80-character"))!;
    expect(titleInput().getAttribute("aria-invalid")).toBe("true");
    expect(titleInput().getAttribute("aria-describedby")).toContain(
      capAlert.id,
    );
  });

  it("does not cap the input itself — pasted overflow stays visible so it can be fixed", () => {
    renderPanel(makeCard({ listingTitle: "short" }));
    expect(titleInput().hasAttribute("maxLength")).toBe(false);

    fireEvent.change(titleInput(), { target: { value: titleOfLength(120) } });
    expect(titleInput().value.length).toBe(120);
    expect(screen.getByText("120/80")).toBeTruthy();
  });

  it("saves the trimmed title on blur, and sends nothing but the title", async () => {
    renderPanel(makeCard({ listingTitle: "old" }));

    await editAndCommit(titleInput(), "  2024 Topps Chrome #1  ");

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled());
    expect(mockUpdateCard.mock.calls[0][0].listingTitle).toBe("2024 Topps Chrome #1");
    expect(Object.keys(mockUpdateCard.mock.calls[0][0]).sort()).toEqual([
      "id",
      "listingTitle",
    ]);
  });

  it("Enter commits without leaving the field", async () => {
    renderPanel(makeCard({ listingTitle: "old" }));

    await act(async () => {
      focusField(titleInput());
      fireEvent.change(titleInput(), {
        target: { value: "2024 Topps Chrome #1" },
      });
      fireEvent.keyDown(titleInput(), { key: "Enter" });
    });

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard.mock.calls[0][0].listingTitle).toBe(
      "2024 Topps Chrome #1",
    );
  });

  it("Regenerate replaces a clean field, persists it, and shows the facts the title was built from", async () => {
    renderPanel(makeCard({ listingTitle: "stale title" }));

    // Nothing is fetched until asked: no chips before the click.
    expect(screen.queryByLabelText("Title built from")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });

    await waitFor(() =>
      expect(titleInput().value).toBe("2024 Topps Chrome Julio Rodriguez #300b"),
    );

    // NEO-216: the fetched title goes through the SAME single-field path a
    // typed one does, so it is saved without a Save button to press.
    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: CARD_ID,
        listingTitle: "2024 Topps Chrome Julio Rodriguez #300b",
      }),
    );

    const chips = screen.getByLabelText("Title built from");
    expect(chips.textContent).toContain("2024");
    expect(chips.textContent).toContain("Topps Chrome");
    expect(chips.textContent).toContain("Julio Rodriguez");
    expect(chips.textContent).toContain("#300b");
    expect(chips.textContent).toContain("SP");
    expect(chips.textContent).toContain("Image Variation; Wearing sunglasses");
    // The two fillers the generator now pads toward 80 with.
    expect(chips.textContent).toContain("Seattle Mariners");
    expect(chips.textContent).toContain("Baseball");
    // Plain text, never links.
    expect(chips.querySelector("a")).toBeNull();
  });

  it("renders no team or sport chip when the preview carries neither", async () => {
    // An older deploy predates both fields. The chips must simply be absent —
    // not "undefined", and not a thrown dialog.
    previewResult = {
      title: "2024 Topps Chrome Julio Rodriguez #300b",
      coreFits: true,
      dropped: [],
      inputs: {
        cardNumber: "300b",
        playerNames: ["Julio Rodriguez"],
        year: "2024",
      },
    };
    renderPanel(makeCard({ listingTitle: "stale" }));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });

    const chips = await screen.findByLabelText("Title built from");
    expect(chips.textContent).toContain("Julio Rodriguez");
    expect(chips.textContent).not.toContain("Team");
    expect(chips.textContent).not.toContain("Sport");
    expect(chips.textContent).not.toContain("undefined");
  });

  it("Regenerate over an edited draft asks a second time instead of discarding it", async () => {
    renderPanel(makeCard({ listingTitle: "stale title" }));

    fireEvent.change(titleInput(), { target: { value: "my own wording" } });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });
    // First click only arms the confirm — no browser dialog, and the draft is
    // untouched.
    expect(titleInput().value).toBe("my own wording");
    expect(
      screen.getByText("Regenerate again to replace the title you have typed."),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });
    await waitFor(() =>
      expect(titleInput().value).toBe("2024 Topps Chrome Julio Rodriguez #300b"),
    );
  });

  it("reports the tokens the generator had to leave out", async () => {
    previewResult = {
      ...(previewResult as Record<string, unknown>),
      coreFits: false,
      dropped: ["SP", "/99"],
    };
    renderPanel(makeCard({ listingTitle: "stale" }));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });

    await waitFor(() =>
      expect(screen.getByText("Left out to fit: SP, /99")).toBeTruthy(),
    );
  });

  it("says so when the stored auto-title was cut short", () => {
    renderPanel(
      makeCard({ listingTitle: titleOfLength(78), listingTitleTruncated: true }),
    );
    expect(screen.getByText("Auto title was cut short — rewrite it")).toBeTruthy();
  });

  it("cardVariation at exactly 65 is fine; 66 warns — the boundary itself, not just an over-by-5 case", () => {
    renderPanel(makeCard({ listingTitle: "fine", cardVariation: "y".repeat(65) }));
    expect(screen.getByText("65/65")).toBeTruthy();
    expect(screen.queryByText(/Variation is/)).toBeNull();
  });

  it("counts the variation against 65 and warns without refusing the write", async () => {
    renderPanel(
      makeCard({ listingTitle: "fine", cardVariation: "y".repeat(70) }),
    );

    expect(screen.getByText("70/65")).toBeTruthy();
    // A warning, not a refusal: which NB field maps to which marketplace
    // aspect is not settled, so this cannot block a save.
    const notice = screen.getByText(/Variation is 70 characters/);
    expect(notice.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();

    const variation = screen.getByLabelText(
      "Card variation",
    ) as HTMLInputElement;
    await editAndCommit(variation, "z".repeat(70));

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalled());
    expect(mockUpdateCard.mock.calls[0][0].cardVariation).toBe("z".repeat(70));
  });
});
