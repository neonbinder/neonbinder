/**
 * NEO-325 (a11y round, security F1) — the Reconcile dialog's Base check as a
 * screen-reader and keyboard user meets it:
 *
 *   - a Pending row the check sets aside is never left selected out of sight;
 *   - the rows do not remount when the check switches on (focus survives);
 *   - one polite live line speaks the whole check;
 *   - a sign-in stop shows in its own column only;
 *   - Keep all's name follows its visible text, its description carries the
 *     rest, and it stays focusable (aria-disabled) when it has nothing to do;
 *   - a row's reason is its handle's description, and the set-aside toggle is
 *     a constant-named disclosure.
 *
 * The verdict rules are `lib/cards/base-match.test.ts`, the queue and the
 * sign-in stop's mechanics are `base-match-probe*.test.tsx`, the dialog's
 * main Base-check behaviour is `ReconciliationModal.baseMatch.test.tsx`.
 * The fake client is that file's, with more ways to answer.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { BASE_MATCH_COPY, judgeAgainstBase, type BaseSignature } from "@/lib/cards/base-match";
import ReconciliationModal, { type PlatformItem } from "./ReconciliationModal";

const VT = "vt1" as Id<"selectorOptions">;
const FN = {
  signature: "baseMatchProbe:getBaseSignatureForVariantType",
  bsc: "baseMatchProbe:probeBscSets",
} as const;

const TROUT = { cardNumber: "1", cardName: "Mike Trout" };
const NOBODY = { cardNumber: "99", cardName: "Nobody" };

function signature(): BaseSignature {
  const first = {
    cardNumber: "1",
    cardName: "Mike Trout",
    namesOnCard: ["Mike Trout"],
    isTeamCard: false,
  };
  return {
    status: "ok",
    baseId: "base1",
    baseName: "Base",
    first,
    perSide: { bsc: 0, sportlots: 0 },
    cards: [first],
  };
}

const REASON_MISMATCH = judgeAgainstBase(signature(), "sportlots", {
  status: "ok",
  first: NOBODY,
}).reason;

type Verdict = "match" | "mismatch" | "fail" | "signed_out" | "no_sign_in" | "refused";
type Call = {
  name: string;
  ids: string[];
  resolve: (v: unknown) => void;
};

type FakeOptions = {
  mode?: "auto" | "hold";
  verdicts?: Record<string, Verdict>;
  /** Hold the signature until `releaseSignature()`. */
  holdSignature?: boolean;
};

function fake(opts: FakeOptions = {}) {
  const mode = opts.mode ?? "auto";
  const verdicts = { ...(opts.verdicts ?? {}) };
  const calls: Call[] = [];
  let release: (v: unknown) => void = () => undefined;
  const answerFor = (call: Call) =>
    call.ids.map((id) => {
      const v = verdicts[id] ?? "match";
      if (v === "fail") return { id, status: "failed", kind: "network" };
      if (v === "signed_out") return { id, status: "failed", kind: "signed_out" };
      if (v === "no_sign_in") return { id, status: "failed", kind: "no_sign_in" };
      if (v === "refused") return { id, status: "refused" };
      const first = v === "match" ? TROUT : NOBODY;
      return call.name === FN.bsc
        ? { id, status: "ok", count: 0, first }
        : { id, status: "ok", first, nonVariationRowsOnPage: 1, pageHadRows: true };
    });
  const client = {
    query: vi.fn((ref: never) => {
      expect(getFunctionName(ref)).toBe(FN.signature);
      if (opts.holdSignature) return new Promise((resolve) => (release = resolve));
      return Promise.resolve(signature());
    }),
    action: vi.fn(
      (ref: never, args: { setIds?: string[]; variantNameIds?: string[] }) =>
        new Promise((resolve) => {
          const call: Call = {
            name: getFunctionName(ref),
            ids: [...(args.setIds ?? args.variantNameIds ?? [])],
            resolve,
          };
          calls.push(call);
          if (mode === "auto") resolve(answerFor(call));
        }),
    ),
  };
  return {
    client,
    calls,
    answer: async (call: Call) => {
      await act(async () => {
        call.resolve(answerFor(call));
      });
      await settle();
    },
    releaseSignature: async () => {
      await act(async () => {
        release(signature());
      });
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

type ModalProps = Parameters<typeof ReconciliationModal>[0];

async function renderModal(
  f: ReturnType<typeof fake>,
  data: {
    bsc?: PlatformItem[];
    sl?: PlatformItem[];
    autoMatched?: ModalProps["initialData"]["autoMatched"];
  },
  extra: Partial<ModalProps> = {},
) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const props: ModalProps = {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm,
    level: "insert",
    initialData: {
      autoMatched: data.autoMatched ?? [],
      unmatchedBsc: data.bsc ?? [],
      unmatchedSl: data.sl ?? [],
      slCandidates: [],
    },
    baseCheck: { variantTypeId: VT },
    ...extra,
  };
  const tree = (p: ModalProps) => (
    <ConvexProvider client={f.client as never}>
      <ReconciliationModal {...p} />
    </ConvexProvider>
  );
  const view = render(tree(props));
  await settle();
  return {
    onConfirm,
    rerender: async (p: ModalProps) => {
      view.rerender(tree(p));
      await settle();
    },
  };
}

const item = (value: string, platformValue: string): PlatformItem => ({ value, platformValue });

const ownSetButton = (label: string) => screen.queryByLabelText(`Make its own set: ${label}`);
const rowOf = (label: string) =>
  screen.getByLabelText(`Make its own set: ${label}`).closest("div.group") as HTMLElement;
/** The drag handle: the row's click-to-select target. */
const handleOf = (label: string) =>
  rowOf(label).querySelector('[aria-roledescription="sortable"]') as HTMLElement;
const isSelected = (label: string) => rowOf(label).className.includes("ring-2");
const toggle = (side: "SportLots" | "BSC") =>
  screen.queryByRole("button", { name: new RegExp(`, ${side}$`) });
const keepAll = (side: "SportLots" | "BSC") =>
  screen.getByRole("button", { name: new RegExp(`^Keep all( \\d+)?, ${side} sets?$`) });
const readyCount = (n: number) => screen.queryByText(new RegExp(`Ready \\(${n}\\)`));

/**
 * The dialog's live line for the check: a screen-reader-only `role="status"`.
 * dnd-kit's own announcer and the footer's save notice are other regions the
 * dialog always had; the first test below pins that they are the only others.
 */
const allStatuses = () => screen.queryAllByRole("status");
const isDndRegion = (el: HTMLElement) => el.id.startsWith("DndLiveRegion");
const isSaveNotice = (el: HTMLElement) => el.className.includes("text-[#FF2EB3]");
const ourStatuses = () =>
  allStatuses().filter((el) => !isDndRegion(el) && !isSaveNotice(el));

const SL_A = item("Sl A", "sl-a");
const SL_B = item("Sl B", "sl-b");
const BSC_A = item("Bsc A", "b-a");

// ---------------------------------------------------------------------------
// A set-aside row is never selected out of sight
// ---------------------------------------------------------------------------

describe("ReconciliationModal Base check — hidden rows are not selected", () => {
  test("control: a selected visible row pairs with a click on the other column", async () => {
    const f = fake();
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A] });

    fireEvent.click(handleOf("Sl A"));
    expect(isSelected("Sl A")).toBe(true);
    fireEvent.click(handleOf("Bsc A"));

    expect(readyCount(1)).toBeTruthy();
  });

  test("a selected SportLots row that gets set aside is no longer selected: a BSC click does not pair", async () => {
    const f = fake({ mode: "hold", verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });

    fireEvent.click(handleOf("Sl A"));
    expect(isSelected("Sl A")).toBe(true);
    const slCall = f.calls.find((c) => c.ids.includes("sl-a"))!;
    await f.answer(slCall);
    expect(ownSetButton("Sl A")).toBeNull();

    fireEvent.click(handleOf("Bsc A"));

    expect(readyCount(1)).toBeNull();
    // The click selected the BSC row instead; nothing paired it.
    expect(isSelected("Bsc A")).toBe(true);
    expect(ownSetButton("Sl B")).toBeTruthy();
  });

  test("opening the toggle shows that row unselected, and a BSC click still does not pair", async () => {
    const f = fake({ mode: "hold", verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });
    fireEvent.click(handleOf("Sl A"));
    await f.answer(f.calls.find((c) => c.ids.includes("sl-a"))!);

    fireEvent.click(toggle("SportLots")!);

    expect(ownSetButton("Sl A")).toBeTruthy();
    expect(isSelected("Sl A")).toBe(false);
    fireEvent.click(handleOf("Bsc A"));
    expect(readyCount(1)).toBeNull();
  });

  test("closing the toggle with a revealed row selected clears it for good", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });
    fireEvent.click(toggle("SportLots")!);
    fireEvent.click(handleOf("Sl A"));
    expect(isSelected("Sl A")).toBe(true);

    fireEvent.click(toggle("SportLots")!);
    expect(ownSetButton("Sl A")).toBeNull();
    fireEvent.click(toggle("SportLots")!);

    // Revealed again, the row comes back as it was never chosen.
    expect(isSelected("Sl A")).toBe(false);
    fireEvent.click(handleOf("Bsc A"));
    expect(readyCount(1)).toBeNull();
  });

  test("opening or closing a column's toggle leaves a visible row's selection alone", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });
    fireEvent.click(handleOf("Sl B"));

    fireEvent.click(toggle("SportLots")!);
    expect(isSelected("Sl B")).toBe(true);
    fireEvent.click(toggle("SportLots")!);
    expect(isSelected("Sl B")).toBe(true);
    fireEvent.click(handleOf("Bsc A"));
    expect(readyCount(1)).toBeTruthy();
  });

  test("the other column's toggle does not clear a set-aside row selected in this one", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch", "b-a": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A, item("Bsc B", "b-b")], sl: [SL_A, SL_B] });
    fireEvent.click(toggle("SportLots")!);
    fireEvent.click(handleOf("Sl A"));

    fireEvent.click(toggle("BSC")!);

    expect(isSelected("Sl A")).toBe(true);
  });

  test("a row of the already-mapped reveal with the same id keeps the selection", async () => {
    // One SportLots set can back two NB sets. Map it twice, then detach it
    // from one set: it is Pending again (and set aside) while another set still
    // maps it, so the same id is both a hidden Pending row and a visible row
    // of the mapped reveal.
    const f = fake({ verdicts: { "sl-a": "mismatch", "sl-b": "mismatch" } });
    const bscB = item("Bsc B", "b-b");
    await renderModal(f, { bsc: [BSC_A, bscB], sl: [SL_A, SL_B] });
    fireEvent.click(toggle("SportLots")!);
    fireEvent.click(screen.getByLabelText("Make its own set: Sl A"));
    fireEvent.click(toggle("SportLots")!); // Sl B is hidden again
    expect(readyCount(1)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show SportLots sets already mapped"));
    const mappedRow = () => screen.getByText(/^mapped to /).parentElement!;
    const mappedHandle = () =>
      mappedRow().querySelector('[aria-roledescription="sortable"]') as HTMLElement;
    fireEvent.click(mappedHandle());
    fireEvent.click(handleOf("Bsc A"));
    expect(readyCount(2)).toBeTruthy();

    const removes = screen.getAllByLabelText(/^Remove Sl A from /);
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1]);
    await settle();
    // Pending again, and set aside (its verdict was cached), yet still mapped.
    expect(screen.queryByLabelText(/^Make its own set: Sl A/)).toBeNull();

    fireEvent.click(mappedHandle());
    expect(mappedRow().querySelector("div.group")!.className).toContain("ring-2");
    fireEvent.click(handleOf("Bsc B"));

    // Paired: a third set.
    expect(readyCount(3)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// No remount when the check switches on
// ---------------------------------------------------------------------------

describe("ReconciliationModal Base check — the rows survive the check starting", () => {
  test("the same elements, with focus kept, before and after the signature arrives", async () => {
    const f = fake({ mode: "hold", holdSignature: true });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });

    const own = ownSetButton("Sl A")!;
    const row = rowOf("Sl A");
    const handle = handleOf("Sl A");
    own.focus();
    expect(document.activeElement).toBe(own);

    await f.releaseSignature();
    expect(f.calls.length).toBeGreaterThan(0); // the check really started

    expect(ownSetButton("Sl A")).toBe(own);
    expect(rowOf("Sl A")).toBe(row);
    expect(handleOf("Sl A")).toBe(handle);
    expect(document.activeElement).toBe(own);
  });

  test("a verdict landing on a visible row does not remount it either", async () => {
    const f = fake({ mode: "hold" });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });
    const own = ownSetButton("Sl A")!;
    own.focus();

    await f.answer(f.calls.find((c) => c.ids.includes("sl-a"))!);

    expect(ownSetButton("Sl A")).toBe(own);
    expect(document.activeElement).toBe(own);
  });
});

// ---------------------------------------------------------------------------
// One live line
// ---------------------------------------------------------------------------

describe("ReconciliationModal Base check — one live line", () => {
  test("exactly one status line of ours, empty at mount, however many columns are checked", async () => {
    const f = fake({ mode: "hold", holdSignature: true });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });

    const lines = ourStatuses();
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe("");
    // Everything else with a status role was there before the check.
    const others = allStatuses().filter((el) => !lines.includes(el));
    expect(others.every((el) => isDndRegion(el) || isSaveNotice(el))).toBe(true);
  });

  test("a dialog that was not asked to check has no live line of ours", async () => {
    const onConfirm = vi.fn();
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={onConfirm}
        level="insert"
        initialData={{ autoMatched: [], unmatchedBsc: [BSC_A], unmatchedSl: [SL_A], slCandidates: [] }}
      />,
    );
    await settle();

    expect(ourStatuses()).toHaveLength(0);
  });

  test("it stays the only one while checking, and the columns hold no live text of their own", async () => {
    const f = fake({ mode: "hold", verdicts: { "sl-b": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });

    expect(ourStatuses()).toHaveLength(1);
    expect(ourStatuses()[0].textContent).toBe(BASE_MATCH_COPY.liveStart(3));
    await f.answer(f.calls[0]);
    await f.answer(f.calls[1]);
    expect(ourStatuses()).toHaveLength(1);
    expect(ourStatuses()[0].textContent).toBe(BASE_MATCH_COPY.liveDone(3, 2, 1, 0));
    // The counters are plain text, not live regions.
    const counter = screen.getAllByText(/^Checked against Base/)[0];
    expect(counter.closest('[aria-live], [role="status"]')).toBeNull();
  });

  test("the total stays fixed when a row goes up to Ready mid-run", async () => {
    const f = fake({ mode: "hold" });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });
    expect(ourStatuses()[0].textContent).toBe(BASE_MATCH_COPY.liveStart(3));

    // A set that leaves before it is checked is accounted for, not removed
    // from the total: one third of the run is done, out of three.
    fireEvent.click(ownSetButton("Sl B")!);
    expect(ourStatuses()[0].textContent).toBe(BASE_MATCH_COPY.liveQuarter(25));

    for (const call of f.calls) await f.answer(call);
    expect(ourStatuses()[0].textContent).toBe(BASE_MATCH_COPY.liveDone(3, 3, 0, 0));
  });

  test("Show all, after the closing sentence, does not say a second closing", async () => {
    const f = fake();
    await renderModal(
      f,
      { sl: [item("1996 Score Ok", "sl-in1"), item("1997 Pinnacle", "sl-out")] },
      { setName: "1996 Score" },
    );
    const closing = BASE_MATCH_COPY.liveDone(1, 1, 0, 0);
    expect(ourStatuses()[0].textContent).toBe(closing);

    fireEvent.click(screen.getByLabelText("Show all SportLots items"));
    await settle();

    expect(ownSetButton("1997 Pinnacle")).toBeTruthy();
    expect(ourStatuses()[0].textContent).toBe(closing);
  });

  test("detaching a Ready set's side, after the closing sentence, does not say a second closing", async () => {
    const f = fake();
    await renderModal(f, {
      autoMatched: [{ displayName: "Pair", bsc: item("Bsc Pair", "b-pair"), sl: item("Sl Pair", "sl-pair"), confidence: 0.9 }],
      sl: [SL_A],
    });
    const closing = BASE_MATCH_COPY.liveDone(1, 1, 0, 0);
    expect(ourStatuses()[0].textContent).toBe(closing);

    fireEvent.click(screen.getByLabelText(/^Remove Sl Pair from /));
    await settle();

    expect(ownSetButton("Sl Pair")).toBeTruthy();
    expect(ourStatuses()[0].textContent).toBe(closing);
  });

  test("a check with nothing to ask says no closing sentence", async () => {
    const f = fake();
    await renderModal(f, { sl: [], bsc: [] });

    expect(ourStatuses()[0].textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The sign-in stop shows in its own column
// ---------------------------------------------------------------------------

describe("ReconciliationModal Base check — a sign-in stop", () => {
  const columnOf = (el: HTMLElement) => el.closest(".grid-cols-2 > div") as HTMLElement;

  test("SportLots signed out: its notice appears in its column only, and BSC is unaffected", async () => {
    const f = fake({ verdicts: { "sl-a": "signed_out", "sl-b": "signed_out" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });

    const notice = screen.getByText(BASE_MATCH_COPY.stoppedNotice("sportlots"));
    expect(columnOf(notice).textContent).toContain("SportLots (");
    expect(columnOf(notice).textContent).not.toContain("BSC (");
    expect(screen.queryByText(BASE_MATCH_COPY.stoppedNotice("bsc"))).toBeNull();
    // BSC checked normally.
    expect(within(rowOf("Bsc A")).getByText(`, ${BASE_MATCH_COPY.srMatch}`)).toBeTruthy();
    // The stopped rows say why, and stay listed.
    expect(screen.getAllByText(BASE_MATCH_COPY.unverifiableSignIn)).toHaveLength(2);
    expect(ownSetButton("Sl A")).toBeTruthy();
    expect(ownSetButton("Sl B")).toBeTruthy();
  });

  test("BSC signed out: the notice is in the BSC column only", async () => {
    const f = fake({ verdicts: { "b-a": "no_sign_in" } });
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A] });

    const notice = screen.getByText(BASE_MATCH_COPY.stoppedNotice("bsc"));
    expect(columnOf(notice).textContent).toContain("BSC (");
    expect(screen.queryByText(BASE_MATCH_COPY.stoppedNotice("sportlots"))).toBeNull();
  });

  test("it is said to a screen reader through the one live line, and the visible notice is not itself live", async () => {
    const f = fake({ verdicts: { "sl-a": "signed_out" } });
    await renderModal(f, { sl: [SL_A] });

    expect(ourStatuses()).toHaveLength(1);
    expect(ourStatuses()[0].textContent).toContain(BASE_MATCH_COPY.liveStopped("sportlots"));
    const notice = screen.getByText(BASE_MATCH_COPY.stoppedNotice("sportlots"));
    expect(notice.closest('[aria-live], [role="status"]')).toBeNull();
    // The spoken and the visible sentence are different texts.
    expect(ourStatuses()[0].textContent).not.toContain(BASE_MATCH_COPY.stoppedNotice("sportlots"));
  });

  test("a mixed batch shows no notice", async () => {
    const f = fake({ verdicts: { "sl-a": "signed_out" } });
    await renderModal(f, { sl: [SL_A, SL_B] });

    expect(screen.queryByText(BASE_MATCH_COPY.stoppedNotice("sportlots"))).toBeNull();
  });

  test("a BSC batch the chain refused shows no notice", async () => {
    const f = fake({ verdicts: { "b-a": "refused" } });
    await renderModal(f, { bsc: [BSC_A] });

    expect(screen.queryByText(BASE_MATCH_COPY.stoppedNotice("bsc"))).toBeNull();
  });

  test("a stopped column's Keep all still reaches its rows: they could not be checked, not refused", async () => {
    const f = fake({ verdicts: { "sl-a": "signed_out", "sl-b": "signed_out" } });
    await renderModal(f, { sl: [SL_A, SL_B] });

    expect(keepAll("SportLots").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(keepAll("SportLots"));
    expect(readyCount(2)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Keep all
// ---------------------------------------------------------------------------

describe("ReconciliationModal Base check — Keep all, for assistive technology", () => {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const beginsWithVisible = (el: HTMLElement) =>
    words(el.getAttribute("aria-label") ?? "").startsWith(words(el.textContent ?? ""));

  test("its name follows the visible text, unfiltered, narrowed by the check and with nothing to keep", async () => {
    const f = fake({ mode: "hold", verdicts: { "sl-b": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B, item("Sl C", "sl-c")] });

    // Nothing settled: nothing to keep, but the name still begins "Keep all".
    let button = keepAll("SportLots");
    expect(button.textContent).toBe("Keep all");
    expect(beginsWithVisible(button)).toBe(true);

    await f.answer(f.calls[0]);
    button = keepAll("SportLots");
    expect(button.textContent).toBe("Keep all 2");
    expect(button.getAttribute("aria-label")).toBe("Keep all 2, SportLots sets");
    expect(beginsWithVisible(button)).toBe(true);
  });

  test("the name is not the description: the long sentence is not in it", async () => {
    const f = fake();
    await renderModal(f, { sl: [SL_A, SL_B] });

    const label = keepAll("SportLots").getAttribute("aria-label")!;
    expect(label).toBe("Keep all, SportLots sets");
    expect(label).not.toMatch(/NeonBinder/);
  });

  test("aria-describedby resolves to a screen-reader-only description that says what is left out", async () => {
    const f = fake({ mode: "hold", verdicts: { "sl-b": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    await f.answer(f.calls[0]);

    const button = keepAll("SportLots");
    const describedBy = button.getAttribute("aria-describedby")!;
    const description = document.getElementById(describedBy)!;
    expect(description).toBeTruthy();
    expect(description.className).toContain("sr-only");
    expect(description.textContent).toContain("Make the 1 listed SportLots set its own NeonBinder set.");
    expect(description.textContent).toContain(BASE_MATCH_COPY.keepAllLeftOut(0, 1).trim());
    // The tooltip says the same.
    expect(button.title).toBe(description.textContent);
  });

  test("the description says 'every pending' when nothing is narrowed", async () => {
    const f = fake();
    await renderModal(f, { sl: [SL_A, SL_B] });

    const description = document.getElementById(keepAll("SportLots").getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Make every pending SportLots set its own NeonBinder set.");
    expect(description.textContent).not.toContain("still being checked");
  });

  test("each column's description is its own element", async () => {
    const f = fake();
    await renderModal(f, { bsc: [BSC_A], sl: [SL_A] });

    const a = keepAll("BSC").getAttribute("aria-describedby");
    const b = keepAll("SportLots").getAttribute("aria-describedby");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  test("with nothing to keep it is aria-disabled, not disabled, and keeps focus as rows settle", async () => {
    const f = fake({ mode: "hold", verdicts: { "sl-a": "mismatch", "sl-b": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    const button = keepAll("SportLots") as HTMLButtonElement;
    button.focus();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);

    // Every row is set aside: still nothing to keep, and focus is where it was.
    await f.answer(f.calls[0]);

    const after = keepAll("SportLots") as HTMLButtonElement;
    expect(after).toBe(button);
    expect(after.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(after);
  });

  test("it is aria-disabled while rows are still being checked and enabled once one has matched", async () => {
    const f = fake({ mode: "hold" });
    await renderModal(f, { sl: [SL_A] });
    expect(keepAll("SportLots").getAttribute("aria-disabled")).toBe("true");

    await f.answer(f.calls[0]);

    expect(keepAll("SportLots").getAttribute("aria-disabled")).toBeNull();
  });

  test("a press while aria-disabled does nothing: no set, no focus move, the selection kept", async () => {
    const f = fake({ mode: "hold" });
    const { onConfirm } = await renderModal(f, { bsc: [BSC_A], sl: [SL_A, SL_B] });
    // Select a BSC row; a dead press on the SportLots button must not undo it.
    fireEvent.click(handleOf("Bsc A"));
    expect(isSelected("Bsc A")).toBe(true);
    const button = keepAll("SportLots");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();

    fireEvent.click(button);
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });

    expect(readyCount(1)).toBeNull();
    expect(readyCount(2)).toBeNull();
    expect(ownSetButton("Sl A")).toBeTruthy();
    expect(ownSetButton("Sl B")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    expect(isSelected("Bsc A")).toBe(true);
  });

  test("a press while enabled still keeps the rows", async () => {
    const f = fake();
    await renderModal(f, { sl: [SL_A, SL_B] });

    fireEvent.click(keepAll("SportLots"));

    expect(readyCount(2)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The reason, and the toggle
// ---------------------------------------------------------------------------

describe("ReconciliationModal Base check — a row's reason and the set-aside group", () => {
  test("a set-aside row's handle is described by its reason first, then by dnd-kit's own instructions", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    fireEvent.click(toggle("SportLots")!);

    const tokens = handleOf("Sl A").getAttribute("aria-describedby")!.split(" ");
    expect(tokens).toHaveLength(2);
    expect(document.getElementById(tokens[0])!.textContent).toBe(REASON_MISMATCH);
    expect(tokens[1]).toMatch(/^DndDescribedBy/);
    expect(document.getElementById(tokens[1])).toBeTruthy();
  });

  test("a row that could not be checked carries its reason the same way", async () => {
    const f = fake({ verdicts: { "sl-a": "fail" } });
    await renderModal(f, { sl: [SL_A] });

    const tokens = handleOf("Sl A").getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(tokens[0])!.textContent).toBe(BASE_MATCH_COPY.unverifiable);
    expect(tokens[1]).toMatch(/^DndDescribedBy/);
  });

  test("a matching row has only dnd-kit's description", async () => {
    const f = fake();
    await renderModal(f, { sl: [SL_A] });

    const tokens = handleOf("Sl A").getAttribute("aria-describedby")!.split(" ");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(/^DndDescribedBy/);
  });

  test("a row with the check off has only dnd-kit's description", async () => {
    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        level="insert"
        initialData={{ autoMatched: [], unmatchedBsc: [], unmatchedSl: [SL_A], slCandidates: [] }}
      />,
    );
    await settle();

    expect(handleOf("Sl A").getAttribute("aria-describedby")).toMatch(/^DndDescribedBy-\d+$/);
  });

  test("two rows with reasons have different reason ids", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch", "sl-b": "fail" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    fireEvent.click(toggle("SportLots")!);

    const a = handleOf("Sl A").getAttribute("aria-describedby")!.split(" ")[0];
    const b = handleOf("Sl B").getAttribute("aria-describedby")!.split(" ")[0];
    expect(a).not.toBe(b);
  });

  test("a marketplace id with odd characters still gives a one-token reason id", async () => {
    const odd = item("Sl Odd", "a b/c:d");
    const f = fake({ verdicts: { "a b/c:d": "mismatch" } });
    await renderModal(f, { sl: [odd, SL_B] });
    fireEvent.click(toggle("SportLots")!);

    const tokens = handleOf("Sl Odd").getAttribute("aria-describedby")!.split(" ");
    expect(tokens).toHaveLength(2);
    expect(document.getElementById(tokens[0])).toBeTruthy();
  });

  test("the toggle keeps one name whichever way it is open, and its state is aria-expanded alone", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    const button = toggle("SportLots")!;
    const name = BASE_MATCH_COPY.toggleName(BASE_MATCH_COPY.mismatchedToggle(1), "sportlots");

    expect(button.getAttribute("aria-label")).toBe(name);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-label")).toBe(name);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(button.getAttribute("aria-label")).toBe(name);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("the toggle's accessible name begins with the words printed on it", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    const button = toggle("SportLots")!;

    expect(button.textContent).toBe(BASE_MATCH_COPY.mismatchedToggle(1));
    expect(button.getAttribute("aria-label")!.startsWith(button.textContent!)).toBe(true);
  });

  test("the toggle has no DOM id; the open group is a role=group labelled by the span inside it", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch" } });
    await renderModal(f, { sl: [SL_A, SL_B] });
    const button = toggle("SportLots")!;
    expect(button.getAttribute("id")).toBeNull();
    expect(screen.queryByRole("group", { name: /don't match the Base/ })).toBeNull();

    fireEvent.click(button);

    const group = screen.getByRole("group", { name: BASE_MATCH_COPY.mismatchedToggle(1) });
    expect(button.getAttribute("aria-controls")).toBe(group.id);
    const labelId = group.getAttribute("aria-labelledby")!;
    const label = document.getElementById(labelId)!;
    expect(label.tagName).toBe("SPAN");
    expect(button.contains(label)).toBe(true);
    expect(within(group).getByLabelText("Make its own set: Sl A")).toBeTruthy();
  });

  test("both columns' groups are separate, each labelled by its own count", async () => {
    const f = fake({ verdicts: { "sl-a": "mismatch", "b-a": "mismatch", "b-b": "mismatch" } });
    await renderModal(f, { bsc: [BSC_A, item("Bsc B", "b-b"), item("Bsc C", "b-c")], sl: [SL_A, SL_B] });
    fireEvent.click(toggle("SportLots")!);
    fireEvent.click(toggle("BSC")!);

    expect(screen.getByRole("group", { name: BASE_MATCH_COPY.mismatchedToggle(1) })).toBeTruthy();
    expect(screen.getByRole("group", { name: BASE_MATCH_COPY.mismatchedToggle(2) })).toBeTruthy();
  });
});
