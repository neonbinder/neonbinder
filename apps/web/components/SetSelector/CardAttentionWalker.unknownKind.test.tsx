/**
 * NEO-102 — `CardAttentionWalker` against an attention kind this bundle has no
 * fixer for.
 *
 * This is a real state, not a hypothetical: NEO-101 appends
 * `titleOverLimit` / `titleTruncated` / `aspectValueOverLimit` to the same
 * `AttentionItem` union, and a Convex deploy is a hard cutover — a browser
 * holding an older SPA bundle will read rows flagged for kinds its registry
 * does not know. It must render no fixer body (nothing that could write the
 * wrong thing) while keeping Skip and Close reachable, rather than throwing
 * inside a modal the operator then cannot leave.
 *
 * Lives in its own file because proving it requires module-mocking
 * `./card-attention` to produce a kind that does not exist in this bundle's
 * union — which every other test in CardAttentionWalker.test.tsx needs to be
 * real.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
    selectorOptions: { updateCard: "selectorOptions.updateCard" },
    players: { getManyByIds: "players.getManyByIds" },
    teams: { getManyByIds: "teams.getManyByIds", list: "teams.list" },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: () => [],
  useMutation: () => vi.fn(),
}));

// A kind from a future deploy: flagged by the server, unknown to this bundle.
vi.mock("./card-attention", () => ({
  deriveCardAttention: () => [{ kind: "titleOverLimit" }],
  needsAttention: () => true,
  attentionItemLabel: () => "has a title over the marketplace limit",
  ATTENTION_LABELS: {},
}));

import CardAttentionWalker from "./CardAttentionWalker";

describe("CardAttentionWalker — a kind with no registered fixer", () => {
  function renderWalker() {
    const onClose = vi.fn();
    render(
      <CardAttentionWalker
        isOpen
        cards={[
          {
            _id: "card-1" as unknown as Id<"cardChecklist">,
            cardNumber: "1",
            cardName: "A Very Long Card Name Indeed",
          },
        ]}
        onClose={onClose}
      />,
    );
    return { onClose };
  }

  it("renders no fixer, says why, and still counts the card", () => {
    renderWalker();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/no fixer for it/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("1 card needs attention");
    // Nothing that could write the wrong thing.
    expect(screen.queryByRole("button", { name: /Save & Next/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "No team on this card" })).toBeNull();
  });

  it("leaves Skip and Close reachable so the operator is never stuck", () => {
    const { onClose } = renderWalker();

    expect(screen.getByRole("button", { name: "Skip card 1 for now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip card 1 for now" }));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Skip-ing between two cards neither of which has a fixer does not yank focus off Skip", async () => {
    // Nothing unmounts on this transition — the Skip button is the SAME DOM
    // node before and after (only its label/handler update), so focus is
    // already exactly where it should be. The walker's advance-time focus
    // effect (CardAttentionWalker.tsx) is guarded on `document.activeElement`
    // actually having dropped to <body> for exactly this reason: an earlier,
    // unconditional version of that fix would have yanked focus off Skip and
    // onto the dialog container on every such advance, for no reason.
    const onClose = vi.fn();
    render(
      <CardAttentionWalker
        isOpen
        cards={[
          { _id: "card-1" as unknown as Id<"cardChecklist">, cardNumber: "1", cardName: "First" },
          { _id: "card-2" as unknown as Id<"cardChecklist">, cardNumber: "2", cardName: "Second" },
        ]}
        onClose={onClose}
      />,
    );

    const skip1 = screen.getByRole("button", { name: "Skip card 1 for now" });
    skip1.focus();
    fireEvent.click(skip1);

    const skip2 = screen.getByRole("button", { name: "Skip card 2 for now" });
    expect(skip2).toBe(skip1); // literally the same node, per the comment above

    // Give the walker's own requestAnimationFrame-scheduled effect a full
    // tick to run, so a regression that fires unconditionally has a chance
    // to show up before we assert it did not.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(skip2);
  });

  it("Skip-ing the LAST no-fixer card to all-clear parks focus on the dialog, not <body>", async () => {
    const onClose = vi.fn();
    render(
      <CardAttentionWalker
        isOpen
        cards={[{ _id: "card-1" as unknown as Id<"cardChecklist">, cardNumber: "1", cardName: "Only" }]}
        onClose={onClose}
      />,
    );

    // Let the open effect's own one-shot fallback settle first — see the
    // comment on the equivalent wait in CardAttentionWalker.test.tsx's
    // "falls through to the all-clear step" test for why a real animation
    // frame always elapses here in practice.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("BUTTON"));

    const skip = screen.getByRole("button", { name: "Skip card 1 for now" });
    skip.focus();
    fireEvent.click(skip);

    expect(screen.getByText(/All clear/)).toBeTruthy();
    // Skip itself unmounted (current is now null) — this IS a real unmount,
    // unlike the no-fixer-to-no-fixer case above, so the park has to fire.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
  });
});
