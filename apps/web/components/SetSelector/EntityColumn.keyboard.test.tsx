/**
 * NEO-260 — the custom-entry form's buttons have to be tellable apart, and
 * Enter has to actually press them.
 *
 * ## The two defects this pins
 *
 * 1. **Same name, same class, two buttons.** The confirm-create step renders
 *    `Create` next to `Back`, both `NeonButton`s with an IDENTICAL class string
 *    (the neon colour is a `data-accent-color` attribute and an inline style,
 *    not a class). A screen-reader user heard "Create, button / Back, button"
 *    with nothing to say which column they were in; maestro-web's `pressKey`
 *    generated ONE XPath for both and Selenium returned the first, so Enter
 *    aimed at Create landed on Create only by luck of DOM order — the NEO-220
 *    shape. Each button now carries its own aria-label and its own
 *    `useFieldTestClass` marker class.
 *
 * 2. **Enter on a focused button did nothing.** A synthetic KeyboardEvent has
 *    no default action, so `pressKey: Enter` never clicked anything; the only
 *    reason the drills worked was the buffered-Enter replay from the still-
 *    focused input. Each button now handles Enter itself.
 *
 * ## What happy-dom can and cannot prove here
 *
 * It CAN prove the accessible names are distinct, that the class strings differ,
 * and that a synthetic `keydown` on each button runs THAT button's action
 * exactly once. It CANNOT reproduce maestro-web's XPath re-find — that lives in
 * the driver, not in the DOM — so this file is evidence the product is now
 * correct, not evidence the E2E symptom is gone. CI's flow run is that.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GenericId } from "convex/values";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OptionId = GenericId<"selectorOptions">;

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
      getAncestorChain: "getAncestorChain",
      findSelectorOptionElsewhere: "findSelectorOptionElsewhere",
    },
  },
}));

const mockAddCustom = vi.fn();
const mockFindElsewhere = vi.fn();
const state: { items: unknown; chain: unknown } = { items: [], chain: undefined };

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useConvex: () => ({ query: (...args: unknown[]) => mockFindElsewhere(...args) }),
  useQuery: (ref: string) =>
    ref === "getAncestorChain" ? state.chain : state.items,
}));

import EntityColumn from "./EntityColumn";

const MFR_ID = "mfr-topps-id" as unknown as OptionId;
const OTHER_MFR_ID = "mfr-allbrands-id" as unknown as OptionId;

const TOPPS_CHAIN = [
  { _id: "sport-id", level: "sport", value: "Baseball" },
  { _id: "year-id", level: "year", value: "2021" },
  { _id: MFR_ID, level: "manufacturer", value: "Topps" },
];

/** Non-empty so the column renders its idle buttons instead of auto-syncing. */
const EXISTING_ITEMS = [
  { _id: "set-existing-id" as unknown as OptionId, value: "Existing Set" },
];

const MATCH_ELSEWHERE = {
  _id: "set-bowman-under-allbrands" as unknown as OptionId,
  value: "Bowman Chrome",
  parentId: OTHER_MFR_ID,
  path: [
    { _id: "sport-id" as unknown as OptionId, level: "sport", value: "Baseball" },
    { _id: "year-id" as unknown as OptionId, level: "year", value: "2021" },
    { _id: OTHER_MFR_ID, level: "manufacturer", value: "All Brands" },
    {
      _id: "set-bowman-under-allbrands" as unknown as OptionId,
      level: "setName",
      value: "Bowman Chrome",
    },
  ],
};

function renderColumn(level: "sport" | "setName" = "setName") {
  return render(
    <EntityColumn
      selector={<div>selector</div>}
      renderForm={() => <div>form</div>}
      addButtonText={level === "sport" ? "Sync Sports" : "Sync Sets"}
      isVisible={true}
      level={level}
      parentId={level === "sport" ? undefined : MFR_ID}
      onDrillToExisting={vi.fn()}
    />,
  );
}

/** Opens "+ Custom", types `typed`, presses Enter on the INPUT once. */
async function typeAndSubmit(typed: string) {
  await act(async () => {
    fireEvent.click(screen.getByText("+ Custom"));
  });
  const input = screen.getByPlaceholderText(
    "Enter custom value...",
  ) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: typed } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  return input;
}

describe("EntityColumn — distinguishable buttons + real Enter (NEO-260)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = EXISTING_ITEMS;
    state.chain = TOPPS_CHAIN;
    mockAddCustom.mockResolvedValue("newly-created-id");
    mockFindElsewhere.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Accessible names
  // -------------------------------------------------------------------------

  it("names the input stage's buttons after the noun THIS column creates", async () => {
    renderColumn();
    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });

    expect(screen.getByLabelText("Add new set")).toBeTruthy();
    expect(screen.getByLabelText("Cancel new set")).toBeTruthy();
  });

  it("names the confirm-create pair 'Create set' / 'Back to set name'", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");

    const create = await screen.findByLabelText("Create set");
    const back = screen.getByLabelText("Back to set name");
    // WCAG 2.5.3 Label in Name: the visible words are inside the name.
    expect(create.textContent).toBe("Create");
    expect(back.textContent).toBe("Back");
  });

  it("uses the column's OWN noun, so two open columns never share a name", async () => {
    renderColumn("sport");
    await typeAndSubmit("Kabaddi");

    expect(await screen.findByLabelText("Create sport")).toBeTruthy();
    expect(screen.getByLabelText("Back to sport name")).toBeTruthy();
    expect(screen.queryByLabelText("Create set")).toBeNull();
  });

  it("names the exists-elsewhere trio, each containing its visible words", async () => {
    mockFindElsewhere.mockResolvedValue([MATCH_ELSEWHERE]);
    renderColumn();
    await typeAndSubmit("Bowman Chrome");

    const goTo = await screen.findByLabelText("Go to it — the existing set");
    const anyway = screen.getByLabelText("Create here anyway — a second set");
    expect(goTo.textContent).toBe("Go to it");
    expect(anyway.textContent).toBe("Create here anyway");
    expect(screen.getByLabelText("Back to set name")).toBeTruthy();
    // "Create set" must not also FIND the create-anyway button: Maestro matches
    // `id:` as an unanchored regex, so a shared substring is a live hazard.
    expect(anyway.getAttribute("aria-label")).not.toContain("Create set");
  });

  // -------------------------------------------------------------------------
  // 2. Distinct class strings — the XPath collapse
  // -------------------------------------------------------------------------

  it("gives the confirm pair DIFFERENT class strings", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");

    const create = await screen.findByLabelText("Create set");
    const back = screen.getByLabelText("Back to set name");
    expect(create.className).not.toBe(back.className);
  });

  it("uses a class and not a DOM id, so the aria-label stays the resource-id", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");

    const create = await screen.findByLabelText("Create set");
    const back = screen.getByLabelText("Back to set name");
    // Maestro's resource-id is `node.id || node.ariaLabel`; an id here would
    // shadow the label the flows and screen readers read.
    expect(create.getAttribute("id")).toBeNull();
    expect(back.getAttribute("id")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Enter actually presses the button it is aimed at
  // -------------------------------------------------------------------------

  it("Enter on the focused Create button creates, exactly once", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");
    const create = await screen.findByLabelText("Create set");

    // A synthetic keydown, which is all maestro-web's pressKey ever sends. No
    // click is dispatched; if the button did not handle Enter itself, nothing
    // at all would happen.
    await act(async () => {
      fireEvent.keyDown(create, { key: "Enter" });
    });

    await waitFor(() => {
      expect(mockAddCustom).toHaveBeenCalledTimes(1);
    });
    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "setName",
      value: "Bowman Chrome",
      parentId: MFR_ID,
    });
  });

  it("Enter on the focused Back button goes back, and writes nothing", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");
    const back = await screen.findByLabelText("Back to set name");

    await act(async () => {
      fireEvent.keyDown(back, { key: "Enter" });
    });

    // Back to the input stage with what was typed still there — Enter did what
    // the FOCUSED control does, not what the form's primary action does.
    const input = screen.getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;
    expect(input.value).toBe("Bowman Chrome");
    expect(mockAddCustom).not.toHaveBeenCalled();
  });

  it("Enter cancels its own event, so a real keypress cannot ALSO click", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");
    const create = await screen.findByLabelText("Create set");

    let prevented = false;
    await act(async () => {
      prevented = !fireEvent.keyDown(create, { key: "Enter", cancelable: true });
    });

    expect(prevented).toBe(true);
  });

  it("Enter on 'Go to it' drills, and on 'Create here anyway' duplicates deliberately", async () => {
    mockFindElsewhere.mockResolvedValue([MATCH_ELSEWHERE]);
    const onDrillToExisting = vi.fn();
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sets"
        isVisible={true}
        level="setName"
        parentId={MFR_ID}
        onDrillToExisting={onDrillToExisting}
      />,
    );
    await typeAndSubmit("Bowman Chrome");

    const anyway = await screen.findByLabelText(
      "Create here anyway — a second set",
    );
    await act(async () => {
      fireEvent.keyDown(anyway, { key: "Enter" });
    });
    await waitFor(() => {
      expect(mockAddCustom).toHaveBeenCalledWith({
        level: "setName",
        value: "Bowman Chrome",
        parentId: MFR_ID,
        allowDuplicateElsewhere: true,
      });
    });
    expect(onDrillToExisting).not.toHaveBeenCalled();
  });

  it("Enter on 'Add' submits the input stage without a mouse", async () => {
    renderColumn();
    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });
    const input = screen.getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Bowman Chrome" } });
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Add new set"), { key: "Enter" });
    });

    expect(await screen.findByLabelText("Create set")).toBeTruthy();
  });

  it("Enter on '+ Custom' opens the form — the whole path is reachable by key", async () => {
    renderColumn();

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Add custom Sets"), {
        key: "Enter",
      });
    });

    expect(screen.getByText("Add Custom Entry")).toBeTruthy();
    expect(screen.getByPlaceholderText("Enter custom value...")).toBeTruthy();
  });

  it("Space is left to the browser — it clicks on keyup, and we must not double it", async () => {
    renderColumn();
    await typeAndSubmit("Bowman Chrome");
    const create = await screen.findByLabelText("Create set");

    await act(async () => {
      fireEvent.keyDown(create, { key: " " });
    });

    expect(mockAddCustom).not.toHaveBeenCalled();
  });

  it("parks focus on the column once a create commits", async () => {
    const { container } = renderColumn();
    await typeAndSubmit("Bowman Chrome");
    const create = await screen.findByLabelText("Create set");

    await act(async () => {
      fireEvent.keyDown(create, { key: "Enter" });
    });
    await waitFor(() => {
      expect(screen.queryByText("Add Custom Entry")).toBeNull();
    });

    // The Create button unmounted with the form. Without the park, focus is on
    // <body> and the next Tab restarts from the top of the document.
    expect(document.activeElement).toBe(container.firstChild);
  });

  it("a disabled Create is not activatable by keyboard either", async () => {
    // Hold the mutation open so `creating` stays true after the first Enter.
    let release: ((v: unknown) => void) | undefined;
    mockAddCustom.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderColumn();
    await typeAndSubmit("Bowman Chrome");
    const create = await screen.findByLabelText("Create set");

    await act(async () => {
      fireEvent.keyDown(create, { key: "Enter" });
    });
    await act(async () => {
      fireEvent.keyDown(create, { key: "Enter" });
    });

    expect(mockAddCustom).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.("id");
    });
  });
});
