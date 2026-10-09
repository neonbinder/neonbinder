/**
 * NEO-325 — the reconciler's Save is blocked while two Ready sets would be
 * saved under one title, and what it sends for sets the operator made their
 * own.
 *
 *   • blocked Save: `aria-disabled` (still in the tab order), `title` = the
 *     sentence, and a press does NOT reach `onConfirm`;
 *   • typing re-enables Save before the field is left; Escape reverts the
 *     title (and does not close the dialog);
 *   • `identityOnly: true` rides on "Make its own set" AND "Keep all" sets,
 *     and on nothing else;
 *   • `twinIds` forces `(#id)` on a twin whose namesake never reached the
 *     dialog; `showAllSlInitially` opens with the SportLots prefix filter off.
 *
 * Companion to `ReconciliationModal.duplicates.test.tsx` (same fixtures).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReconciliationModal, {
  type PlatformItem,
} from "./ReconciliationModal";
import {
  RENAME_TIP,
  TITLE_CLASH_ROW_LINE,
  titleClashMessage,
} from "./ready-title-clashes";
import { MAX_SELECTOR_VALUE_LENGTH } from "../../convex/selectorSyncMatch";

const ANIME_111: PlatformItem = { value: "Anime", platformValue: "111" };
const ANIME_222: PlatformItem = { value: "Anime", platformValue: "222" };
const SOLO_333: PlatformItem = { value: "Solo", platformValue: "333" };
const BSC_ONE: PlatformItem = { value: "Bsc One", platformValue: "bsc-one" };

type ModalProps = Parameters<typeof ReconciliationModal>[0];

function renderModal(extra: Partial<ModalProps> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <ReconciliationModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      level="insert"
      initialData={{
        autoMatched: [],
        unmatchedBsc: [BSC_ONE],
        unmatchedSl: [ANIME_111, ANIME_222, SOLO_333],
        slCandidates: [],
      }}
      {...extra}
    />,
  );
  return { onConfirm, onClose };
}

function makeOwnSet(label: string) {
  fireEvent.click(screen.getByLabelText(`Make its own set: ${label}`));
}

/** Promote both twins: two Ready sets that both start out named "Anime". */
function promoteBothTwins() {
  makeOwnSet("Anime (#111)");
  makeOwnSet("Anime (#222)");
}

/** The footer's clash sentence: the element Save points at. */
const clashRegion = () => {
  const id = saveButton().getAttribute("aria-describedby")!.split(" ")[0];
  return document.getElementById(id)!;
};

const saveButton = () => screen.getByText(/^Save \d+ sets$/).closest("button")!;

/** The title inputs of the Ready sets, in order. */
const titleInputs = () =>
  screen.getAllByLabelText(/^NeonBinder set name for /) as HTMLInputElement[];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReconciliationModal — Save is blocked while titles clash (NEO-325)", () => {
  test("two Ready sets with one title: Save is aria-disabled, its title is the sentence, and pressing it does not confirm", async () => {
    const { onConfirm } = renderModal();
    promoteBothTwins();

    const save = saveButton();
    expect(save.getAttribute("aria-disabled")).toBe("true");
    // Not the `disabled` attribute: that would drop it from the tab order.
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(save.getAttribute("title")).toContain("Anime");
    expect(clashRegion().textContent).toContain("Anime");

    fireEvent.click(save);
    await new Promise((r) => setTimeout(r, 0));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("the title attribute is exactly the sentence the status region shows", () => {
    renderModal();
    promoteBothTwins();

    expect(saveButton().getAttribute("title")).toBe(
      clashRegion().textContent,
    );
    expect(saveButton().getAttribute("title")).toBe(
      titleClashMessage({
        key: "anime",
        title: "Anime",
        readyKeys: ["a", "b"],
        existingCount: 0,
      }),
    );
  });

  test("the clashing title inputs are marked invalid and describe themselves with the sentence", () => {
    renderModal();
    promoteBothTwins();

    for (const input of titleInputs()) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBeTruthy();
    }
  });

  test("no clash, no block: one Ready set saves normally and carries no aria-disabled or title", async () => {
    const { onConfirm } = renderModal();
    makeOwnSet("Solo");

    const save = saveButton();
    expect(save.hasAttribute("aria-disabled")).toBe(false);
    expect(save.hasAttribute("title")).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  test("typing a different title re-enables Save BEFORE the field is left", async () => {
    const { onConfirm } = renderModal();
    promoteBothTwins();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(titleInputs()[1], { target: { value: "Anime Gold" } });

    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);
    expect(saveButton().hasAttribute("title")).toBe(false);
    // A real press on Save blurs the field first, which commits the title.
    fireEvent.blur(titleInputs()[1]);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const items = onConfirm.mock.calls[0][0].items as Array<{ value: string }>;
    expect(items.map((i) => i.value).sort()).toEqual(["Anime", "Anime Gold"]);
  });

  test("typing a title that creates a clash blocks Save at once", () => {
    renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);

    fireEvent.change(titleInputs()[1], { target: { value: "anime " } });

    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  test("Escape in a title field reverts that title, unblocks Save, and does not close the dialog", () => {
    const { onClose } = renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    const [, solo] = titleInputs();
    solo.focus();

    fireEvent.change(solo, { target: { value: "Anime" } });
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(solo, { key: "Escape" });

    expect(solo.value).toBe("Solo");
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Discard/)).toBeNull();
  });

  test("Enter commits a title and Save stays unblocked", async () => {
    const { onConfirm } = renderModal();
    promoteBothTwins();
    const second = titleInputs()[1];

    fireEvent.change(second, { target: { value: "Anime Retail" } });
    fireEvent.keyDown(second, { key: "Enter" });

    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  test("an emptied title does not count as a clash and snaps back on blur", () => {
    renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    const solo = titleInputs()[1];

    fireEvent.change(solo, { target: { value: "" } });
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.blur(solo);

    expect(solo.value).toBe("Solo");
  });
});

describe("ReconciliationModal — identityOnly rides on sets the operator made their own (NEO-325)", () => {
  type Sent = Array<{ value: string; identityOnly?: boolean }>;

  test("Make its own set sends identityOnly: true", async () => {
    const { onConfirm } = renderModal();
    makeOwnSet("Solo");
    fireEvent.click(saveButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const items = onConfirm.mock.calls[0][0].items as Sent;
    expect(items).toHaveLength(1);
    expect(items[0].identityOnly).toBe(true);
  });

  test("Keep all sends identityOnly: true on every set it makes", async () => {
    const { onConfirm } = renderModal({
      initialData: {
        autoMatched: [],
        unmatchedBsc: [],
        unmatchedSl: [SOLO_333, { value: "Duo", platformValue: "444" }],
        slCandidates: [],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Keep all, SportLots sets/ }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const items = onConfirm.mock.calls[0][0].items as Sent;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.identityOnly === true)).toBe(true);
  });

  test("a set made by pairing a SportLots row with a BSC row (not its own) carries no identityOnly", async () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByText("Solo"));
    fireEvent.click(screen.getByText(BSC_ONE.value));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const items = onConfirm.mock.calls[0][0].items as Sent;
    expect(items).toHaveLength(1);
    expect("identityOnly" in items[0]).toBe(false);
  });

  test("a restored Ready set from existingRows carries no identityOnly", async () => {
    const { onConfirm } = renderModal({
      initialData: {
        autoMatched: [
          { displayName: "Gold", bsc: BSC_ONE, sl: SOLO_333, confidence: 1 },
        ],
        unmatchedBsc: [],
        unmatchedSl: [],
        slCandidates: [],
      },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());

    const items = onConfirm.mock.calls[0][0].items as Sent;
    expect("identityOnly" in items[0]).toBe(false);
  });
});

describe("ReconciliationModal — twinIds and showAllSlInitially (NEO-325)", () => {
  test("a lone item whose id is in twinIds still shows (#id): its namesake never reached the dialog", () => {
    renderModal({
      initialData: {
        autoMatched: [],
        unmatchedBsc: [],
        unmatchedSl: [ANIME_111],
        slCandidates: [],
      },
      twinIds: { bsc: [], sportlots: ["111"] },
    });

    expect(screen.getByLabelText("Make its own set: Anime (#111)")).toBeTruthy();
    expect(screen.queryByLabelText("Make its own set: Anime")).toBeNull();
  });

  test("without twinIds the same lone item reads as its bare name", () => {
    renderModal({
      initialData: {
        autoMatched: [],
        unmatchedBsc: [],
        unmatchedSl: [ANIME_111],
        slCandidates: [],
      },
    });

    expect(screen.getByLabelText("Make its own set: Anime")).toBeTruthy();
  });

  test("twinIds forces the id on every item that shares a TWIN name, and only that name", () => {
    renderModal({
      initialData: {
        autoMatched: [],
        unmatchedBsc: [],
        unmatchedSl: [ANIME_111, SOLO_333],
        slCandidates: [],
      },
      twinIds: { bsc: [], sportlots: ["111"] },
    });

    expect(screen.getByLabelText("Make its own set: Anime (#111)")).toBeTruthy();
    expect(screen.getByLabelText("Make its own set: Solo")).toBeTruthy();
  });

  test("twinIds for BSC forces the BSC slug", () => {
    renderModal({
      initialData: {
        autoMatched: [],
        unmatchedBsc: [{ value: "Gold", platformValue: "gold-1" }],
        unmatchedSl: [],
        slCandidates: [],
      },
      twinIds: { bsc: ["gold-1"], sportlots: [] },
    });

    expect(screen.getByLabelText("Make its own set: Gold (#gold-1)")).toBeTruthy();
  });

  test("the SportLots prefix filter hides non-matching items by default; showAllSlInitially opens with it off", () => {
    const initialData = {
      autoMatched: [],
      unmatchedBsc: [],
      unmatchedSl: [
        { value: "Chrome Gold", platformValue: "1" },
        { value: "Heritage", platformValue: "2" },
      ],
      slCandidates: [],
    };

    const { unmount } = (() => {
      const r = render(
        <ReconciliationModal
          isOpen
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          level="insert"
          setName="Chrome"
          initialData={initialData}
        />,
      );
      return r;
    })();
    expect(screen.queryByLabelText("Make its own set: Heritage")).toBeNull();
    expect(
      (screen.getByLabelText("Show all SportLots items") as HTMLInputElement).checked,
    ).toBe(false);
    unmount();

    render(
      <ReconciliationModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        level="insert"
        setName="Chrome"
        showAllSlInitially
        initialData={initialData}
      />,
    );
    expect(screen.getByLabelText("Make its own set: Heritage")).toBeTruthy();
    expect(
      (screen.getByLabelText("Show all SportLots items") as HTMLInputElement).checked,
    ).toBe(true);
  });
});

describe("ReconciliationModal — keyboard, focus and the row's own clash line (NEO-325 a11y)", () => {
  test("Enter commits the title and focus stays on the SAME field (no remount, no drop to the page)", () => {
    renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    const solo = titleInputs()[1];
    solo.focus();

    fireEvent.change(solo, { target: { value: "  Solo Retail  " } });
    fireEvent.keyDown(solo, { key: "Enter" });

    expect(titleInputs()[1]).toBe(solo);
    expect(document.activeElement).toBe(solo);
    // Committed, and trimmed in the field itself.
    expect(solo.value).toBe("Solo Retail");
  });

  test("Escape reverts the title and focus stays on the SAME field", () => {
    const { onClose } = renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    const solo = titleInputs()[1];
    solo.focus();
    fireEvent.change(solo, { target: { value: "Something else" } });

    fireEvent.keyDown(solo, { key: "Escape" });

    expect(titleInputs()[1]).toBe(solo);
    expect(document.activeElement).toBe(solo);
    expect(solo.value).toBe("Solo");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("an Escape does not leave a stale draft behind: a later blur does not bring the abandoned title back", () => {
    renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    const solo = titleInputs()[1];
    solo.focus();
    fireEvent.change(solo, { target: { value: "Anime" } });
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(solo, { key: "Escape" });
    fireEvent.blur(solo);

    expect(solo.value).toBe("Solo");
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);
  });

  test("a clashing title is described by its OWN line first, then by the footer sentence", () => {
    renderModal();
    promoteBothTwins();

    for (const input of titleInputs()) {
      const [rowLineId, sentenceId, ...rest] = input
        .getAttribute("aria-describedby")!
        .split(" ");
      expect(rest).toEqual([]);
      expect(document.getElementById(rowLineId)?.textContent).toContain(
        TITLE_CLASH_ROW_LINE,
      );
      // The footer's sentence is the one Save points at.
      expect(sentenceId).not.toBe(rowLineId);
      expect(saveButton().getAttribute("aria-describedby")).toContain(sentenceId);
    }
    // One line per row, never one shared id.
    const ids = titleInputs().map((i) => i.getAttribute("aria-describedby")!.split(" ")[0]);
    expect(new Set(ids).size).toBe(2);
  });

  test("a row that does not clash has no clash line and no describedby", () => {
    renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");

    for (const input of titleInputs()) {
      expect(input.hasAttribute("aria-describedby")).toBe(false);
      expect(input.hasAttribute("aria-invalid")).toBe(false);
    }
    expect(screen.queryByText(TITLE_CLASH_ROW_LINE, { exact: false })).toBeNull();
  });

  test("the title field takes at most the store's name ceiling", () => {
    renderModal();
    makeOwnSet("Solo");

    expect(titleInputs()[0].maxLength).toBe(MAX_SELECTOR_VALUE_LENGTH);
    expect(MAX_SELECTOR_VALUE_LENGTH).toBe(200);
  });

  test("the rename tip is the placeholder only while the title clashes", () => {
    renderModal();
    makeOwnSet("Anime (#111)");
    makeOwnSet("Solo");
    expect(titleInputs()[1].hasAttribute("placeholder")).toBe(false);

    fireEvent.change(titleInputs()[1], { target: { value: "Anime" } });
    expect(titleInputs()[0].placeholder).toBe(RENAME_TIP);
    expect(titleInputs()[1].placeholder).toBe(RENAME_TIP);

    fireEvent.change(titleInputs()[1], { target: { value: "Anime Retail" } });
    expect(titleInputs()[0].hasAttribute("placeholder")).toBe(false);
    expect(titleInputs()[1].hasAttribute("placeholder")).toBe(false);
  });

  test("pressing a blocked Save moves focus to the first title that needs a new name, and confirms nothing", async () => {
    const { onConfirm } = renderModal();
    makeOwnSet("Solo");
    promoteBothTwins();
    const [solo, firstTwin] = titleInputs();
    expect(solo.getAttribute("aria-invalid")).toBeNull();
    saveButton().focus();

    fireEvent.click(saveButton());

    expect(document.activeElement).toBe(firstTwin);
    expect(document.activeElement).not.toBe(solo);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ReconciliationModal — the twin sentence and where a clash sits (NEO-325)", () => {
  const SENTENCE = "Both marketplaces list these under one name.";

  test("the dialog is described by the twin sentence when there is one", () => {
    renderModal({ twinNotice: SENTENCE });

    const dialog = screen.getByRole("dialog");
    const id = dialog.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toBe(SENTENCE);
  });

  test("with no twin sentence the dialog carries no aria-describedby", () => {
    renderModal();

    expect(screen.getByRole("dialog").hasAttribute("aria-describedby")).toBe(false);
  });

  test("a clash with a saved set says where it is saved when the caller names the parent", () => {
    const scope = "2024 Topps Chrome › Inserts";
    renderModal({
      parentPath: scope,
      existingRows: [{ value: "Anime", platformData: {} }],
    });

    makeOwnSet("Anime (#111)");

    const sentence = clashRegion().textContent!;
    expect(sentence).toBe(
      titleClashMessage(
        { key: "anime", title: "Anime", readyKeys: ["a"], existingCount: 1 },
        scope,
      ),
    );
    expect(sentence).toContain(scope);
    expect(saveButton().getAttribute("title")).toBe(sentence);
  });

  test("without a parent path the same clash says 'here'", () => {
    renderModal({ existingRows: [{ value: "Anime", platformData: {} }] });

    makeOwnSet("Anime (#111)");

    expect(clashRegion().textContent).toBe(
      titleClashMessage({ key: "anime", title: "Anime", readyKeys: ["a"], existingCount: 1 }),
    );
    expect(clashRegion().textContent).toContain("” here.");
  });
});
