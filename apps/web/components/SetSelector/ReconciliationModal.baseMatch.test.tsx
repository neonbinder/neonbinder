/**
 * NEO-325 — the Reconcile dialog's Base match check: unmatched marketplace
 * sets on either side are checked against NB's saved Base, the ones that do
 * not match are set aside behind a per-column toggle (never removed), and
 * "Keep all" promotes only what has been checked and matched.
 *
 * The dialog gets a Convex client from `<ConvexProvider>` only when the caller
 * passes `baseCheck`. A fake client records every probe call; `auto` answers
 * them from a per-id verdict table, `hold` leaves them pending so the
 * "still checking" states are observable. The verdict rules are
 * `lib/cards/base-match.test.ts`, the queue is `base-match-probe.test.tsx`.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  BASE_MATCH_COPY,
  judgeAgainstBase,
  type BaseSignature,
} from "@/lib/cards/base-match";
import ReconciliationModal, { type PlatformItem } from "./ReconciliationModal";

const useConvexSpy = vi.hoisted(() => vi.fn());
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useConvex: (...args: Parameters<typeof actual.useConvex>) => {
      useConvexSpy();
      return actual.useConvex(...args);
    },
  };
});

const VT = "vt1" as Id<"selectorOptions">;
const FN = {
  signature: "baseMatchProbe:getBaseSignatureForVariantType",
  bsc: "baseMatchProbe:probeBscSets",
  slFirst: "baseMatchProbe:probeSlFirstPage",
  slCount: "baseMatchProbe:probeSlCount",
} as const;

const TROUT = { cardNumber: "1", cardName: "Mike Trout" };
const NOBODY = { cardNumber: "99", cardName: "Nobody" };

/** No linked Base cards on either side: a row is judged on its first card. */
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

type Verdict = "match" | "mismatch" | "fail";
type Call = {
  name: string;
  ids: string[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

type FakeOptions = {
  /** `hold` leaves every probe call pending until the test answers it. */
  mode?: "auto" | "hold";
  /** The signature call's answer; "hold" never answers. */
  signature?: unknown;
  verdicts?: Record<string, Verdict>;
};

function fake(opts: FakeOptions = {}) {
  const mode = opts.mode ?? "auto";
  const verdicts = { ...(opts.verdicts ?? {}) };
  const calls: Call[] = [];
  const answerFor = (call: Call) => {
    const rows = call.ids.map((id) => {
      const v = verdicts[id] ?? "match";
      if (v === "fail") return { id, status: "failed", kind: "network" };
      const first = v === "match" ? TROUT : NOBODY;
      return call.name === FN.bsc
        ? { id, status: "ok", count: 0, first }
        : { id, status: "ok", first, nonVariationRowsOnPage: 1, pageHadRows: true };
    });
    return rows;
  };
  const client = {
    query: vi.fn((ref: never) => {
      expect(getFunctionName(ref)).toBe(FN.signature);
      if (opts.signature === "hold") return new Promise(() => undefined);
      return Promise.resolve(opts.signature ?? signature());
    }),
    action: vi.fn(
      (ref: never, args: { setIds?: string[]; variantNameIds?: string[] }) =>
        new Promise((resolve, reject) => {
          const call: Call = {
            name: getFunctionName(ref),
            ids: [...(args.setIds ?? args.variantNameIds ?? [])],
            resolve,
            reject,
          };
          calls.push(call);
          if (mode === "auto") resolve(answerFor(call));
        }),
    ),
  };
  return {
    client,
    calls,
    verdicts,
    /** Answer a held call from the verdict table. */
    answer: async (call: Call) => {
      await act(async () => {
        call.resolve(answerFor(call));
      });
      await settle();
    },
    idsAsked: () => calls.flatMap((c) => c.ids),
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
  f: ReturnType<typeof fake> | null,
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
    ...extra,
  };
  const withCheck: ModalProps = f ? { ...props, baseCheck: { variantTypeId: VT } } : props;
  const tree = (p: ModalProps) =>
    f ? (
      <ConvexProvider client={f.client as never}>
        <ReconciliationModal {...p} />
      </ConvexProvider>
    ) : (
      <ReconciliationModal {...p} />
    );
  const view = render(tree(withCheck));
  await settle();
  return {
    onConfirm,
    props: withCheck,
    rerender: async (p: ModalProps) => {
      view.rerender(tree(p));
      await settle();
    },
  };
}

const item = (value: string, platformValue: string): PlatformItem => ({
  value,
  platformValue,
});

const ownSetButton = (label: string) =>
  screen.queryByLabelText(`Make its own set: ${label}`);
const rowOf = (label: string) =>
  screen.getByLabelText(`Make its own set: ${label}`).closest("div.group") as HTMLElement;
const toggle = (side: "SportLots" | "BSC") =>
  screen.queryByRole("button", { name: new RegExp(`, ${side}$`) });
const keepAll = (side: "SportLots" | "BSC") =>
  screen.getByRole("button", {
    name: new RegExp(`^Keep all: \\d+ ${side} sets?$`),
  }) as HTMLButtonElement;
const srStatusIn = (row: HTMLElement) => row.querySelector(".sr-only")?.textContent ?? "";

async function savedItems(onConfirm: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByText(/^Save \d+ sets$/));
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  return onConfirm.mock.calls[0][0].items as Array<{
    value: string;
    identityOnly?: true;
    platformData: { bsc?: string[]; sportlots?: string[] };
  }>;
}

// Four SportLots sets: two match, one does not, one cannot be checked.
const SL_OK1 = item("Sl Ok One", "sl-ok1");
const SL_BAD = item("Sl Bad", "sl-bad");
const SL_OK2 = item("Sl Ok Two", "sl-ok2");
const SL_FAIL = item("Sl Fail", "sl-fail");
const FOUR_SL = [SL_OK1, SL_BAD, SL_OK2, SL_FAIL];
const FOUR_VERDICTS: Record<string, Verdict> = {
  "sl-bad": "mismatch",
  "sl-fail": "fail",
};

beforeEach(() => {
  useConvexSpy.mockClear();
});

describe("ReconciliationModal Base check — only when asked for", () => {
  test("without baseCheck there is no chrome and useConvex is never called", async () => {
    await renderModal(null, { bsc: [item("Bsc A", "b-a")], sl: FOUR_SL });

    expect(useConvexSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/against Base/)).toBeNull();
    expect(screen.queryByRole("button", { name: /that don't match the Base/ })).toBeNull();
    expect(srStatusIn(rowOf("Sl Bad"))).toBe("");
    expect(keepAll("SportLots").getAttribute("aria-label")).toBe(
      "Keep all: 4 SportLots sets",
    );
  });

  test("with baseCheck the dialog reads the client", async () => {
    const f = fake({ mode: "hold" });
    await renderModal(f, { sl: FOUR_SL });
    expect(useConvexSpy).toHaveBeenCalled();
    expect(f.client.query).toHaveBeenCalledTimes(1);
  });

  test("there is no chrome while the signature loads", async () => {
    const f = fake({ signature: "hold" });
    await renderModal(f, { bsc: [item("Bsc A", "b-a")], sl: FOUR_SL });

    expect(screen.queryByText(/against Base/)).toBeNull();
    expect(srStatusIn(rowOf("Sl Bad"))).toBe("");
    expect(f.client.action).not.toHaveBeenCalled();
    // Every row is listed and Keep all reaches them all.
    expect(keepAll("SportLots").getAttribute("aria-label")).toBe(
      "Keep all: 4 SportLots sets",
    );
  });

  test.each(["noBase", "manyBases", "notParallelType", "noCards", "tooManyCards"])(
    "a %s signature leaves the dialog exactly as it was",
    async (status) => {
      const f = fake({ signature: { status } });
      await renderModal(f, { bsc: [item("Bsc A", "b-a")], sl: FOUR_SL });

      expect(screen.queryByText(/against Base/)).toBeNull();
      expect(toggle("SportLots")).toBeNull();
      expect(srStatusIn(rowOf("Sl Bad"))).toBe("");
      expect(f.client.action).not.toHaveBeenCalled();
      expect(keepAll("SportLots").getAttribute("aria-label")).toBe(
        "Keep all: 4 SportLots sets",
      );
    },
  );
});

describe("ReconciliationModal Base check — rows and counter", () => {
  test("a row shows a glyph and a screen-reader status, and settles from checking", async () => {
    const f = fake({ mode: "hold", verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    const row = rowOf("Sl Ok One");
    expect(row.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(srStatusIn(row)).toBe(`, ${BASE_MATCH_COPY.srChecking}`);

    await f.answer(f.calls[0]);
    expect(srStatusIn(rowOf("Sl Ok One"))).toBe(`, ${BASE_MATCH_COPY.srMatch}`);
    expect(srStatusIn(rowOf("Sl Ok Two"))).toBe(`, ${BASE_MATCH_COPY.srMatch}`);
    expect(srStatusIn(rowOf("Sl Fail"))).toBe(`, ${BASE_MATCH_COPY.srUnverifiable}`);
  });

  test("the counter goes from Checking to Checked", async () => {
    const f = fake({ mode: "hold", verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    expect(screen.getByText(BASE_MATCH_COPY.checkingHeader(0, 4))).toBeTruthy();
    await f.answer(f.calls[0]);
    expect(screen.getByText(BASE_MATCH_COPY.checkedHeader(2, 1, 1))).toBeTruthy();
    expect(screen.queryByText(/^Checking against Base/)).toBeNull();
  });

  test("a row that cannot be checked says so and stays listed", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    expect(ownSetButton("Sl Fail")).toBeTruthy();
    expect(screen.getByText(BASE_MATCH_COPY.unverifiable("sportlots"))).toBeTruthy();
  });
});

describe("ReconciliationModal Base check — set aside, never removed", () => {
  test("a mismatched row is hidden from its column and the column's count", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    expect(ownSetButton("Sl Bad")).toBeNull();
    expect(ownSetButton("Sl Ok One")).toBeTruthy();
    expect(screen.getByText("SPORTLOTS (3 of 4)", { exact: false })).toBeTruthy();
  });

  test("the toggle is a disclosure whose accessible name ends with the column", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    const button = toggle("SportLots")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe(
      BASE_MATCH_COPY.toggleName(BASE_MATCH_COPY.showMismatched(1), "sportlots"),
    );
    // The other column has nothing set aside, so it has no toggle.
    expect(toggle("BSC")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe(
      BASE_MATCH_COPY.toggleName(BASE_MATCH_COPY.hideMismatched(1), "sportlots"),
    );
  });

  test("revealed, a mismatched row shows its reason and renders before the rest", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });
    fireEvent.click(toggle("SportLots")!);

    const buttons = screen
      .getAllByLabelText(/^Make its own set: /)
      .map((b) => b.getAttribute("aria-label"));
    expect(buttons[0]).toBe("Make its own set: Sl Bad");
    expect(buttons).toHaveLength(4);
    expect(screen.getByText(REASON_MISMATCH)).toBeTruthy();

    // Hiding it again takes it out of the column but nowhere else.
    fireEvent.click(toggle("SportLots")!);
    expect(ownSetButton("Sl Bad")).toBeNull();
  });

  test("a set-aside row stays in Pending: Make its own set promotes it with identityOnly", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    const { onConfirm } = await renderModal(f, { sl: FOUR_SL });
    fireEvent.click(toggle("SportLots")!);
    fireEvent.click(screen.getByLabelText("Make its own set: Sl Bad"));

    const items = await savedItems(onConfirm);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      value: "Sl Bad",
      identityOnly: true,
      platformData: { sportlots: ["sl-bad"] },
    });
  });

  test("a mismatched BSC row is set aside the same way, under its own toggle", async () => {
    const f = fake({ verdicts: { "b-bad": "mismatch" } });
    await renderModal(f, { bsc: [item("Bsc Good", "b-good"), item("Bsc Bad", "b-bad")] });

    expect(ownSetButton("Bsc Bad")).toBeNull();
    const button = toggle("BSC")!;
    expect(button.getAttribute("aria-label")).toBe(
      BASE_MATCH_COPY.toggleName(BASE_MATCH_COPY.showMismatched(1), "bsc"),
    );
    fireEvent.click(button);
    expect(ownSetButton("Bsc Bad")).toBeTruthy();
  });

  test("if the focused row is set aside, focus moves to the toggle", async () => {
    const f = fake({ mode: "hold", verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    const own = screen.getByLabelText("Make its own set: Sl Bad");
    own.focus();
    expect(document.activeElement).toBe(own);

    await f.answer(f.calls[0]);
    expect(ownSetButton("Sl Bad")).toBeNull();
    expect(document.activeElement).toBe(toggle("SportLots"));
  });

  test("focus the operator put elsewhere is left alone", async () => {
    const f = fake({ mode: "hold", verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    const filter = screen.getByLabelText("Search SportLots items");
    filter.focus();
    await f.answer(f.calls[0]);
    expect(document.activeElement).toBe(filter);
  });
});

describe("ReconciliationModal Base check — Keep all", () => {
  test("keeps what matched and what could not be checked, never a mismatched row", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    const { onConfirm } = await renderModal(f, { sl: FOUR_SL });

    const button = keepAll("SportLots");
    expect(button.getAttribute("aria-label")).toBe("Keep all: 3 SportLots sets");
    expect(button.textContent).toBe("Keep all 3");
    fireEvent.click(button);

    const items = await savedItems(onConfirm);
    expect(items.map((i) => i.value).sort()).toEqual(
      ["Sl Fail", "Sl Ok One", "Sl Ok Two"].sort(),
    );
    expect(items.every((i) => i.identityOnly === true)).toBe(true);
    // The set-aside row is still waiting behind its toggle.
    expect(toggle("SportLots")).toBeTruthy();
  });

  test("still leaves out a mismatched row when the operator has revealed it", async () => {
    const f = fake({ verdicts: FOUR_VERDICTS });
    const { onConfirm } = await renderModal(f, { sl: FOUR_SL });
    fireEvent.click(toggle("SportLots")!);

    expect(keepAll("SportLots").getAttribute("aria-label")).toBe(
      "Keep all: 3 SportLots sets",
    );
    fireEvent.click(keepAll("SportLots"));
    const items = await savedItems(onConfirm);
    expect(items.map((i) => i.value)).not.toContain("Sl Bad");
    expect(items).toHaveLength(3);
  });

  test("leaves out rows still being checked, and its name and count follow as rows settle", async () => {
    const f = fake({ mode: "hold", verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });

    const waiting = keepAll("SportLots");
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute("aria-label")).toBe("Keep all: 0 SportLots sets");

    await f.answer(f.calls[0]);
    const settled = keepAll("SportLots");
    expect(settled.disabled).toBe(false);
    expect(settled.getAttribute("aria-label")).toBe("Keep all: 3 SportLots sets");
    expect(settled.textContent).toBe("Keep all 3");
  });

  test("a row still checking is not kept while the others are", async () => {
    // 12 BSC sets: the first two calls (8 ids) are answered, the rest wait.
    const many = Array.from({ length: 12 }, (_, i) => item(`Bsc ${i}`, `b${i}`));
    const f = fake({ mode: "hold" });
    const { onConfirm } = await renderModal(f, { bsc: many });
    await f.answer(f.calls[0]);

    expect(keepAll("BSC").getAttribute("aria-label")).toBe("Keep all: 4 BSC sets");
    fireEvent.click(keepAll("BSC"));
    const items = await savedItems(onConfirm);
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.value)).toEqual(["Bsc 0", "Bsc 1", "Bsc 2", "Bsc 3"]);
  });

  test("its title lists what it leaves out", async () => {
    const f = fake({ mode: "hold", verdicts: FOUR_VERDICTS });
    await renderModal(f, { sl: FOUR_SL });
    expect(keepAll("SportLots").title).toContain(
      BASE_MATCH_COPY.keepAllLeftOut(4, 0).trim(),
    );

    await f.answer(f.calls[0]);
    const title = keepAll("SportLots").title;
    expect(title).toContain(BASE_MATCH_COPY.keepAllLeftOut(0, 1).trim());
    expect(title).not.toContain("still being checked");
  });

  test("with the check off its title says nothing about the Base", async () => {
    await renderModal(null, { sl: FOUR_SL });
    expect(keepAll("SportLots").title).not.toContain("Base");
  });
});

describe("ReconciliationModal Base check — the queue follows the operator", () => {
  test("typing in the search puts the matching rows first in line", async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item(i >= 9 ? `Black Refractor ${i}` : `Set ${i}`, `b${i}`),
    );
    const f = fake({ mode: "hold" });
    await renderModal(f, { bsc: items });
    expect(f.calls).toHaveLength(2); // b0-b7

    fireEvent.change(screen.getByLabelText("Filter BSC items"), {
      target: { value: "refractor" },
    });
    await settle();
    await f.answer(f.calls[0]);

    expect(f.calls[2].ids).toEqual(["b9", "b10", "b11", "b8"]);
  });

  test("Show all SportLots items checks the rows outside the prefix", async () => {
    const inside = [item("1996 Score Ok", "sl-in1"), item("1996 Score Two", "sl-in2")];
    const outside = item("1997 Pinnacle Museum", "sl-out");
    const f = fake();
    await renderModal(f, { sl: [...inside, outside] }, { setName: "1996 Score" });

    expect(f.idsAsked()).not.toContain("sl-out");
    expect(f.idsAsked()).toEqual(expect.arrayContaining(["sl-in1", "sl-in2"]));

    fireEvent.click(screen.getByLabelText("Show all SportLots items"));
    await settle();
    expect(f.idsAsked()).toContain("sl-out");
    expect(ownSetButton("1997 Pinnacle Museum")).toBeTruthy();
  });
});

describe("ReconciliationModal Base check — verdicts are kept for the sitting", () => {
  test("a set that goes to Ready and comes back keeps its verdict with no new call", async () => {
    const f = fake({ verdicts: { "b-bad": "mismatch" } });
    await renderModal(f, { bsc: [item("Bsc Good", "b-good"), item("Bsc Bad", "b-bad")] });
    const callsBefore = f.calls.length;

    fireEvent.click(screen.getByLabelText("Make its own set: Bsc Good"));
    expect(ownSetButton("Bsc Good")).toBeNull();
    // Disband returns it to Pending.
    fireEvent.click(screen.getByLabelText(/^Remove set /));
    await settle();

    expect(ownSetButton("Bsc Good")).toBeTruthy();
    expect(srStatusIn(rowOf("Bsc Good"))).toBe(`, ${BASE_MATCH_COPY.srMatch}`);
    expect(f.calls.length).toBe(callsBefore);
  });

  test("detaching one side of a Ready set returns it with its verdict and no new call", async () => {
    const f = fake({ verdicts: { "sl-bad": "mismatch" } });
    await renderModal(
      f,
      {
        autoMatched: [
          {
            displayName: "Pair",
            bsc: item("Bsc Pair", "b-pair"),
            sl: item("Sl Pair", "sl-pair"),
            confidence: 0.9,
          },
        ],
        sl: [SL_BAD],
      },
    );
    const callsBefore = f.calls.length;
    expect(f.idsAsked()).not.toContain("sl-pair");

    // The paired item was never pending, so detaching it is its first check.
    fireEvent.click(screen.getByLabelText(/^Remove Sl Pair from /));
    await settle();
    const afterDetach = f.calls.length;
    expect(afterDetach).toBeGreaterThan(callsBefore);
    expect(srStatusIn(rowOf("Sl Pair"))).toBe(`, ${BASE_MATCH_COPY.srMatch}`);

    // Promote and detach again: it was checked once, and is not asked twice.
    fireEvent.click(screen.getByLabelText("Make its own set: Sl Pair"));
    fireEvent.click(screen.getByLabelText(/^Remove set Sl Pair/));
    await settle();
    expect(f.calls.length).toBe(afterDetach);
    expect(srStatusIn(rowOf("Sl Pair"))).toBe(`, ${BASE_MATCH_COPY.srMatch}`);
  });
});

describe("ReconciliationModal Base check — Save and the strip", () => {
  test("Save is never blocked while checks are in flight", async () => {
    const f = fake({ mode: "hold" });
    const { onConfirm } = await renderModal(f, { sl: FOUR_SL });
    expect(screen.getByText(BASE_MATCH_COPY.checkingHeader(0, 4))).toBeTruthy();

    // A row still being checked can still be made its own set by hand.
    fireEvent.click(screen.getByLabelText("Make its own set: Sl Ok One"));
    const items = await savedItems(onConfirm);
    expect(items.map((i) => i.value)).toEqual(["Sl Ok One"]);
  });

  test("the sleeve strip draws at most 200 and shows the rest as +N", async () => {
    const many = Array.from({ length: 205 }, (_, i) => item(`Bsc ${i}`, `b${i}`));
    const f = fake({ mode: "hold" });
    await renderModal(f, { bsc: many });

    const strip = document.querySelector(
      'div[aria-hidden="true"].flex-wrap',
    ) as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.querySelectorAll("span[title]")).toHaveLength(200);
    expect(within(strip).getByText("+5")).toBeTruthy();
    // The counter still says the whole column.
    expect(screen.getByText(BASE_MATCH_COPY.checkingHeader(0, 205))).toBeTruthy();
  });

  test("twin (#id) suffixes still render with the check on", async () => {
    const f = fake();
    await renderModal(f, {
      bsc: [item("Anime", "111"), item("Anime", "222")],
    });

    expect(ownSetButton("Anime (#111)")).toBeTruthy();
    expect(ownSetButton("Anime (#222)")).toBeTruthy();
    expect(within(rowOf("Anime (#111)")).getByText("(#111)")).toBeTruthy();
    expect(srStatusIn(rowOf("Anime (#222)"))).toBe(`, ${BASE_MATCH_COPY.srMatch}`);
  });
});
