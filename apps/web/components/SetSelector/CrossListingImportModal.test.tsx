/**
 * NEO-296 — the cross-release import is sliced, so it can stop HALF DONE.
 *
 * What this file pins is the consequence of that slicing, not the drill:
 *
 *  1. **A mid-slice failure reports what already committed.** Each slice is
 *     its own transaction, so slice 1 linking 400 cards is durable whether or
 *     not slice 2 succeeds. The first version of the loop kept its accumulator
 *     inside the `try`, so a throw in slice 2 reported "Import failed: …" and
 *     those 400 links were reported to nobody — the same shape as the
 *     "Nothing was saved" falsehood this branch removed from the wizard,
 *     reintroduced one loop later. This is the regression a future refactor
 *     would bring straight back, which is why it is asserted here rather than
 *     left to a reading of the code.
 *  2. **There is a running count between slices**, because one press is now up
 *     to three sequential round-trips and a button reading "Linking…" for that
 *     long looks hung and invites a second press.
 *  3. **The in-flight controls use `aria-disabled`, never native `disabled`**,
 *     which blurs the just-pressed button to `<body>` for the whole import.
 *
 * Mocking mirrors MoveSetToBrandControl.test.tsx: `convex/react` is
 * module-mocked and routed by the string-mocked query reference.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "selectorOptions.getSelectorOptions",
      addCrossListingsByCardNumbers:
        "selectorOptions.addCrossListingsByCardNumbers",
    },
  },
}));

/**
 * One option per level down to `variantType`, and NONE at `insert` — which is
 * the modal's own auto-stop: an empty optional level settles the source at its
 * parent, so the drill is five taps and no "use … as the source set".
 */
const OPTIONS: Record<string, Array<{ _id: string; value: string }>> = {
  sport: [{ _id: "sport-1", value: "Baseball" }],
  year: [{ _id: "year-1", value: "1996" }],
  manufacturer: [{ _id: "mfr-1", value: "Score" }],
  setName: [{ _id: "set-1", value: "Score" }],
  variantType: [{ _id: "var-1", value: "Base" }],
  insert: [],
  parallel: [],
};

const mockAddCrossListings = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (query: string, args: unknown) => {
    if (query !== "selectorOptions.getSelectorOptions") return undefined;
    if (args === "skip") return undefined;
    const { level } = args as { level: string };
    return OPTIONS[level] ?? [];
  },
  useMutation: () => mockAddCrossListings,
}));

import CrossListingImportModal from "./CrossListingImportModal";
import { CROSS_LISTING_LINKS_PER_CALL } from "../../lib/cards/commit-limits";

/** A promise this test resolves by hand, so mid-import state is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unhandled rejection is only unhandled until the component's own catch
  // attaches; keep node quiet in the window before that.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const onClose = vi.fn();

function renderModal() {
  return render(
    <CrossListingImportModal
      isOpen
      onClose={onClose}
      targetVariantId={"target-variant" as never}
    />,
  );
}

/** Walk to the source set: five taps, then the optional level auto-stops. */
function drillToSource() {
  fireEvent.click(screen.getByLabelText("Pick Sport Baseball"));
  fireEvent.click(screen.getByLabelText("Pick Year 1996"));
  fireEvent.click(screen.getByLabelText("Pick Manufacturer Score"));
  fireEvent.click(screen.getByLabelText("Pick Set Score"));
  fireEvent.click(screen.getByLabelText("Pick Variant Base"));
  expect(screen.getByText("Source set: Base")).toBeTruthy();
}

function typeNumbers(value: string) {
  fireEvent.change(screen.getByLabelText("Card numbers to cross-list"), {
    target: { value },
  });
}

function submitButton(): HTMLButtonElement {
  return screen.getByLabelText(
    "Link cross-release cards",
  ) as HTMLButtonElement;
}

function submit() {
  const button = submitButton();
  fireEvent.submit(button.closest("form") as HTMLFormElement);
}

/** `n` sequential card numbers, as the operator would paste them: a range. */
const RANGE_500 = "1-500";
const linkedBatch = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => String(from + i));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CrossListingImportModal — a sliced import that stops partway", () => {
  it("reports the links an earlier slice already committed", async () => {
    // 500 numbers is two slices at CROSS_LISTING_LINKS_PER_CALL=400.
    const committed = linkedBatch(1, CROSS_LISTING_LINKS_PER_CALL);
    mockAddCrossListings
      .mockResolvedValueOnce({
        linked: committed,
        alreadyLinked: [],
        notFound: [],
      })
      .mockRejectedValueOnce(new Error("Too many writes"));

    renderModal();
    drillToSource();
    typeNumbers(RANGE_500);
    await act(async () => {
      submit();
    });

    const alert = await screen.findByRole("alert");
    // The message names the failure AND what survived it. Reporting only the
    // failure tells the operator nothing was saved, which sends him looking
    // for work that is already on disk — or undoing it.
    expect(alert.textContent).toBe(
      "Import stopped partway: Too many writes. 400 cards were linked before it stopped — paste the same list again to finish the rest.",
    );
    expect(alert.textContent).not.toMatch(/^Import failed/);
    // Both slices were attempted; the count is real, not a guess.
    expect(mockAddCrossListings).toHaveBeenCalledTimes(2);
  });

  it("drops the count when the very first slice failed", async () => {
    mockAddCrossListings.mockRejectedValueOnce(new Error("Too many writes"));

    renderModal();
    drillToSource();
    typeNumbers(RANGE_500);
    await act(async () => {
      submit();
    });

    const alert = await screen.findByRole("alert");
    // "0 cards were linked" is noise; the recovery instruction is not.
    expect(alert.textContent).toBe(
      "Import stopped partway: Too many writes. Paste the same list again to finish the rest.",
    );
  });

  it("says one card in the singular", async () => {
    mockAddCrossListings
      .mockResolvedValueOnce({ linked: ["7"], alreadyLinked: [], notFound: [] })
      .mockRejectedValueOnce(new Error("Too many writes"));

    renderModal();
    drillToSource();
    typeNumbers(RANGE_500);
    await act(async () => {
      submit();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 card was linked before it stopped");
  });

  it("merges every slice into one result when nothing fails", async () => {
    mockAddCrossListings
      .mockResolvedValueOnce({
        linked: linkedBatch(1, 400),
        alreadyLinked: [],
        notFound: [],
      })
      .mockResolvedValueOnce({
        linked: linkedBatch(401, 98),
        alreadyLinked: ["499"],
        notFound: ["500"],
      });

    renderModal();
    drillToSource();
    typeNumbers(RANGE_500);
    await act(async () => {
      submit();
    });

    await waitFor(() =>
      expect(screen.getByText("Linked 498 cards.")).toBeTruthy(),
    );
    expect(screen.getByText(/Already linked: 499/)).toBeTruthy();
    expect(screen.getByText(/Not found in source set: 500/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("CrossListingImportModal — the in-flight window", () => {
  it("counts the slices off as they land, rather than sitting on 'Linking…'", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockAddCrossListings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderModal();
    drillToSource();
    typeNumbers(RANGE_500);
    await act(async () => {
      submit();
    });

    expect(screen.getByText("Linked 0 of 500…")).toBeTruthy();

    await act(async () => {
      first.resolve({
        linked: linkedBatch(1, 400),
        alreadyLinked: [],
        notFound: [],
      });
    });
    expect(screen.getByText("Linked 400 of 500…")).toBeTruthy();

    await act(async () => {
      second.resolve({ linked: linkedBatch(401, 100), alreadyLinked: [], notFound: [] });
    });
    // Gone once there is a real answer to read instead.
    await waitFor(() => expect(screen.queryByText(/Linked \d+ of/)).toBeNull());
    expect(screen.getByText("Linked 500 cards.")).toBeTruthy();
  });

  it("keeps the pressed button focusable and focused for the whole import", async () => {
    const first = deferred<unknown>();
    mockAddCrossListings.mockReturnValueOnce(first.promise);

    renderModal();
    drillToSource();
    typeNumbers("1-10");
    // Settling the source parks focus on the card-number field via rAF; let
    // that land before standing on the button, or the effect steals it back
    // and the assertion below measures the wrong thing.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const button = submitButton();
    button.focus();
    await act(async () => {
      submit();
    });

    // Native `disabled` would drop it out of the tab order and blur it to
    // <body> — outside the still-open dialog — for a window that is now up to
    // three sequential round-trips long.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);

    await act(async () => {
      first.resolve({ linked: ["1"], alreadyLinked: [], notFound: [] });
    });
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("refuses a second press while one import is in flight", async () => {
    const first = deferred<unknown>();
    mockAddCrossListings.mockReturnValueOnce(first.promise);

    renderModal();
    drillToSource();
    typeNumbers("1-10");
    await act(async () => {
      submit();
    });
    expect(mockAddCrossListings).toHaveBeenCalledTimes(1);

    // `aria-disabled` does not stop a click, so the handler has to — the whole
    // point of the copy fix being a progress line is that the operator CAN
    // press again, and must not be able to double-write when he does.
    await act(async () => {
      submit();
    });
    expect(mockAddCrossListings).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ linked: ["1"], alreadyLinked: [], notFound: [] });
    });
  });

  it("leaves Cancel reachable rather than natively disabled, and inert while busy", async () => {
    const first = deferred<unknown>();
    mockAddCrossListings.mockReturnValueOnce(first.promise);

    renderModal();
    drillToSource();
    typeNumbers("1-10");
    await act(async () => {
      submit();
    });

    const cancel = screen.getByLabelText(
      "Cancel cross-release import",
    ) as HTMLButtonElement;
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve({ linked: ["1"], alreadyLinked: [], notFound: [] });
    });
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalled();
  });
});
