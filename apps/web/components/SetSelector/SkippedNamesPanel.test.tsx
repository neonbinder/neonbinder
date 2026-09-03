/**
 * NEO-212 — coverage for `SkippedNamesPanel`, the see-and-undo surface for the
 * review wizard's "Skip — not a person/team" decision.
 *
 * The security review's objection to skips was that they are the one decision
 * in this feature with no visible record and no way back: the name is filtered
 * out of every later fetch of that set, silently, forever. So the two things
 * pinned hardest here are the ones that objection turns on — that a skip is
 * SHOWN (name, kind, when), and that clearing it is reachable and reports what
 * clearing actually does (the name returns on the NEXT SYNC, not immediately).
 *
 * Also pinned: the panel renders no chrome at all when there is nothing to
 * show. It sits under the sync controls of a screen that is already dense, and
 * a permanent empty "Skipped names (0)" disclosure would be noise on every set
 * that has never skipped anything — which is nearly all of them.
 *
 * --- Mocking strategy ---
 * Mirrors EntityReviewWizard.test.tsx: convex/react's useQuery/useMutation are
 * module-mocked and routed by the (string-mocked) query/mutation reference, so
 * no Convex client is involved.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    entityReviewSkips: {
      listForSet: "entityReviewSkips.listForSet",
      clearSkip: "entityReviewSkips.clearSkip",
    },
  },
}));

let currentSkips: unknown;
const mockClearSkip = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "entityReviewSkips.listForSet") return currentSkips;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "entityReviewSkips.clearSkip") return mockClearSkip;
    return vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import SkippedNamesPanel from "./SkippedNamesPanel";

const SELECTOR_OPTION_ID = "selopt-1" as unknown as Id<"selectorOptions">;

/** 2026-09-03T17:00:00Z — formatted with an explicit locale-free short date. */
const SKIPPED_AT = new Date(2026, 8, 3, 12, 0, 0).getTime();

function makeSkip(overrides: Partial<{
  _id: string;
  kind: "player" | "team";
  name: string;
  skippedAt: number;
}> = {}) {
  return {
    _id: "skip-1",
    kind: "player" as const,
    name: "Checklist",
    skippedAt: SKIPPED_AT,
    ...overrides,
  };
}

function renderPanel() {
  return render(<SkippedNamesPanel selectorOptionId={SELECTOR_OPTION_ID} />);
}

beforeEach(() => {
  currentSkips = undefined;
  mockClearSkip.mockReset();
  mockClearSkip.mockResolvedValue(null);
});

describe("SkippedNamesPanel — no chrome when there is nothing to show", () => {
  it("renders nothing while the query is still loading", () => {
    currentSkips = undefined;
    const { container } = renderPanel();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the set has no skipped names", () => {
    currentSkips = [];
    const { container } = renderPanel();
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/Skipped names/)).toBeNull();
  });
});

describe("SkippedNamesPanel — the record of what was skipped", () => {
  it("shows the count in the summary's visible text and accessible name", () => {
    currentSkips = [
      makeSkip({ _id: "skip-1", name: "Checklist" }),
      makeSkip({ _id: "skip-2", name: "Team Card", kind: "team" }),
    ];
    renderPanel();

    const summary = screen.getByLabelText(
      "Skipped names (2) — not players or teams",
    );
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.textContent).toContain("Skipped names (2)");
  });

  it("explains what a skip means and how to take it back", () => {
    currentSkips = [makeSkip()];
    renderPanel();

    expect(screen.getByText(
        "These names were marked not a person or team and will not be offered again for this set. Unskip a name to review it on the next sync.",
      ),
    ).toBeTruthy();
  });

  it("lists each skipped name with its kind and the date it was skipped", () => {
    currentSkips = [
      makeSkip({ _id: "skip-1", name: "Checklist", kind: "player" }),
      makeSkip({ _id: "skip-2", name: "Team Card", kind: "team" }),
    ];
    renderPanel();

    const list = screen.getByRole("list", { name: "Skipped names" });
    expect(list).toBeTruthy();

    const when = new Date(SKIPPED_AT).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(screen.getByText(`Checklist · player · skipped ${when}`),
    ).toBeTruthy();
    expect(screen.getByText(`Team Card · team · skipped ${when}`),
    ).toBeTruthy();
  });

  it("gives each Unskip button a name-specific accessible name", () => {
    currentSkips = [
      makeSkip({ _id: "skip-1", name: "Checklist" }),
      makeSkip({ _id: "skip-2", name: "Team Card", kind: "team" }),
    ];
    renderPanel();

    // Visible text is the same on every row; the accessible name is what
    // distinguishes them, so two rows must not collide.
    expect(screen.getAllByText("Unskip")).toHaveLength(2);
    expect(screen.getByLabelText("Unskip Checklist")).toBeTruthy();
    expect(screen.getByLabelText("Unskip Team Card")).toBeTruthy();
  });
});

describe("SkippedNamesPanel — the undo", () => {
  it("calls clearSkip with the row's id and announces the result politely", async () => {
    currentSkips = [
      makeSkip({ _id: "skip-1", name: "Checklist" }),
      makeSkip({ _id: "skip-2", name: "Team Card", kind: "team" }),
    ];
    renderPanel();

    fireEvent.click(screen.getByLabelText("Unskip Checklist"));

    await waitFor(() => {
      expect(mockClearSkip).toHaveBeenCalledWith({ skipId: "skip-1" });
    });

    const status = await screen.findByRole("status");
    // The message must say NEXT SYNC — nothing re-opens the wizard here, and
    // "Unskipped" on its own would read as though the name came back now.
    expect(status.textContent).toBe(
      "Unskipped Checklist — it will be reviewed on the next sync.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the confirmation on screen after the last skip is cleared", async () => {
    currentSkips = [makeSkip({ _id: "skip-1", name: "Checklist" })];
    const { rerender } = renderPanel();

    fireEvent.click(screen.getByLabelText("Unskip Checklist"));
    await waitFor(() => expect(mockClearSkip).toHaveBeenCalled());

    // The reactive query drops the row it just deleted.
    currentSkips = [];
    rerender(<SkippedNamesPanel selectorOptionId={SELECTOR_OPTION_ID} />);

    // The disclosure is gone (nothing left to disclose) but the live-region
    // line survives, so the confirmation is not unmounted before it is read.
    expect(screen.queryByText(/Skipped names \(/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Unskipped Checklist — it will be reviewed on the next sync.",
    );
  });

  it("reports a failure as an alert, using the backend's own message", async () => {
    currentSkips = [makeSkip({ _id: "skip-1", name: "Checklist" })];
    mockClearSkip.mockRejectedValue(
      new ConvexError("Only an admin can change skipped names."),
    );
    renderPanel();

    fireEvent.click(screen.getByLabelText("Unskip Checklist"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Only an admin can change skipped names.");
    expect(screen.queryByRole("status")).toBeNull();
    // The row is still there — nothing was cleared.
    expect(screen.getByLabelText("Unskip Checklist")).toBeTruthy();
  });

  it("falls back to its own message when the failure carries none", async () => {
    currentSkips = [makeSkip({ _id: "skip-1", name: "Checklist" })];
    // A plain Error is redacted to "Server Error" in production, so its
    // `.message` is never shown — see lib/errors/user-facing-message.ts.
    mockClearSkip.mockRejectedValue(new Error("boom"));
    renderPanel();

    fireEvent.click(screen.getByLabelText("Unskip Checklist"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't unskip Checklist. Try again.");
    expect(alert.textContent).not.toContain("boom");
  });
});
