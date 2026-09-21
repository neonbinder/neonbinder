/**
 * NEO-237 (D11–D13) — `SetCandidateReviewModal`, the "new on SportLots"
 * review screen.
 *
 * Nothing here mocks Convex — like `SelectorSyncReviewModal.test.tsx`, the
 * component is props in, result out (`SetCandidatesPill` owns the queries and
 * mutations and is not exercised here). Covers the load-bearing properties
 * from the component's own docstring: Escape writes nothing, Create/Skip/
 * Bring back call the right mutation with the right argument, and focus is
 * parked on the dialog once a row leaves and focus has actually dropped to
 * `<body>`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import SetCandidateReviewModal, {
  candidatePillText,
  createRefusal,
  defaultSetName,
  groupCandidatesByBrand,
  memberSummary,
  prependedPrefix,
  skippedToggleText,
  type SetCandidate,
} from "./SetCandidateReviewModal";

const candidateId = (n: number) => `setcand_${n}` as Id<"setCandidates">;
const manufacturerId = (n: number) => `selopt_${n}` as Id<"selectorOptions">;

function candidate(over: Partial<SetCandidate> = {}): SetCandidate {
  return {
    _id: candidateId(1),
    manufacturerId: manufacturerId(1),
    side: "sportlots",
    label: "Heritage",
    defaultName: "Topps Heritage",
    brandPrefix: "Topps",
    members: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("candidatePillText", () => {
  it("names the count", () => {
    expect(candidatePillText(3)).toBe("3 new on SportLots");
  });
});

describe("memberSummary", () => {
  it("is empty for a root with no members", () => {
    expect(memberSummary([])).toBe("");
  });
  it("says what a member IS, not 'variants'", () => {
    expect(memberSummary([{ label: "Chrome Sepia" }, { label: "Chrome Refractor" }])).toBe(
      "+ 2 more starting with it",
    );
  });
});

describe("skippedToggleText", () => {
  it("is empty when nothing is skipped", () => {
    expect(skippedToggleText(0, false)).toBe("");
  });
  it("says Show/Hide with the count", () => {
    expect(skippedToggleText(3, false)).toBe("Show skipped (3)");
    expect(skippedToggleText(3, true)).toBe("Hide skipped (3)");
  });
});

describe("defaultSetName / prependedPrefix", () => {
  it("the field starts as the server's defaultName", () => {
    expect(defaultSetName(candidate())).toBe("Topps Heritage");
  });

  it("the lead-in is the brandPrefix when it was actually prepended", () => {
    expect(prependedPrefix(candidate())).toBe("Topps");
  });

  it("no lead-in when defaultName equals the label (nothing prepended)", () => {
    expect(
      prependedPrefix(
        candidate({ label: "Topps Chrome", defaultName: "Topps Chrome" }),
      ),
    ).toBeNull();
  });

  it("no lead-in when the brand carries no prefix (e.g. Unknown)", () => {
    expect(
      prependedPrefix(
        candidate({ brandPrefix: undefined, defaultName: "Carddass" }),
      ),
    ).toBeNull();
  });
});

describe("groupCandidatesByBrand", () => {
  it("groups rows without a brand into one ungrouped list", () => {
    const groups = groupCandidatesByBrand([candidate(), candidate({ _id: candidateId(2) })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].brand).toBeUndefined();
    expect(groups[0].items).toHaveLength(2);
  });

  it("groups by manufacturerId, first-seen order, for the All Brands view", () => {
    const topps = candidate({ brand: "Topps" });
    const bowman = candidate({
      _id: candidateId(2),
      manufacturerId: manufacturerId(2),
      brand: "Bowman",
      label: "Draft",
    });
    const groups = groupCandidatesByBrand([topps, bowman]);
    expect(groups.map((g) => g.brand)).toEqual(["Topps", "Bowman"]);
  });
});

describe("createRefusal", () => {
  it("reads CUSTOM_VALUE_INVALID's reason", () => {
    expect(
      createRefusal({ data: { code: "CUSTOM_VALUE_INVALID", reason: "Name cannot be empty" } }),
    ).toBe("Name cannot be empty");
  });

  it("names the clashing set for SET_NAME_CLASH_AT_TARGET", () => {
    expect(
      createRefusal({
        data: { code: "SET_NAME_CLASH_AT_TARGET", existingId: "x", value: "Chrome" },
      }),
    ).toMatch(/'Chrome' is already a set under this brand/);
  });

  it("returns null for an unrecognised error shape", () => {
    expect(createRefusal(new Error("boom"))).toBeNull();
    expect(createRefusal("boom")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

function renderModal(props: Partial<React.ComponentProps<typeof SetCandidateReviewModal>> = {}) {
  const onClose = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onSkip = vi.fn().mockResolvedValue(undefined);
  const onUnskip = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <SetCandidateReviewModal
      isOpen
      candidates={[candidate()]}
      viewMode={false}
      onClose={onClose}
      onCreate={onCreate}
      onSkip={onSkip}
      onUnskip={onUnskip}
      {...props}
    />,
  );
  return { onClose, onCreate, onSkip, onUnskip, ...utils };
}

describe("SetCandidateReviewModal — the dialog", () => {
  it("Escape closes and writes nothing", () => {
    const { onClose, onCreate, onSkip } = renderModal();
    fireEvent.change(screen.getByLabelText('Name for "Heritage"'), {
      target: { value: "Something Else" },
    });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("Create set calls onCreate with the candidate id and the field's current value", async () => {
    const { onCreate } = renderModal();
    fireEvent.change(screen.getByLabelText('Name for "Heritage"'), {
      target: { value: "Topps Heritage Custom" },
    });
    fireEvent.click(screen.getByLabelText('Create set from "Heritage"'));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(candidateId(1), "Topps Heritage Custom"),
    );
  });

  it("Enter in the name field also fires Create", async () => {
    const { onCreate } = renderModal();
    const field = screen.getByLabelText('Name for "Heritage"');
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(candidateId(1), "Topps Heritage"));
  });

  it("Skip calls onSkip with the candidate id", async () => {
    const { onSkip } = renderModal();
    fireEvent.click(screen.getByLabelText('Skip "Heritage"'));
    await waitFor(() => expect(onSkip).toHaveBeenCalledWith(candidateId(1)));
  });

  it("Show skipped reveals the way-back list, and Bring back calls onUnskip", async () => {
    const skipped = [candidate({ _id: candidateId(2), label: "Chrome" })];
    const { onUnskip } = renderModal({ candidates: [candidate()], skipped });

    fireEvent.click(screen.getByText("Show skipped (1)"));
    fireEvent.click(screen.getByLabelText('Bring back "Chrome"'));
    await waitFor(() => expect(onUnskip).toHaveBeenCalledWith(candidateId(2)));
  });

  it("the skipped toggle does not render when nothing is skipped", () => {
    renderModal({ skipped: [] });
    expect(screen.queryByText(/Show skipped/)).toBeNull();
  });

  it("groups by brand and shows an eyebrow heading in view mode", () => {
    renderModal({
      viewMode: true,
      candidates: [
        candidate({ brand: "Topps" }),
        candidate({ _id: candidateId(2), manufacturerId: manufacturerId(2), brand: "Bowman", label: "Draft" }),
      ],
    });
    expect(screen.getByText("Topps")).toBeTruthy();
    expect(screen.getByText("Bowman")).toBeTruthy();
  });

  it("shows the muted brand lead-in before the label when one was prepended", () => {
    renderModal();
    // The lead-in and the label are separate text nodes in the same <p>; the
    // label itself must still be findable as its own direct text.
    expect(screen.getByText("Heritage")).toBeTruthy();
    expect(screen.getByText("Topps ·", { exact: false })).toBeTruthy();
  });

  it("'All caught up' renders instead of a list when candidates is empty", () => {
    renderModal({ candidates: [] });
    expect(screen.getByText(/All caught up/)).toBeTruthy();
  });

  it("focus lands on the dialog container once a row leaves and focus dropped to <body>", async () => {
    const { rerender, onSkip } = renderModal({
      candidates: [candidate(), candidate({ _id: candidateId(2), label: "Chrome" })],
    });

    const skipBtn = screen.getByLabelText('Skip "Heritage"');
    fireEvent.click(skipBtn);
    await waitFor(() => expect(onSkip).toHaveBeenCalled());

    // The row leaves the list: the parent (a reactive query in production)
    // re-renders with the candidate removed. In a real browser, removing the
    // focused element from the document drops focus to <body>; happy-dom does
    // not model that side effect (and the mount-time rAF may have already
    // moved focus to Close), so the blur is applied to whatever currently
    // holds focus, to reach the state the component's effect actually watches
    // for: focus having ACTUALLY dropped to <body>.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(
      <SetCandidateReviewModal
        isOpen
        candidates={[candidate({ _id: candidateId(2), label: "Chrome" })]}
        viewMode={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onSkip={onSkip}
        onUnskip={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
  });

  it("returns null and renders nothing when isOpen is false", () => {
    const { container } = render(
      <SetCandidateReviewModal
        isOpen={false}
        candidates={[candidate()]}
        viewMode={false}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
