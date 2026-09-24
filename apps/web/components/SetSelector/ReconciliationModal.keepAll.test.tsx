/**
 * NEO-300 — the Pending columns' "Keep all" and the in-row "Make its own set".
 *
 * A column can list 141 BSC sets. Keeping each as its own NeonBinder set used
 * to be 141 presses on a tiny text link under each row. "Keep all" does what
 * those presses would do, to exactly the rows the column is SHOWING, in one
 * reducer action; the per-row control is a real button inside the row.
 */

import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReconciliationModal, {
  reconciliationReducer,
  type PlatformItem,
} from "./ReconciliationModal";

type InitialData = Parameters<typeof ReconciliationModal>[0]["initialData"];

const bsc = (value: string, platformValue = value.toLowerCase().replace(/\W+/g, "-")): PlatformItem => ({
  value,
  platformValue,
});

const S1 = bsc("Artist's Proofs Series 1");
const S2 = bsc("Artist's Proofs Series 2");
const DK = bsc("Diamond Kings");
const SL_AP = bsc("1996 Score Artists Proofs", "sl-ap");
const SL_DK = bsc("1996 Score Diamond Kings", "sl-dk");
// Outside the "1996 Score" prefix — hidden until "Show all SportLots items".
const SL_OTHER = bsc("1997 Pinnacle Museum", "sl-pm");

function renderModal(initialData: InitialData, extra: { setName?: string } = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      initialData={initialData}
      {...extra}
    />,
  );
  return { onConfirm };
}

function pending(bscItems: PlatformItem[], slItems: PlatformItem[] = []): InitialData {
  return { autoMatched: [], unmatchedBsc: bscItems, unmatchedSl: slItems, slCandidates: [] };
}

const keepAllBsc = () =>
  screen.getByRole("button", { name: /^Keep all: \d+ BSC sets?$/ });
const keepAllSl = () =>
  screen.getByRole("button", { name: /^Keep all: \d+ SportLots sets?$/ });

async function savedItems(onConfirm: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByText(/^Save \d+ sets$/));
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  return onConfirm.mock.calls[0][0].items as Array<{
    value: string;
    platformData: { bsc?: string[]; sportlots?: string[] };
  }>;
}

async function flushFrame() {
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}

describe("ReconciliationModal — Keep all", () => {
  test("keeps every listed item in the column as its own one-sided set", async () => {
    const { onConfirm } = renderModal(pending([S1, S2, DK], [SL_AP]));

    expect(keepAllBsc().textContent).toBe("Keep all");
    fireEvent.click(keepAllBsc());

    expect(screen.getByText(/Ready \(3\)/)).toBeTruthy();
    expect(screen.getByText("Nothing pending on BSC")).toBeTruthy();
    // The other column is untouched.
    expect(screen.getByLabelText(`Make its own set: ${SL_AP.value}`)).toBeTruthy();

    const items = await savedItems(onConfirm);
    expect(items.map((i) => [i.value, i.platformData])).toEqual([
      [S1.value, { bsc: [S1.platformValue] }],
      [S2.value, { bsc: [S2.platformValue] }],
      [DK.value, { bsc: [DK.platformValue] }],
    ]);
  });

  test("reaches only what the search box is showing, and says how many", async () => {
    const { onConfirm } = renderModal(pending([S1, S2, DK]));
    fireEvent.change(screen.getByLabelText("Filter BSC items"), {
      target: { value: "series" },
    });

    const button = keepAllBsc();
    expect(button.textContent).toBe("Keep all 2");
    expect(button.getAttribute("aria-label")).toBe(
      "Keep all: 2 BSC sets",
    );
    fireEvent.click(button);

    // The hidden row is still pending, and it is the only one.
    fireEvent.change(screen.getByLabelText("Filter BSC items"), {
      target: { value: "" },
    });
    expect(screen.getByLabelText(`Make its own set: ${DK.value}`)).toBeTruthy();
    expect(screen.queryByLabelText(`Make its own set: ${S1.value}`)).toBeNull();
    expect(keepAllBsc().getAttribute("aria-label")).toBe(
      "Keep all: 1 BSC set",
    );

    const items = await savedItems(onConfirm);
    expect(items.map((i) => i.value)).toEqual([S1.value, S2.value]);
  });

  test("honours the SportLots prefix filter until Show all is ticked", () => {
    renderModal(pending([], [SL_AP, SL_DK, SL_OTHER]), { setName: "1996 Score" });

    fireEvent.click(keepAllSl());
    expect(screen.getByText(/Ready \(2\)/)).toBeTruthy();

    // The out-of-prefix set was not listed, so it was not kept.
    fireEvent.click(screen.getByLabelText("Show all SportLots items"));
    expect(
      screen.getByLabelText(`Make its own set: ${SL_OTHER.value}`),
    ).toBeTruthy();
    fireEvent.click(keepAllSl());
    expect(screen.getByText(/Ready \(3\)/)).toBeTruthy();
  });

  test("leaves the already-mapped reveal alone — those already back a set", () => {
    renderModal(pending([S1, S2]));
    fireEvent.click(screen.getByLabelText(`Make its own set: ${S1.value}`));
    fireEvent.click(screen.getByLabelText("Show BSC sets already mapped"));
    // S1 is listed again (as mapped), S2 is pending.
    expect(screen.getByText(`mapped to ${S1.value}`)).toBeTruthy();

    fireEvent.click(keepAllBsc());
    // S2 joined; S1 was NOT made into a second set.
    expect(screen.getByText(/Ready \(2\)/)).toBeTruthy();
  });

  test("is disabled with nothing listed, and hands focus back to the filter", async () => {
    renderModal(pending([S1]));
    const button = keepAllBsc();
    button.focus();
    fireEvent.click(button);
    await flushFrame();

    expect(keepAllBsc()).toHaveProperty("disabled", true);
    expect(document.activeElement).toBe(screen.getByLabelText("Filter BSC items"));
  });

  test("141 rows become 141 sets from one press", () => {
    const many = Array.from({ length: 141 }, (_, n) => bsc(`Insert ${n + 1}`, `bsc-${n + 1}`));
    renderModal(pending(many));

    fireEvent.click(keepAllBsc());

    expect(screen.getByText(/Ready \(141\)/)).toBeTruthy();
    expect(screen.getByText("Save 141 sets")).toBeTruthy();
    expect(screen.getByText("Nothing pending on BSC")).toBeTruthy();
  });
});

/**
 * One action, not N: the reducer is where "one state update" is observable.
 * A click handler dispatching N PROMOTE_SOLOs would also batch into one React
 * render, so a render count could not tell the two apart — this can.
 */
describe("reconciliationReducer — PROMOTE_SOLO_MANY", () => {
  type State = Parameters<typeof reconciliationReducer>[0];
  const empty: State = { ready: [], pendingBsc: [], pendingSl: [], seq: 5 };

  test("does in one pass what PROMOTE_SOLO does per item", () => {
    const items = [S1, S2, DK];
    const start: State = { ...empty, pendingBsc: items };
    const many = reconciliationReducer(start, {
      type: "PROMOTE_SOLO_MANY",
      side: "bsc",
      items,
    });
    const oneByOne = items.reduce(
      (s, item) => reconciliationReducer(s, { type: "PROMOTE_SOLO", side: "bsc", item }),
      start,
    );
    expect(many).toEqual(oneByOne);
    expect(many.ready.map((r) => r.key)).toEqual(["set-5", "set-6", "set-7"]);
    expect(many.seq).toBe(8);
  });

  test("an item listed twice becomes one set", () => {
    const next = reconciliationReducer(
      { ...empty, pendingSl: [SL_AP] },
      { type: "PROMOTE_SOLO_MANY", side: "sl", items: [SL_AP, SL_AP] },
    );
    expect(next.ready).toHaveLength(1);
    expect(next.pendingSl).toEqual([]);
  });

  test("nothing to keep is the same state object", () => {
    const start: State = { ...empty, pendingBsc: [S1] };
    expect(
      reconciliationReducer(start, { type: "PROMOTE_SOLO_MANY", side: "bsc", items: [] }),
    ).toBe(start);
  });
});

describe("ReconciliationModal — Make its own set is a button in the row", () => {
  test("sits inside the item's row, beside (not inside) the drag handle", () => {
    renderModal(pending([S1, S2]));
    const button = screen.getByRole("button", {
      name: `Make its own set: ${S1.value}`,
    });
    expect(button.textContent).toBe("Make its own set");

    // The row that shows the name is the row that holds the button.
    const handle = screen.getByText(S1.value).closest(".cursor-grab") as HTMLElement;
    expect(handle).toBeTruthy();
    const row = handle.parentElement as HTMLElement;
    expect(row.contains(button)).toBe(true);
    // ...but never nested in the handle, which dnd-kit makes a role="button".
    expect(handle.contains(button)).toBe(false);
    expect(handle.getAttribute("role")).toBe("button");

    // WCAG 2.5.8 target size (happy-dom has no layout; the class is the pin).
    expect(button.className).toContain("min-h-[28px]");
  });

  test("pressing it keeps the operator in the column: focus moves to the next row", async () => {
    renderModal(pending([S1, S2, DK]));
    const first = screen.getByLabelText(`Make its own set: ${S1.value}`);
    first.focus();
    fireEvent.click(first);
    await flushFrame();

    expect(document.activeElement).toBe(
      screen.getByLabelText(`Make its own set: ${S2.value}`),
    );
    expect(
      within(screen.getByText(/Ready \(1\)/).parentElement as HTMLElement).getByLabelText(
        `NeonBinder set name for ${S1.value}`,
      ),
    ).toBeTruthy();
  });

  test("the last row hands focus back to the filter", async () => {
    renderModal(pending([S1]));
    const only = screen.getByLabelText(`Make its own set: ${S1.value}`);
    only.focus();
    fireEvent.click(only);
    await flushFrame();
    expect(document.activeElement).toBe(screen.getByLabelText("Filter BSC items"));
  });
});

/**
 * WCAG 2.5.3 label in name: a speech user says what they SEE, so each
 * accessible name must begin with the visible words (punctuation aside).
 */
describe("ReconciliationModal — names begin with the visible text", () => {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const beginsWithVisible = (el: HTMLElement) =>
    words(el.getAttribute("aria-label") ?? "").startsWith(words(el.textContent ?? ""));

  test("row button and Keep all, filtered or not", () => {
    renderModal(pending([S1, S2, DK], [SL_AP]));
    const rowButton = screen.getByRole("button", { name: `Make its own set: ${S1.value}` });
    expect(beginsWithVisible(rowButton)).toBe(true);
    expect(keepAllBsc().getAttribute("aria-label")).toBe("Keep all: 3 BSC sets");
    expect(beginsWithVisible(keepAllBsc())).toBe(true);
    expect(keepAllSl().getAttribute("aria-label")).toBe("Keep all: 1 SportLots set");

    fireEvent.change(screen.getByLabelText("Filter BSC items"), {
      target: { value: "series" },
    });
    expect(keepAllBsc().textContent).toBe("Keep all 2");
    expect(beginsWithVisible(keepAllBsc())).toBe(true);
  });

  /**
   * maestro-web reports resource-id as `id || aria-label`: a DOM id on
   * either button would replace the name the flows tap it by
   * ("Make its own set: Anime$", "Keep all: [1-9][0-9]* BSC sets?").
   */
  test("Keep all, Make its own set and the row handle carry no DOM id", () => {
    renderModal(pending([S1, S2], [SL_AP]));
    const controls = [
      keepAllBsc(),
      keepAllSl(),
      screen.getByRole("button", { name: `Make its own set: ${S1.value}` }),
      screen.getByRole("button", { name: `Make its own set: ${SL_AP.value}` }),
      // The drag handle (role="button" from dnd-kit) around the row's name.
      screen.getByText(S1.value).parentElement!,
    ];
    for (const el of controls) expect(el.getAttribute("id")).toBeNull();
  });

  test("the two columns' names never contain one another (Maestro ids are a regex find)", () => {
    renderModal(pending([S1], [SL_AP]));
    const a = keepAllBsc().getAttribute("aria-label")!;
    const b = keepAllSl().getAttribute("aria-label")!;
    expect(a.includes(b) || b.includes(a)).toBe(false);
    // CardPairingModal's ids, which setup.yaml taps.
    for (const id of ["Keep all BSC-only cards", "Keep all SportLots-only cards"]) {
      expect(new RegExp(id).test(a) || new RegExp(id).test(b)).toBe(false);
    }
  });
});
