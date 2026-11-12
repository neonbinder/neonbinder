/**
 * NEO-496 (C1b) — Map Base Set offers the set's uploaded checklist beside BSC
 * and SportLots. A Base may be several sections ("Base" + "Base Rated
 * Prospects"), so the list picks any number; it pre-selects the Base's own
 * links, else the ONE section named base / base cards / base set, else
 * nothing. The form saves the picked sections only when they changed, and
 * never offers the list when the Base's own links did not come back.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setReconciliation: { fetchRawOptions: "fetchRawOptions" },
    selectorOptions: {
      setVariantTypePlatformData: "setVariantTypePlatformData",
      getAncestorChain: "getAncestorChain",
      getSelectorOptionById: "getSelectorOptionById",
      getSlotCardCounts: "getSlotCardCounts",
    },
    marketplaceWaits: { forRun: "marketplaceWaits.forRun" },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockSetPlatformData = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (ref: string) => (ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn()),
  useMutation: (ref: string) =>
    ref === "setVariantTypePlatformData" ? mockSetPlatformData : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getAncestorChain") {
      return [
        { _id: "sport-id", level: "sport", value: "Baseball" },
        { _id: "year-id", level: "year", value: "2026" },
        { _id: "mfr-id", level: "manufacturer", value: "Panini" },
        { _id: "set-id", level: "setName", value: "2026 Donruss", platformData: {} },
        { _id: "vt-base", level: "variantType", value: "Base" },
      ];
    }
    return undefined;
  },
}));

import BaseSetPicker, {
  preselectedChecklistKeys,
  type BaseChecklistSection,
} from "./BaseSetPicker";
import BaseMappingForm, { baseChecklistOf } from "./BaseMappingForm";

const BASE: BaseChecklistSection = { sectionKey: "base", name: "Base", rowCount: 200, kind: "base" };
const BASE_RP: BaseChecklistSection = {
  sectionKey: "base rated prospects",
  name: "Base Rated Prospects",
  rowCount: 50,
  kind: "base-child",
};
const BOMB: BaseChecklistSection = { sectionKey: "bomb squad", name: "Bomb Squad", rowCount: 10, kind: "other" };

type PickerProps = React.ComponentProps<typeof BaseSetPicker>;

function renderPicker(overrides: Partial<PickerProps> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <BaseSetPicker
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      slOptions={[]}
      bscOptions={[]}
      setName="2026 Donruss"
      manufacturer="Panini"
      loading={false}
      {...overrides}
    />,
  );
  return { onConfirm };
}

const option = (name: string) =>
  screen.getByRole("option", { name: `Checklist base section: ${name}` });

describe("preselectedChecklistKeys", () => {
  it("the Base's own links win", () => {
    expect(preselectedChecklistKeys([BASE, BASE_RP], ["base rated prospects"])).toEqual([
      "base rated prospects",
    ]);
  });
  it("else the one section classified base", () => {
    expect(preselectedChecklistKeys([BASE, BASE_RP, BOMB], [])).toEqual(["base"]);
  });
  it("two named base, or none: nothing", () => {
    expect(
      preselectedChecklistKeys([BASE, { ...BOMB, kind: "base", sectionKey: "base set" }], []),
    ).toEqual([]);
    expect(preselectedChecklistKeys([BOMB], [])).toEqual([]);
  });
});

describe("BaseSetPicker — checklist list", () => {
  it("no checklist: no list, and the copy names only the marketplaces", () => {
    renderPicker({ slOptions: [{ value: "2026 Donruss", platformValue: "1" }] });
    expect(screen.queryByText("Checklist base")).toBeNull();
    expect(
      screen.getByText(/^Choose the SportLots and BSC sets that hold/),
    ).toBeTruthy();
  });

  it("pre-selects the base section and lists its runs; Show all reveals the rest", () => {
    renderPicker({ checklist: { sections: [BASE, BASE_RP, BOMB], linkedKeys: [] } });
    expect(screen.getByRole("listbox", { name: "Checklist base" }).getAttribute("aria-multiselectable")).toBe("true");
    expect(option("Base").getAttribute("aria-selected")).toBe("true");
    expect(option("Base Rated Prospects").getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("option", { name: "Checklist base section: Bomb Squad" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Show all checklist sections"));
    expect(option("Bomb Squad")).toBeTruthy();
  });

  it("picks several sections and confirms them with no marketplace pick", async () => {
    const { onConfirm } = renderPicker({
      checklist: { sections: [BASE, BASE_RP], linkedKeys: [] },
    });
    fireEvent.click(option("Base Rated Prospects"));
    expect(option("Base Rated Prospects").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Base Set" }));
    });
    expect(onConfirm).toHaveBeenCalledWith({
      sl: undefined,
      bsc: undefined,
      checklistSectionKeys: ["base", "base rated prospects"],
    });
  });

  it("Space toggles a section off; with nothing picked Confirm is off", () => {
    renderPicker({ checklist: { sections: [BASE], linkedKeys: [] } });
    fireEvent.keyDown(option("Base"), { key: " " });
    expect(option("Base").getAttribute("aria-selected")).toBe("false");
    expect(
      (screen.getByRole("button", { name: "Confirm Base Set" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText("Pick a SportLots or BSC set, or a checklist section, to continue."),
    ).toBeTruthy();
  });

  it("Enter on a section ticks it and confirms", async () => {
    const { onConfirm } = renderPicker({
      checklist: { sections: [BASE, BASE_RP], linkedKeys: ["base"] },
    });
    await act(async () => {
      fireEvent.keyDown(option("Base Rated Prospects"), { key: "Enter" });
    });
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ checklistSectionKeys: ["base", "base rated prospects"] }),
    );
  });
});

describe("baseChecklistOf", () => {
  const checklist = {
    sections: [BASE_RP as BaseChecklistSection & { sectionKey: string; name: string }],
    rowLinks: [{ rowId: "vt-base", sections: [{ sectionKey: "base", name: "Base" }] }],
  };
  it("lists the Base's own sections first, then the free ones", () => {
    expect(baseChecklistOf(checklist, "vt-base")).toEqual({
      sections: [{ sectionKey: "base", name: "Base" }, BASE_RP],
      linkedKeys: ["base"],
    });
  });
  it("offers nothing when the Base's links did not come back", () => {
    expect(baseChecklistOf({ sections: [BASE] }, "vt-base")).toBeNull();
  });
});

describe("BaseMappingForm — saving the checklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetPlatformData.mockResolvedValue(undefined);
  });

  function result(rowLinks: Array<{ rowId: string; sections: Array<{ sectionKey: string; name: string }> }>) {
    return {
      success: true,
      bscOptions: [],
      slOptions: [],
      errors: [],
      checklist: {
        checklistId: "pc1",
        baseSectionNames: [],
        sections: [BASE, BASE_RP].filter(
          (s) => !rowLinks.some((r) => r.sections.some((l) => l.sectionKey === s.sectionKey)),
        ),
        rowLinks,
        matches: [],
        candidates: [],
        unmatchedSectionKeys: [],
      },
    };
  }

  async function openForm() {
    const onClose = vi.fn();
    render(
      <BaseMappingForm
        variantTypeId={"vt-base" as unknown as Parameters<typeof BaseMappingForm>[0]["variantTypeId"]}
        autoOpen
        mode="initial"
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(screen.getByText("Checklist base")).toBeTruthy());
    await act(async () => {});
    return { onClose };
  }

  it("a checklist alone opens the picker and saves the preselected base section", async () => {
    mockFetchRawOptions.mockResolvedValue(result([]));
    const { onClose } = await openForm();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Base Set" }));
    });
    expect(mockSetPlatformData).toHaveBeenCalledWith(
      expect.objectContaining({ platformData: {}, checklistSectionKeys: ["base"] }),
    );
    expect(onClose).toHaveBeenCalledWith("mapped");
  });

  it("the Base's links unchanged: nothing written, the Base is mapped", async () => {
    mockFetchRawOptions.mockResolvedValue(
      result([{ rowId: "vt-base", sections: [{ sectionKey: "base", name: "Base" }] }]),
    );
    const { onClose } = await openForm();
    expect(option("Base").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Base Set" }));
    });
    expect(mockSetPlatformData).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("mapped");
  });

  it("adding a run to the Base sends every key it will hold", async () => {
    mockFetchRawOptions.mockResolvedValue(
      result([{ rowId: "vt-base", sections: [{ sectionKey: "base", name: "Base" }] }]),
    );
    await openForm();
    fireEvent.click(option("Base Rated Prospects"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Base Set" }));
    });
    expect(mockSetPlatformData).toHaveBeenCalledWith(
      expect.objectContaining({ checklistSectionKeys: ["base", "base rated prospects"] }),
    );
  });
});
