/**
 * NEO-294 — the operator's "move this set to another brand".
 *
 * What these pin is the control's contract with the operator, not its markup:
 * the brand list is not asked for until it is opened, the set's CURRENT brand
 * is never offered, the confirm names the destination and promises the cards
 * and marketplace links come along, a refusal lands inside the dialog rather
 * than closing it, and focus never falls to `<body>` when the list unmounts
 * from under it.
 *
 * Mocking strategy mirrors SetAttributesPanel.test.tsx: `convex/react`'s
 * `useQuery`/`useMutation` are module-mocked and routed by the string-mocked
 * query reference.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    brandView: {
      getBrandsForYearOfSet: "brandView.getBrandsForYearOfSet",
      moveSetToBrand: "brandView.moveSetToBrand",
    },
  },
}));

const mockMoveSetToBrand = vi.fn();
/** Every `useQuery` call this control makes, so "skip" can be asserted. */
const queryCalls: Array<{ query: string; args: unknown }> = [];
let currentBrands: unknown;

vi.mock("convex/react", () => ({
  useQuery: (query: string, args: unknown) => {
    queryCalls.push({ query, args });
    if (query === "brandView.getBrandsForYearOfSet") {
      return args === "skip" ? undefined : currentBrands;
    }
    return undefined;
  },
  useMutation: (mutation: string) =>
    mutation === "brandView.moveSetToBrand" ? mockMoveSetToBrand : vi.fn(),
}));

import MoveSetToBrandControl, {
  MOVE_SET_LABEL,
  MOVE_SET_PROMPT,
  moveClashRefusal,
} from "./MoveSetToBrandControl";

const SET_ID = "set-id" as never;

/** The server's order: Unknown leads, then the rest by name. */
const BRANDS = [
  { _id: "unknown-id", value: "Unknown", isCurrent: false },
  { _id: "bowman-id", value: "Bowman", isCurrent: false },
  { _id: "topps-id", value: "Topps", isCurrent: true },
];

const showToast = vi.fn();
const onMoved = vi.fn();

function renderControl() {
  return render(
    <MoveSetToBrandControl
      setId={SET_ID}
      setValue="2024 Topps Chrome"
      yearLabel="2024"
      showToast={showToast}
      onMoved={onMoved}
    />,
  );
}

/** The list container — the `<p>` prompt's own parent. */
function listContainer(): HTMLElement {
  return screen.getByText(MOVE_SET_PROMPT).parentElement as HTMLElement;
}

function openList() {
  fireEvent.click(screen.getByRole("button", { name: MOVE_SET_LABEL }));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryCalls.length = 0;
  currentBrands = BRANDS;
  mockMoveSetToBrand.mockResolvedValue({ movedTo: "Unknown" });
});

describe("MoveSetToBrandControl — the list", () => {
  it("does not ask for the year's brands until the list is opened", () => {
    renderControl();
    expect(
      queryCalls.filter(
        (c) => c.query === "brandView.getBrandsForYearOfSet" && c.args !== "skip",
      ),
    ).toHaveLength(0);
    expect(screen.queryByText(MOVE_SET_PROMPT)).toBeNull();

    openList();

    expect(
      queryCalls.some(
        (c) =>
          c.query === "brandView.getBrandsForYearOfSet" &&
          JSON.stringify(c.args) === JSON.stringify({ setId: SET_ID }),
      ),
    ).toBe(true);
  });

  it("offers every brand but the one the set is already under, in the server's order", () => {
    renderControl();
    openList();

    const list = screen.getByRole("group", { name: "Brands in 2024" });
    const names = within(list)
      .getAllByRole("button")
      .map((b) => b.textContent);
    // Unknown leads exactly as the Manufacturers column shows it, and the
    // current brand is not an option at all.
    expect(names).toEqual(["Unknown", "Bowman"]);
    expect(within(list).queryByText("Topps")).toBeNull();
  });

  it("names each option by what pressing it does", () => {
    renderControl();
    openList();
    expect(screen.getByLabelText("Move to Unknown")).toBeTruthy();
    expect(screen.getByLabelText("Move to Bowman")).toBeTruthy();
  });

  it("focuses the first brand when the list opens", async () => {
    renderControl();
    openList();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Move to Unknown")),
    );
  });

  it("says so while the brands are still arriving", () => {
    currentBrands = undefined;
    renderControl();
    openList();
    expect(screen.getByText("Finding this year's brands…")).toBeTruthy();
  });

  it("says the year has nowhere else to put it rather than showing an empty list", () => {
    currentBrands = [{ _id: "topps-id", value: "Topps", isCurrent: true }];
    renderControl();
    openList();
    expect(
      screen.getByText("This year has no other brand to move it to."),
    ).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("closes on Escape and puts focus back on the trigger", async () => {
    renderControl();
    openList();
    const trigger = screen.getByRole("button", { name: MOVE_SET_LABEL });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(screen.getByLabelText("Move to Unknown"), {
      key: "Escape",
    });

    expect(screen.queryByText(MOVE_SET_PROMPT)).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("is a disclosure — the same button closes the list it opened", () => {
    renderControl();
    openList();
    expect(screen.getByText(MOVE_SET_PROMPT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MOVE_SET_LABEL }));
    expect(screen.queryByText(MOVE_SET_PROMPT)).toBeNull();
  });
});

describe("MoveSetToBrandControl — the confirm", () => {
  it("names the destination and promises the cards and links come along", () => {
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Bowman"));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText('Move "2024 Topps Chrome" to Bowman?'),
    ).toBeTruthy();
    // The operator's real question, answered before they commit.
    expect(
      within(dialog).getByText(
        "The set keeps its cards, its variants and its marketplace links — only the brand above it changes. Sync Sets will leave it where you put it.",
      ),
    ).toBeTruthy();
    expect(mockMoveSetToBrand).not.toHaveBeenCalled();
  });

  it("cancelling leaves the list open and moves nothing", () => {
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Bowman"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(MOVE_SET_PROMPT)).toBeTruthy();
    expect(mockMoveSetToBrand).not.toHaveBeenCalled();
  });

  it("moves the set, toasts the destination the SERVER named, and parks focus on the trigger", async () => {
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Unknown"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));

    await waitFor(() =>
      expect(mockMoveSetToBrand).toHaveBeenCalledWith({
        setId: SET_ID,
        brandId: "unknown-id",
      }),
    );
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Moved to Unknown"));
    // Both the dialog and the list are gone — the question has been answered.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(MOVE_SET_PROMPT)).toBeNull();
    // The list was what focus was on; without the park it would be on <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: MOVE_SET_LABEL }),
      ),
    );
  });

  it("shows a name clash inside the dialog, names the set already there, and moves nothing", async () => {
    mockMoveSetToBrand.mockRejectedValue(
      new ConvexError({
        code: "SET_NAME_CLASH_AT_TARGET",
        existingId: "other-set",
        value: "topps chrome",
      }),
    );
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Bowman"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      'Bowman already has a set called "topps chrome" — nothing moved. Rename one of them first.',
    );
    // The refusal is where the question was asked: the dialog stays open, and
    // nothing is claimed in the panel's toast.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("falls back to a plain sentence for an error that carries no operator text", async () => {
    mockMoveSetToBrand.mockRejectedValue(new Error("Server Error"));
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Bowman"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not move this set");
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("MoveSetToBrandControl — the modal barrier (NEO-294 a11y)", () => {
  it("makes the brand list unreachable while the confirm is up, and reachable again after Cancel", () => {
    // The list stays MOUNTED behind the dialog so Cancel returns to the same
    // open list — but `aria-modal="true"` promises a screen reader that
    // nothing outside the dialog exists, and the Tab trap only holds for Tab.
    // A browse cursor would otherwise walk into a year's worth of brand
    // buttons that cannot be pressed.
    renderControl();
    openList();
    expect(listContainer().hasAttribute("inert")).toBe(false);

    fireEvent.click(screen.getByLabelText("Move to Bowman"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(listContainer().hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(MOVE_SET_PROMPT)).toBeTruthy();
    expect(listContainer().hasAttribute("inert")).toBe(false);
  });

  it("keeps the list unreachable while a refusal is being read inside the dialog", async () => {
    // A clash leaves the dialog open. The barrier has to hold for as long as
    // the dialog does, not just until the first round-trip finishes.
    mockMoveSetToBrand.mockRejectedValue(
      new ConvexError({ code: "SET_NAME_CLASH_AT_TARGET", value: "Chrome" }),
    );
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Bowman"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));

    await screen.findByRole("alert");
    expect(listContainer().hasAttribute("inert")).toBe(true);
  });

  it("cancelling hands focus back to the brand that was chosen", async () => {
    // Going inert blurs whatever was focused inside the list, so `ConfirmDialog`'s
    // own restore-on-close has nothing useful to go back to. Without the
    // hand-back a keyboard operator who changed their mind restarts at the top
    // of the document.
    renderControl();
    openList();
    const bowman = screen.getByLabelText("Move to Bowman");
    fireEvent.click(bowman);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Move to Bowman")),
    );
  });
});

describe("MoveSetToBrandControl — telling the owner where the set went", () => {
  it("reports the destination brand so the column can follow the set", async () => {
    // The Sets column is scoped to the brand the set just LEFT. Without this
    // the row silently disappears from an open column while the panel below
    // carries on describing it — a toast saying "Moved to Unknown" beside a
    // column that no longer lists the set is two different answers.
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Unknown"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));

    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("unknown-id"));
    // After the toast: the confirmation is the sentence, the re-point is the
    // evidence, and they arrive in that order.
    expect(showToast).toHaveBeenCalledWith("Moved to Unknown");
  });

  it("says nothing to the owner when the move was refused", async () => {
    mockMoveSetToBrand.mockRejectedValue(
      new ConvexError({ code: "SET_NAME_CLASH_AT_TARGET", value: "Chrome" }),
    );
    renderControl();
    openList();
    fireEvent.click(screen.getByLabelText("Move to Bowman"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));

    await screen.findByRole("alert");
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("works without an owner listening", async () => {
    // `onMoved` is optional: the panel renders this control at set level
    // wherever it mounts, and a caller that has no column to re-point is a
    // legitimate one.
    render(
      <MoveSetToBrandControl
        setId={SET_ID}
        setValue="2024 Topps Chrome"
        yearLabel="2024"
        showToast={showToast}
      />,
    );
    openList();
    fireEvent.click(screen.getByLabelText("Move to Unknown"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, move it" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Moved to Unknown"));
  });
});

describe("moveClashRefusal", () => {
  it("reads the refusal from `data`, never from the message", () => {
    expect(
      moveClashRefusal(
        new ConvexError({
          code: "SET_NAME_CLASH_AT_TARGET",
          existingId: "x",
          value: "Chrome",
        }),
        "Topps",
      ),
    ).toBe(
      'Topps already has a set called "Chrome" — nothing moved. Rename one of them first.',
    );
  });

  it("is null for anything that is not this refusal", () => {
    expect(moveClashRefusal(new Error("boom"), "Topps")).toBeNull();
    expect(
      moveClashRefusal(new ConvexError({ code: "PREFIX_TAKEN" }), "Topps"),
    ).toBeNull();
    expect(moveClashRefusal(null, "Topps")).toBeNull();
  });

  it("still says something useful when the server names no set", () => {
    expect(
      moveClashRefusal(
        new ConvexError({ code: "SET_NAME_CLASH_AT_TARGET" }),
        "Topps",
      ),
    ).toBe(
      'Topps already has a set called "a set of that name" — nothing moved. Rename one of them first.',
    );
  });
});
