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

/**
 * NEO-300 — the drop half of a drag, reached through the real handler.
 *
 * dnd-kit's pointer sensor needs layout happy-dom does not do, and a keyboard
 * drag's drop target comes from rectangles that are all zero here. The
 * context itself is the real one; this only keeps a hand on the props the
 * modal gave it, so a test can call `onDragStart` / `onDragEnd` exactly as a
 * finished drag would.
 */
type DndHandlers = {
  onDragStart?: (e: { active: { id: string } }) => void;
  onDragEnd?: (e: {
    active: { id: string };
    over: { id: string } | null;
  }) => void;
};
const dnd: DndHandlers = {};
/** Every drop dnd-kit itself reported, for a real (keyboard) drag. */
const dndEnds: Array<{ active: unknown; over: unknown }> = [];
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  const Real = actual.DndContext;
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof Real>) => {
      dnd.onDragStart = props.onDragStart as DndHandlers["onDragStart"];
      dnd.onDragEnd = props.onDragEnd as DndHandlers["onDragEnd"];
      return (
        <Real
          {...props}
          onDragEnd={(e) => {
            dndEnds.push({ active: e.active.id, over: e.over?.id ?? null });
            props.onDragEnd?.(e);
          }}
        />
      );
    },
  };
});

import { keyboardDrag, stubLayout } from "../../lib/testing/keyboard-drag";
import ParallelGroupingModal, {
  emptyGroupingState,
  groupingReducer,
  type GroupingState,
  type Placement,
  type RowInfo,
} from "./ParallelGroupingModal";

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

/**
 * NEO-300 — moving many rows at once.
 *
 * Jason's case: six top-level "Chrome Autographs Mojo … Refractors" rows all
 * belong under "Chrome Autographs Mojo Refractors", and none of them
 * prefix-matches it, so no suggestion helps — it was six drags. A seventh
 * row, "… Blue Wave", already holds a parallel, sits in the middle of the run
 * (rows sort by name) and can never be picked.
 */
describe("ParallelGroupingModal — several rows at once", () => {
  const P = "Chrome Autographs Mojo";
  const MOJO = `${P} Refractors`;
  const AQUA = `${P} Aqua Refractors`;
  const BW = `${P} Black and White Refractors`;
  const BLACK = `${P} Black Refractors`;
  const BLUE = `${P} Blue Refractors`;
  const WAVE = `${P} Blue Wave`;
  const GOLD = `${P} Gold Refractors`;
  const GREEN = `${P} Green Refractors`;
  const SIX = [AQUA, BW, BLACK, BLUE, GOLD, GREEN];

  function mojoTree() {
    return [
      { insert: { _id: "mojo", value: MOJO }, parallels: [] },
      { insert: { _id: "aqua", value: AQUA }, parallels: [] },
      { insert: { _id: "bw", value: BW }, parallels: [] },
      { insert: { _id: "black", value: BLACK }, parallels: [] },
      { insert: { _id: "blue", value: BLUE }, parallels: [] },
      {
        insert: { _id: "wave", value: WAVE },
        parallels: [
          { _id: "wave-red", value: "Wave Red" },
          { _id: "wave-teal", value: "Wave Teal" },
        ],
      },
      { insert: { _id: "gold", value: GOLD }, parallels: [] },
      { insert: { _id: "green", value: GREEN }, parallels: [] },
    ];
  }

  beforeEach(() => {
    tree = mojoTree();
  });

  const tick = (name: string) =>
    screen.getByRole("checkbox", { name: `Select ${name}` });
  const nameButton = (name: string) =>
    screen.getByText(name).closest("button") as HTMLButtonElement;
  const isPicked = (name: string) =>
    tick(name).getAttribute("aria-checked") === "true";
  const picked = (names: string[]) => names.filter(isPicked);
  const boxTitle = (name: string) => `Parallels of "${name}"`;
  const zoneOf = (title: string) =>
    screen.getByText(title).parentElement!.parentElement as HTMLElement;
  // dnd-kit keeps a role="status" of its own; this is the footer's.
  const count = () =>
    document.querySelector('[role="status"][data-selection-count]')!
      .textContent;

  async function savedPlan() {
    await act(async () => {
      fireEvent.click(screen.getByText(/^Save \d+ changes?$/));
    });
    expect(mockApply).toHaveBeenCalledTimes(1);
    return mockApply.mock.calls[0][0];
  }

  test("Cmd/Ctrl+click and the tick box toggle rows in and out", () => {
    renderModal();
    fireEvent.click(nameButton(AQUA), { metaKey: true });
    fireEvent.click(nameButton(GOLD), { ctrlKey: true });
    fireEvent.click(tick(GREEN));
    expect(picked([...SIX, MOJO])).toEqual([AQUA, GOLD, GREEN]);
    expect(count()).toBe("3 selected");
    // Selected is not colour alone: the tick box says so, and so does the
    // name button's pressed state.
    expect(nameButton(GOLD).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(nameButton(GOLD), { metaKey: true });
    fireEvent.click(tick(GREEN));
    expect(picked([...SIX, MOJO])).toEqual([AQUA]);
    expect(count()).toBe("1 selected");
  });

  test("a picked row wears the selected style even while it is a suggestion", () => {
    // "… Mojo Refractors Gold" prefix-matches the target, so it opens yellow.
    tree = [
      ...mojoTree(),
      { insert: { _id: "sugg", value: `${MOJO} Gold` }, parallels: [] },
    ];
    renderModal();
    const row = () => screen.getByRole("group", { name: `${MOJO} Gold` });
    expect(row().className).toContain("border-yellow-700");
    fireEvent.click(tick(`${MOJO} Gold`));
    expect(row().className).toContain("border-neon-blue");
    expect(row().className).not.toContain("border-yellow-700");
    // The badge still says it was suggested.
    expect(within(row()).getByText("Suggested")).toBeTruthy();
  });

  test("a plain click still selects that row alone", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(BW));
    fireEvent.click(tick(BLACK));
    expect(count()).toBe("3 selected");

    fireEvent.click(screen.getByText(GOLD));
    expect(picked([...SIX, MOJO])).toEqual([GOLD]);
    // The single-row wording is the one a Maestro flow waits on.
    expect(
      screen.getAllByText("Click here to make the selected row a parallel")
        .length,
    ).toBeGreaterThan(0);

    // ...and click-to-place moves only it.
    fireEvent.click(screen.getByText(boxTitle(MOJO)));
    expect(screen.getByText("1 promotion, 0 demotions")).toBeTruthy();
    expect(within(zoneOf(boxTitle(MOJO))).getByText(GOLD)).toBeTruthy();
  });

  test("Shift+click takes the run from the anchor, skipping a row that holds parallels", () => {
    renderModal();
    fireEvent.click(screen.getByText(AQUA));
    fireEvent.click(nameButton(GREEN), { shiftKey: true });
    // The whole run, less "Blue Wave" (it holds parallels) and less the
    // target, which sorts after Green.
    expect(picked([...SIX, MOJO])).toEqual(SIX);
    expect(tick(WAVE).hasAttribute("disabled")).toBe(true);
    expect(tick(WAVE).getAttribute("aria-checked")).toBe("false");
    expect(count()).toBe("6 selected");

    // A second Shift+click from the same anchor replaces the run.
    fireEvent.click(tick(BLACK), { shiftKey: true });
    expect(picked([...SIX, MOJO])).toEqual([AQUA, BW, BLACK]);
  });

  test("a range never spans boxes: Shift+click in another list adds that row alone", () => {
    renderModal();
    fireEvent.click(screen.getByText(AQUA));
    fireEvent.click(nameButton("Wave Teal"), { shiftKey: true });
    // Aqua kept, Teal added — not every row between them.
    expect(picked([...SIX, MOJO])).toEqual([AQUA]);
    expect(isPicked("Wave Teal")).toBe(true);
    expect(isPicked("Wave Red")).toBe(false);
    // Teal is the new anchor: a Shift+click in its own box runs from it.
    fireEvent.click(tick("Wave Red"), { shiftKey: true });
    expect(isPicked("Wave Red")).toBe(true);
    expect(count()).toBe("3 selected");
  });

  test("Esc clears the selection first, and the dialog on the next press", () => {
    const { onClose } = renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(GOLD));

    fireEvent.keyDown(overlay(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(picked(SIX)).toEqual([]);
    expect(count()).toBe("");

    fireEvent.keyDown(overlay(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Clear empties the selection and keeps focus in the dialog", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(picked(SIX)).toEqual([]);
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
    expect(document.activeElement).toBe(overlay());
  });

  test("keyboard: arrows walk the list, Shift+arrows extend, Space is the tick's own", () => {
    renderModal();
    tick(AQUA).focus();
    // A plain arrow moves focus down the list without picking anything, and
    // is not left to scroll the body.
    expect(fireEvent.keyDown(tick(AQUA), { key: "ArrowDown" })).toBe(false);
    expect(document.activeElement).toBe(tick(BW));
    expect(picked(SIX)).toEqual([]);

    fireEvent.keyDown(tick(BW), { key: "ArrowDown", shiftKey: true });
    expect(document.activeElement).toBe(tick(BLACK));
    expect(picked(SIX)).toEqual([BW, BLACK]);
    fireEvent.keyDown(tick(BLACK), { key: "ArrowDown", shiftKey: true });
    // "Blue Wave" can't be picked, so it is not a stop either.
    fireEvent.keyDown(tick(BLUE), { key: "ArrowDown", shiftKey: true });
    expect(document.activeElement).toBe(tick(GOLD));
    expect(picked(SIX)).toEqual([BW, BLACK, BLUE, GOLD]);
    // Back up: the run shrinks toward the anchor.
    fireEvent.keyDown(tick(GOLD), { key: "ArrowUp", shiftKey: true });
    expect(picked(SIX)).toEqual([BW, BLACK, BLUE]);

    // The name buttons walk the same way.
    nameButton(AQUA).focus();
    fireEvent.keyDown(nameButton(AQUA), { key: "ArrowDown" });
    expect(document.activeElement).toBe(nameButton(BW));

    // Space on the tick is a button press, not dnd-kit's Space-to-lift.
    expect(fireEvent.keyDown(tick(AQUA), { key: " ", code: "Space" })).toBe(true);
    expect(tick(AQUA).tagName).toBe("BUTTON");
  });

  test("click-to-place moves every selected row, in one save", async () => {
    renderModal();
    fireEvent.click(screen.getByText(AQUA));
    fireEvent.click(nameButton(GREEN), { shiftKey: true });
    // Every box invites the drop — except those of the six themselves.
    expect(
      within(zoneOf(boxTitle(MOJO))).getByText(
        "Click here to make the 6 selected rows parallels",
      ),
    ).toBeTruthy();
    expect(
      within(zoneOf(boxTitle(BLUE))).getByText(
        "This row is selected. Untick it to drop the other 5 rows here.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText(boxTitle(MOJO)));

    expect(screen.getByText("6 promotions, 0 demotions")).toBeTruthy();
    const box = zoneOf(boxTitle(MOJO));
    for (const name of SIX) expect(within(box).getByText(name)).toBeTruthy();
    // The selection is spent.
    expect(screen.queryByText(/selected$/)).toBeNull();

    const plan = await savedPlan();
    expect(plan.promotions).toHaveLength(6);
    expect(
      new Set(plan.promotions.map((p: { insertId: string }) => p.insertId)),
    ).toEqual(new Set(["aqua", "bw", "black", "blue", "gold", "green"]));
    for (const p of plan.promotions) expect(p.targetInsertId).toBe("mojo");
    expect(plan.demotions).toEqual([]);
  });

  test("a drag of any selected row carries the whole selection", async () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(BLUE));
    fireEvent.click(tick(GREEN));

    act(() => {
      dnd.onDragStart!({ active: { id: "blue" } });
    });
    // The other two ride along, dimmed like the grabbed row.
    const rowOf = (name: string) => screen.getByRole("group", { name });
    expect(rowOf(AQUA).style.opacity).toBe("0.4");
    expect(rowOf(GREEN).style.opacity).toBe("0.4");
    expect(rowOf(GOLD).style.opacity).toBe("1");

    act(() => {
      dnd.onDragEnd!({
        active: { id: "blue" },
        over: { id: "drop-insert-mojo" },
      });
    });
    expect(screen.getByText("3 promotions, 0 demotions")).toBeTruthy();
    const plan = await savedPlan();
    expect(
      plan.promotions.map((p: { insertId: string }) => p.insertId).sort(),
    ).toEqual(["aqua", "blue", "green"]);
  });

  test("the drag overlay stacks the rows and counts them", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(GOLD));
    // A real keyboard lift: Space on the row's own drag handle.
    act(() => {
      fireEvent.keyDown(screen.getByRole("group", { name: GOLD }), {
        key: " ",
        code: "Space",
      });
    });
    expect(screen.getByText("2 rows")).toBeTruthy();
  });

  test("a drag of an UNSELECTED row moves it alone and keeps the selection", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(GOLD));
    act(() => {
      dnd.onDragStart!({ active: { id: "green" } });
      dnd.onDragEnd!({
        active: { id: "green" },
        over: { id: "drop-insert-mojo" },
      });
    });
    expect(screen.getByText("1 promotion, 0 demotions")).toBeTruthy();
    expect(picked(SIX)).toEqual([AQUA, GOLD]);
  });

  test("a picked row that is handed a parallel drops out of the selection", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(GOLD));
    // Green (not picked) dropped under Aqua: Aqua now holds a parallel.
    act(() => {
      dnd.onDragEnd!({
        active: { id: "green" },
        over: { id: "drop-insert-aqua" },
      });
    });
    expect(tick(AQUA).hasAttribute("disabled")).toBe(true);
    expect(picked(SIX)).toEqual([GOLD]);
    expect(count()).toBe("1 selected");
  });

  test("demote many: rows from two boxes to the top level at once", async () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(BW));
    fireEvent.click(screen.getByText(boxTitle(MOJO)));
    // Now: Aqua and B&W under Mojo; Red and Teal under Blue Wave.
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick("Wave Red"));
    fireEvent.click(tick("Wave Teal"));
    expect(
      screen.getByText("Click here to place the 3 selected rows at the top level"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Top-level inserts"));

    // Aqua's promotion is undone; Red and Teal are demoted.
    expect(screen.getByText("1 promotion, 2 demotions")).toBeTruthy();
    const plan = await savedPlan();
    expect(plan.promotions).toEqual([{ insertId: "bw", targetInsertId: "mojo" }]);
    expect(
      plan.demotions.map((d: { parallelId: string }) => d.parallelId).sort(),
    ).toEqual(["wave-red", "wave-teal"]);
  });

  test("a box whose own row is selected refuses the selection, and says why", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(BW));
    fireEvent.click(tick(MOJO));

    const box = zoneOf(boxTitle(MOJO));
    expect(
      within(box).getByText("This row is selected. Untick it to drop the other 2 rows here."),
    ).toBeTruthy();
    // It does not offer itself as a click target (the other boxes do)...
    expect(box.className).not.toContain("cursor-pointer");
    expect(zoneOf(boxTitle(GOLD)).className).toContain("cursor-pointer");
    // ...a click on it does nothing...
    fireEvent.click(screen.getByText(boxTitle(MOJO)));
    // ...and neither does a drop (a drop lands nowhere, but even one that
    // reached the handler is refused whole).
    act(() => {
      dnd.onDragEnd!({ active: { id: "aqua" }, over: { id: "drop-insert-mojo" } });
    });
    expect(screen.getByText("No changes yet")).toBeTruthy();
    expect(picked([AQUA, BW, MOJO])).toEqual([AQUA, BW, MOJO]);

    // Untick the target and the same click moves the other two.
    fireEvent.click(tick(MOJO));
    fireEvent.click(screen.getByText(boxTitle(MOJO)));
    expect(screen.getByText("2 promotions, 0 demotions")).toBeTruthy();
  });

  test("a selected row's own box counts the OTHER rows: none, one, or several", () => {
    renderModal();
    const hint = () =>
      within(zoneOf(boxTitle(MOJO))).getByText(/^This row is selected/)
        .textContent;
    fireEvent.click(tick(MOJO));
    expect(hint()).toBe("This row is selected");
    fireEvent.click(tick(AQUA));
    expect(hint()).toBe("This row is selected. Untick it to drop the other row here.");
    fireEvent.click(tick(BW));
    expect(hint()).toBe(
      "This row is selected. Untick it to drop the other 2 rows here.",
    );
  });

  test("clicking a row inside a box selects it; it does not drop the selection there", () => {
    renderModal();
    fireEvent.click(screen.getByText(AQUA));
    // "Wave Red" sits inside Blue Wave's box, which is a click target now.
    fireEvent.click(screen.getByText("Wave Red"));
    expect(screen.getByText("No changes yet")).toBeTruthy();
    expect(isPicked("Wave Red")).toBe(true);
    expect(isPicked(AQUA)).toBe(false);
    fireEvent.click(tick("Wave Teal"));
    expect(screen.getByText("No changes yet")).toBeTruthy();
    expect(count()).toBe("2 selected");
  });

  /**
   * A REAL keyboard drag, through dnd-kit's own KeyboardSensor and collision
   * code, on stubbed rectangles: Space on Gold's handle, five ArrowDowns
   * (25px each) carry it from the top-level box into Mojo's box below, Space
   * drops. Before the keyboard-aware collision, `pointerWithin` found no
   * target without a pointer and this drop landed nowhere.
   */
  test("a keyboard drop lands, and carries the selection", async () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick(GOLD));
    const handle = screen.getByRole("group", { name: GOLD });
    const restore = stubLayout(
      new Map([
        [zoneOf("Top-level inserts"), { top: 0, left: 0, width: 600, height: 400 }],
        [handle, { top: 300, left: 20, width: 560, height: 36 }],
        [zoneOf(boxTitle(MOJO)), { top: 420, left: 0, width: 600, height: 120 }],
      ]),
    );
    try {
      await keyboardDrag(handle, Array(5).fill("ArrowDown"));
    } finally {
      restore();
    }
    expect(dndEnds.at(-1)).toEqual({ active: "gold", over: "drop-insert-mojo" });
    expect(screen.getByText("2 promotions, 0 demotions")).toBeTruthy();
    const box = zoneOf(boxTitle(MOJO));
    expect(within(box).getByText(AQUA)).toBeTruthy();
    expect(within(box).getByText(GOLD)).toBeTruthy();
  });

  /**
   * maestro-web reports resource-id as `id || aria-label`: a DOM id on a
   * control hides its accessible name from every flow. The controls NEO-300
   * added are reached by name ("Select <row>", "Clear selection"), so none
   * of them may carry one. Arrow keys find rows by a data attribute instead
   * (the keyboard test above still walks them).
   */
  test("no row control and no Clear button carries a DOM id", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    const controls = [
      ...screen.getAllByRole("checkbox"),
      nameButton(AQUA),
      nameButton("Wave Red"),
      screen.getByLabelText("Remove Wave Red from parallels"),
      screen.getByRole("button", { name: "Clear selection" }),
    ];
    for (const el of controls) expect(el.getAttribute("id")).toBeNull();
    // Maestro reaches the tick by its name.
    expect(tick(AQUA).getAttribute("aria-label")).toBe(`Select ${AQUA}`);
  });

  test("✕ on one row keeps the rest of the selection", () => {
    renderModal();
    fireEvent.click(tick(AQUA));
    fireEvent.click(tick("Wave Red"));
    fireEvent.click(screen.getByLabelText("Remove Wave Teal from parallels"));
    expect(screen.getByText("0 promotions, 1 demotion")).toBeTruthy();
    expect(isPicked(AQUA)).toBe(true);
    expect(isPicked("Wave Red")).toBe(true);
  });
});

/**
 * NEO-300 — the reducer on its own: states the UI keeps out of reach, which
 * is exactly why they need a backstop.
 */
describe("groupingReducer — a move of several rows is all or nothing", () => {
  const id = (s: string) => s as Id<"selectorOptions">;
  function state(): GroupingState {
    const rows = new Map<Id<"selectorOptions">, RowInfo>();
    const placement = new Map<Id<"selectorOptions">, Placement>();
    const add = (
      key: string,
      kind: "insert" | "parallel",
      parent: string | null,
    ) => {
      rows.set(id(key), {
        _id: id(key),
        value: key,
        originalKind: kind,
        originalParentId: parent ? id(parent) : null,
        originalHadParallels: false,
      });
      placement.set(
        id(key),
        parent ? { kind: "child", parentId: id(parent) } : { kind: "ungrouped" },
      );
    };
    add("target", "insert", null);
    add("a", "insert", null);
    add("holder", "insert", null);
    add("b", "insert", null);
    add("held", "parallel", "holder");
    return groupingReducer(emptyGroupingState, {
      type: "INIT",
      rows,
      placement,
      suggested: new Set(),
    });
  }

  test("a valid row and one holding parallels: nothing moves", () => {
    const before = state();
    const after = groupingReducer(before, {
      type: "MOVE",
      rowIds: [id("a"), id("holder")],
      placement: { kind: "child", parentId: id("target") },
      fromSelection: true,
    });
    expect(after).toBe(before);
  });

  test("the target inside the rows: nothing moves", () => {
    const before = state();
    const after = groupingReducer(before, {
      type: "MOVE",
      rowIds: [id("a"), id("b"), id("target")],
      placement: { kind: "child", parentId: id("target") },
      fromSelection: true,
    });
    expect(after).toBe(before);
  });

  test("all valid: one action moves them all and spends the selection", () => {
    let s = state();
    s = groupingReducer(s, { type: "TOGGLE", rowId: id("a") });
    s = groupingReducer(s, { type: "TOGGLE", rowId: id("b") });
    const after = groupingReducer(s, {
      type: "MOVE",
      rowIds: s.selected,
      placement: { kind: "child", parentId: id("target") },
      fromSelection: true,
    });
    expect(after.placement.get(id("a"))).toEqual({ kind: "child", parentId: "target" });
    expect(after.placement.get(id("b"))).toEqual({ kind: "child", parentId: "target" });
    expect(after.selected).toEqual([]);
  });

  test("a row holding parallels can't be picked by any path", () => {
    const s = state();
    for (const action of [
      { type: "SELECT_ONLY" as const, rowId: id("holder") },
      { type: "TOGGLE" as const, rowId: id("holder") },
    ]) {
      expect(groupingReducer(s, action).selected).toEqual([]);
    }
    const ranged = groupingReducer(s, {
      type: "SELECT_RANGE",
      rowId: id("b"),
      list: [id("a"), id("holder"), id("b")],
      from: id("a"),
    });
    expect(ranged.selected).toEqual(["a", "b"]);
  });
});
