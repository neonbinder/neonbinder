/**
 * NEO-325 — the twin half of `SyncDoneNotice`: the names a sync LEFT for the
 * operator because a marketplace lists them more than once.
 *
 * Three lines show, the rest sit behind "Show all N", names past the server's
 * cap are counted ("+ N more"), the guidance line depends on the column's
 * level, and the one Dismiss clears the box. Wording is DRAFT copy, so the
 * assertions pin structure (counts, ids, which control) and read the sentence
 * from the helper that owns it where they need it.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SyncDoneNotice from "./SyncDoneNotice";
import {
  TWIN_LINES_SHOWN,
  twinLeftIdsText,
  twinsLeftGuidance,
  twinsLeftSummary,
  type TwinLeftEntry,
} from "./selector-sync-feedback";

const entry = (name: string, sportlots: string[] = [], bsc: string[] = []): TwinLeftEntry => ({
  name,
  bsc,
  sportlots,
});

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => entry(`Name ${i + 1}`, [`${i}1`, `${i}2`]));

function renderNotice(
  twins: Parameters<typeof SyncDoneNotice>[0]["twins"],
  extra: Partial<Parameters<typeof SyncDoneNotice>[0]> = {},
) {
  const onDismiss = vi.fn();
  render(
    <SyncDoneNotice notices={[]} onDismiss={onDismiss} twins={twins} {...extra} />,
  );
  return { onDismiss };
}

describe("SyncDoneNotice — twins left (NEO-325)", () => {
  it("shows nothing when there is no message, no unlink notice and no twins: no text and no Dismiss", () => {
    const { container } = render(
      <SyncDoneNotice notices={[]} onDismiss={vi.fn()} twins={{ entries: [] }} />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("twins alone are enough to render the box, with the summary sentence", () => {
    const entries = [entry("Anime", ["378117", "378118"])];
    renderNotice({ entries, total: 1, level: "setName" });

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(twinsLeftSummary(entries, 1))).toBeTruthy();
  });

  it("each line reads name, side and #ids together", () => {
    renderNotice({
      entries: [entry("Anime", ["378117", "378118"]), entry("Gold", [], ["gold-a", "gold-b"])],
    });

    expect(screen.getByText("Anime (SportLots #378117, #378118)")).toBeTruthy();
    expect(screen.getByText("Gold (BSC #gold-a, #gold-b)")).toBeTruthy();
    // The bare name is never a node of its own, so a flow's `text: Anime`
    // cannot match the notice.
    expect(screen.queryByText("Anime")).toBeNull();
  });

  it("a name on both sides names both, in one line", () => {
    renderNotice({ entries: [entry("Chrome", ["1", "2"], ["chrome-a"])] });
    const both = entry("Chrome", ["1", "2"], ["chrome-a"]);
    expect(screen.getByText(`Chrome (${twinLeftIdsText(both)})`)).toBeTruthy();
    expect(twinLeftIdsText(both)).toContain("BSC #chrome-a");
    expect(twinLeftIdsText(both)).toContain("SportLots #1, #2");
  });

  it("shows TWIN_LINES_SHOWN lines and hides the rest behind Show all N", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN + 2) });

    for (let i = 1; i <= TWIN_LINES_SHOWN; i++) {
      expect(screen.getByText(new RegExp(`^Name ${i} \\(`))).toBeTruthy();
    }
    expect(screen.queryByText(new RegExp(`^Name ${TWIN_LINES_SHOWN + 1} \\(`))).toBeNull();
    const toggle = screen.getByText(`Show all ${TWIN_LINES_SHOWN + 2}`);
    expect(toggle.closest("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("Show all reveals the rest, and Show fewer hides them again", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN + 2) });

    fireEvent.click(screen.getByText(`Show all ${TWIN_LINES_SHOWN + 2}`));
    expect(screen.getByText(new RegExp(`^Name ${TWIN_LINES_SHOWN + 2} \\(`))).toBeTruthy();
    const fewer = screen.getByText("Show fewer").closest("button")!;
    expect(fewer.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fewer);
    expect(screen.queryByText(new RegExp(`^Name ${TWIN_LINES_SHOWN + 2} \\(`))).toBeNull();
  });

  it("exactly TWIN_LINES_SHOWN entries need no Show all", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN) });
    expect(screen.queryByText(/^Show all/)).toBeNull();
  });

  it("names past the server's cap are counted as + N more, inside the revealed list", () => {
    const entries = many(TWIN_LINES_SHOWN + 2);
    renderNotice({ entries, total: entries.length + 7 });

    expect(screen.queryByText("+ 7 more")).toBeNull();
    fireEvent.click(screen.getByText(`Show all ${entries.length}`));
    expect(screen.getByText("+ 7 more")).toBeTruthy();
  });

  it("with no Show all (few entries) the + N more line stands on its own", () => {
    renderNotice({ entries: many(2), total: 12 });
    expect(screen.getByText("+ 10 more")).toBeTruthy();
  });

  it("no total, or a total equal to the list, adds no + N more", () => {
    renderNotice({ entries: many(2) });
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("the Show all button is named for the notice it belongs to", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN + 1) }, { columnLabel: "Sets" });
    expect(
      screen.getByLabelText(`Show all ${TWIN_LINES_SHOWN + 1} names in the Sets notice`),
    ).toBeTruthy();
  });

  it.each([
    ["setName" as const],
    ["insert" as const],
    ["parallel" as const],
  ])("a %s column shows its guidance line", (level) => {
    renderNotice({ entries: [entry("Anime", ["1", "2"])], level });
    const text = twinsLeftGuidance(level)!;
    expect(text).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("the Sets and the Inserts columns point at different places", () => {
    expect(twinsLeftGuidance("setName")).not.toBe(twinsLeftGuidance("insert"));
    expect(twinsLeftGuidance("insert")).toBe(twinsLeftGuidance("parallel"));
  });

  it.each([["manufacturer" as const], ["year" as const], ["sport" as const], [undefined]])(
    "a %s column has no linking UI, so no guidance line",
    (level) => {
      expect(twinsLeftGuidance(level)).toBeNull();
      renderNotice({ entries: [entry("Anime", ["1", "2"])], level });
      expect(document.querySelectorAll("p.opacity-80")).toHaveLength(0);
    },
  );

  it("Dismiss clears the notice through the one button, with or without twins", () => {
    const { onDismiss } = renderNotice(
      { entries: [entry("Anime", ["1", "2"])] },
      { columnLabel: "Sets" },
    );
    fireEvent.click(screen.getByLabelText("Dismiss Sets notice"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a notice that also carries a server message and an unlink notice shows all three halves under ONE Dismiss", () => {
    renderNotice(
      { entries: [entry("Anime", ["1", "2"])] },
      {
        message: "SportLots was not reached.",
        notices: [{ side: "bsc", count: 1, names: ["Anime"], hidden: 0, text: "No longer listed on BSC." }],
      },
    );
    expect(screen.getByText("SportLots was not reached.")).toBeTruthy();
    expect(screen.getByText("No longer listed on BSC.")).toBeTruthy();
    expect(screen.getByText(`Anime (${twinLeftIdsText(entry("x", ["1", "2"]))})`)).toBeTruthy();
    expect(screen.getAllByText("Dismiss")).toHaveLength(1);
  });

  it("the list sits in an aria-live=off region so opening it does not re-announce every line", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN + 1) });
    expect(document.querySelector('[aria-live="off"]')).not.toBeNull();
  });
});

describe("SyncDoneNotice — the disclosure and the empty region (NEO-325 a11y)", () => {
  it("the Show all button comes BEFORE the lines it reveals, in the DOM, and controls them", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN + 2) });
    const toggle = screen.getByText(`Show all ${TWIN_LINES_SHOWN + 2}`).closest("button")!;

    fireEvent.click(screen.getByText(`Show all ${TWIN_LINES_SHOWN + 2}`));

    const firstRevealed = screen.getByText(new RegExp(`^Name ${TWIN_LINES_SHOWN + 1} \\(`));
    // Opening it moves the reader on INTO the new lines, not back past them.
    expect(
      toggle.compareDocumentPosition(firstRevealed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(list.contains(firstRevealed)).toBe(true);
    // The wrapper that holds the revealed lines is quiet inside the status box.
    expect(list.getAttribute("aria-live")).toBe("off");
    // The shown lines are still above the button.
    const shownLine = screen.getByText(/^Name 1 \(/);
    expect(
      shownLine.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the controlled list exists, empty, before it is opened, so aria-controls always resolves", () => {
    renderNotice({ entries: many(TWIN_LINES_SHOWN + 2) });
    const toggle = screen.getByText(`Show all ${TWIN_LINES_SHOWN + 2}`).closest("button")!;

    const list = document.getElementById(toggle.getAttribute("aria-controls")!);

    expect(list).not.toBeNull();
    expect(list!.textContent).toBe("");
  });

  it("with nothing to say it renders a bare status region: empty, unstyled, and no Dismiss", () => {
    const { container } = render(
      <SyncDoneNotice notices={[]} onDismiss={vi.fn()} twins={{ entries: [] }} />,
    );

    const region = screen.getByRole("status");
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(region);
    expect(region.textContent).toBe("");
    expect(region.hasAttribute("class")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("the bare region and the filled notice are the SAME element, so what arrives is announced", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<SyncDoneNotice notices={[]} onDismiss={onDismiss} />);
    const before = screen.getByRole("status");

    rerender(<SyncDoneNotice notices={[]} onDismiss={onDismiss} message="SportLots was not reached." />);

    expect(screen.getByRole("status")).toBe(before);
    expect(before.textContent).toContain("SportLots was not reached.");
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });
});
