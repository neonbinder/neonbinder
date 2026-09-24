/**
 * NEO-220 — you cannot lose a grouping session by accident.
 *
 * This modal is pure drag: nothing is written until Save, the backdrop closed
 * it on one stray click, and Escape was handled on `window` — so it fired
 * wherever focus happened to be, including inside any dialog rendered over the
 * top of it. Both paths threw away every pending move without asking.
 *
 * First component tests for this file; the reducer's own diff (`computeDiff`)
 * is exercised through the footer count, which is the same number the confirm
 * now shows.
 */

import { describe, expect, test, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getInsertTreeByVariantType: "getInsertTreeByVariantType",
      applyParallelGroupings: "applyParallelGroupings",
    },
  },
}));

const mockApply = vi.fn().mockResolvedValue(undefined);
let tree: unknown = undefined;

vi.mock("convex/react", () => ({
  useMutation: () => mockApply,
  useQuery: (ref: string) =>
    ref === "getInsertTreeByVariantType" ? tree : undefined,
}));

import ParallelGroupingModal from "./ParallelGroupingModal";

const VARIANT_TYPE_ID = "vt1" as Id<"selectorOptions">;

/**
 * One insert with one parallel under it. Deliberately a single ungrouped
 * insert, so `detectGroupings` has nothing to suggest and the modal opens with
 * a genuinely empty diff — a tree with suggestions opens dirty on purpose, and
 * that is a different test.
 */
function oneParallel() {
  return [
    {
      insert: { _id: "i1", value: "Refractor" },
      parallels: [{ _id: "p1", value: "Gold" }],
    },
  ];
}

function renderModal() {
  const onClose = vi.fn();
  render(
    <ParallelGroupingModal
      isOpen
      onClose={onClose}
      variantTypeId={VARIANT_TYPE_ID}
    />,
  );
  return { onClose };
}

/** The overlay that now owns Escape — focused on open, `tabIndex={-1}`. */
const overlay = () =>
  screen.getByText("Group Parallels").closest('[tabindex="-1"]') as HTMLElement;

/** Demote the one parallel to top level: exactly one pending move. */
function demoteTheParallel() {
  fireEvent.click(screen.getByLabelText("Remove Gold from parallels"));
}

beforeEach(() => {
  tree = oneParallel();
  mockApply.mockClear();
});

describe("ParallelGroupingModal — keyboard entry point", () => {
  /**
   * The window listener this replaced fired wherever focus was, which is why
   * it had to go: the discard confirm is a sibling in the same portal, and a
   * window listener would have closed the session behind it on the same key.
   */
  test("focus opens on the dialog container, so Escape lands inside", () => {
    renderModal();
    expect(document.activeElement).toBe(overlay());
  });

  test("Escape on the root closes an untouched session", () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(overlay(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
  });
});

describe("ParallelGroupingModal — discard guard", () => {
  test("a backdrop click on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.click(overlay());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Cancel on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape after a move asks first, and names the count", () => {
    const { onClose } = renderModal();
    demoteTheParallel();
    // The footer and the confirm read the same number.
    expect(screen.getByText("Save 1 change")).toBeTruthy();

    fireEvent.keyDown(overlay(), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Discard 1 pending move?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discard 1 pending move" }),
    ).toBeTruthy();
  });

  test("a backdrop click after a move asks first", () => {
    const { onClose } = renderModal();
    demoteTheParallel();

    fireEvent.click(overlay());

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Discard 1 pending move" }),
    ).toBeTruthy();
  });

  test("Cancel on the confirm keeps both the moves and the dialog", () => {
    const { onClose } = renderModal();
    demoteTheParallel();
    fireEvent.click(screen.getByText("Cancel"));

    const confirm = screen.getByRole("dialog", { name: /Discard/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
    // The move survived — the confirm never touched the reducer.
    expect(screen.getByText("Save 1 change")).toBeTruthy();
  });

  test("confirming the discard closes the modal", () => {
    const { onClose } = renderModal();
    demoteTheParallel();
    fireEvent.keyDown(overlay(), { key: "Escape" });

    fireEvent.click(
      screen.getByRole("button", { name: "Discard 1 pending move" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApply).not.toHaveBeenCalled();
  });
});

/**
 * NEO-300 — `applyParallelGroupings` refuses a plan that would put a row
 * somewhere it already is with a ConvexError carrying the operator's sentence.
 * `.message` arrives wrapped in the Convex request prefix on prod, so the
 * footer reads `data`.
 */
describe("ParallelGroupingModal — a refused save", () => {
  async function saveOneMove() {
    renderModal();
    demoteTheParallel();
    await act(async () => {
      fireEvent.click(screen.getByText("Save 1 change"));
    });
  }

  test("shows the ConvexError's own sentence, not the wrapped message", async () => {
    const err = new ConvexError('"Refractor" is already a parallel of "Chrome".');
    err.message =
      '[CONVEX M(selectorOptions:applyParallelGroupings)] [Request ID: abc] Server Error Uncaught ConvexError: "Refractor" is already a parallel of "Chrome".';
    mockApply.mockRejectedValueOnce(err);
    await saveOneMove();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe('"Refractor" is already a parallel of "Chrome".');
    expect(alert.textContent).not.toContain("CONVEX");
  });

  test("falls back to the message for any other error", async () => {
    mockApply.mockRejectedValueOnce(new Error("Network went away"));
    await saveOneMove();
    expect(screen.getByRole("alert").textContent).toBe("Network went away");
  });

  test("a ConvexError with structured data falls back too", async () => {
    mockApply.mockRejectedValueOnce(new ConvexError({ code: "X" }));
    await saveOneMove();
    // Not "[object Object]" — the message path, as before.
    expect(screen.getByRole("alert").textContent).not.toContain("[object");
  });

  test("Save stays focused through the save, so the refusal lands beside it (a11y)", async () => {
    // Native `disabled` dropped focus to <body> the moment Save was pressed,
    // and the role="alert" refusal then arrived with the keyboard user
    // nowhere near it.
    let reject!: (e: unknown) => void;
    mockApply.mockImplementationOnce(
      () => new Promise((_res, rej) => (reject = rej)),
    );
    renderModal();
    demoteTheParallel();
    const save = screen.getByText("Save 1 change").closest("button") as HTMLButtonElement;
    save.focus();
    await act(async () => {
      fireEvent.click(save);
    });

    // In flight: aria-disabled, never native disabled, and still focused.
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    // A second press while in flight does nothing.
    await act(async () => {
      fireEvent.click(save);
    });
    expect(mockApply).toHaveBeenCalledTimes(1);

    await act(async () => {
      reject(new ConvexError('"Refractor" is already a parallel of "Chrome".'));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      '"Refractor" is already a parallel of "Chrome".',
    );
    expect(document.activeElement).toBe(save);
    expect(save.getAttribute("aria-disabled")).toBeNull();
  });
});

/**
 * NEO-300 — the dialog never scrolls itself.
 *
 * An effect used to `scrollIntoView` the LAST ✕ in the list on open and on
 * every placement change, so on a real variant type the dialog opened at the
 * bottom and jumped back there on every drag, ✕ and "Accept all". happy-dom
 * does no layout, so this pins the two things that can be observed: nothing
 * calls `scrollIntoView`, and the body's `scrollTop` is where it was left.
 */
describe("ParallelGroupingModal — the body is never scrolled for the operator", () => {
  /** Two groups, both with ✕ buttons, plus a suggestion — every trigger. */
  function busyTree() {
    return [
      {
        insert: { _id: "i1", value: "Chrome" },
        parallels: [
          { _id: "p1", value: "Chrome Gold" },
          { _id: "p2", value: "Chrome Red" },
        ],
      },
      {
        insert: { _id: "i2", value: "Stars" },
        parallels: [{ _id: "p3", value: "Stars Blue" }],
      },
      { insert: { _id: "i3", value: "Anime" }, parallels: [] },
      // Prefix-matches "Anime": opens as a suggestion, so Accept all shows.
      { insert: { _id: "i4", value: "Anime Kanji" }, parallels: [] },
    ];
  }

  const body = () =>
    document.querySelector("[data-grouping-body]") as HTMLElement;

  /** Let any requestAnimationFrame callback an effect queued run. */
  async function flushFrames() {
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
  }

  let scrollSpy: ReturnType<typeof vi.fn<(arg?: unknown) => void>>;
  let restoreScroll: () => void;
  beforeEach(() => {
    tree = busyTree();
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (arg?: unknown) => void;
    };
    const original = proto.scrollIntoView;
    scrollSpy = vi.fn<(arg?: unknown) => void>();
    proto.scrollIntoView = scrollSpy;
    restoreScroll = () => {
      proto.scrollIntoView = original;
    };
  });

  test("opens scrolled to the top", async () => {
    renderModal();
    await flushFrames();
    try {
      expect(body().scrollTop).toBe(0);
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      restoreScroll();
    }
  });

  test("a ✕, an Accept all and a move leave the scroll position alone", async () => {
    renderModal();
    await flushFrames();
    try {
      // Where the operator had scrolled to.
      body().scrollTop = 137;
      expect(body().scrollTop).toBe(137);

      fireEvent.click(screen.getByLabelText("Remove Chrome Red from parallels"));
      await flushFrames();
      expect(body().scrollTop).toBe(137);

      fireEvent.click(screen.getByText(/Accept all suggestions/));
      await flushFrames();
      expect(body().scrollTop).toBe(137);

      // Click-to-place (the keyboard path of a drag): Chrome Red under Stars.
      fireEvent.click(screen.getByText("Chrome Red"));
      fireEvent.click(screen.getByText('Parallels of "Stars"'));
      await flushFrames();
      expect(screen.getByText("Save 2 changes")).toBeTruthy();
      expect(body().scrollTop).toBe(137);

      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      restoreScroll();
    }
  });
});

/**
 * NEO-300 — a row the operator ✕'s out of a group can take parallels at once.
 *
 * Jason's case: "Bowman Sterling Autos" sat under "Bowman Sterling"; he ✕'d it
 * and then needed to drag "Bowman Sterling Autographs Gold Refractors" under
 * it. Only rows that were inserts at open used to get a "Parallels of …" box,
 * so a demoted saved parallel had nowhere to receive anything.
 *
 * Moves are made with click-to-place, which dispatches the same PLACE a drop
 * does; dnd-kit's pointer sensor needs real layout that happy-dom lacks.
 */
describe("ParallelGroupingModal — a demoted row is a drop target at once", () => {
  const BS = "Bowman Sterling";
  const AUTOS = "Bowman Sterling Autos";
  const GOLD = "Bowman Sterling Autographs Gold Refractors";

  const boxTitle = (name: string) => `Parallels of "${name}"`;
  const zoneOf = (name: string) =>
    screen.getByText(boxTitle(name)).parentElement!.parentElement as HTMLElement;

  async function save() {
    await act(async () => {
      fireEvent.click(screen.getByText(/^Save \d+ changes?$/));
    });
    expect(mockApply).toHaveBeenCalledTimes(1);
    return mockApply.mock.calls[0][0];
  }

  test("a SAVED parallel, once ✕'d, gets its own empty box and takes a row", async () => {
    tree = [
      {
        insert: { _id: "bs", value: BS },
        parallels: [{ _id: "autos", value: AUTOS }],
      },
      // An insert today; opens suggested under "Bowman Sterling".
      { insert: { _id: "gold", value: GOLD }, parallels: [] },
    ];
    renderModal();
    expect(screen.queryByText(boxTitle(AUTOS))).toBeNull();

    fireEvent.click(screen.getByLabelText(`Remove ${AUTOS} from parallels`));

    // Straight away, with no parallels in it yet.
    const zone = zoneOf(AUTOS);
    expect(within(zone).getByText("0 parallels")).toBeTruthy();

    fireEvent.click(screen.getByText(GOLD));
    fireEvent.click(screen.getByText(boxTitle(AUTOS)));
    expect(within(zoneOf(AUTOS)).getByText(GOLD)).toBeTruthy();
    expect(within(zoneOf(AUTOS)).getByText("1 parallel")).toBeTruthy();

    // One Save carries both halves: the demotion AND the move under it.
    // (The server must accept a target it is demoting in the same plan.)
    expect(await save()).toEqual({
      variantTypeId: VARIANT_TYPE_ID,
      promotions: [{ insertId: "gold", targetInsertId: "autos" }],
      demotions: [{ parallelId: "autos" }],
      reparentings: [],
    });
  });

  test("a saved parallel can be re-parented under a demoted one in the same save", async () => {
    tree = [
      {
        insert: { _id: "bs", value: BS },
        parallels: [
          { _id: "autos", value: AUTOS },
          { _id: "gold", value: GOLD },
        ],
      },
    ];
    renderModal();

    fireEvent.click(screen.getByLabelText(`Remove ${AUTOS} from parallels`));
    fireEvent.click(screen.getByText(GOLD));
    fireEvent.click(screen.getByText(boxTitle(AUTOS)));

    expect(await save()).toEqual({
      variantTypeId: VARIANT_TYPE_ID,
      promotions: [],
      demotions: [{ parallelId: "autos" }],
      reparentings: [{ parallelId: "gold", newInsertId: "autos" }],
    });
  });

  test("an undone SUGGESTION takes a row too, with no demotion in the plan", async () => {
    // All three are inserts; both longer names open suggested under the short.
    tree = [
      { insert: { _id: "bs", value: BS }, parallels: [] },
      { insert: { _id: "autos", value: AUTOS }, parallels: [] },
      { insert: { _id: "gold", value: GOLD }, parallels: [] },
    ];
    renderModal();

    fireEvent.click(screen.getByLabelText(`Remove ${AUTOS} from parallels`));
    expect(within(zoneOf(AUTOS)).getByText("0 parallels")).toBeTruthy();
    fireEvent.click(screen.getByText(GOLD));
    fireEvent.click(screen.getByText(boxTitle(AUTOS)));

    expect(await save()).toEqual({
      variantTypeId: VARIANT_TYPE_ID,
      promotions: [{ insertId: "gold", targetInsertId: "autos" }],
      demotions: [],
      reparentings: [],
    });
  });

  test("a row holding parallels cannot itself be moved under another (no chains)", () => {
    tree = [
      {
        insert: { _id: "bs", value: BS },
        parallels: [{ _id: "autos", value: AUTOS }],
      },
      { insert: { _id: "gold", value: GOLD }, parallels: [] },
    ];
    renderModal();
    fireEvent.click(screen.getByLabelText(`Remove ${AUTOS} from parallels`));
    fireEvent.click(screen.getByText(GOLD));
    fireEvent.click(screen.getByText(boxTitle(AUTOS)));

    // "Bowman Sterling Autos" now holds a parallel: its row cannot be picked
    // up, so it cannot land under "Bowman Sterling" with Gold beneath it.
    const autosRow = within(
      screen.getByText("Top-level inserts").parentElement!.parentElement as HTMLElement,
    )
      .getByText(AUTOS)
      .closest("button") as HTMLButtonElement;
    expect(autosRow.disabled).toBe(true);
  });
});

/**
 * NEO-300 — a draggable row is a named group, not a button around buttons.
 *
 * dnd-kit's default attributes made the row div role="button", which hides the
 * select and ✕ buttons inside it from the accessibility tree. And with no
 * activator node, a Space/Enter bubbling up from either inner button was taken
 * as "pick this row up": preventDefault'ed, so the button never fired.
 */
describe("ParallelGroupingModal — draggable rows", () => {
  const row = (name: string) => screen.getByRole("group", { name });
  const reject = () => screen.getByLabelText("Remove Gold from parallels");

  test("each row is a group named by its own text, holding its buttons", () => {
    renderModal();
    const gold = row("Gold");
    expect(gold.getAttribute("aria-roledescription")).toBe("draggable");
    expect(gold.contains(reject())).toBe(true);
    expect(reject().closest('[role="button"]')).toBeNull();
  });

  test("Enter or Space on ✕ is left to the button, not taken as a drag", () => {
    renderModal();
    // `fireEvent` returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(reject(), { key: "Enter", code: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(reject(), { key: " ", code: "Space" })).toBe(true);
    // No drag began: the overlay would render a second "Gold".
    expect(screen.getAllByText("Gold")).toHaveLength(1);
  });

  test("Space on the row itself still picks it up (keyboard drag)", () => {
    renderModal();
    expect(fireEvent.keyDown(row("Gold"), { key: " ", code: "Space" })).toBe(false);
  });
});
