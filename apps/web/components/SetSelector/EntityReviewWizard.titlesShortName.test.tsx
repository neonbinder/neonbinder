/**
 * NEO-335 title rules — the wizard carries the Card titles step's short name
 * to the commit (`onListingShortNameChange`, the commit's batch-level
 * `listingShortName`) ONLY when the step was shown, asked for one, and the
 * operator typed one or took the suggestion — and the kept titles it reports
 * are the ones generated with that same name.
 *
 * The real CardTitlesStep renders here; its own behaviour is pinned in
 * CardTitlesStep.shortName.test.tsx.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => {
  const moduleProxy = (mod: string) =>
    new Proxy({}, { get: (_t, fn) => `${mod}.${String(fn)}` });
  return { api: new Proxy({}, { get: (_t, mod) => moduleProxy(String(mod)) }) };
});

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useQueries: (queries: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(queries)) out[key] = undefined;
    return out;
  },
  useMutation: () => vi.fn(() => Promise.resolve(0)),
  useAction: () => vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("./EntityLinkSearch", () => ({ default: () => null }));

import EntityReviewWizard from "./EntityReviewWizard";

const LABEL = "Shorter set name for titles";
/** Long enough that every new card's title is trimmed. */
const LONG_TITLES = {
  sportValue: "Baseball",
  setNameValue: "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box",
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
  setTeamNames: [],
  players: [],
  teams: [],
};
const CARDS = [{ cardNumber: "1", cardName: "Base", players: ["Pete Rose"], teams: ["Reds"] }];

function setup(props: Record<string, unknown> = {}) {
  const onListingShortNameChange = vi.fn();
  const onTitleAnswersChange = vi.fn();
  render(
    <EntityReviewWizard
      isOpen
      teamsOnly
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId=""
      summary={{ cardCount: 1, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      previewCards={CARDS}
      onTeamAnswersChange={vi.fn()}
      titleContext={LONG_TITLES}
      onTitleAnswersChange={onTitleAnswersChange}
      onListingShortNameChange={onListingShortNameChange}
      {...props}
    />,
  );
  const sent = () =>
    onListingShortNameChange.mock.calls.map((c) => c[0]).filter((v) => v !== undefined);
  return { onListingShortNameChange, onTitleAnswersChange, sent };
}

describe("the short name reaches the commit only when the step collected it", () => {
  it("typed on the titles step: reported, and the cards it fits send no kept title", () => {
    const { onListingShortNameChange, onTitleAnswersChange } = setup();
    // Before anything is typed, the trimmed title is kept.
    expect(onTitleAnswersChange.mock.calls.at(-1)?.[0]?.[0]?.listingTitleKept).toContain(
      "Chrome Update",
    );
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "Topps Sapphire" } });
    fireEvent.blur(field);
    expect(onListingShortNameChange).toHaveBeenLastCalledWith("Topps Sapphire");
    expect(onTitleAnswersChange).toHaveBeenLastCalledWith([undefined]);
  });

  it("a title the operator wrote before the short name still rides on the commit", () => {
    const { onTitleAnswersChange } = setup();
    const own = screen.getByRole("textbox", { name: /^Title for #1/ });
    fireEvent.change(own, { target: { value: "My Pete Rose title #1" } });
    fireEvent.blur(own);
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "Topps Sapphire" } });
    fireEvent.blur(field);
    expect(onTitleAnswersChange).toHaveBeenLastCalledWith([
      { listingTitle: "My Pete Rose title #1" },
    ]);
  });

  it("'Use suggestion' is reported the same way", () => {
    const { onListingShortNameChange } = setup();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    });
    expect(onListingShortNameChange).toHaveBeenLastCalledWith("Topps Chrome");
  });

  it("the field shown but left empty: nothing is sent (a suggestion is never stored on its own)", () => {
    const { sent } = setup();
    expect(screen.getByRole("textbox", { name: LABEL })).toBeTruthy();
    expect(sent()).toEqual([]);
  });

  it("a name the server would refuse is not sent, and the titles stay the full-name ones", () => {
    const { sent, onTitleAnswersChange } = setup();
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "Topps​Sapphire" } });
    fireEvent.blur(field);
    expect(sent()).toEqual([]);
    expect(onTitleAnswersChange.mock.calls.at(-1)?.[0]?.[0]?.listingTitleKept).toContain(
      "Chrome Update",
    );
  });

  it("a short name already stored: no field, nothing sent", () => {
    const { sent } = setup({ titleContext: { ...LONG_TITLES, listingShortName: "Topps Sapphire" } });
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
    expect(sent()).toEqual([]);
  });

  it("no titles step at all: nothing sent", () => {
    const { sent } = setup({ titleContext: { ...LONG_TITLES, setNameValue: "Chrome" } });
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
    expect(sent()).toEqual([]);
  });

  it("without a commit to carry it, the step never asks", () => {
    setup({ onListingShortNameChange: undefined });
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
  });
});

void React;
