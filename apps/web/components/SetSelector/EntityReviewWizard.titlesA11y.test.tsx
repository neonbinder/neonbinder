/**
 * NEO-335 Phase 2 — accessibility-audit items on the wizard's post-review
 * steps:
 *  - the titles step's Next is described by CardTitlesStep's lead heading
 *    (the wizard hands the step a `headingId` and points at it);
 *  - focus lands on the step's control even when that control mounts AFTER
 *    the screen was decided (the dialog opening late, or the titles-only
 *    entry whose title context arrives a render later).
 *
 * CardTitlesStep is stubbed to the part of its contract this file needs: it
 * renders its lead heading under the id it is given. Its own behaviour is in
 * CardTitlesStep.test.tsx.
 */
import { fireEvent, render, screen } from "@testing-library/react";
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

const stepProps: Array<{ headingId?: string }> = [];
vi.mock("./CardTitlesStep", () => ({
  default: (props: { headingId?: string }) => {
    stepProps.push(props);
    return <h3 id={props.headingId}>Trimmed to fit. Keep it, or make it yours.</h3>;
  },
}));

import EntityReviewWizard from "./EntityReviewWizard";

const NEXT_NAME = "Next (Enter)";
/** Long enough that every new card's title is trimmed. */
const LONG_TITLES = {
  sportValue: "Baseball",
  setNameValue: "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box",
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
  setTeamNames: [],
  players: [],
  teams: [],
};
const TEAMED = [{ cardNumber: "1", cardName: "Base", players: ["Pete Rose"], teams: ["Reds"] }];

function wizard(props: Record<string, unknown> = {}) {
  return (
    <EntityReviewWizard
      isOpen
      teamsOnly
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId=""
      summary={{ cardCount: 1, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      previewCards={TEAMED}
      onTeamAnswersChange={vi.fn()}
      titleContext={LONG_TITLES}
      {...props}
    />
  );
}

describe("the titles step's Next", () => {
  it("is described by the step's lead heading, through the id the wizard hands the step", () => {
    render(wizard());
    const next = screen.getByRole("button", { name: NEXT_NAME });
    const describedBy = next.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(stepProps.at(-1)?.headingId).toBe(describedBy);
    const lead = document.getElementById(describedBy!);
    expect(lead?.textContent).toBe("Trimmed to fit. Keep it, or make it yours.");
  });
});

describe("focus follows the step even when its control mounts late", () => {
  it("lands on Next when the dialog opens after the screen was already decided", () => {
    const { rerender } = render(wizard({ isOpen: false }));
    expect(screen.queryByRole("button", { name: NEXT_NAME })).toBeNull();
    rerender(wizard({ isOpen: true }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: NEXT_NAME }));
  });

  it("titles-only entry: moves to Next once the title context arrives", () => {
    const { rerender } = render(wizard({ titleContext: undefined }));
    // No titles step yet: Save, with Confirm & Save focused.
    expect(document.activeElement?.textContent).toBe("Confirm & Save (Enter)");
    rerender(wizard());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: NEXT_NAME }));
  });

  it("leaves focus alone once given, on the same screen", () => {
    const { rerender } = render(wizard());
    const next = screen.getByRole("button", { name: NEXT_NAME });
    expect(document.activeElement).toBe(next);
    const cancel = screen.getByRole("button", { name: /^Cancel \(Esc\)/ });
    cancel.focus();
    rerender(wizard());
    expect(document.activeElement).toBe(cancel);
  });

  it("keeps the Next marker class and the auto-repeat guard on the titles-only entry", () => {
    const onConfirm = vi.fn();
    render(wizard({ onConfirm }));
    const next = screen.getByRole("button", { name: NEXT_NAME });
    expect(next.className).toMatch(/mb-field-\S*-btn-next-step/);
    // Next by keyboard, then a held Enter's repeat on Confirm & Save: no commit.
    fireEvent.keyDown(next, { key: "Enter" });
    const confirm = document.activeElement as HTMLElement;
    expect(confirm.textContent).toBe("Confirm & Save (Enter)");
    fireEvent.keyDown(confirm, { key: "Enter", repeat: true });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

void React;
