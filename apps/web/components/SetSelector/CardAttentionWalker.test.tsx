/**
 * NEO-102 — coverage for the post-commit "needs attention" pass: the derived
 * rule, the fixer registry, and `CardAttentionWalker`'s queue.
 *
 * The queue is the part worth pinning hardest. There is no queue array in
 * state — the presented card is `remaining.find(currentId) ?? remaining[0]`
 * over a list derived from the live rows — so three behaviours all fall out of
 * one expression and all three have to be asserted separately:
 *
 *   1. fixing a card advances (the row stops satisfying the rule),
 *   2. skipping advances without writing anything,
 *   3. a row APPEARING (the background BSC team pass keeps landing for seconds
 *      after a commit, sometimes with a lower card number) does NOT move the
 *      operator off the card they are answering.
 *
 * --- Mocking strategy ---
 * convex/react is module-mocked and routed by the (string-mocked) reference,
 * mirroring EntityReviewWizard.test.tsx. `./TeamPicker` is stubbed: it has its
 * own test file (TeamPicker.test.tsx) covering the typeahead and the
 * findOrCreate "+ Create" path, so this file only verifies that the fixer
 * routes the picker's value into the write and enforces the cap around it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
    selectorOptions: { updateCard: "selectorOptions.updateCard" },
    players: { getManyByIds: "players.getManyByIds" },
    teams: { getManyByIds: "teams.getManyByIds", pickerCandidates: "teams.pickerCandidates" },
  },
}));

type Suggestion = {
  teamId: string;
  name: string;
  source: "career";
  playerName: string;
  /** NEO-330 — defaults to `name`; the server era-labels a shared name. */
  label?: string;
  /** NEO-330 — defaults to true: these fixtures are set-year stints, the preselected kind. */
  inSetYear?: boolean;
};

/**
 * The server's full shape for a fixture list, cached per list so the mock
 * hands the fixer the same array on every render, as Convex does.
 */
const wireShape = new WeakMap<Suggestion[], Array<Required<Suggestion>>>();
function onTheWire(list: Suggestion[]): Array<Required<Suggestion>> {
  let shaped = wireShape.get(list);
  if (!shaped) {
    shaped = list.map((s) => ({ label: s.name, inSetYear: true, ...s }) as Required<Suggestion>);
    wireShape.set(list, shaped);
  }
  return shaped;
}

let suggestionsByCard: Record<string, Suggestion[]>;
const NO_SUGGESTIONS: Suggestion[] = [];
let playerRows: Array<{ _id: string; name: string }> | undefined;
const mockUpdateCard = vi.fn();
const mockConfirmCardNoTeam = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "cardChecklist.suggestedTeamsForCard") {
      const cardId = (args as { cardId?: string })?.cardId ?? "";
      return onTheWire(suggestionsByCard[cardId] ?? NO_SUGGESTIONS);
    }
    if (ref === "players.getManyByIds") return args === "skip" ? undefined : playerRows;
    return [];
  },
  useMutation: (ref: string) => {
    if (ref === "selectorOptions.updateCard") return mockUpdateCard;
    if (ref === "cardChecklist.confirmCardNoTeam") return mockConfirmCardNoTeam;
    return vi.fn();
  },
}));

/** The picker's own behaviour lives in TeamPicker.test.tsx — see the note above. */
vi.mock("./TeamPicker", () => ({
  default: ({
    value,
    onChange,
    contextOptionId,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    contextOptionId?: string;
  }) => (
    <div data-context-option-id={contextOptionId ?? ""}>
      <span data-testid="picker-value">{value.join(",")}</span>
      <button type="button" onClick={() => onChange([...value, `extra-${value.length}`])}>
        Stub add team
      </button>
    </div>
  ),
}));

/**
 * NEO-335 — `UnreviewedNameFixer` mounts a PlayerPicker; only the walk ORDER
 * test below renders that fixer, and it reads the heading, not the picker.
 */
vi.mock("./PlayerPicker", () => ({ default: () => null }));

import CardAttentionWalker, { walkDoneLine, walkStep } from "./CardAttentionWalker";
import { LISTING_TITLE_MAX } from "../../convex/features/listingLimits";
import { deriveCardAttention, needsAttention } from "./card-attention";
import {
  attentionFixers,
  attentionWalkRank,
  attentionWalkSubtitle,
  isAwaitingTeamLookup,
  pickAttentionFixer,
  unfixableReason,
  UNFIXABLE_WALK_SUBTITLE,
  type CardChecklistRow,
} from "./cardAttentionRegistry";
import type { AttentionItem } from "./card-attention";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stored row that needs a team: BSC-linked, its lookup has been and gone,
 * it still has no team, and no operator has answered. This is the shape of the
 * ten real teamless cards in dev's 2026 Topps base.
 */
function needsTeamRow(overrides: Partial<CardChecklistRow> = {}): CardChecklistRow {
  return {
    _id: "card-1" as unknown as Id<"cardChecklist">,
    cardNumber: "1",
    cardName: "American League Leaders ERA LL",
    platformData: { bsc: { ref: "bsc-ref-1" } },
    teamCheckDoneAt: 1_000,
    ...overrides,
  };
}

function renderWalker(cards: CardChecklistRow[], props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <CardAttentionWalker
      isOpen
      cards={cards}
      sportId={"sport-1" as unknown as Id<"selectorOptions">}
      onClose={onClose}
      {...props}
    />,
  );
  return { ...utils, onClose };
}

// NEO-330: a career chip's name reads "<team> · <players> played here".
const chip = (name: string, from: string) =>
  screen.getByRole("button", { name: `${name} · ${from} played here` }) as HTMLButtonElement;

/**
 * NEO-335 Phase 2 — the chrome's "Step x of y", the walker's one counter. Read
 * from the header so the done line (also `role="status"`) never answers for it.
 */
const counter = () =>
  document.querySelector("header [role='status']")?.textContent ?? null;
const rail = () => document.querySelector<HTMLElement>("[data-rail-fill]")!;

const saveButton = () =>
  screen.getByRole("button", { name: /Save & Next/ }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCard.mockResolvedValue(null);
  mockConfirmCardNoTeam.mockResolvedValue({ confirmed: true, stamped: true });
  suggestionsByCard = {};
  playerRows = undefined;
});

// ---------------------------------------------------------------------------
// The derived rule
// ---------------------------------------------------------------------------

describe("deriveCardAttention", () => {
  it("flags a BSC-linked card whose lookup ran, found no team, and nobody has answered", () => {
    expect(deriveCardAttention(needsTeamRow())).toEqual([{ kind: "missingTeam" }]);
  });

  it("does NOT flag a BSC-linked card whose lookup has not run yet", () => {
    // processBscTeamEnrichmentQueue is one detail request every 300ms, so a
    // freshly-synced 900-card set is minutes from finished. Badging every BSC
    // card during the drain would flood the checklist with items that resolve
    // themselves and train the operator to ignore the badge.
    expect(deriveCardAttention({ ...needsTeamRow(), teamCheckDoneAt: undefined })).toEqual(
      [],
    );
  });

  it("flags a card with NO marketplace ref immediately — there is no lookup to wait for", () => {
    // The case the placeholder rule got wrong: gating on teamCheckDoneAt
    // unconditionally left hand-added cards permanently unbadged, which is the
    // exact invisibility this ticket exists to fix. A card with no
    // platformData.bsc.ref has nothing that will ever stamp teamCheckDoneAt on
    // it, so waiting for that stamp means waiting forever. NEO-239: the absent
    // ref IS the condition — there is no "custom" flag to read, and a row that
    // later gets an id attached simply stops matching.
    const handAdded: CardChecklistRow = {
      _id: "card-hand-added" as unknown as Id<"cardChecklist">,
      cardNumber: "301",
      cardName: "Hand-added Card",
    };
    expect(deriveCardAttention(handAdded)).toEqual([{ kind: "missingTeam" }]);
    expect(needsAttention(handAdded)).toBe(true);
  });

  it("flags a SportLots-only card immediately, for the same reason", () => {
    // SportLots' checklist scrape never attempts team extraction, so an SL ref
    // is not something to wait on either.
    expect(
      needsAttention({
        ...needsTeamRow(),
        platformData: { sportlots: { ref: "1 AL Leaders ERA LL" } },
        teamCheckDoneAt: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT flag a card that has a team", () => {
    expect(
      needsAttention({
        ...needsTeamRow(),
        teamOnCardIds: ["team-1" as unknown as Id<"teams">],
      }),
    ).toBe(false);
  });

  it("does NOT flag a card an operator said has no team", () => {
    // The field that separates "nobody has answered" from "answered: none",
    // which teamCheckDoneAt alone cannot express — and the reason a re-sync
    // stops asking.
    expect(needsAttention({ ...needsTeamRow(), teamNoneConfirmedAt: 2_000 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The registry contract NEO-101 codes against
// ---------------------------------------------------------------------------

describe("attentionFixers registry", () => {
  it("resolves the missingTeam kind", () => {
    const { item, Fixer } = pickAttentionFixer([{ kind: "missingTeam" }]);
    expect(item).toEqual({ kind: "missingTeam" });
    expect(Fixer).toBe(attentionFixers.missingTeam);
  });

  it("resolves all three of NEO-101's title kinds to the one title fixer", () => {
    // One component for three kinds is the deliberate choice: they are the same
    // field with different reasons, so a card flagged for two of them is asked
    // once. See TitleFixer's own file for the reasoning.
    for (const kind of [
      "titleOverLimit",
      "titleTruncated",
      "aspectValueOverLimit",
    ] as const) {
      const { Fixer } = pickAttentionFixer([{ kind }] as unknown as AttentionItem[]);
      expect(Fixer).toBe(attentionFixers.titleOverLimit);
      expect(Fixer).toBeDefined();
    }
  });

  it("returns no fixer for an unregistered kind, without throwing", () => {
    // A bundle older than the row that carries a kind must degrade, not crash.
    // The stand-in has to be a kind NOTHING registers — this test used
    // `titleOverLimit` until NEO-101 registered it, at which point it passed
    // for the wrong reason. Cast because the kind does not exist in THIS
    // bundle's union, which is precisely the case under test.
    const unknown = [{ kind: "somethingFromTheFuture" }] as unknown as AttentionItem[];
    const { item, Fixer } = pickAttentionFixer(unknown);
    expect(Fixer).toBeUndefined();
    expect(item).toEqual({ kind: "somethingFromTheFuture" });
    expect(unfixableReason(item)).toContain("no fixer for it");
  });

  it("skips past an unregistered kind to one it can fix", () => {
    const mixed = [
      { kind: "somethingFromTheFuture" },
      { kind: "missingTeam" },
    ] as unknown as AttentionItem[];
    const { item, Fixer } = pickAttentionFixer(mixed);
    expect(item).toEqual({ kind: "missingTeam" });
    expect(Fixer).toBe(attentionFixers.missingTeam);
  });

  it("a card flagged for BOTH missingTeam and a title kind picks whichever is FIRST in the row's own item order", () => {
    // Both kinds are registered (to different components), so this is not the
    // "skip past what nothing can fix" case above — it is the tie-break rule
    // itself: `pickAttentionFixer` takes the first item its registry knows,
    // in the order `deriveCardAttention` produced them, never a fixed
    // priority between kinds. `deriveCardAttention` happens to push
    // `missingTeam` before the title kinds (see cardAttention.ts), so this
    // pins the CONSEQUENCE of that ordering as observed through the registry,
    // not the ordering itself (which is cardAttention.test.ts's job).
    const missingTeamFirst = [
      { kind: "missingTeam" },
      { kind: "titleOverLimit", length: 94 },
    ] as AttentionItem[];
    const first = pickAttentionFixer(missingTeamFirst);
    expect(first.item).toEqual({ kind: "missingTeam" });
    expect(first.Fixer).toBe(attentionFixers.missingTeam);

    // Reversing the array (not a real `deriveCardAttention` output today, but
    // the registry itself must not hard-code which kind "wins" — a fixer
    // module reordering a future item list must change this outcome too)
    // proves the choice tracks ARRAY ORDER, not a kind name comparison.
    const titleFirst = [
      { kind: "titleOverLimit", length: 94 },
      { kind: "missingTeam" },
    ] as AttentionItem[];
    const second = pickAttentionFixer(titleFirst);
    expect(second.item).toEqual({ kind: "titleOverLimit", length: 94 });
    expect(second.Fixer).toBe(attentionFixers.titleOverLimit);
  });

  it("end to end: a REAL row missing a team with an over-limit title routes to MissingTeamFixer first", () => {
    // Not a hand-built item array — the actual `deriveCardAttention` output
    // for one row, fed straight into `pickAttentionFixer`. This is the case
    // the walker itself hits: a fresh custom card with no team yet, whose
    // operator also pasted an over-length title before saving.
    const row = {
      teamOnCardIds: [],
      platformData: {},
      listingTitle: "x".repeat(94),
    };
    const items = deriveCardAttention(row);
    expect(items.map((i) => i.kind)).toEqual(["missingTeam", "titleOverLimit"]);

    const { item, Fixer } = pickAttentionFixer(items);
    expect(item).toEqual({ kind: "missingTeam" });
    expect(Fixer).toBe(attentionFixers.missingTeam);
  });
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — presentation", () => {
  it("renders nothing when closed", () => {
    renderWalker([needsTeamRow()], { isOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the card, its players, and the wizard chrome: title, Step x of y, and the question's type", () => {
    playerRows = [
      { _id: "p1", name: "Tarik Skubal" },
      { _id: "p2", name: "Garrett Crochet" },
    ];
    renderWalker([
      needsTeamRow({ playerIds: ["p1", "p2"] as unknown as Array<Id<"players">> }),
      needsTeamRow({ _id: "card-2" as unknown as Id<"cardChecklist">, cardNumber: "2" }),
    ]);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#1 American League Leaders ERA LL",
    );
    expect(screen.getByText(/Tarik Skubal · Garrett Crochet/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Tidy up this set");
    expect(counter()).toBe("Step 1 of 2");
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    // No per-kind count anywhere: the counter is the only number.
    expect(document.body.textContent).not.toMatch(/need attention|fixed/);
  });

  it("never renders a marketplace ref, in text or in an attribute", () => {
    // A SportLots ref IS a seller-typed description: untrusted content as well
    // as noise. Asserted against the HTML so a `title` tooltip cannot leak it.
    renderWalker([
      needsTeamRow({
        platformData: {
          bsc: { ref: "bsc-ref-1" },
          sportlots: { ref: "1 AL Leaders ERA LL [ Sliding ]" },
        },
      }),
    ]);
    expect(document.body.innerHTML).not.toContain("bsc-ref-1");
    expect(document.body.innerHTML).not.toContain("Sliding");
  });

  it("shows an all-clear step when nothing needs attention", () => {
    renderWalker([{ ...needsTeamRow(), teamNoneConfirmedAt: 5 }]);
    expect(screen.getByText(/All clear/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Done/ })).toBeTruthy();
    // Nothing walked, so there is no count to give: the counter is empty.
    expect(counter()).toBe("");
  });

  it("preselects the suggested teams and says whose career each came from", () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    renderWalker([needsTeamRow()]);

    expect(chip("Detroit Tigers", "Tarik Skubal").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("picker-value").textContent).toBe("team-tigers");
  });

  it("renders one chip per team when two players share it", () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Riley Greene" },
    ];
    renderWalker([needsTeamRow()]);

    expect(chip("Detroit Tigers", "Tarik Skubal & Riley Greene")).toBeTruthy();
    expect(screen.getByTestId("picker-value").textContent).toBe("team-tigers");
  });
});

// ---------------------------------------------------------------------------
// NEO-271 — the dialog's own geometry
// ---------------------------------------------------------------------------

/**
 * What is and is not assertable here.
 *
 * happy-dom computes no layout, so there is not a single pixel in this block:
 * `getBoundingClientRect()` is all zeroes and a test that asserted a rendered
 * width would be asserting the test environment rather than the product. What
 * IS assertable is the structure and the classes that CARRY the constraint —
 * which row is the scroll container, what is deliberately outside it, and the
 * arithmetic the width was chosen by — so that is what these pin. The pixels
 * belong to E2E (`checklist-attention-walker-missing-team.yaml` measures the
 * body's box at 1024×629) and to the operator.
 */
describe("CardAttentionWalker — dialog geometry (NEO-271)", () => {
  /** The panel: the bordered card inside the centring overlay. */
  const panelOf = (dialog: HTMLElement) => dialog.firstElementChild as HTMLElement;
  /** Its three rows, in order: header, body, footer. */
  const rowsOf = (dialog: HTMLElement) =>
    Array.from(panelOf(dialog).children) as HTMLElement[];

  it("is wide enough for an 80-character title in the widest font this dialog can render in", () => {
    renderWalker([needsTeamRow()]);
    const panel = panelOf(screen.getByRole("dialog"));

    // Read the budget OUT of the class rather than restating it, so narrowing
    // the dialog fails here with the reason attached rather than silently
    // shrinking the field the meter counts characters against.
    const rem = /max-w-\[(\d+(?:\.\d+)?)rem\]/.exec(panel.className);
    expect(rem).not.toBeNull();
    const panelPx = Number(rem?.[1]) * 16;

    // Measured with fontTools: summed glyph advances at `text-sm` (14px) over
    // a realistic worst-case title (mixed case, spaces, a `#` and a card
    // number) come to 8.07px per character in DejaVu Sans — what `system-ui`
    // resolves to on the Linux CI runner, and the widest of the faces this
    // dialog can pick up (Lexend 7.80, Arial 7.25, SF Pro Text 6.84). The
    // body's `p-6` and the input's `p-1.5` plus its 1px borders are the part
    // the title field never gets.
    const BODY_PADDING_PX = 24 * 2;
    const INPUT_CHROME_PX = 6 * 2 + 1 * 2;
    const WIDEST_PX_PER_CHAR = 8.07;
    const charsVisible =
      (panelPx - BODY_PADDING_PX - INPUT_CHROME_PX) / WIDEST_PX_PER_CHAR;
    expect(charsVisible).toBeGreaterThanOrEqual(LISTING_TITLE_MAX);

    // And it still fits CI's 1024px-wide viewport once the overlay's `p-4` is
    // paid, with `w-full` doing the reflow below that.
    expect(panelPx + 16 * 2).toBeLessThanOrEqual(1024);
    expect(panel.className).toContain("w-full");
  });

  it("caps its height on the PANEL, so the body can grow into the whole viewport", () => {
    renderWalker([needsTeamRow()]);
    const dialog = screen.getByRole("dialog");
    const panel = panelOf(dialog);
    const [header, body, footer] = rowsOf(dialog);

    // `max-h-full` resolves against the overlay's content box (`inset-0` minus
    // its `p-4`) — the idiom EntityReviewWizard documents.
    expect(panel.className).toContain("max-h-full");
    expect(panel.className).toContain("flex-col");
    // The cap is no longer on the body: `max-h-[70vh]` scrolled a data-heavy
    // fixer while ~140px of viewport went unused above and below the dialog.
    expect(body.className).not.toContain("max-h-");
    expect(body.className).toContain("overflow-y-auto");
    // …and the body is the only elastic row, so all the shrinking lands there.
    expect(header.className).toContain("shrink-0");
    expect(footer.className).toContain("shrink-0");
  });

  it("keeps the reserved minimum height that stops the dialog jumping card to card", () => {
    renderWalker([needsTeamRow()]);
    const [, body] = rowsOf(screen.getByRole("dialog"));
    // NEO-110: the overlay centres the dialog, so a body that changes height
    // moves the footer by HALF the delta and a click aimed at Skip lands on
    // whatever rendered into those coordinates. 20rem is the floor that covers
    // every registered fixer at the width above; the `55vh` clause only bites
    // on a viewport too short to fit floor + header + footer at all.
    expect(body.className).toContain("min-h-[min(20rem,55vh)]");
  });

  it("keeps the heading, the progress line and the Skip/Close footer OUTSIDE the scrolling region", () => {
    renderWalker([
      needsTeamRow(),
      needsTeamRow({ _id: "card-2" as unknown as Id<"cardChecklist">, cardNumber: "2" }),
    ]);
    const dialog = screen.getByRole("dialog");
    const [header, body, footer] = rowsOf(dialog);

    const heading = screen.getByRole("heading", { level: 2 });
    const progress = screen.getByText("Step 1 of 2");
    const skip = screen.getByRole("button", { name: /^Skip for now, card / });
    const close = screen.getByRole("button", { name: /Close/ });

    expect(header.contains(heading)).toBe(true);
    expect(header.contains(progress)).toBe(true);
    expect(footer.contains(skip)).toBe(true);
    expect(footer.contains(close)).toBe(true);
    // The scroll container holds none of them, so no amount of body scrolling
    // can take the dialog's chrome out of view.
    expect(body.contains(heading)).toBe(false);
    expect(body.contains(progress)).toBe(false);
    expect(body.contains(skip)).toBe(false);
    expect(body.contains(close)).toBe(false);
  });

  it("a fixer's own Save button IS inside the scrolling region — which is what the floor and the cap are for", () => {
    // Honest about where the limit lies: Save belongs to the fixer, not to the
    // walker's chrome, so "Save stays visible" is a consequence of the body
    // being tall enough rather than of it being outside the scroll box.
    renderWalker([needsTeamRow()]);
    const [, body] = rowsOf(screen.getByRole("dialog"));
    expect(
      body.contains(screen.getByRole("button", { name: "Save & Next (Enter)" })),
    ).toBe(true);
  });

  it("leaves the live region and the focus trap exactly as they were", () => {
    // The resize touched the panel's classes only. `role="status"` with no
    // `aria-live` override is the documented pattern for this line (it never
    // switches to `role="alert"`), and Tab still cycles inside the dialog —
    // pinned here alongside the geometry so a future sizing change cannot
    // quietly restructure the chrome that carries either.
    renderWalker([needsTeamRow()]);
    const dialog = screen.getByRole("dialog");
    const progress = screen.getByText("Step 1 of 1");
    expect(progress.getAttribute("role")).toBe("status");
    expect(progress.getAttribute("aria-live")).toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("card-attention-walker-title");

    const focusable = dialog.querySelectorAll<HTMLElement>("button:not([disabled])");
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
  });
});

// ---------------------------------------------------------------------------
// Writes + advance
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — fixing a card", () => {
  it("Enter saves the preselected chips and the queue advances to the next card", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
      { teamId: "team-sox", name: "Boston Red Sox", source: "career", playerName: "Garrett Crochet" },
    ];
    const rows = [
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ];
    const { rerender, onClose } = renderWalker(rows);

    // Enter from inside the panel, on a non-button element: this pins the
    // wrapper's own Enter-saves path. (Enter on the focused Save button goes
    // through native activation instead — covered in the keyboard-only block.)
    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "Enter" });

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        // `id`, not `cardId`: that is what convex/selectorOptions.ts's
        // updateCard declares, and Convex arg validators are strict.
        id: rows[0]._id,
        teamOnCardIds: ["team-tigers", "team-sox"],
      }),
    );
    await waitFor(() => expect(counter()).toBe("Step 2 of 2"));

    // The write lands in the database, the row stops satisfying the rule, and
    // THAT is what advances the walker — nothing calls "next".
    rerender(
      <CardAttentionWalker
        isOpen
        cards={[
          { ...rows[0], teamOnCardIds: ["team-tigers"] as unknown as Array<Id<"teams">> },
          rows[1],
        ]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#2 NL Leaders ERA LL",
    );
    // The answered card left the list; y holds.
    expect(counter()).toBe("Step 2 of 2");
  });

  it("toggling a chip off keeps it out of the write", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
      { teamId: "team-sox", name: "Boston Red Sox", source: "career", playerName: "Garrett Crochet" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(chip("Detroit Tigers", "Tarik Skubal"));
    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-sox"],
      }),
    );
  });

  it("saves a team added through the picker alongside the chips", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(screen.getByRole("button", { name: "Stub add team" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-tigers", "extra-1"],
      }),
    );
  });

  // NEO-102: the picker's popover overlaid "Save & Next (Enter)", so the click
  // meant for Save landed on a typeahead option and added a SECOND team
  // instead of saving. The overlay itself is fixed and pinned in
  // TeamPicker.test.tsx (outside-click close — jsdom has no layout, so it
  // cannot be reproduced from here); this pins the outcome that regressed:
  // one pick, one save, one team.
  it("after picking a team, Save & Next writes exactly that team — once", async () => {
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(screen.getByRole("button", { name: "Stub add team" }));
    expect(screen.getByTestId("picker-value").textContent).toBe("extra-0");

    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: row._id,
      teamOnCardIds: ["extra-0"],
    });
  });

  it("'No team on this card' records the explicit answer instead of a team list", async () => {
    const row = needsTeamRow();
    renderWalker([row]);

    fireEvent.click(screen.getByRole("button", { name: "No team on this card" }));

    await waitFor(() =>
      expect(mockConfirmCardNoTeam).toHaveBeenCalledWith({ cardId: row._id }),
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("'No team on this card' stays in the tab order while its own request is in flight", async () => {
    // NEO-189's audit found a Confirm that natively-disabled itself the
    // instant it went inert, dropping out of the tab order and stranding
    // focus with no route to the reason. This button is the same shape of
    // control (it sets `busy`, which used to natively-disable it too) — the
    // fix is aria-disabled, same as Save.
    let resolveConfirm!: (v: { confirmed: boolean; stamped: boolean }) => void;
    mockConfirmCardNoTeam.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    renderWalker([needsTeamRow()]);

    const noTeamBtn = screen.getByRole("button", {
      name: "No team on this card",
    }) as HTMLButtonElement;
    fireEvent.click(noTeamBtn);

    await waitFor(() => expect(noTeamBtn.textContent).toBe("No team on this card"));
    // Still reachable — not the native `disabled` attribute, which would pull
    // it out of the tab order entirely.
    expect(noTeamBtn.disabled).toBe(false);

    resolveConfirm({ confirmed: true, stamped: true });
    await waitFor(() => expect(mockConfirmCardNoTeam).toHaveBeenCalledTimes(1));
  });

  it("a blocked chip at the cap is described by the cap notice, for a screen-reader user landing on it directly", () => {
    suggestionsByCard["card-1"] = Array.from({ length: 9 }, (_, i) => ({
      teamId: `team-${i + 1}`,
      name: `Team ${i + 1}`,
      source: "career" as const,
      playerName: "Someone",
    }));
    renderWalker([needsTeamRow()]);

    const ninth = chip("Team 9", "Someone");
    expect(ninth.getAttribute("aria-describedby")).toBe("attention-team-cap");
    const cap = document.getElementById("attention-team-cap");
    expect(cap).toBeTruthy();
    expect(cap?.textContent).toContain("limit of 8 teams");

    // A chip that IS chosen is never "blocked" even at the cap — removing one
    // of the eight is always legal, so it carries no such description.
    const first = chip("Team 1", "Someone");
    expect(first.getAttribute("aria-describedby")).toBeNull();
  });

  it("counts an already-confirmed card as answered (confirmed, not stamped)", async () => {
    // Another tab, or a double-press, got there first. Nothing was written by
    // THIS call, but the card is answered — so it still advances.
    mockConfirmCardNoTeam.mockResolvedValueOnce({ confirmed: true, stamped: false });
    renderWalker([
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "No team on this card" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
        "#2 NL Leaders ERA LL",
      ),
    );
    expect(counter()).toBe("Step 2 of 2");
  });

  it("does NOT count a REFUSED confirmation as walked, and says why", async () => {
    // The mutation refuses rather than throws when the row has gained teams or
    // is gone — a race against another tab or the background BSC pass.
    // Advancing here would report a card as answered when nothing was written.
    mockConfirmCardNoTeam.mockResolvedValueOnce({ confirmed: false, stamped: false });
    renderWalker([needsTeamRow()]);

    fireEvent.click(screen.getByRole("button", { name: "No team on this card" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("has teams now");
    // Still on the same card, still step 1: nothing was walked.
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#1 American League Leaders ERA LL",
    );
    expect(counter()).toBe("Step 1 of 1");
  });

  it("advances the moment the write lands, without waiting for the subscription", async () => {
    // A write and the client's subscription update are not the same instant.
    // Without the session's own record of what it answered, the card would
    // flash back on screen in between.
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    renderWalker([
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    // `cards` is unchanged — no rerender with the fixed row.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
        "#2 NL Leaders ERA LL",
      ),
    );
  });

  it("does not save with nothing chosen, and the primary stays in the tab order", () => {
    renderWalker([needsTeamRow()]);

    const save = screen.getByRole("button", {
      name: "Save & Next (Enter)",
    }) as HTMLButtonElement;
    // NEO-189: a natively-disabled primary leaves the tab order and strands
    // focus with no route to the reason it is inert.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "Enter" });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("surfaces a rejected write instead of swallowing it", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    mockUpdateCard.mockRejectedValueOnce(new Error("not an admin"));
    renderWalker([needsTeamRow()]);

    fireEvent.click(screen.getByRole("button", { name: "Save & Next (Enter)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not an admin");
  });

  it("caps the write at 8 teams and says so", () => {
    suggestionsByCard["card-1"] = Array.from({ length: 9 }, (_, i) => ({
      teamId: `team-${i + 1}`,
      name: `Team ${i + 1}`,
      source: "career" as const,
      playerName: "Someone",
    }));
    renderWalker([needsTeamRow()]);

    // Preselection itself respects the cap.
    expect(screen.getByTestId("picker-value").textContent?.split(",")).toHaveLength(8);
    expect(screen.getByText(/limit of 8 teams on one card/)).toBeTruthy();

    // A ninth is refused, not silently swapped in for one of the eight.
    fireEvent.click(screen.getByRole("button", { name: "Stub add team" }));
    expect(screen.getByTestId("picker-value").textContent?.split(",")).toHaveLength(8);

    // The unchosen chip stays reachable so the notice explaining why is too.
    const ninth = chip("Team 9", "Someone");
    expect(ninth.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(ninth);
    expect(screen.getByTestId("picker-value").textContent?.split(",")).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Skip, close, and a queue that changes underneath
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — deferring", () => {
  it("Skip advances without writing anything", () => {
    const rows = [
      needsTeamRow(),
      needsTeamRow({
        _id: "card-2" as unknown as Id<"cardChecklist">,
        cardNumber: "2",
        cardName: "NL Leaders ERA LL",
      }),
    ];
    renderWalker(rows);

    fireEvent.click(screen.getByRole("button", { name: "Skip for now, card 1" }));

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#2 NL Leaders ERA LL",
    );
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(mockConfirmCardNoTeam).not.toHaveBeenCalled();
    // Skipping is not a write — the card keeps its badge in the grid and comes
    // back next time — but in THIS sitting it has been walked.
    expect(counter()).toBe("Step 2 of 2");
  });

  it("Escape closes and defers the rest", () => {
    const { onClose } = renderWalker([needsTeamRow()]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("the Close button closes too", () => {
    const { onClose } = renderWalker([needsTeamRow()]);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a row appearing mid-answer does not move the operator off the card on screen", () => {
    // The background BSC team pass keeps landing for seconds after a commit,
    // and a card it flags can sort BEFORE the one being answered. Without the
    // currentId pin the walker would follow remaining[0] and swap the card out
    // from under the operator.
    const onScreen = needsTeamRow({
      _id: "card-5" as unknown as Id<"cardChecklist">,
      cardNumber: "5",
      cardName: "On Screen",
    });
    const { rerender, onClose } = renderWalker([onScreen]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#5 On Screen");

    rerender(
      <CardAttentionWalker
        isOpen
        cards={[
          needsTeamRow({
            _id: "card-2" as unknown as Id<"cardChecklist">,
            cardNumber: "2",
            cardName: "Arrived Later",
          }),
          onScreen,
        ]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#5 On Screen");
    // The new card joins the sitting: y grows, x stays on the card being read.
    expect(counter()).toBe("Step 1 of 2");
  });

  it("falls through to the all-clear step when the last card is fixed elsewhere, and does not strand focus on <body>", async () => {
    // The control that had focus (MissingTeamFixer's own — Save & Next when
    // there are chips, the picker trigger when there are none, as here)
    // unmounts along with the whole fixer once `current` has nowhere left to
    // point — nothing
    // else in the all-clear branch is focusable, so without the walker's own
    // advance-time park, focus would blur straight to <body> with the dialog
    // still open. See the audit-fix comment above the effect in
    // CardAttentionWalker.tsx.
    const row = needsTeamRow();
    const { rerender, onClose } = renderWalker([row]);
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
    // Let the fixer's own mount-time focus (and the walker's one-shot open
    // fallback) settle onto that control first — a real animation frame always
    // elapses before an operator's next action, and collapsing that gap is
    // what let a STALE, already-scheduled fallback from the open effect win
    // the race against this test's own assertion below.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("BUTTON"));

    rerender(
      <CardAttentionWalker
        isOpen
        cards={[{ ...row, teamNoneConfirmedAt: 9 }]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/All clear/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Skip for now, card / })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
  });
});

// ---------------------------------------------------------------------------
// NEO-335 — walk order and the done line
// ---------------------------------------------------------------------------

describe("attentionWalkRank (NEO-335)", () => {
  it("ranks missing team, then unlinked names, then every title kind, then what this bundle cannot fix", () => {
    const team = attentionWalkRank([{ kind: "missingTeam" }]);
    const name = attentionWalkRank([{ kind: "unreviewedName", names: ["X"] }]);
    const titles = (
      [
        { kind: "titleOverLimit", length: 94 },
        { kind: "titleTruncated" },
        { kind: "aspectValueOverLimit", field: "cardVariation", length: 70 },
      ] as AttentionItem[]
    ).map((item) => attentionWalkRank([item]));
    const unknown = attentionWalkRank([
      { kind: "somethingFromTheFuture" },
    ] as unknown as AttentionItem[]);

    expect(team).toBeLessThan(name);
    for (const title of titles) {
      expect(name).toBeLessThan(title);
      expect(title).toBe(titles[0]);
      expect(title).toBeLessThan(unknown);
    }
  });

  it("ranks a card by the question it will be ASKED, not the earliest kind it carries", () => {
    // `deriveCardAttention` lists an unlinked name after a title, so this card
    // presents TitleFixer — and must walk with the titles, not the names.
    const items = deriveCardAttention({
      teamOnCardIds: ["team-1" as unknown as Id<"teams">],
      listingTitle: "x".repeat(94),
      pendingPlayerNames: ["Somebody"],
      platformData: {},
    });
    expect(items.map((i) => i.kind)).toEqual(["titleOverLimit", "unreviewedName"]);
    expect(attentionWalkRank(items)).toBe(
      attentionWalkRank([{ kind: "titleOverLimit", length: 94 }]),
    );
  });
});

describe("CardAttentionWalker — walk order (NEO-335)", () => {
  /** Lowest card numbers on the kinds that walk LAST, so number order alone would get it wrong. */
  const titleRow = needsTeamRow({
    _id: "card-t" as unknown as Id<"cardChecklist">,
    cardNumber: "1",
    cardName: "Title Card",
    teamOnCardIds: ["team-1" as unknown as Id<"teams">],
    listingTitle: "x".repeat(94),
  });
  const nameRow = needsTeamRow({
    _id: "card-n" as unknown as Id<"cardChecklist">,
    cardNumber: "2",
    cardName: "Name Card",
    pendingPlayerNames: ["Somebody"],
  });
  const teamRow10 = needsTeamRow({
    _id: "card-10" as unknown as Id<"cardChecklist">,
    cardNumber: "10",
    cardName: "Team Card Ten",
  });
  const teamRow3 = needsTeamRow({
    _id: "card-3" as unknown as Id<"cardChecklist">,
    cardNumber: "3",
    cardName: "Team Card Three",
  });

  const heading = () => screen.getByRole("heading", { level: 3 }).textContent;
  const skip = () => fireEvent.click(screen.getByRole("button", { name: /^Skip for now, card .*$/ }));

  it("asks every missing team first (by number), then unlinked names, then titles", () => {
    // Handed over in an order that matches neither rule.
    renderWalker([titleRow, teamRow10, nameRow, teamRow3]);

    expect(heading()).toBe("#3 Team Card Three");
    skip();
    expect(heading()).toBe("#10 Team Card Ten");
    skip();
    expect(heading()).toBe("#2 Name Card");
    skip();
    expect(heading()).toBe("#1 Title Card");
    skip();
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  it("a missing-team card arriving mid-walk joins its group without moving the card on screen", () => {
    const { rerender, onClose } = renderWalker([nameRow, titleRow]);
    expect(heading()).toBe("#2 Name Card");

    rerender(
      <CardAttentionWalker
        isOpen
        cards={[nameRow, titleRow, teamRow3]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );
    // Pinned: still the card being read.
    expect(heading()).toBe("#2 Name Card");
  });
});

// ---------------------------------------------------------------------------
// NEO-335 Phase 2 (D9) — the wizard chrome: one counter, a subtitle per kind
// ---------------------------------------------------------------------------

describe("walkStep (NEO-335 Phase 2)", () => {
  it("x is the walked count plus one; y is every card the sitting has seen", () => {
    expect(walkStep(4, 4, true)).toEqual({ step: 1, total: 4 });
    expect(walkStep(4, 1, true)).toEqual({ step: 4, total: 4 });
  });

  it("reads y of y once nothing is left, and 0 of 0 for a walk that never had a card", () => {
    expect(walkStep(4, 0, false)).toEqual({ step: 4, total: 4 });
    expect(walkStep(0, 0, false)).toEqual({ step: 0, total: 0 });
  });

  it("never lets x pass y, nor y fall below what is left", () => {
    expect(walkStep(2, 3, true)).toEqual({ step: 1, total: 3 });
  });
});

describe("attentionWalkSubtitle (NEO-335 Phase 2)", () => {
  it("names the question, not the kind: titles share one subtitle", () => {
    expect(attentionWalkSubtitle([{ kind: "missingTeam" }])).toBe("Cards with no team");
    expect(attentionWalkSubtitle([{ kind: "unreviewedName", names: ["X"] }])).toBe(
      "Names not yet linked",
    );
    for (const item of [
      { kind: "titleOverLimit", length: 94 },
      { kind: "titleTruncated" },
      { kind: "aspectValueOverLimit", field: "cardVariation", length: 70 },
    ] as AttentionItem[]) {
      expect(attentionWalkSubtitle([item])).toBe("Card titles");
    }
  });

  it("follows the item the walker will ASK about, the same one the rank files it under", () => {
    // Title first in the row's own order, so TitleFixer presents it.
    expect(
      attentionWalkSubtitle([
        { kind: "titleOverLimit", length: 94 },
        { kind: "unreviewedName", names: ["X"] },
      ] as AttentionItem[]),
    ).toBe("Card titles");
  });

  it("falls back for a kind this bundle has no fixer for", () => {
    expect(
      attentionWalkSubtitle([{ kind: "somethingFromTheFuture" }] as unknown as AttentionItem[]),
    ).toBe(UNFIXABLE_WALK_SUBTITLE);
  });
});

describe("CardAttentionWalker — Step x of y and the subtitle (NEO-335 Phase 2)", () => {
  const row = (id: string, cardNumber: string, extra: Partial<CardChecklistRow> = {}) =>
    needsTeamRow({
      _id: id as unknown as Id<"cardChecklist">,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      ...extra,
    });
  const titleRow = row("card-t", "1", {
    teamOnCardIds: ["team-1" as unknown as Id<"teams">],
    listingTitle: "x".repeat(94),
  });
  const nameRow = row("card-n", "2", { pendingPlayerNames: ["Somebody"] });
  const teamRow3 = row("card-3", "3");
  const teamRow10 = row("card-10", "10");
  const skip = () =>
    fireEvent.click(screen.getByRole("button", { name: /^Skip for now, card .*$/ }));
  const subtitleOf = (text: string) => screen.queryByText(text);
  const rerenderWith = (
    rerender: (ui: React.ReactElement) => void,
    onClose: () => void,
    cards: CardChecklistRow[],
  ) =>
    rerender(
      <CardAttentionWalker
        isOpen
        cards={cards}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );

  it("one counter across every card in the walk, with each group's subtitle, in Phase 1's order", () => {
    renderWalker([titleRow, teamRow10, nameRow, teamRow3]);

    expect(counter()).toBe("Step 1 of 4");
    expect(subtitleOf("Cards with no team")).toBeTruthy();
    skip();
    expect(counter()).toBe("Step 2 of 4");
    expect(subtitleOf("Cards with no team")).toBeTruthy();
    skip();
    expect(counter()).toBe("Step 3 of 4");
    expect(subtitleOf("Names not yet linked")).toBeTruthy();
    expect(subtitleOf("Cards with no team")).toBeNull();
    skip();
    expect(counter()).toBe("Step 4 of 4");
    expect(subtitleOf("Card titles")).toBeTruthy();
    skip();

    // Done: the counter stays full, and no group's subtitle is left behind.
    expect(screen.getByText(/All clear/)).toBeTruthy();
    expect(counter()).toBe("Step 4 of 4");
    for (const s of ["Cards with no team", "Names not yet linked", "Card titles"]) {
      expect(subtitleOf(s)).toBeNull();
    }
  });

  it("y never shrinks: a card resolved somewhere else still counts as walked", () => {
    const a = row("card-a", "1");
    const b = row("card-b", "2");
    const c = row("card-c", "3");
    const { rerender, onClose } = renderWalker([a, b, c]);
    expect(counter()).toBe("Step 1 of 3");

    // Another tab (or a lookup landing) answers #2, which is not on screen.
    rerenderWith(rerender, onClose, [a, { ...b, teamNoneConfirmedAt: 9 }, c]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#1 Card 1");
    expect(counter()).toBe("Step 2 of 3");

    // …and the rest go the same way. y still holds at the end.
    rerenderWith(rerender, onClose, [
      { ...a, teamNoneConfirmedAt: 9 },
      { ...b, teamNoneConfirmedAt: 9 },
      { ...c, teamNoneConfirmedAt: 9 },
    ]);
    expect(screen.getByText(/All clear/)).toBeTruthy();
    expect(counter()).toBe("Step 3 of 3");
  });

  it("y holds as answered cards leave the live rows, and a card flagged mid-sitting grows it", async () => {
    suggestionsByCard["card-a"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    const a = row("card-a", "1");
    const b = row("card-b", "2");
    const { rerender, onClose } = renderWalker([a, b]);

    fireEvent.click(saveButton());
    await waitFor(() => expect(counter()).toBe("Step 2 of 2"));

    // The write reaches the subscription: #1 is no longer flagged at all.
    const answeredA = { ...a, teamOnCardIds: ["team-tigers"] as unknown as Array<Id<"teams">> };
    rerenderWith(rerender, onClose, [answeredA, b]);
    expect(counter()).toBe("Step 2 of 2");

    // A failed lookup flags another card while #2 is on screen.
    rerenderWith(rerender, onClose, [answeredA, b, row("card-c", "3")]);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#2 Card 2");
    expect(counter()).toBe("Step 2 of 3");
  });

  it("the rail moves forward with a transition that reduced motion switches off, and never animates back", () => {
    const a = row("card-a", "1");
    const b = row("card-b", "2");
    const { rerender, onClose } = renderWalker([a, b]);
    expect(rail().style.width).toBe("50.000%");

    skip();
    expect(rail().style.width).toBe("100.000%");
    expect(rail().getAttribute("data-rail-forward")).toBe("true");
    // The only motion in the walker, and `prefers-reduced-motion` turns it off.
    expect(rail().className).toContain("motion-reduce:transition-none");

    // y grows under the operator: the fill drops, and does so without a
    // transition — a bar sliding backwards reads as lost work.
    rerenderWith(rerender, onClose, [a, b, row("card-c", "3")]);
    expect(counter()).toBe("Step 2 of 3");
    expect(rail().getAttribute("data-rail-forward")).toBe("false");
    expect(rail().className).toContain("transition-none");
    expect(rail().className).not.toContain("transition-[width]");
  });

  it("the rail is hidden from assistive tech; the counter is what is read", () => {
    renderWalker([row("card-a", "1")]);
    expect(rail().closest("[aria-hidden='true']")).toBeTruthy();
    expect(screen.getByText("Step 1 of 1").getAttribute("role")).toBe("status");
  });
});

describe("CardAttentionWalker — the done line (NEO-335)", () => {
  const awaiting = (n: number): CardChecklistRow =>
    needsTeamRow({
      _id: `card-wait-${n}` as unknown as Id<"cardChecklist">,
      cardNumber: String(100 + n),
      cardName: `Waiting ${n}`,
      teamCheckDoneAt: undefined,
    });

  it("isAwaitingTeamLookup: BSC-linked, teamless, unanswered and not yet looked up — nothing else", () => {
    expect(isAwaitingTeamLookup(awaiting(1))).toBe(true);
    // Looked up already (the walk asks it instead).
    expect(isAwaitingTeamLookup(needsTeamRow())).toBe(false);
    // No BSC ref: no lookup to wait for.
    expect(isAwaitingTeamLookup({ ...awaiting(1), platformData: { sportlots: { ref: "sl-1" } } })).toBe(false);
    // Has a team, or a typed team name.
    expect(
      isAwaitingTeamLookup({ ...awaiting(1), teamOnCardIds: ["team-1" as unknown as Id<"teams">] }),
    ).toBe(false);
    expect(isAwaitingTeamLookup({ ...awaiting(1), pendingTeamNames: ["Reds"] })).toBe(false);
    // An operator said it has none.
    expect(isAwaitingTeamLookup({ ...awaiting(1), teamNoneConfirmedAt: 5 })).toBe(false);
  });

  it("walkDoneLine: All clear, or All clear for now with the count still being looked up", () => {
    expect(walkDoneLine(0)).toBe("All clear — nothing on this checklist needs attention.");
    expect(walkDoneLine(1)).toBe("All clear for now. Still looking up teams for 1 card.");
    expect(walkDoneLine(4)).toBe("All clear for now. Still looking up teams for 4 cards.");
  });

  it("says plain All clear when nothing is waiting", () => {
    renderWalker([]);
    const line = screen.getByText("All clear — nothing on this checklist needs attention.");
    // A status line, so the walk ending is announced, not just drawn.
    expect(line.getAttribute("role")).toBe("status");
  });

  it("says how many are still being looked up, and never walks them", () => {
    renderWalker([awaiting(1), awaiting(2)]);
    // Nothing to ask: both are waiting on the lookup, not on a person.
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(
      screen.getByText("All clear for now. Still looking up teams for 2 cards."),
    ).toBeTruthy();
  });

  it("the count follows the live rows as lookups land", () => {
    const { rerender, onClose } = renderWalker([awaiting(1), awaiting(2)]);
    rerender(
      <CardAttentionWalker
        isOpen
        cards={[
          awaiting(1),
          { ...awaiting(2), teamOnCardIds: ["team-1" as unknown as Id<"teams">], teamCheckDoneAt: 9 },
        ]}
        sportId={"sport-1" as unknown as Id<"selectorOptions">}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByText("All clear for now. Still looking up teams for 1 card."),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Keyboard-only
// ---------------------------------------------------------------------------

describe("CardAttentionWalker — keyboard-only", () => {
  it("lands focus on Save & Next on every advance when there are suggestion chips", async () => {
    // NEO-282: the panel says "Enter accepts these" and the button says
    // "Save & Next (Enter)", so the first Enter has to SAVE. It used to land
    // on the first chip, where Enter toggled the suggestion off instead.
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    suggestionsByCard["card-2"] = [
      { teamId: "team-sox", name: "Boston Red Sox", source: "career", playerName: "Garrett Crochet" },
    ];
    renderWalker([
      needsTeamRow(),
      needsTeamRow({ _id: "card-2" as unknown as Id<"cardChecklist">, cardNumber: "2" }),
    ]);

    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
    // And it is the LIVE Save — the preselection has landed, so Enter here is
    // a real save, not a keystroke into an aria-disabled control.
    expect(saveButton().getAttribute("aria-disabled")).toBeNull();
    expect(chip("Detroit Tigers", "Tarik Skubal").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Skip for now, card 1" }));

    // Focus follows the new card rather than staying on a control that
    // belonged to the one just deferred. The walker remounts the fixer per
    // card, so this is the NEXT card's Save button, and its own chip is
    // preselected behind it.
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
    expect(chip("Boston Red Sox", "Garrett Crochet").getAttribute("aria-pressed")).toBe("true");
  });

  it("lands focus on the picker trigger when there is nothing to suggest", async () => {
    // No linked players with careers → no chips → nothing chosen → Save is
    // aria-disabled. Parking focus on an inert Save would be worse than the
    // old behaviour, so focus goes to the first control the operator has to
    // use: the picker's own trigger (stubbed here as "Stub add team").
    renderWalker([needsTeamRow()]);

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stub add team" })),
    );
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("Enter on the focused Save button saves exactly once", async () => {
    // The wrapper's onKeyDown saves on Enter from anywhere inside the fixer,
    // and Enter on a focused <button> ALSO fires its click natively. With
    // focus now starting on Save, that keystroke reaches the fixer twice —
    // keydown then click — and the write must land once. Two things hold
    // that line: the BUTTON guard in the wrapper (the keydown path bails),
    // and the `busy` gate (a second `save` while the first is in flight is
    // a no-op). This pins the OUTCOME; the guard's own load-bearing case is
    // the chip test below, where nothing else stops a toggle from saving.
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    const save = saveButton();
    await waitFor(() => expect(document.activeElement).toBe(save));

    // What the browser does for Enter on a focused button: keydown bubbles
    // (through the wrapper's handler), then the button's click fires.
    fireEvent.keyDown(save, { key: "Enter" });
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-tigers"],
      }),
    );
    expect(mockUpdateCard).toHaveBeenCalledTimes(1);
  });

  it("runs the whole fix from the keyboard: Shift+Tab back to a chip, toggle with Enter, save with Enter", async () => {
    suggestionsByCard["card-1"] = [
      { teamId: "team-tigers", name: "Detroit Tigers", source: "career", playerName: "Tarik Skubal" },
    ];
    const row = needsTeamRow();
    renderWalker([row]);

    await waitFor(() => expect(document.activeElement).toBe(saveButton()));

    // The operator moves off Save to the chip (Shift+Tab in a browser; the
    // test moves focus directly — Tab order is pinned separately below).
    const first = chip("Detroit Tigers", "Tarik Skubal");
    first.focus();
    expect(document.activeElement).toBe(first);

    // Enter on a focused chip toggles it (native button activation) and must
    // NOT also save — the same BUTTON guard that keeps Save from double-firing.
    fireEvent.keyDown(first, { key: "Enter" });
    fireEvent.click(first);
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(first);
    fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), { key: "Enter" });

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: row._id,
        teamOnCardIds: ["team-tigers"],
      }),
    );
  });

  it("keeps Tab inside the dialog", () => {
    renderWalker([needsTeamRow()]);
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>("button:not([disabled])");
    const last = focusable[focusable.length - 1];
    last.focus();

    fireEvent.keyDown(dialog, { key: "Tab" });

    expect(document.activeElement).toBe(focusable[0]);
  });
});

describe("CardAttentionWalker — NEO-331 the set context reaches the team picker", () => {
  it("hands the checklist's row to the fixer's picker as contextOptionId", () => {
    renderWalker([needsTeamRow()], {
      contextOptionId: "variant-1" as unknown as Id<"selectorOptions">,
    });
    expect(
      document.querySelector("[data-context-option-id]")?.getAttribute("data-context-option-id"),
    ).toBe("variant-1");
  });

  it("hands it nothing when the walker was given nothing", () => {
    renderWalker([needsTeamRow()]);
    expect(
      document.querySelector("[data-context-option-id]")?.getAttribute("data-context-option-id"),
    ).toBe("");
  });
});
