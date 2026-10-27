/**
 * NEO-361 — the admin's review of one card request: approving it as a card
 * already in the set with that number, adding it to its checklist and
 * approving, and declining with a note. The server half (copies moving,
 * the exactly-one guard) is collectionRequests.test.ts.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { name: string; args: unknown }[]);
const answers = vi.hoisted(() => new Map<string, unknown>());

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : answers.get(getFunctionName(ref))),
    useMutation: (ref: never) => async (args: unknown) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const answer = answers.get(name);
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
});
// The picker reads players and the theme; neither matters here.
vi.mock("@/components/SetSelector/PlayerPicker", () => ({ default: () => null }));

import RequestReview from "./RequestReview";

const SET = {
  _id: "st",
  name: "Contenders",
  season: "1996",
  sport: { _id: "sp", name: "Football" },
  year: { _id: "yr", name: "1996" },
  manufacturer: { _id: "br", name: "Playoff" },
};
const BASE = { _id: "base", name: "Base" };

function review(over: Record<string, unknown> = {}) {
  return {
    _id: "r1",
    kind: "card",
    status: "waiting",
    label: "1996 Contenders #41 Reggie White",
    ownerId: "user",
    requestedAt: 1,
    privateCard: {
      _id: "p1",
      requestId: "r1",
      status: "waiting",
      cardNumber: "41",
      player: "Reggie White",
      set: SET,
      variant: BASE,
      privateSet: null,
    },
    privateSet: null,
    privateSetCards: [],
    sameNumber: [],
    copies: 1,
    ...over,
  };
}

function show() {
  return render(
    <MemoryRouter>
      <RequestReview requestId={"r1" as never} onDone={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  answers.set("collectionRequests:approveCard", { moved: 1 });
});

describe("RequestReview", () => {
  it("approves as a card already in the set with that number, with the note", async () => {
    answers.set(
      "collectionRequests:review",
      review({ sameNumber: [{ _id: "k9", cardNumber: "41", cardName: "Reggie White", variant: { name: "Gold" } }] }),
    );
    show();
    fireEvent.change(screen.getByLabelText("Note to the collector (optional)"), { target: { value: "It's the Gold." } });
    fireEvent.click(screen.getByRole("button", { name: "This is the card: Gold #41 Reggie White" }));
    await waitFor(() =>
      expect(calls).toEqual([
        { name: "collectionRequests:approveCard", args: { requestId: "r1", cardId: "k9", note: "It's the Gold." } },
      ]),
    );
    const outcome = await screen.findByText("Added. One line of their copies moved onto it.");
    // The outcome takes the keyboard: the button that acted is gone with its form.
    await waitFor(() => expect(document.activeElement?.contains(outcome)).toBe(true));
  });

  it("adds the card to its checklist, then approves it as that card", async () => {
    answers.set("collectionRequests:review", review());
    answers.set("selectorOptions:addCustomCard", "k10");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Add and approve" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({
      name: "selectorOptions:addCustomCard",
      args: { selectorOptionId: "base", cardNumber: "41", cardName: "Reggie White" },
    });
    expect(calls[1]).toEqual({ name: "collectionRequests:approveCard", args: { requestId: "r1", cardId: "k10" } });
  });

  it("sends a typed checklist to the set builder, and declines", async () => {
    answers.set(
      "collectionRequests:review",
      review({ privateCard: { ...review().privateCard, variant: null, variantName: "Gold Foil" } }),
    );
    answers.set("collectionRequests:decline", null);
    show();
    expect(screen.queryByRole("button", { name: "Add and approve" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open the set builder" }).getAttribute("href")).toBe(
      "/admin/set-builder?sport=sp&year=yr&brand=br&set=st",
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(calls).toEqual([{ name: "collectionRequests:decline", args: { requestId: "r1" } }]));
  });
});
