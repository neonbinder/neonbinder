import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommitQueue,
  DEMO_TARGET_BOX_KEY,
  isPlainLine,
  linesInBox,
  MAX_BOX_QUANTITY,
  otherLines,
  parseQuantity,
  plainQuantity,
  readStoredTargetBox,
  resolveTargetBox,
  targetBoxStorageKey,
  writeStoredTargetBox,
} from "./targetBox";
import type { Container, Copy } from "../data/types";

/**
 * NEO-364 (D8-D10) — the inventory's quick-entry rules, pure: which box the
 * fields count, what "the quantity" of a card in a box means, what a typed
 * value commits as, and the queue every field's write goes through.
 */

const copy = (over: Partial<Copy> = {}): Copy => ({
  id: "c1",
  cardId: "card1",
  variantId: "v1",
  setId: "s1",
  homeId: "box1",
  homeKind: "box",
  upForTrade: false,
  quantity: 1,
  acquiredAt: "2026-10-01",
  notes: "",
  ...over,
});

const box = (id: string, over: Partial<Container> = {}): Container => ({ id, kind: "box", name: id, count: null, ...over });
const SHELF: Container[] = [
  { id: "main", kind: "binder", system: "main", name: "Main", count: null },
  box("unsorted", { system: "unsorted", name: "Unsorted" }),
  { id: "trade", kind: "binder", system: "trade", name: "Up for Trade", count: null },
  box("box1", { name: "Show box" }),
  box("box2", { name: "Dime box" }),
  { id: "binder1", kind: "binder", name: "Ohtani rainbow", count: null },
];

describe("a plain line (D9)", () => {
  it("is raw with nothing noted and not up for trade", () => {
    expect(isPlainLine(copy())).toBe(true);
  });

  it("ignores the row it sits in and the day it was acquired", () => {
    expect(isPlainLine(copy({ slot: 3, acquiredAt: "1999-01-01" }))).toBe(true);
  });

  it.each([
    ["a grade", { graded: { grader: "PSA" as const, grade: "9" } }],
    ["a condition", { condition: "Mint" as const }],
    ["a serial number", { serialNumber: "23/50" }],
    ["a cost", { costBasis: 1.5 }],
    ["a location", { location: "Shelf 2" }],
    ["a note", { notes: "corner ding" }],
    ["up for trade", { upForTrade: true }],
  ] as const)("is not plain with %s", (_why, over) => {
    expect(isPlainLine(copy(over))).toBe(false);
  });

  it("treats a cost of 0 as a cost recorded, but a missing one as none", () => {
    expect(isPlainLine(copy({ costBasis: 0 }))).toBe(false);
    expect(isPlainLine(copy({ costBasis: undefined }))).toBe(true);
  });
});

describe("the quantity (D9)", () => {
  it("sums the plain copies of the card in the box, whatever lines they are on", () => {
    const lines = [copy({ id: "a", quantity: 2 }), copy({ id: "b", quantity: 3, slot: 1 }), copy({ id: "c", quantity: 5, notes: "x" })];
    expect(plainQuantity(lines)).toBe(5);
  });

  it("is 0 with no lines, or only lines that are not plain", () => {
    expect(plainQuantity([])).toBe(0);
    expect(plainQuantity([copy({ graded: { grader: "PSA", grade: "9" } })])).toBe(0);
  });

  it("linesInBox keeps this box's live lines only, and nothing while either is unknown", () => {
    const here = copy({ id: "here" });
    const lines = [here, copy({ id: "elsewhere", homeId: "box2" }), copy({ id: "empty", quantity: 0 }), copy({ id: "binder", homeId: "binder1", homeKind: "binder" })];
    expect(linesInBox(lines, "box1").map((c) => c.id)).toEqual(["here"]);
    expect(linesInBox(undefined, "box1")).toEqual([]);
    expect(linesInBox(lines, undefined)).toEqual([]);
  });
});

describe("the other lines, read-only beside the field", () => {
  it("is null when every copy there is plain", () => {
    expect(otherLines([copy(), copy({ id: "b", quantity: 4 })])).toBeNull();
    expect(otherLines([])).toBeNull();
  });

  it("counts the copies and names each other line, short", () => {
    const lines = [
      copy({ id: "a", graded: { grader: "PSA", grade: "9" } }),
      copy({ id: "b", condition: "Mint", quantity: 2 }),
      copy({ id: "plain", quantity: 7 }),
    ];
    expect(otherLines(lines)).toEqual({ count: 3, text: "+3 more: PSA 9, Raw Mint ×2" });
  });

  it("says a serial, a trade flag and bare notes", () => {
    expect(otherLines([copy({ serialNumber: "23/50" })])!.text).toBe("+1 more: Raw 23/50");
    expect(otherLines([copy({ upForTrade: true })])!.text).toBe("+1 more: Raw for trade");
    expect(otherLines([copy({ notes: "ding" })])!.text).toBe("+1 more: Raw with notes");
    expect(otherLines([copy({ graded: { grader: "BGS", grade: "" } })])!.text).toBe("+1 more: BGS ?");
  });
});

describe("what a typed value commits as", () => {
  it.each([
    ["3", 3],
    ["0", 0],
    [" 12 ", 12],
    ["007", 7],
  ])("reads %j as %i", (text, n) => {
    expect(parseQuantity(text)).toBe(n);
  });

  it.each([[""], ["  "], ["-1"], ["1.5"], ["abc"], ["1e3"], ["+2"]])("reads %j as nothing (the field goes back)", (text) => {
    expect(parseQuantity(text)).toBeNull();
  });

  it("caps at the most a line holds", () => {
    expect(parseQuantity("999")).toBe(MAX_BOX_QUANTITY);
    expect(parseQuantity("1000")).toBe(MAX_BOX_QUANTITY);
    expect(parseQuantity("99999999999")).toBe(MAX_BOX_QUANTITY);
  });
});

describe("the target box (D8)", () => {
  it("waits for the shelf", () => {
    expect(resolveTargetBox(undefined, "box1", "box2")).toBeUndefined();
  });

  it("takes the URL's box first", () => {
    expect(resolveTargetBox(SHELF, "box1", "box2")?.id).toBe("box1");
  });

  it("falls back to the box kept on this device", () => {
    expect(resolveTargetBox(SHELF, null, "box2")?.id).toBe("box2");
  });

  it("falls back to Unsorted when nothing is picked", () => {
    expect(resolveTargetBox(SHELF, null, null)?.id).toBe("unsorted");
  });

  it.each([
    ["a deleted id", "gone"],
    ["a binder", "binder1"],
    ["the trade pile", "trade"],
    ["Main", "main"],
  ])("reads %s on the URL as the next fallback, quietly", (_why, id) => {
    expect(resolveTargetBox(SHELF, id, "box2")?.id).toBe("box2");
    expect(resolveTargetBox(SHELF, id, null)?.id).toBe("unsorted");
  });

  it("a bad URL id and a bad kept id both read as Unsorted", () => {
    expect(resolveTargetBox(SHELF, "gone", "binder1")?.id).toBe("unsorted");
  });

  it("with no Unsorted yet, the first box", () => {
    const noUnsorted = SHELF.filter((c) => c.system !== "unsorted");
    expect(resolveTargetBox(noUnsorted, null, null)?.id).toBe("box1");
  });

  it("with no box at all, nothing", () => {
    expect(resolveTargetBox(SHELF.filter((c) => c.kind !== "box"), "box1", "box2")).toBeUndefined();
  });
});

describe("where the pick is kept", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });
  beforeEach(() => window.localStorage.clear());

  it("one key per signed-in collector, one for the demo, none while it is not known who is signed in", () => {
    expect(targetBoxStorageKey("user_1", false)).toBe("nb.inventory.targetBox.user_1");
    expect(targetBoxStorageKey("user_2", false)).not.toBe(targetBoxStorageKey("user_1", false));
    expect(targetBoxStorageKey(undefined, false)).toBeNull();
    expect(targetBoxStorageKey(null, false)).toBeNull();
    expect(targetBoxStorageKey("user_1", true)).toBe(DEMO_TARGET_BOX_KEY);
    expect(DEMO_TARGET_BOX_KEY).toBe("nb.demo.targetBox");
    expect(targetBoxStorageKey(null, true)).toBe(DEMO_TARGET_BOX_KEY);
  });

  it("writes the pick and reads it back", () => {
    writeStoredTargetBox("k", "box2");
    expect(readStoredTargetBox("k")).toBe("box2");
    expect(readStoredTargetBox("other")).toBeNull();
  });

  /** Replaces `window.localStorage` for one test (a private window, blocked site data). */
  function stubStorage(storage: () => Storage) {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get: storage });
    return () => {
      if (original) Object.defineProperty(window, "localStorage", original);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    };
  }

  it("with no key, reads and writes nothing", () => {
    const touched = vi.fn(() => window.localStorage);
    const restore = stubStorage(touched as unknown as () => Storage);
    try {
      writeStoredTargetBox(null, "box1");
      expect(readStoredTargetBox(null)).toBeNull();
      expect(touched).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("storage whose methods throw forgets the pick and never throws", () => {
    const refuse = () => {
      throw new DOMException("denied", "SecurityError");
    };
    const restore = stubStorage(() => ({ getItem: refuse, setItem: refuse }) as unknown as Storage);
    try {
      expect(() => writeStoredTargetBox("k", "box1")).not.toThrow();
      expect(readStoredTargetBox("k")).toBeNull();
    } finally {
      restore();
    }
  });

  it("storage that cannot even be reached (the accessor throws) is forgotten the same way", () => {
    const restore = stubStorage(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      expect(() => writeStoredTargetBox("k", "box1")).not.toThrow();
      expect(readStoredTargetBox("k")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("the commit queue (D10)", () => {
  /** A task that finishes when `release` is called. */
  function gated<T>(value: T) {
    let release!: () => void;
    let fail!: (e: Error) => void;
    const done = new Promise<T>((resolve, reject) => {
      release = () => resolve(value);
      fail = reject;
    });
    return { done, release, fail };
  }

  it("runs the writes in the order they were queued, one at a time", async () => {
    const queue = createCommitQueue();
    const log: string[] = [];
    const first = gated("a");
    const second = gated("b");
    const a = queue.enqueue(async () => {
      log.push("start a");
      const r = await first.done;
      log.push("end a");
      return r;
    });
    const b = queue.enqueue(async () => {
      log.push("start b");
      const r = await second.done;
      log.push("end b");
      return r;
    });
    // b is queued behind a: it never starts early, even if its own work is ready.
    second.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["start a"]);
    first.release();
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("hands each caller its own task's result", async () => {
    const queue = createCommitQueue();
    const results = await Promise.all([1, 2, 3].map((n) => queue.enqueue(async () => n * 10)));
    expect(results).toEqual([10, 20, 30]);
  });

  it("a failed write rejects its own caller only: the queue carries on", async () => {
    const queue = createCommitQueue();
    const log: string[] = [];
    const bad = queue.enqueue(async () => {
      log.push("bad");
      throw new Error("refused");
    });
    const good = queue.enqueue(async () => {
      log.push("good");
      return "ok";
    });
    await expect(bad).rejects.toThrow("refused");
    await expect(good).resolves.toBe("ok");
    expect(log).toEqual(["bad", "good"]);
  });

  it("a write queued after a failure still runs, and one queued while idle runs at once", async () => {
    const queue = createCommitQueue();
    await expect(queue.enqueue(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(queue.enqueue(async () => "later")).resolves.toBe("later");
  });

  it("each page has a queue of its own", async () => {
    const a = createCommitQueue();
    const b = createCommitQueue();
    const stuck = gated("x");
    void a.enqueue(() => stuck.done);
    await expect(b.enqueue(async () => "free")).resolves.toBe("free");
    stuck.release();
  });

  it("a task that throws synchronously rejects its caller and does not stall the queue", async () => {
    const queue = createCommitQueue();
    const bad = queue.enqueue(() => {
      throw new Error("sync");
    });
    await expect(bad).rejects.toThrow("sync");
    await expect(queue.enqueue(async () => "after")).resolves.toBe("after");
  });
});
