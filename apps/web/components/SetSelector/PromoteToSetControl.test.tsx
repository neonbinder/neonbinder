/**
 * NEO-305 — "Promote to set": when the row action shows, what the dialog
 * previews, the clash and its attach answer, and what it sends.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setParallelConversion: {
      getParallelPromotionEligibility: "eligibility",
      getParallelPromotionPreview: "preview",
      promoteParallelToSet: "promote",
    },
  },
}));

let eligibility: unknown;
let previews: Record<string, unknown>;
const mockPromote = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "eligibility") return eligibility;
    if (ref === "preview") return previews[(args as { slSlotKey: string }).slSlotKey];
    return undefined;
  },
  useMutation: (ref: string) => (ref === "promote" ? mockPromote : vi.fn()),
}));

import PromoteToSetControl, { PROMOTE_LABEL, promoteCopy } from "./PromoteToSetControl";

const ROW_ID = "p-pristine" as never;

function preview(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    rowValue: "Pristine",
    brandValue: "Topps",
    setName: "Topps Pristine",
    cardCount: 2,
    rowStays: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  eligibility = { eligible: true, links: [{ slot: "s0", label: "Pristine" }] };
  previews = { s0: preview() };
  mockPromote.mockResolvedValue({
    setId: "set-new",
    baseId: "base-new",
    setValue: "Topps Pristine",
    created: true,
    parallelKept: false,
  });
});

function renderControl() {
  const showToast = vi.fn();
  const onReshaped = vi.fn();
  render(
    <PromoteToSetControl
      parallelId={ROW_ID}
      parallelValue="Pristine"
      showToast={showToast}
      onReshaped={onReshaped}
    />,
  );
  return { showToast, onReshaped };
}

describe("PromoteToSetControl — when it shows", () => {
  it("shows on a parallel carrying a SportLots set", () => {
    renderControl();
    expect(screen.getByRole("button", { name: PROMOTE_LABEL })).toBeTruthy();
  });

  it.each([
    ["the row is not a parallel with a SportLots set", { eligible: false }],
    ["the answer has not arrived", undefined],
  ])("renders nothing when %s", (_why, answer) => {
    eligibility = answer;
    const { container } = render(
      <PromoteToSetControl parallelId={ROW_ID} parallelValue="Blue" showToast={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("PromoteToSetControl — the dialog", () => {
  it("previews the new set, says the empty row goes, opens on the confirm, and promotes", async () => {
    const { showToast, onReshaped } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    const dialog = screen.getByRole("dialog", { name: promoteCopy.title("Pristine") });
    expect(dialog.textContent).toContain(promoteCopy.rowGoes("Pristine"));
    expect(dialog.textContent).toContain("Topps›, Topps Pristine›, Basenew");
    const confirm = screen.getByRole("button", { name: promoteCopy.confirmNew });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(mockPromote).toHaveBeenCalledWith({ parallelId: ROW_ID, slSlotKey: "s0" });
    expect(showToast).toHaveBeenCalledWith(promoteCopy.done("Topps Pristine", true));
    expect(onReshaped).toHaveBeenCalledWith([
      { _id: "set-new", level: "setName" },
      { _id: "base-new", level: "variantType" },
    ]);
  });

  it("a row keeping a BSC set says it stays", () => {
    previews.s0 = preview({ rowStays: true });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    expect(screen.getByRole("dialog").textContent).toContain(promoteCopy.rowStays("Pristine"));
  });

  it("on a name clash, offers to add to that set's Base and sends it", async () => {
    previews.s0 = preview({
      setName: "Topps Chrome",
      clash: { setId: "set-chrome", value: "Topps Chrome", hasBase: true, holdsLink: false },
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    expect(screen.getByRole("dialog").textContent).toContain(
      promoteCopy.clash("Topps", "Topps Chrome"),
    );
    expect(screen.getByRole("dialog").textContent).toContain("Topps Chrome›, Basejoins");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: promoteCopy.confirmAttach("Topps Chrome") }));
    });
    expect(mockPromote).toHaveBeenCalledWith({
      parallelId: ROW_ID,
      slSlotKey: "s0",
      attachToSetId: "set-chrome",
    });
  });

  it.each([
    ["the clashing set has no Base", { hasBase: false, holdsLink: false }],
    ["the clashing set's Base already holds the link", { hasBase: true, holdsLink: true }],
  ])("blocks the confirm when %s", async (_why, flags) => {
    previews.s0 = preview({
      setName: "Topps Chrome",
      clash: { setId: "set-chrome", value: "Topps Chrome", ...flags },
    });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    const confirm = screen.getByRole("button", { name: promoteCopy.confirmNew });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("a refusal the preview already knows is said, and blocks the confirm", () => {
    previews.s0 = preview({ refusal: "1 card on “Pristine” is matched to BSC as well as SportLots, so it can't be split off. Nothing changed." });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    expect(screen.getByRole("dialog").textContent).toContain("can't be split off");
    expect(
      screen.getByRole("button", { name: promoteCopy.confirmNew }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("with several SportLots sets, the operator picks one", async () => {
    eligibility = {
      eligible: true,
      links: [
        { slot: "s0", label: "Pristine" },
        { slot: "s1", label: "Pristine Refractor" },
      ],
    };
    previews.s1 = preview({ setName: "Topps Pristine Refractor" });
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    const first = screen.getByRole("button", { name: "Promote Pristine" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.click(screen.getByRole("button", { name: "Promote Pristine Refractor" }));
    expect(screen.getByRole("dialog").textContent).toContain("Topps Pristine Refractor");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: promoteCopy.confirmNew }));
    });
    expect(mockPromote).toHaveBeenCalledWith({ parallelId: ROW_ID, slSlotKey: "s1" });
  });

  it("a server refusal lands inside the dialog", async () => {
    mockPromote.mockRejectedValue(new ConvexError("Topps already has a set called “Topps Pristine”. Add it to that set's Base instead."));
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: promoteCopy.confirmNew }));
    });
    expect(screen.getByRole("alert").textContent).toContain("already has a set called");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("no two buttons share a name while the dialog is up (the trigger is still in the document)", () => {
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: PROMOTE_LABEL }));
    const names = screen.getAllByRole("button").map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("Escape cancels and hands focus back to the trigger", async () => {
    renderControl();
    const trigger = screen.getByRole("button", { name: PROMOTE_LABEL });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
