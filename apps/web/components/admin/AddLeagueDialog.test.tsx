/**
 * NEO-240 (review follow-up) — the modal Team Management adds a league in.
 *
 * A dialog's contract is almost entirely invisible when it breaks. It renders,
 * it looks right, and the failure is that a keyboard user cannot get into it,
 * cannot get out of it, or is dropped on `<body>` when it closes — none of
 * which a screenshot or an eyeball ever catches. So what is asserted here is
 * the contract rather than the appearance:
 *
 *  - It is announced as a dialog, and NAMED by its own heading.
 *  - Focus goes in, and comes back to the control that opened it.
 *  - Escape, Cancel and the scrim all close it, and none of them decides
 *    anything on the way out.
 *  - Creating, and picking a near match instead, both report and close.
 *  - A failure is readable WHERE IT HAPPENED — the host's status line is behind
 *    the scrim at that moment.
 *
 * The form inside it is covered by `AddLeagueForm.test.tsx`; this file only
 * ever touches the form to make something happen to the dialog.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    leagues: {
      createByAdmin: "leagues.createByAdmin",
      nearMatches: "leagues.nearMatches",
    },
    selectorOptions: {
      getSelectorOptions: "selectorOptions.getSelectorOptions",
    },
  },
}));

const mockCreateByAdmin = vi.fn();
let sports: unknown;
let nearMatches: unknown;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "selectorOptions.getSelectorOptions") return sports;
    if (ref === "leagues.nearMatches") return nearMatches;
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "leagues.createByAdmin" ? mockCreateByAdmin : vi.fn(),
  useAction: () => vi.fn(),
}));

import { AddLeagueDialog } from "./AddLeagueDialog";

const SPORTS = [
  { _id: "sport-baseball", _creationTime: 1, level: "sport", value: "Baseball" },
  { _id: "sport-hockey", _creationTime: 1, level: "sport", value: "Hockey" },
];

const onSelect = vi.fn();
const onClose = vi.fn();
const onStatus = vi.fn();

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof AddLeagueDialog>> = {},
) {
  return render(
    <AddLeagueDialog
      sportId={"sport-baseball" as never}
      onSelect={onSelect}
      onClose={onClose}
      onStatus={onStatus}
      {...overrides}
    />,
  );
}

const dialog = () => screen.getByRole("dialog");
const nameField = () => screen.getByLabelText("New league name");

beforeEach(() => {
  vi.clearAllMocks();
  sports = SPORTS;
  nearMatches = undefined;
  mockCreateByAdmin.mockResolvedValue({ id: "lg-npb", created: true });
});

describe("AddLeagueDialog — how it is announced", () => {
  it("is a modal dialog named by its own heading", () => {
    renderDialog();

    const el = dialog();
    expect(el.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", {
      level: 3,
      name: "Add a league",
    });
    // Named BY the heading rather than by a duplicated aria-label: two strings
    // saying the same thing is two strings that can drift apart.
    expect(el.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.id).toBeTruthy();
  });

  it("names the team's sport, once it knows it", () => {
    renderDialog();
    expect(screen.getByText("Sport: Baseball")).toBeTruthy();
  });

  it("says nothing rather than 'unknown' while the sports are loading", () => {
    // "unknown" is an answer. A dialog that flashes the wrong answer and then
    // corrects itself is worse than one that visibly has not answered yet.
    sports = undefined;
    renderDialog();
    expect(screen.getByText("Sport: …")).toBeTruthy();
  });
});

describe("AddLeagueDialog — focus", () => {
  it("opens on the first field, ready to type", () => {
    renderDialog();
    expect(document.activeElement).toBe(nameField());
  });

  it("keeps Tab inside the dialog", () => {
    // `aria-modal="true"` PROMISES this. Without the trap, Tab from the last
    // control walks into the team form behind the scrim, which the operator
    // cannot see and a screen reader will happily read out.
    renderDialog();

    const focusable = Array.from(
      dialog().querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("hands focus back to the control that opened it", () => {
    // React does not move focus when it unmounts a focused node — it leaves it
    // on <body>, so the next Tab restarts at the top of the page.
    const select = document.createElement("select");
    document.body.appendChild(select);
    const returnFocusTo = createRef<HTMLElement>();
    (returnFocusTo as { current: HTMLElement | null }).current = select;

    renderDialog({ returnFocusTo });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(select);
    select.remove();
  });

  it("falls back to whatever had focus when no target was named", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    renderDialog();
    fireEvent.keyDown(dialog(), { key: "Escape" });

    expect(document.activeElement).toBe(button);
    button.remove();
  });
});

describe("AddLeagueDialog — the ways out", () => {
  it.each([
    ["Escape", () => fireEvent.keyDown(dialog(), { key: "Escape" })],
    [
      "Cancel",
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    ["the scrim", () => fireEvent.click(dialog())],
  ])("closes on %s without deciding anything", (_label, dismiss) => {
    renderDialog();
    // Something half-typed, so a dismissal that quietly created it would show.
    fireEvent.change(nameField(), { target: { value: "Nippon Pro" } });

    dismiss();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
  });

  it("does not close on a click inside the panel", () => {
    // The scrim and the panel are one element tree; without the stop, every
    // click on a field would dismiss the dialog under the operator's hand.
    renderDialog();
    fireEvent.click(nameField());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses Escape and the scrim while a create is in flight", async () => {
    // Not to defend a draft — there is nothing here worth a confirm. Closing
    // over the round trip drops the result on an unmounted host, and the league
    // lands in the table having never been shown to anyone.
    let release: (() => void) | undefined;
    mockCreateByAdmin.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ id: "lg-npb", created: true });
      }),
    );

    renderDialog();
    fireEvent.change(nameField(), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );
    await screen.findByLabelText("Adding league");

    fireEvent.keyDown(dialog(), { key: "Escape" });
    fireEvent.click(dialog());
    expect(onClose).not.toHaveBeenCalled();

    release?.();
    await waitFor(() => expect(onSelect).toHaveBeenCalled());
  });
});

describe("AddLeagueDialog — finishing", () => {
  it("reports the new league and closes", async () => {
    renderDialog();
    fireEvent.change(nameField(), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({
        id: "lg-npb",
        created: true,
        name: "Nippon Professional Baseball",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("reports a near-match pick and closes, without creating a duplicate", async () => {
    // The guard the inline fields never had: an operator typing a second
    // spelling of a league that already exists is offered the row instead.
    nearMatches = [
      {
        _id: "lg-npb",
        name: "Nippon Professional Baseball",
        confidence: "close",
      },
    ];
    renderDialog();
    fireEvent.change(nameField(), { target: { value: "Nippon Pro Baseball" } });

    fireEvent.click(
      await screen.findByLabelText("Open Nippon Professional Baseball"),
    );

    expect(onSelect).toHaveBeenCalledWith({
      id: "lg-npb",
      created: false,
      name: "Nippon Professional Baseball",
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
  });

  it("shows a failure inside the dialog, and forwards it to the host", async () => {
    // Inside, because the host's status line is behind the scrim at the moment
    // this appears. Forwarded as well, because the SUCCESS line is only ever
    // read after the dialog is gone, and one channel has to carry both.
    // A ConvexError, not a plain Error: `userFacingMessage` shows only what a
    // ConvexError deliberately carried, because production redacts the rest.
    mockCreateByAdmin.mockRejectedValue(new ConvexError("Convex is down"));
    renderDialog();
    fireEvent.change(nameField(), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Convex is down");
    expect(dialog().contains(alert)).toBe(true);
    expect(onStatus).toHaveBeenCalledWith({
      text: "Convex is down",
      isError: true,
    });
    // A failed create leaves the operator where they were, with what they typed.
    expect(onClose).not.toHaveBeenCalled();
  });
});
