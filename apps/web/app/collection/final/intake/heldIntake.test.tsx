import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import {
  beginSend,
  clearAllHeld,
  finishSend,
  heldIntakeKey,
  holdFiles,
  keepHeldFor,
  readHeld,
  releaseForNewRun,
  removeHeld,
  retryHeld,
  sayHeld,
  updateHeldSetup,
  useHeldIntake,
  type HeldSetup,
} from "./heldIntake";

/**
 * NEO-452 — the store of photos dropped before the run was set up. Module
 * state, so these pin what outlives a screen: the pile, who it belongs to, the
 * claim that stops a second screen sending it twice, the setup that only lives
 * while files do, and the unload prompt that is armed exactly while files wait.
 */
const A = heldIntakeKey("u1", "inventory");
const B = heldIntakeKey("u1", "collection");
const OTHER = heldIntakeKey("u2", "inventory");
const photo = (name: string) => new File(["x"], name, { type: "image/jpeg" });
const zip = (name = "pile.zip") => new File(["x"], name, { type: "application/zip" });
const setup = (extra: Partial<HeldSetup> = {}): HeldSetup => ({
  homeId: "box1",
  variant: { variantId: "v1" as Id<"selectorOptions">, title: "1988 Topps Base" },
  defaults: { acquiredOn: "2026-11-06", minPriceCents: 150 },
  ...extra,
});
const names = (key: string) => readHeld(key).files.map((f) => f.name);
const unloadPrompts = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(clearAllHeld);
afterEach(clearAllHeld);

describe("the key", () => {
  it("is the user and the side, and a signed-out visitor is its own owner", () => {
    expect(heldIntakeKey("u1", "inventory")).toBe("u1:inventory");
    expect(heldIntakeKey(null, "inventory")).toBe("signed-out:inventory");
    expect(heldIntakeKey(undefined, "collection")).toBe("signed-out:collection");
  });

  it("keeps each user's and each side's pile apart", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    holdFiles(OTHER, [photo("o.jpg")], setup());
    expect(names(A)).toEqual(["a.jpg"]);
    expect(names(B)).toEqual([]);
    expect(names(OTHER)).toEqual(["o.jpg"]);
    removeHeld(A);
    expect(names(OTHER)).toEqual(["o.jpg"]);
  });

  it("reads nothing for a key it never saw, and the same empty entry each time", () => {
    expect(readHeld("nobody:inventory")).toEqual({ files: [], setup: null, sending: false, failedConfig: null, note: "" });
    expect(readHeld("nobody:inventory")).toBe(readHeld("nobody:collection"));
  });
});

describe("holdFiles", () => {
  it("adds a second drop to the pile, in order, and keeps the setup it came with", () => {
    expect(holdFiles(A, [photo("a.jpg")], setup())).toBeNull();
    expect(holdFiles(A, [photo("b.jpg"), photo("c.jpg")], setup({ homeId: "box2" }))).toBeNull();
    expect(names(A)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(readHeld(A).setup?.homeId).toBe("box2");
  });

  it("refuses a drop that makes the pile one nothing can send, answers the refused pile, and leaves the first pile alone", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const before = readHeld(A);
    const refused = holdFiles(A, [zip()], setup({ homeId: "other" }));
    expect(refused?.map((f) => f.name)).toEqual(["a.jpg", "pile.zip"]);
    expect(readHeld(A)).toBe(before);
    // Two zips are refused too, even when the first pile is one zip.
    clearAllHeld();
    holdFiles(A, [zip("one.zip")], setup());
    expect(holdFiles(A, [zip("two.zip")], setup())?.map((f) => f.name)).toEqual(["one.zip", "two.zip"]);
    expect(names(A)).toEqual(["one.zip"]);
  });

  it("a fresh drop clears the failure and the note", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    beginSend(A);
    finishSend(A, readHeld(A).files, "cfg");
    sayHeld(A, "Couldn't send these photos.");
    expect(readHeld(A)).toMatchObject({ failedConfig: "cfg", note: "Couldn't send these photos." });
    holdFiles(A, [photo("b.jpg")], setup());
    expect(readHeld(A)).toMatchObject({ failedConfig: null, note: "" });
  });

  it("an empty drop holds nothing: no entry, no unload prompt", () => {
    holdFiles(A, [], setup());
    expect(names(A)).toEqual([]);
    expect(unloadPrompts()).toBe(false);
  });
});

describe("the setup lives only while files do", () => {
  it("updateHeldSetup with nothing held keeps nothing, so an old Min price cannot leak into a later run", () => {
    updateHeldSetup(A, setup());
    expect(readHeld(A).setup).toBeNull();
    holdFiles(A, [photo("a.jpg")], setup());
    removeHeld(A);
    updateHeldSetup(A, setup());
    expect(readHeld(A).setup).toBeNull();
    expect(readHeld(A).files).toEqual([]);
  });

  it("keeps the setup current while files are held", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    updateHeldSetup(A, setup({ defaults: { acquiredOn: "2026-11-06" } }));
    expect(readHeld(A).setup?.defaults).toEqual({ acquiredOn: "2026-11-06" });
  });

  it("is gone once the last files have gone up", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    finishSend(A, pile, null);
    expect(readHeld(A)).toEqual({ files: [], setup: null, sending: false, failedConfig: null, note: "" });
  });

  it("is gone when the pile is removed", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    removeHeld(A);
    expect(readHeld(A).setup).toBeNull();
  });
});

describe("beginSend and finishSend", () => {
  it("claims the pile once: a second screen is told there is nothing to send", () => {
    holdFiles(A, [photo("a.jpg"), photo("b.jpg")], setup());
    const claimed = beginSend(A);
    expect(claimed?.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(readHeld(A).sending).toBe(true);
    expect(beginSend(A)).toBeNull();
  });

  it("has nothing to claim when nothing is held", () => {
    expect(beginSend(A)).toBeNull();
    expect(readHeld(A).sending).toBe(false);
  });

  it("success removes exactly the files that went, and keeps ones that landed meanwhile with the setup", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    holdFiles(A, [photo("late.jpg")], setup({ homeId: "box2" }));
    finishSend(A, pile, null);
    expect(names(A)).toEqual(["late.jpg"]);
    expect(readHeld(A)).toMatchObject({ sending: false, failedConfig: null });
    expect(readHeld(A).setup?.homeId).toBe("box2");
    expect(unloadPrompts()).toBe(true);
  });

  it("failure keeps every file, records the setup it failed on, and ends the claim", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    finishSend(A, pile, "cfg-1");
    expect(names(A)).toEqual(["a.jpg"]);
    expect(readHeld(A)).toMatchObject({ sending: false, failedConfig: "cfg-1" });
    expect(beginSend(A)).not.toBeNull();
  });

  it("beginning a send forgets an earlier failure; Try again clears it without sending", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    finishSend(A, beginSend(A)!, "cfg");
    retryHeld(A);
    expect(readHeld(A).failedConfig).toBeNull();
    expect(readHeld(A).sending).toBe(false);
    finishSend(A, beginSend(A)!, "cfg");
    expect(readHeld(A).failedConfig).toBe("cfg");
    beginSend(A);
    expect(readHeld(A).failedConfig).toBeNull();
  });

  it("finishing the same pile twice removes nothing more and breaks nothing", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    finishSend(A, pile, null);
    holdFiles(A, [photo("b.jpg")], setup());
    finishSend(A, pile, null);
    expect(names(A)).toEqual(["b.jpg"]);
  });

  it("a pile removed mid-send leaves the claim standing until the send reports, then nothing is resurrected", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    removeHeld(A);
    expect(readHeld(A)).toMatchObject({ files: [], sending: true });
    expect(beginSend(A)).toBeNull();
    finishSend(A, pile, null);
    expect(readHeld(A)).toEqual({ files: [], setup: null, sending: false, failedConfig: null, note: "" });
  });

  it("a failure reported after the pile was removed leaves no files to retry and no prompt", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    removeHeld(A);
    finishSend(A, pile, "cfg");
    expect(readHeld(A).files).toEqual([]);
    expect(unloadPrompts()).toBe(false);
  });

  it("a send finishing after the store was emptied (a test, a sign-out) creates nothing", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const pile = beginSend(A)!;
    clearAllHeld();
    finishSend(A, pile, null);
    expect(readHeld(A).files).toEqual([]);
    expect(readHeld(A).sending).toBe(false);
    finishSend(A, pile, "cfg");
    expect(readHeld(A).files).toEqual([]);
  });

  it("the claimed pile is a snapshot: later drops don't change what is being sent", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const claimed = beginSend(A)!;
    holdFiles(A, [photo("b.jpg")], setup());
    expect(claimed.map((f) => f.name)).toEqual(["a.jpg"]);
  });
});

describe("the note", () => {
  it("is kept with no files so a send finishing after a remount can still say how it went", () => {
    sayHeld(A, "Sent 1 photo.");
    expect(readHeld(A).note).toBe("Sent 1 photo.");
  });

  it("an empty note with nothing else held leaves no entry behind", () => {
    sayHeld(A, "Sent 1 photo.");
    sayHeld(A, "");
    expect(readHeld(A)).toBe(readHeld("nobody:inventory"));
  });

  it("goes with the pile when it is removed", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    sayHeld(A, "Couldn't send these photos.");
    removeHeld(A);
    expect(readHeld(A).note).toBe("");
  });
});

describe("waitForNewRun (NEO-529)", () => {
  /** A send into a session that closed: `landed` went in, the rest are kept. */
  const closeOn = (files: string[], landed: string[]) => {
    holdFiles(A, files.map(photo), setup());
    const pile = beginSend(A)!;
    finishSend(A, pile.filter((f) => landed.includes(f.name)), null, true);
  };

  it("is absent on a pile with no closed-session history, before and after a send", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    expect(readHeld(A).waitForNewRun).toBeUndefined();
    const pile = beginSend(A)!;
    finishSend(A, pile.slice(0, 0), null);
    expect(readHeld(A).waitForNewRun).toBeUndefined();
    expect(readHeld(A)).not.toHaveProperty("waitForNewRun");
  });

  it("marks the photos a closed session left behind", () => {
    closeOn(["a.jpg", "b.jpg"], ["a.jpg"]);
    expect(names(A)).toEqual(["b.jpg"]);
    expect(readHeld(A).waitForNewRun).toBe(true);
    expect(readHeld(A).setup).not.toBeNull();
  });

  it("is never set with nothing left to wait", () => {
    closeOn(["a.jpg"], ["a.jpg"]);
    expect(readHeld(A)).toEqual({ files: [], setup: null, sending: false, failedConfig: null, note: "" });
  });

  it("outlasts a later drop and a later failure: only New run lets them go", () => {
    closeOn(["a.jpg", "b.jpg"], ["a.jpg"]);
    holdFiles(A, [photo("c.jpg")], setup());
    expect(readHeld(A).waitForNewRun).toBe(true);
    const pile = beginSend(A)!;
    finishSend(A, pile, "cfg-1");
    expect(readHeld(A).waitForNewRun).toBe(true);
    retryHeld(A);
    expect(readHeld(A).waitForNewRun).toBe(true);
  });

  it("a send into a run the collector opened keeps waiting for whatever is still left", () => {
    closeOn(["a.jpg", "b.jpg", "c.jpg"], ["a.jpg"]);
    const pile = beginSend(A)!;
    finishSend(A, pile.filter((f) => f.name === "b.jpg"), null);
    expect(names(A)).toEqual(["c.jpg"]);
    expect(readHeld(A).waitForNewRun).toBe(true);
  });

  it("New run releases it and keeps the photos", () => {
    closeOn(["a.jpg", "b.jpg"], ["a.jpg"]);
    releaseForNewRun(A);
    expect(names(A)).toEqual(["b.jpg"]);
    expect(readHeld(A)).not.toHaveProperty("waitForNewRun");
  });

  it("New run on a pile that isn't waiting changes nothing and tells no one", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const before = readHeld(A);
    releaseForNewRun(A);
    expect(readHeld(A)).toBe(before);
  });

  it("goes with the pile when it is removed", () => {
    closeOn(["a.jpg", "b.jpg"], ["a.jpg"]);
    removeHeld(A);
    expect(readHeld(A)).toEqual({ files: [], setup: null, sending: false, failedConfig: null, note: "" });
    holdFiles(A, [photo("d.jpg")], setup());
    expect(readHeld(A).waitForNewRun).toBeUndefined();
  });
});

describe("the unload prompt", () => {
  it("is armed while any files are held, asks the browser to confirm, and goes with the last of them", () => {
    expect(unloadPrompts()).toBe(false);
    holdFiles(A, [photo("a.jpg")], setup());
    expect(unloadPrompts()).toBe(true);
    removeHeld(A);
    expect(unloadPrompts()).toBe(false);
  });

  it("is one listener however many piles there are, and stays while any pile is left", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    holdFiles(A, [photo("a.jpg")], setup());
    holdFiles(B, [photo("b.jpg")], setup());
    holdFiles(A, [photo("c.jpg")], setup());
    expect(add.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    removeHeld(A);
    expect(unloadPrompts()).toBe(true);
    removeHeld(B);
    expect(unloadPrompts()).toBe(false);
    expect(remove.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it("holds through a send that fails, and drops once the send succeeds", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    finishSend(A, beginSend(A)!, "cfg");
    expect(unloadPrompts()).toBe(true);
    finishSend(A, beginSend(A)!, null);
    expect(unloadPrompts()).toBe(false);
  });

  it("is cleared by clearAllHeld", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    clearAllHeld();
    expect(unloadPrompts()).toBe(false);
  });
});

describe("useHeldIntake", () => {
  it("re-renders a screen with the entry for its key, and not for another key's change", () => {
    const { result } = renderHook(() => useHeldIntake(A));
    const empty = result.current;
    act(() => {
      holdFiles(OTHER, [photo("o.jpg")], setup());
    });
    expect(result.current).toBe(empty);
    act(() => {
      holdFiles(A, [photo("a.jpg")], setup());
    });
    expect(result.current.files.map((f) => f.name)).toEqual(["a.jpg"]);
    act(() => removeHeld(A));
    expect(result.current.files).toEqual([]);
  });

  it("two screens on one key see the same claim", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const first = renderHook(() => useHeldIntake(A));
    const second = renderHook(() => useHeldIntake(A));
    act(() => {
      beginSend(A);
    });
    expect(first.result.current.sending).toBe(true);
    expect(second.result.current.sending).toBe(true);
  });
});

describe("keepHeldFor: whoever is signed in is the only one with a pile", () => {
  it("forgets every other user's piles on both sides, keeps the signed-in user's, and drops the prompt with them", () => {
    holdFiles(OTHER, [photo("o.jpg")], setup());
    holdFiles(heldIntakeKey("u2", "collection"), [photo("o2.jpg")], setup());
    holdFiles(A, [photo("a.jpg")], setup());
    keepHeldFor("u1");
    expect(names(OTHER)).toEqual([]);
    expect(names(heldIntakeKey("u2", "collection"))).toEqual([]);
    expect(names(A)).toEqual(["a.jpg"]);
    expect(unloadPrompts()).toBe(true);
    keepHeldFor("u2");
    expect(names(A)).toEqual([]);
    expect(unloadPrompts()).toBe(false);
  });

  it("signed out (null) forgets every signed-in user's piles", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    keepHeldFor(null);
    expect(names(A)).toEqual([]);
    expect(unloadPrompts()).toBe(false);
  });

  it("a user whose id starts with another's is not the same user", () => {
    const longer = heldIntakeKey("u10", "inventory");
    holdFiles(longer, [photo("x.jpg")], setup());
    holdFiles(A, [photo("a.jpg")], setup());
    keepHeldFor("u1");
    expect(names(longer)).toEqual([]);
    expect(names(A)).toEqual(["a.jpg"]);
  });

  it("a send of someone who has gone finishing up has nowhere to say so: nothing is written for them", () => {
    holdFiles(OTHER, [photo("o.jpg")], setup());
    const pile = beginSend(OTHER)!;
    keepHeldFor("u1");
    finishSend(OTHER, pile, "cfg");
    sayHeld(OTHER, "Sent 1 photo.");
    holdFiles(OTHER, [photo("late.jpg")], setup());
    expect(readHeld(OTHER).note).toBe("");
    expect(unloadPrompts()).toBe(false);
  });

  it("tells screens already listening that their pile is gone", () => {
    holdFiles(OTHER, [photo("o.jpg")], setup());
    const { result } = renderHook(() => useHeldIntake(OTHER));
    expect(result.current.files).toHaveLength(1);
    act(() => keepHeldFor("u1"));
    expect(result.current.files).toEqual([]);
  });

  it("with nobody else holding anything it changes nothing and wakes nobody", () => {
    holdFiles(A, [photo("a.jpg")], setup());
    const before = readHeld(A);
    keepHeldFor("u1");
    expect(readHeld(A)).toBe(before);
  });
});
