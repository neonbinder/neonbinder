/**
 * NEO-325 — SportLots lists DISTINCT sets under one name (a year's "Anime" can
 * be three radio ids). The modal must treat the id as the identity and the
 * name as a label only: key, select, drag, promote and resolve by
 * `platformValue`, and show the id on a name the side repeats.
 *
 * Fixture: SL Anime/111, Anime/222, Solo/333 beside two BSC sets. A name-keyed
 * modal collapses the two Anime rows into one key and resolves every click on
 * either of them to the first.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReconciliationModal, {
  type PlatformItem,
} from "./ReconciliationModal";

const ANIME_111: PlatformItem = { value: "Anime", platformValue: "111" };
const ANIME_222: PlatformItem = { value: "Anime", platformValue: "222" };
const SOLO_333: PlatformItem = { value: "Solo", platformValue: "333" };
const BSC_ONE: PlatformItem = { value: "Bsc One", platformValue: "bsc-one" };
const BSC_TWO: PlatformItem = { value: "Bsc Two", platformValue: "bsc-two" };

type ModalProps = Parameters<typeof ReconciliationModal>[0];

function renderModal(extra: Partial<ModalProps> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      initialData={{
        autoMatched: [],
        unmatchedBsc: [BSC_ONE, BSC_TWO],
        unmatchedSl: [ANIME_111, ANIME_222, SOLO_333],
        slCandidates: [],
      }}
      {...extra}
    />,
  );
  return { onConfirm };
}

async function itemsFromConfirm(onConfirm: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  return onConfirm.mock.calls[0][0].items as Array<{
    value: string;
    platformData: { bsc?: string[]; sportlots?: string[] };
  }>;
}

/** The aria-labels of every SL row's "Make its own set" button, in order. */
function slOwnSetLabels(): Array<string | null> {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-own-set="sl"]'),
  ).map((b) => b.getAttribute("aria-label"));
}

/** The clickable (select) half of the row that owns this promote button. */
function rowHandle(ownSetLabel: string): HTMLElement {
  const button = screen.getByLabelText(ownSetLabel);
  return button.parentElement!.previousElementSibling as HTMLElement;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // (g) The duplicate-key warning is a console.error; any test in this file
  // that provoked it has the twins sharing a React key.
  const keyWarnings = consoleError.mock.calls.filter((args: unknown[]) =>
    /same key|unique "key"/i.test(String(args[0])),
  );
  consoleError.mockRestore();
  expect(keyWarnings).toEqual([]);
});

describe("ReconciliationModal — SportLots sets that share a name (NEO-325)", () => {
  test("twins render with their id in the accessible name; a unique name is unsuffixed", () => {
    renderModal();

    expect(slOwnSetLabels()).toEqual([
      "Make its own set: Anime (#111)",
      "Make its own set: Anime (#222)",
      "Make its own set: Solo",
    ]);
    // Exact-string lookup: the bare name no longer names either twin.
    expect(screen.queryByLabelText("Make its own set: Anime")).toBeNull();
  });

  test("the BSC side is unaffected by an SL name collision", () => {
    renderModal();

    expect(screen.getByLabelText("Make its own set: Bsc One")).toBeTruthy();
    expect(screen.getByLabelText("Make its own set: Bsc Two")).toBeTruthy();
  });

  test("promoting the second twin saves ITS id, not the first one's", async () => {
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByLabelText("Make its own set: Anime (#222)"));
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].platformData.sportlots).toEqual(["222"]);
  });

  test("click-pairing the second twin with a BSC row carries its id", async () => {
    const { onConfirm } = renderModal();

    fireEvent.click(rowHandle("Make its own set: Anime (#222)"));
    fireEvent.click(screen.getByText(BSC_ONE.value));
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items).toHaveLength(1);
    expect(items[0].platformData.sportlots).toEqual(["222"]);
    expect(items[0].platformData.bsc).toEqual(["bsc-one"]);
  });

  test("attaching the second twin to a Ready set names its id and carries it", async () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByLabelText("Make its own set: Bsc One"));

    fireEvent.click(rowHandle("Make its own set: Anime (#222)"));
    fireEvent.click(
      screen.getByLabelText("Add Anime (#222) to this set, Bsc One"),
    );
    fireEvent.click(screen.getByText(/Save 1 sets/));
    const items = await itemsFromConfirm(onConfirm);

    expect(items[0].platformData.sportlots).toEqual(["222"]);
  });

  test("a mapped twin's chip names its id, and its Remove control says which", () => {
    renderModal();
    fireEvent.click(rowHandle("Make its own set: Anime (#222)"));
    fireEvent.click(screen.getByText(BSC_ONE.value));

    expect(
      screen.getByLabelText("Remove Anime (#222) from Bsc One"),
    ).toBeTruthy();
    // The other twin is still pending and keeps its suffix.
    expect(slOwnSetLabels()).toEqual([
      "Make its own set: Anime (#111)",
      "Make its own set: Solo",
    ]);
  });

  describe("filtering the SportLots column", () => {
    test("shows exactly the matching twins, both still suffixed", () => {
      renderModal();

      fireEvent.change(screen.getByLabelText("Search SportLots items"), {
        target: { value: "Anime" },
      });

      expect(slOwnSetLabels()).toEqual([
        "Make its own set: Anime (#111)",
        "Make its own set: Anime (#222)",
      ]);
    });

    test("a single-match filter shows exactly one row, unsuffixed", () => {
      renderModal();

      fireEvent.change(screen.getByLabelText("Search SportLots items"), {
        target: { value: "Solo" },
      });

      expect(slOwnSetLabels()).toEqual(["Make its own set: Solo"]);
    });

    test("narrowing then clearing leaves no stale or missing rows", () => {
      renderModal();
      const search = screen.getByLabelText("Search SportLots items");

      fireEvent.change(search, { target: { value: "Solo" } });
      fireEvent.change(search, { target: { value: "" } });

      expect(slOwnSetLabels()).toEqual([
        "Make its own set: Anime (#111)",
        "Make its own set: Anime (#222)",
        "Make its own set: Solo",
      ]);
    });

    test("a filter that hides one twin does not drop the other's suffix", () => {
      // 111 is mapped on a restored set, so the filtered Pending list holds
      // 222 alone. The name is still shared on the side, so 222 keeps its id.
      renderModal({
        existingRows: [
          { value: "Set A", platformData: { sportlots: ["111"] } },
        ],
      });

      fireEvent.change(screen.getByLabelText("Search SportLots items"), {
        target: { value: "Anime" },
      });

      expect(slOwnSetLabels()).toEqual(["Make its own set: Anime (#222)"]);
    });
  });

  describe("with one twin already mapped on a restored Ready set", () => {
    const restored: Partial<ModalProps> = {
      existingRows: [{ value: "Set A", platformData: { sportlots: ["111"] } }],
    };

    test("the pending twin is suffixed even though its sibling is not in Pending", () => {
      renderModal(restored);

      expect(slOwnSetLabels()).toEqual([
        "Make its own set: Anime (#222)",
        "Make its own set: Solo",
      ]);
      expect(
        screen.getByLabelText("Remove Anime (#111) from Set A"),
      ).toBeTruthy();
    });

    test("'Show sets already mapped' lists the mapped twin by its id beside the pending one", () => {
      renderModal(restored);

      fireEvent.click(
        screen.getByLabelText("Show SportLots sets already mapped"),
      );

      const mappedRow = screen.getByText("mapped to Set A")
        .previousElementSibling as HTMLElement;
      expect(mappedRow.textContent).toContain("Anime");
      expect(mappedRow.textContent).toContain("(#111)");
      expect(slOwnSetLabels()).toEqual([
        "Make its own set: Anime (#222)",
        "Make its own set: Solo",
      ]);
    });

    test("selecting the revealed mapped twin attaches ITS id to a second set", async () => {
      const { onConfirm } = renderModal({
        ...restored,
        initialData: {
          autoMatched: [],
          unmatchedBsc: [BSC_ONE],
          unmatchedSl: [ANIME_111, ANIME_222, SOLO_333],
          slCandidates: [],
        },
      });
      fireEvent.click(screen.getByLabelText("Make its own set: Bsc One"));
      fireEvent.click(
        screen.getByLabelText("Show SportLots sets already mapped"),
      );

      const mappedRow = screen.getByText("mapped to Set A")
        .previousElementSibling as HTMLElement;
      fireEvent.click(mappedRow.firstElementChild as HTMLElement);
      fireEvent.click(screen.getByLabelText("Add Anime (#111) to this set, Bsc One"));
      fireEvent.click(screen.getByText(/Save 2 sets/));
      const items = await itemsFromConfirm(onConfirm);

      const bscSet = items.find((i) => i.value === "Bsc One");
      expect(bscSet?.platformData.sportlots).toEqual(["111"]);
    });
  });

  describe("one marketplace set mapped by two NB sets", () => {
    const twoSets: Partial<ModalProps> = {
      existingRows: [
        { value: "Set A", platformData: { sportlots: ["111"] } },
        { value: "Set B", platformData: { sportlots: ["111"] } },
      ],
    };

    test("detaching it from both returns exactly ONE Pending copy", () => {
      renderModal(twoSets);
      // Mapped twice is still one marketplace set (it is not a twin of
      // itself); "Anime" is shared because 222 also carries it.
      expect(screen.getByLabelText("Remove Anime (#111) from Set A")).toBeTruthy();

      fireEvent.click(screen.getByLabelText("Remove Anime (#111) from Set A"));
      fireEvent.click(screen.getByLabelText("Remove Anime (#111) from Set B"));

      const labels = slOwnSetLabels().filter((l) => l?.includes("(#111)"));
      expect(labels).toEqual(["Make its own set: Anime (#111)"]);
    });

    test("disbanding both sets returns exactly ONE Pending copy", () => {
      renderModal(twoSets);

      fireEvent.click(screen.getByLabelText("Remove set Set A"));
      fireEvent.click(screen.getByLabelText("Remove set Set B"));

      const labels = slOwnSetLabels().filter((l) => l?.includes("(#111)"));
      expect(labels).toEqual(["Make its own set: Anime (#111)"]);
      expect(slOwnSetLabels()).toHaveLength(3);
    });
  });
});
