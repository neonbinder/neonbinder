import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import NoticeLine, { NoticeSpokenContext, type Notice } from "./notice";
import { NOTHING_TO_UNDO, STILL_SAVING, useStatusLine, type StatusLine } from "../../final/statusLine";

/**
 * NEO-529 — the status line's live region speaks once per notice: the same
 * words twice are said twice, the same notice drawn again says nothing, and
 * only the `announce` words are said when the line shows more than that.
 */

/** Every set of words the live region was given, in order (a cleared region adds none). */
function listen(region: Element) {
  const said: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.textContent) said.push(node.textContent);
    }
  });
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  return {
    said,
    /** Delivers what the observer has queued. */
    flush: () => {
      for (const record of observer.takeRecords()) {
        for (const node of record.addedNodes) if (node.textContent) said.push(node.textContent);
      }
    },
    stop: () => observer.disconnect(),
  };
}

/** Lets the frame the live region waits for run. */
const nextFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

const region = () => screen.getByRole("status");
/** The words the line shows (not its live region). */
const shown = () => screen.getAllByText((_, el) => el?.tagName === "P" && !el.hasAttribute("role"))[0];

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});
function heard() {
  const l = listen(region());
  stops.push(l.stop);
  return l;
}

/** A page holding the line, as FinalCollectionPage does. */
function Page({ onLine }: { onLine: (line: StatusLine) => void }) {
  const line = useStatusLine();
  onLine(line);
  return <NoticeLine notice={line.notice} onUndo={line.undo} onDismiss={line.dismiss} floating />;
}

function page() {
  let line!: StatusLine;
  const view = render(<Page onLine={(l) => (line = l)} />);
  return { view, line: () => line };
}

describe("NoticeLine's live region", () => {
  it("says Ctrl/⌘+Z's \"Nothing to undo.\" twice when it is pressed twice", async () => {
    const { line } = page();
    const live = heard();
    act(() => line().undoLast());
    await nextFrame();
    expect(region().textContent).toBe(NOTHING_TO_UNDO);
    act(() => line().undoLast());
    // Cleared first, so the same words land as a change.
    expect(region().textContent).toBe("");
    await nextFrame();
    live.flush();
    expect(live.said).toEqual([NOTHING_TO_UNDO, NOTHING_TO_UNDO]);
    expect(region().textContent).toBe(NOTHING_TO_UNDO);
  });

  it("says \"Undone.\" each time an undo lands, even twice in a row", async () => {
    const { line } = page();
    const live = heard();
    act(() => line().notify("Removed.", () => {}));
    await nextFrame();
    act(() => line().undo());
    await nextFrame();
    act(() => line().notify("Removed again.", () => {}));
    await nextFrame();
    act(() => line().undo());
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["Removed.", "Undone.", "Removed again.", "Undone."]);
  });

  it("says nothing when the same notice is drawn again", async () => {
    const notice: Notice = { id: 1, message: "Saved." };
    const props = { onUndo: () => {}, onDismiss: () => {} };
    const { rerender } = render(<NoticeLine notice={null} {...props} />);
    const live = heard();
    rerender(<NoticeLine notice={notice} {...props} />);
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["Saved."]);
    // The same notice, and a copy of it with the same id (Undo dropped, an undo running).
    rerender(<NoticeLine notice={notice} {...props} />);
    rerender(<NoticeLine notice={{ ...notice, undoing: true }} {...props} />);
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["Saved."]);
  });

  it("does not say the notice already up when the line mounts, and empties when the line is taken down", async () => {
    const props = { onUndo: () => {}, onDismiss: () => {} };
    const { rerender } = render(<NoticeLine notice={{ id: 4, message: "Moved." }} {...props} />);
    // Shown, not said: the drawer opening over a notice is not news. The
    // region is drawn already holding the words (no clear, no frame), which a
    // screen reader does not read out, so the words can still be found in it.
    expect(shown().textContent).toBe("Moved.");
    expect(region().textContent).toBe("Moved.");
    const live = heard();
    await nextFrame();
    live.flush();
    expect(live.said).toEqual([]);
    rerender(<NoticeLine notice={{ id: 5, message: "Saved." }} {...props} />);
    await nextFrame();
    expect(region().textContent).toBe("Saved.");
    rerender(<NoticeLine notice={null} {...props} />);
    expect(region().textContent).toBe("");
  });

  it("the words shown are not a live region, and Undo sits outside the one that is", async () => {
    const { line } = page();
    act(() => line().notify("Added.", () => {}));
    await nextFrame();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const shown = screen.getByText("Added.", { selector: "p:not([role])" });
    expect(shown.closest("[role=status]")).toBeNull();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(region().contains(undo)).toBe(false);
    expect(region().textContent).toBe("Added.");
  });

  it("a refusal merged in front of a newer write's words says only the refusal; the line shows both", async () => {
    const { line } = page();
    let older!: ReturnType<StatusLine["beginWrite"]>;
    act(() => {
      older = line().beginWrite();
    });
    act(() => line().beginWrite().done("Moved it.", () => {}));
    await nextFrame();
    const live = heard();
    act(() => older.refused("That didn't save."));
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["That didn't save."]);
    expect(shown().textContent).toBe("That didn't save. Moved it.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("Ctrl/⌘+Z while a write saves says \"Still saving.\" and leaves the words shown", async () => {
    const { line } = page();
    act(() => line().notify("Added.", () => {}));
    await nextFrame();
    act(() => void line().beginWrite());
    const live = heard();
    act(() => line().undoLast());
    await nextFrame();
    act(() => line().undoLast());
    await nextFrame();
    live.flush();
    expect(live.said).toEqual([STILL_SAVING, STILL_SAVING]);
    expect(screen.getByText("Added.", { selector: "p:not([role])" })).toBeTruthy();
    expect(screen.queryByText(STILL_SAVING, { selector: "p:not([role])" })).toBeNull();
  });

  it("Undo pressed by the keyboard leaves focus on Dismiss, the words still shown", async () => {
    const undo = vi.fn();
    const { line } = page();
    act(() => line().notify("Removed.", undo));
    const button = screen.getByRole("button", { name: "Undo" });
    act(() => button.focus());
    act(() => void fireEvent.click(button));
    await nextFrame();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.getByText("Undone.", { selector: "p:not([role])" })).toBeTruthy();
  });

  it("two notices inside one frame are both said, each once", async () => {
    const props = { onUndo: () => {}, onDismiss: () => {} };
    const { rerender } = render(<NoticeLine notice={null} {...props} />);
    const live = heard();
    rerender(<NoticeLine notice={{ id: 1, message: "Added." }} {...props} />);
    rerender(<NoticeLine notice={{ id: 2, message: "Moved." }} {...props} />);
    await nextFrame();
    expect(region().textContent).toBe("Added. Moved.");
    rerender(<NoticeLine notice={{ id: 3, message: "Saved." }} {...props} />);
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["Added. Moved.", "Saved."]);
  });

  it("a newer write's success behind a refusal says only the success; the line shows both", async () => {
    const { line } = page();
    let older!: ReturnType<StatusLine["beginWrite"]>;
    let newer!: ReturnType<StatusLine["beginWrite"]>;
    act(() => {
      older = line().beginWrite();
      newer = line().beginWrite();
    });
    const live = heard();
    act(() => older.refused("That box is full."));
    await nextFrame();
    act(() => newer.done("Moved it.", () => {}));
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["That box is full.", "Moved it."]);
    expect(shown().textContent).toBe("That box is full. Moved it.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("a refusal and the success behind it landing in one render are said whole", async () => {
    const { line } = page();
    let older!: ReturnType<StatusLine["beginWrite"]>;
    let newer!: ReturnType<StatusLine["beginWrite"]>;
    act(() => {
      older = line().beginWrite();
      newer = line().beginWrite();
    });
    const live = heard();
    act(() => {
      older.refused("That box is full.");
      newer.done("Moved it.", () => {});
    });
    await nextFrame();
    live.flush();
    expect(live.said).toEqual(["That box is full. Moved it."]);
  });

  it("a line mounted over a joined line says nothing of it", async () => {
    const props = { onUndo: () => {}, onDismiss: () => {} };
    const joined: Notice = {
      id: 7,
      kind: "refusal",
      refusal: { words: "R.", id: 6, at: 0 },
      undoFor: { words: "B.", id: 7 },
      message: "R. B.",
      announce: "B.",
    };
    const { rerender } = render(<NoticeLine notice={joined} {...props} />);
    const live = heard();
    await nextFrame();
    rerender(<NoticeLine notice={{ ...joined, id: 8, undoFor: { words: "C.", id: 8 }, message: "R. C.", announce: "C." }} {...props} />);
    await nextFrame();
    live.flush();
    // R (id 6) came up before this line was drawn: said already, so only C.
    expect(live.said).toEqual(["C."]);
  });

  it("a refusal in front of a write's words reads apart: its own span in the negative ink, ending its sentence", async () => {
    const { line } = page();
    let older!: ReturnType<StatusLine["beginWrite"]>;
    let newer!: ReturnType<StatusLine["beginWrite"]>;
    act(() => {
      older = line().beginWrite();
      newer = line().beginWrite();
    });
    act(() => older.refused("No room in that box"));
    act(() => newer.done("Moved it.", () => {}));
    expect(shown().textContent).toBe("No room in that box. Moved it.");
    const refusal = shown().querySelector("span");
    expect(refusal?.textContent).toBe("No room in that box.");
    expect(refusal?.className).toContain("text-neon-pink-text");
    // The Undo is the write's: it sits outside the refusal's words.
    expect(refusal?.contains(screen.getByRole("button", { name: "Undo" }))).toBe(false);
  });
});

/**
 * A page whose desk line steps aside while the card drawer is open, as
 * FinalCollectionPage hands MyBindersTab `drawer ? null : notice`.
 */
function DeskAndDrawer({ onLine, shared = true }: { onLine: (line: StatusLine, setDrawer: (open: boolean) => void) => void; shared?: boolean }) {
  const line = useStatusLine();
  const [drawer, setDrawer] = useState(false);
  onLine(line, setDrawer);
  const body = (
    <>
      <section aria-label="Desk">
        <NoticeLine notice={drawer ? null : line.notice} onUndo={line.undo} onDismiss={line.dismiss} floating />
      </section>
      {drawer && (
        <section aria-label="Drawer">
          <NoticeLine notice={line.notice} onUndo={line.undo} onDismiss={line.dismiss} />
        </section>
      )}
    </>
  );
  return shared ? <NoticeSpokenContext.Provider value={line.spoken}>{body}</NoticeSpokenContext.Provider> : body;
}

describe("every line of one status line shares what has been said", () => {
  function setup(shared = true) {
    let line!: StatusLine;
    let setDrawer!: (open: boolean) => void;
    render(
      <DeskAndDrawer
        shared={shared}
        onLine={(l, s) => {
          line = l;
          setDrawer = s;
        }}
      />,
    );
    const regionIn = (name: string) => within(screen.getByRole("region", { name })).getByRole("status");
    return { line: () => line, drawer: (open: boolean) => act(() => setDrawer(open)), setDrawer: (open: boolean) => setDrawer(open), regionIn };
  }

  it("drawer open, a write lands (the drawer's line says it), drawer closes: the desk's line says nothing", async () => {
    const { line, drawer, regionIn } = setup();
    drawer(true);
    const inDrawer = listen(regionIn("Drawer"));
    const atDesk = listen(regionIn("Desk"));
    stops.push(inDrawer.stop, atDesk.stop);
    act(() => line().beginWrite().done("Moved it.", () => {}));
    await nextFrame();
    drawer(false);
    await nextFrame();
    inDrawer.flush();
    atDesk.flush();
    expect(inDrawer.said).toEqual(["Moved it."]);
    expect(atDesk.said).toEqual([]);
  });

  it("a refusal said in the drawer is not said again by the desk", async () => {
    const { line, drawer, regionIn } = setup();
    let older!: ReturnType<StatusLine["beginWrite"]>;
    let newer!: ReturnType<StatusLine["beginWrite"]>;
    act(() => {
      older = line().beginWrite();
      newer = line().beginWrite();
    });
    drawer(true);
    const atDesk = listen(regionIn("Desk"));
    stops.push(atDesk.stop);
    act(() => older.refused("That box is full."));
    await nextFrame();
    act(() => newer.done("Moved it.", () => {}));
    await nextFrame();
    drawer(false);
    await nextFrame();
    atDesk.flush();
    expect(atDesk.said).toEqual([]);
  });

  it("a notice that comes up as the drawer closes is said once, by the desk", async () => {
    const { line, drawer, setDrawer, regionIn } = setup();
    drawer(true);
    const atDesk = listen(regionIn("Desk"));
    stops.push(atDesk.stop);
    // One render: the drawer's line never drew it, so it is news at the desk.
    act(() => {
      line().notify("Took it out.");
      setDrawer(false);
    });
    await nextFrame();
    atDesk.flush();
    expect(atDesk.said).toEqual(["Took it out."]);
  });

  it("a line taken away before its frame ran hands the words on: the desk says them", async () => {
    const { line, setDrawer, drawer, regionIn } = setup();
    drawer(true);
    const atDesk = listen(regionIn("Desk"));
    stops.push(atDesk.stop);
    // The drawer's line draws it, then closes before its frame runs.
    act(() => line().beginWrite().done("Moved it.", () => {}));
    act(() => setDrawer(false));
    await nextFrame();
    atDesk.flush();
    expect(atDesk.said).toEqual(["Moved it."]);
  });

  it("a line drawn over a notice another line said holds its words without saying them", async () => {
    const { line, drawer, regionIn } = setup();
    act(() => line().notify("Saved."));
    await nextFrame();
    drawer(true);
    // The drawer's region is drawn already holding them: found, not news.
    expect(regionIn("Drawer").textContent).toBe("Saved.");
    const inDrawer = listen(regionIn("Drawer"));
    stops.push(inDrawer.stop);
    await nextFrame();
    inDrawer.flush();
    expect(inDrawer.said).toEqual([]);
  });
});
