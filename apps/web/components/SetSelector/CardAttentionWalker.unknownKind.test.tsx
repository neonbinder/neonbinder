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

import { fireEvent, render, screen } from "@testing-library/react";
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
});
