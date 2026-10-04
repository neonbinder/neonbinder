/**
 * NEO-224 — where focus goes as the set builder's cascade moves, and the
 * restore notice.
 *
 * The cascade, not each column, decides where focus lands (one effect keyed on
 * the deepest OPEN column), so these tests drive the real SetSelector and
 * stand in for everything below it: every column selector is a `Stub` that
 * renders what the real EntitySelector's contract promises — exactly one
 * `role="combobox"` while the column is open, a collapsed
 * `aria-expanded="false"` chip once it has a selection — plus a `pick-<level>`
 * button wired to the REAL select handler. The drill is the real
 * `useDrillUrlState` under a real `MemoryRouter`; only `resolveDrillPath` is
 * mocked (every id valid unless a test says otherwise).
 *
 * `fireEvent.click` does not move focus, so a test's starting focus is
 * whatever the cascade (or the test) put there: that is the honest model of a
 * keyboard operator whose focus stays where it was when the row they picked
 * is replaced.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      getCardChecklist: "getCardChecklist",
    },
    parallelChecklistBuild: { getParallelsForBuild: "getParallelsForBuild" },
    drillPath: { resolveDrillPath: "resolveDrillPath" },
  },
}));

/** What the page's queries answer; tests reassign `cards`. */
const world: {
  cards: unknown[] | undefined;
  /** What `getAncestorChain` answers: where a parallel's source name comes from. */
  chain: Array<{ _id: string; value: string }> | undefined;
  resolver: (ids: string[]) => Array<{ _id: string }>;
  /** The id each `pick-<level>` button hands the real handler. */
  picks: Record<string, string>;
  /**
   * True while the checklist has not drawn its Fetch button yet, so the D3
   * rule is left waiting on the DOM (its MutationObserver) rather than on a
   * re-run of its effect.
   */
  fetchHidden: boolean;
  /**
   * A level whose collapsed column still holds a search box: stands in for
   * focus sitting in a column's own combobox while D3 is pending.
   */
  lingering: string | null;
} = {
  cards: [],
  chain: [],
  resolver: (ids) => ids.map((_id) => ({ _id })),
  picks: {},
  fetchHidden: false,
  lingering: null,
};

const ROWS: Record<string, unknown> = {
  "vt-base": { _id: "vt-base", value: "Base", metadata: { isBase: true }, platformData: {} },
  "vt-base-2": { _id: "vt-base-2", value: "Base", metadata: { isBase: true }, platformData: {} },
  "vt-insert": {
    _id: "vt-insert",
    value: "Insert",
    metadata: { variantRole: "insert" },
    platformData: {},
  },
};

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "resolveDrillPath") {
      return world.resolver((args as { ids: string[] }).ids);
    }
    if (ref === "getSelectorOptionById") {
      return ROWS[(args as { id: string }).id];
    }
    if (ref === "getAncestorChain") return world.chain;
    if (ref === "getCardChecklist") return world.cards;
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("../../convex/bscFacets", () => ({
  bscSourceView: () => ({ sources: [] }),
}));

// A column is on the page only when it is visible, like the real one.
vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({
    selector,
    isVisible,
  }: {
    selector: React.ReactNode;
    isVisible?: boolean;
  }) => (isVisible === false ? null : <div>{selector}</div>),
}));

/** Declared at module scope, referenced only at render time by the mocks below. */
function Stub({ level, ...props }: { level: string } & Record<string, unknown>) {
  const entries = Object.entries(props);
  const selected = entries.find(([k]) => k.startsWith("selected"))?.[1];
  const onSelect = entries.find(([k]) => /^on\w+Select$/.test(k))?.[1] as
    | ((id: string, parent?: string) => void)
    | undefined;
  const expanded = props.expanded as boolean;
  const setExpanded = props.setExpanded as ((v: boolean) => void) | undefined;
  const open = !selected || expanded;
  return (
    <div>
      {open ? (
        <input
          role="combobox"
          aria-label={`${level} search`}
          // Enter commits, as the real combobox does with a highlighted row.
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            onSelect?.(world.picks[level] ?? `${level}-1`);
            setExpanded?.(false);
          }}
        />
      ) : (
        <button aria-expanded="false" onClick={() => setExpanded?.(true)}>
          {`${level} chip`}
        </button>
      )}
      <button
        onClick={() => {
          onSelect?.(world.picks[level] ?? `${level}-1`);
          setExpanded?.(false);
        }}
      >
        {`pick-${level}`}
      </button>
      <button onClick={() => setExpanded?.(false)}>{`collapse-${level}`}</button>
      {/* The "+ Custom" entry's text field, which lives in the column row. */}
      <input type="text" aria-label={`${level} custom value`} />
      {!open && world.lingering === level ? (
        <input role="combobox" aria-label={`${level} lingering search`} />
      ) : null}
    </div>
  );
}

vi.mock("../SetSelector/SportSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="sport" {...p} />,
}));
vi.mock("../SetSelector/YearSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="year" {...p} />,
}));
vi.mock("../SetSelector/ManufacturerSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="manufacturer" {...p} />,
}));
vi.mock("../SetSelector/SetSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="set" {...p} />,
}));
vi.mock("../SetSelector/SetVariantSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="type" {...p} />,
}));
vi.mock("../SetSelector/VariantSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="insert" {...p} />,
}));
vi.mock("../SetSelector/ParallelSelector", () => ({
  default: (p: Record<string, unknown>) => <Stub level="parallel" {...p} />,
}));

vi.mock("../SetSelector/YearForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetVariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/VariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelForm", () => ({ default: () => null }));
vi.mock("../SetSelector/BaseMappingForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelGroupingModal", () => ({ default: () => null }));
vi.mock("../SetSelector/MultiSourcePanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SportForm", () => ({ SportForm: () => null }));

// The D3 landing spots, with the accessible names their owners give them.
// With cards the real checklist's header carries a SECOND "Sync card
// checklist" button, so the stub does too: landing on the attributes panel
// must beat it. A parallel's empty checklist holds ParallelBuildButton, whose
// visible text is its name, or its "Loading…" stand-in until the source's
// name is known.
vi.mock("../SetSelector/CardChecklist", () => ({
  default: ({
    parallelBuild,
  }: {
    parallelBuild?: { role?: string; sourceValue?: string };
  }) => (
    <div>
      {world.cards?.length === 0 &&
      parallelBuild?.role !== "parallel" &&
      !world.fetchHidden ? (
        <button aria-label="Sync card checklist">Fetch from Marketplaces</button>
      ) : null}
      {world.cards?.length === 0 && parallelBuild?.role === "parallel" ? (
        parallelBuild.sourceValue ? (
          <button>
            <span>{`Build from ${parallelBuild.sourceValue}`}</span>
          </button>
        ) : (
          <button aria-disabled="true">Loading…</button>
        )
      ) : null}
      {world.cards && world.cards.length > 0 ? (
        <button aria-label="Sync card checklist">Fetch again</button>
      ) : null}
    </div>
  ),
}));
vi.mock("../SetSelector/SetAttributesPanel", () => ({
  default: () => (
    <div role="region" aria-label="Set attributes panel">
      <button aria-label="Edit attributes">Edit attributes</button>
    </div>
  ),
}));

import SetSelector from "./SetSelector";

let navigateRef: ((to: number | string) => void) | null = null;
function NavProbe() {
  const navigate = useNavigate();
  React.useEffect(() => {
    navigateRef = (to) => navigate(to as never);
  });
  return null;
}

const at = (initial: string) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initial]}>
        <NavProbe />
        {children}
      </MemoryRouter>
    );
  };

const mount = (initial = "/") => render(<SetSelector />, { wrapper: at(initial) });
const combobox = (level: string) => screen.getByRole("combobox", { name: `${level} search` });
const pick = async (level: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText(`pick-${level}`));
  });
};
const focused = () => document.activeElement as HTMLElement;
const goBack = () => act(async () => navigateRef!(-1));

/**
 * The page's one polite region, found the way a screen reader finds it.
 * Scoped to OUTSIDE the column row: each real column carries its own sr-only
 * filter-count region beside its search box (NEO-224), which is a different
 * region with a different job.
 */
function liveRegion(): HTMLElement {
  const regions = screen
    .getAllByRole("status")
    .filter(
      (el) =>
        el.className.includes("sr-only") &&
        !el.closest("[data-set-selector-scroll]"),
    );
  expect(regions).toHaveLength(1);
  return regions[0];
}

/** Pick sport > year > brand > set > Base: a terminal selection. */
async function drillToBase(typeId = "vt-base") {
  world.picks.type = typeId;
  await pick("sport");
  await pick("year");
  await pick("manufacturer");
  await pick("set");
  await pick("type");
}

beforeEach(() => {
  world.cards = [];
  world.chain = [];
  world.resolver = (ids) => ids.map((_id) => ({ _id }));
  world.picks = {};
  world.fetchHidden = false;
  world.lingering = null;
  navigateRef = null;
});

afterEach(() => {
  document.querySelectorAll("[data-test-outside]").forEach((el) => el.remove());
});

describe("SetSelector focus — the cascade (NEO-224)", () => {
  it("on mount, focus lands in the Sports combobox", () => {
    mount();
    expect(focused()).toBe(combobox("sport"));
  });

  it("after a pick, focus is in the new deepest column's combobox", async () => {
    mount();
    await pick("sport");
    expect(focused()).toBe(combobox("year"));
    await pick("year");
    expect(focused()).toBe(combobox("manufacturer"));
    await pick("manufacturer");
    expect(focused()).toBe(combobox("set"));
  });

  it("a restored deep link lands in the deepest open column", async () => {
    mount("/?sport=sp&year=yr&brand=br");
    expect(focused()).toBe(combobox("set"));
  });

  it("a restored link that the server cuts short lands in the deepest column that survived", async () => {
    world.resolver = (ids) => ids.slice(0, 2).map((_id) => ({ _id }));
    mount("/?sport=sp&year=yr&brand=gone");
    await act(async () => {});
    expect(focused()).toBe(combobox("manufacturer"));
  });

  it("Back (popstate) lands in the deepest open column of the restored selection", async () => {
    mount();
    await pick("sport");
    await pick("year");
    await pick("manufacturer");
    expect(focused()).toBe(combobox("set"));

    await goBack();
    expect(focused()).toBe(combobox("manufacturer"));
    await goBack();
    expect(focused()).toBe(combobox("year"));
  });

  it("Forward lands in the deepest column too", async () => {
    mount();
    await pick("sport");
    await pick("year");
    await goBack();
    expect(focused()).toBe(combobox("year"));

    await act(async () => navigateRef!(1));
    expect(focused()).toBe(combobox("manufacturer"));
  });

  it("a re-render that opens no new column moves nothing", async () => {
    const view = mount();
    await pick("sport");
    const box = combobox("year");
    box.blur();
    // Focus is on <body>; nothing about the cascade changed, so nothing is taken.
    view.rerender(<SetSelector />);
    expect(focused()).toBe(document.body);
  });
});

describe("SetSelector focus — never taken from where it belongs", () => {
  it("is not taken from a dialog the operator is in", async () => {
    mount();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-outside", "");
    const inside = document.createElement("button");
    inside.textContent = "inside dialog";
    dialog.appendChild(inside);
    document.body.appendChild(dialog);
    inside.focus();

    await pick("sport");

    expect(focused()).toBe(inside);
  });

  it("is not taken in the frame before a dialog has claimed focus (a dialog is up, <body> holds focus)", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("data-test-outside", "");
    document.body.appendChild(dialog);
    mount();
    // Mounted under a dialog: even the first focus is not the cascade's to take.
    expect(focused()).toBe(document.body);

    await pick("sport");
    expect(focused()).toBe(document.body);
  });

  it("is not taken from a control outside the column row (the checklist)", async () => {
    mount();
    const outside = document.createElement("button");
    outside.textContent = "outside";
    outside.setAttribute("data-test-outside", "");
    document.body.appendChild(outside);
    outside.focus();

    await pick("sport");

    expect(focused()).toBe(outside);
  });

  it("is not taken from a collapsed chip the operator focused (Escape/Collapse parks it there)", async () => {
    mount();
    await pick("sport");
    await pick("year");
    const chip = screen.getByRole("button", { name: "sport chip" });
    chip.focus();
    expect(focused()).toBe(chip);

    await pick("manufacturer");

    expect(focused()).toBe(chip);
  });

  it("a non-chip control inside the row IS handed on to the new column", async () => {
    mount();
    const collapse = screen.getByText("collapse-sport");
    collapse.focus();
    await pick("sport");
    expect(focused()).toBe(combobox("year"));
  });
});

describe("SetSelector focus — a terminal selection (D3)", () => {
  it("Base with zero cards focuses the Sync card checklist button", async () => {
    world.cards = [];
    mount();
    await drillToBase();

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
  });

  it("Base with cards focuses the attributes panel's Edit attributes button, not Sync", async () => {
    world.cards = [{ _id: "c1" }];
    mount();
    await drillToBase();

    expect(focused()).toBe(screen.getByRole("button", { name: "Edit attributes" }));
  });

  it("waits for the cards to load before choosing a target", async () => {
    world.cards = undefined;
    const view = mount();
    await drillToBase();
    // Nothing is chosen yet: still on the last place the cascade put it.
    expect(focused().getAttribute("aria-label")).not.toBe("Sync card checklist");
    expect(focused().getAttribute("aria-label")).not.toBe("Edit attributes");

    world.cards = [];
    await act(async () => view.rerender(<SetSelector />));
    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
  });

  /** Pick down to a leaf parallel under the insert `insert-1`. */
  async function drillToLeafParallel() {
    world.picks.type = "vt-insert";
    await pick("sport");
    await pick("year");
    await pick("manufacturer");
    await pick("set");
    await pick("type");
    await pick("insert");
    await pick("parallel");
  }

  it("a leaf parallel with no cards focuses its Build from <insert> button (Jason, 2026-10-04)", async () => {
    world.cards = [];
    world.chain = [{ _id: "insert-1", value: "Anime" }];
    mount();
    await drillToLeafParallel();

    expect(focused()).toBe(screen.getByRole("button", { name: "Build from Anime" }));
  });

  it("waits for the insert's name: the Loading… stand-in is never the target", async () => {
    world.cards = [];
    world.chain = undefined; // the ancestor chain has not answered
    const view = mount();
    await drillToLeafParallel();
    expect(focused()).not.toBe(screen.getByRole("button", { name: "Loading…" }));
    expect(focused().getAttribute("aria-label")).not.toBe("Edit attributes");

    world.chain = [{ _id: "insert-1", value: "Anime" }];
    await act(async () => view.rerender(<SetSelector />));
    expect(focused()).toBe(screen.getByRole("button", { name: "Build from Anime" }));
  });

  it("a leaf parallel with no source name to build from falls back to the attributes panel", async () => {
    world.cards = [];
    world.chain = []; // answered, and the insert is not in it
    mount();
    await drillToLeafParallel();

    expect(focused()).toBe(screen.getByRole("button", { name: "Edit attributes" }));
  });

  it("a leaf parallel WITH cards focuses the attributes panel, not Build", async () => {
    world.cards = [{ _id: "c1" }];
    world.chain = [{ _id: "insert-1", value: "Anime" }];
    mount();
    await drillToLeafParallel();

    expect(focused()).toBe(screen.getByRole("button", { name: "Edit attributes" }));
  });

  it("fires once per selection: collapsing a column afterwards does not pull focus back", async () => {
    world.cards = [];
    mount();
    await drillToBase();
    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));

    // Re-open the Variant Types chip (focus follows into its combobox), then
    // collapse it again with the same selection.
    // (A real press focuses the chip first; fireEvent does not.)
    const chip = screen.getByRole("button", { name: "type chip" });
    chip.focus();
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(focused()).toBe(combobox("type"));
    const collapse = screen.getByText("collapse-type");
    collapse.focus();
    await act(async () => {
      fireEvent.click(collapse);
    });

    expect(focused()).toBe(collapse);
    expect(focused()).not.toBe(screen.getByRole("button", { name: "Sync card checklist" }));
  });

  it("a NEW selection re-arms it", async () => {
    world.cards = [];
    mount();
    await drillToBase("vt-base");
    const collapse = screen.getByText("collapse-type");
    collapse.focus();
    expect(focused()).toBe(collapse);

    world.picks.type = "vt-base-2";
    await pick("type");

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
  });

  it("is not taken from a dialog (the Base mapping picker auto-opens on an unmapped Base)", async () => {
    world.cards = [];
    mount();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-outside", "");
    const inside = document.createElement("button");
    dialog.appendChild(inside);
    document.body.appendChild(dialog);
    inside.focus();

    await drillToBase();

    expect(focused()).toBe(inside);
  });

  it("is not taken while a dialog is up and <body> holds focus (the frame before the picker takes it)", async () => {
    world.cards = [];
    mount();
    await pick("sport");
    await pick("year");
    await pick("manufacturer");
    await pick("set");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-outside", "");
    document.body.appendChild(dialog);
    (focused() as HTMLElement).blur();
    expect(focused()).toBe(document.body);

    world.picks.type = "vt-base";
    await pick("type");

    expect(focused()).toBe(document.body);
  });

  it("is not taken from outside the cascade row", async () => {
    world.cards = [];
    mount();
    await pick("sport");
    await pick("year");
    await pick("manufacturer");
    await pick("set");
    const outside = document.createElement("button");
    outside.setAttribute("data-test-outside", "");
    document.body.appendChild(outside);
    outside.focus();

    world.picks.type = "vt-base";
    await pick("type");

    expect(focused()).toBe(outside);
  });
});

/**
 * NEO-224 fix round 2 — the cascade never takes focus from a field the
 * operator is typing into. The "+ Custom" entry lives in the column row, so
 * "inside the row" alone is not enough: a D3 target landing mid-word used to
 * pull focus to Fetch from Marketplaces, and the next Enter fetched.
 */
describe("SetSelector focus — never taken from a field being typed into", () => {
  const customInput = (level: string) =>
    screen.getByRole("textbox", { name: `${level} custom value` });
  const typeInto = (el: HTMLElement, value: string) => {
    el.focus();
    fireEvent.change(el, { target: { value } });
  };

  it("D3 waiting on the cards: typing in + Custom keeps focus there when they arrive", async () => {
    world.cards = undefined;
    const view = mount();
    await drillToBase();
    const field = customInput("type");
    typeInto(field, "Chrome Ref");

    world.cards = [];
    await act(async () => view.rerender(<SetSelector />));

    expect(focused()).toBe(field);
    expect(screen.getByRole("button", { name: "Sync card checklist" })).not.toBe(focused());
  });

  it("D3 waiting on the DOM: typing in + Custom keeps focus there when Fetch appears", async () => {
    world.cards = [];
    world.fetchHidden = true;
    const view = mount();
    await drillToBase();
    // The rule found no target and is watching the page for one.
    expect(screen.queryByRole("button", { name: "Sync card checklist" })).toBeNull();
    const field = customInput("type");
    typeInto(field, "Chrome Ref");

    world.fetchHidden = false;
    await act(async () => view.rerender(<SetSelector />));

    expect(screen.getByRole("button", { name: "Sync card checklist" })).toBeTruthy();
    expect(focused()).toBe(field);
  });

  it("D3 waiting on the DOM: focus in a column's own combobox still moves to Fetch", async () => {
    world.cards = [];
    world.fetchHidden = true;
    world.lingering = "type";
    const view = mount();
    await drillToBase();
    const box = screen.getByRole("combobox", { name: "type lingering search" });
    typeInto(box, "Bas");

    world.fetchHidden = false;
    await act(async () => view.rerender(<SetSelector />));

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
  });

  it("a new deepest column does not take focus from + Custom", async () => {
    mount();
    await pick("sport");
    await pick("year");
    await goBack(); // year is the open column again; its combobox has focus
    const field = customInput("year");
    typeInto(field, "1987");

    await act(async () => navigateRef!(1)); // forward: manufacturer opens

    expect(screen.getByRole("combobox", { name: "manufacturer search" })).toBeTruthy();
    expect(focused()).toBe(field);
  });

  it("a new deepest column still takes focus from a column's combobox that holds text", async () => {
    mount();
    typeInto(combobox("sport"), "Base");
    await pick("sport");
    expect(focused()).toBe(combobox("year"));
  });
});

describe("SetSelector — the restore notice (NEO-224)", () => {
  /** Jason's signed-off copy (2026-10-04). */
  const NOTICE =
    "That link's trail went cold partway, so we opened it as far as it goes.";

  /**
   * The status region says `<notice> <column> column opened`, and the
   * visible line must be that same notice.
   */
  function noticeFromRegion(suffix: string): string {
    const spoken = liveRegion().textContent ?? "";
    expect(spoken.endsWith(suffix)).toBe(true);
    const notice = spoken.slice(0, spoken.length - suffix.length).trim();
    expect(notice).toBe(NOTICE);
    return notice;
  }

  it("shows the visible notice and speaks it through the single status region when a link is cut short", async () => {
    world.resolver = (ids) => ids.slice(0, 2).map((_id) => ({ _id }));
    mount("/?sport=sp&year=yr&brand=gone");
    await act(async () => {});

    const notice = noticeFromRegion("Manufacturers column opened");
    expect(notice.length).toBeGreaterThan(0);
    // The visible half is the very same sentence...
    const visible = screen.getByText(notice);
    expect(visible.getAttribute("role")).toBeNull();
    // ...and it is not a second live region: one status region on the page.
    expect(liveRegion()).not.toBe(visible);
  });

  it("is absent for a link that restored whole", async () => {
    mount("/?sport=sp&year=yr");
    await act(async () => {});
    expect(liveRegion().textContent).toBe("Manufacturers column opened");
  });

  it("is gone after the next pick, in the page and in the status region", async () => {
    world.resolver = () => [];
    mount("/?sport=nope");
    await act(async () => {});
    const notice = noticeFromRegion("Sports column opened");
    expect(screen.getByText(notice)).toBeTruthy();

    await pick("sport");

    expect(screen.queryByText(notice)).toBeNull();
    expect(liveRegion().textContent).toBe("Years column opened");
  });

  it("says it is rewinding while a link is still being checked, and the card carries the same name", () => {
    world.resolver = (() => undefined) as never;
    mount("/?sport=sp");
    expect(liveRegion().textContent).toBe("Rewinding the tape to your set…");

    // The placeholder card: a named, busy group. The page region above is the
    // ONE thing that speaks; the bar inside the card is decorative.
    const card = screen.getByRole("group", { name: "Rewinding the tape to your set…" });
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(card.querySelector('[role="status"]')).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("the deepest combobox, where focus lands, is described by the visible notice", async () => {
    world.resolver = (ids) => ids.slice(0, 2).map((_id) => ({ _id }));
    mount("/?sport=sp&year=yr&brand=gone");
    await act(async () => {});

    const box = combobox("manufacturer");
    expect(focused()).toBe(box);
    const describedBy = box.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toBe(NOTICE);
    // Only the deepest box carries it.
    for (const other of screen.getAllByRole("combobox")) {
      if (other !== box) expect(other.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("drops the description with the notice on the next pick", async () => {
    world.resolver = (ids) => ids.slice(0, 2).map((_id) => ({ _id }));
    mount("/?sport=sp&year=yr&brand=gone");
    await act(async () => {});
    const box = combobox("manufacturer");
    expect(box.getAttribute("aria-describedby")).toBeTruthy();

    await pick("manufacturer");

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(combobox("set").getAttribute("aria-describedby")).toBeNull();
    for (const el of screen.queryAllByRole("combobox")) {
      expect(el.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("a link that restored whole describes nothing", async () => {
    mount("/?sport=sp&year=yr");
    await act(async () => {});
    expect(combobox("manufacturer").getAttribute("aria-describedby")).toBeNull();
  });
});

describe("SetSelector focus — D3 scrolls the target into view only after a keyboard pick", () => {
  const scrolled: HTMLElement[] = [];
  /** Where the fetch button "is", relative to a 768px-tall viewport. */
  let fetchRect: { top: number; bottom: number } = { top: 900, bottom: 940 };
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    scrolled.length = 0;
    fetchRect = { top: 900, bottom: 940 };
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute("aria-label") === "Sync card checklist") {
        return {
          ...fetchRect,
          left: 10,
          right: 200,
          width: 190,
          height: fetchRect.bottom - fetchRect.top,
          x: 10,
          y: fetchRect.top,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalRect.call(this);
    };
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScroll;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  /** Drill to the set by pointer, then commit Base with Enter in its combobox. */
  async function enterOnBase() {
    world.picks.type = "vt-base";
    await pick("sport");
    await pick("year");
    await pick("manufacturer");
    await pick("set");
    const box = combobox("type");
    expect(focused()).toBe(box);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
  }

  it("Enter on Base with the fetch button below the fold focuses AND scrolls it, nearest", async () => {
    world.cards = [];
    mount();
    await enterOnBase();

    const fetch = screen.getByRole("button", { name: "Sync card checklist" });
    expect(focused()).toBe(fetch);
    expect(scrolled).toEqual([fetch]);
  });

  it("calls scrollIntoView with block: nearest", async () => {
    world.cards = [];
    const calls: unknown[] = [];
    HTMLElement.prototype.scrollIntoView = function (arg?: unknown) {
      calls.push(arg);
    };
    mount();
    await enterOnBase();
    expect(calls).toEqual([{ block: "nearest" }]);
  });

  it("Enter on Base with the target already on screen focuses without scrolling", async () => {
    world.cards = [];
    fetchRect = { top: 500, bottom: 540 };
    mount();
    await enterOnBase();

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
    expect(scrolled).toEqual([]);
  });

  it("a target only PARTLY off screen is not scrolled (it is not wholly outside)", async () => {
    world.cards = [];
    fetchRect = { top: 750, bottom: 790 };
    mount();
    await enterOnBase();

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
    expect(scrolled).toEqual([]);
  });

  it("a pointer pick of Base focuses with preventScroll and never scrolls, however far off screen", async () => {
    world.cards = [];
    mount();
    await drillToBase();

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
    expect(scrolled).toEqual([]);
  });

  it("a pointer press after a keyboard Enter clears it: the next pick is a pointer pick", async () => {
    world.cards = [];
    mount();
    world.picks.type = "vt-base";
    await pick("sport");
    // Enter in a column (keyboard), then the operator reaches for the mouse.
    await act(async () => {
      fireEvent.keyDown(combobox("year"), { key: "Enter" });
    });
    await pick("manufacturer");
    await pick("set");
    const typeButton = screen.getByText("pick-type");
    await act(async () => {
      fireEvent.pointerDown(typeButton);
      fireEvent.click(typeButton);
    });

    expect(focused()).toBe(screen.getByRole("button", { name: "Sync card checklist" }));
    expect(scrolled).toEqual([]);
  });
});

describe("the /set-selector redirect (main.tsx LegacySetSelector)", () => {
  // main.tsx boots the whole app (createRoot, Sentry, Clerk, ~50 pages) at
  // import, so its route table cannot be mounted in a unit test. This reads
  // the source instead: weaker than a render, so the E2E flow that visits
  // /set-selector?… is the behavioural proof.
  const main = readFileSync(join(__dirname, "../../src/main.tsx"), "utf8");

  it("routes /set-selector through a component that forwards the query string", () => {
    expect(main).toContain('<Route path="/set-selector" element={<LegacySetSelector />} />');
    const component = main.slice(main.indexOf("function LegacySetSelector"));
    const body = component.slice(0, component.indexOf("\n}\n"));
    expect(body).toContain("useLocation()");
    expect(body).toContain("`/admin/set-builder${search}`");
  });

  it("no longer redirects with a bare, query-dropping Navigate", () => {
    expect(main).not.toContain('<Navigate to="/admin/set-builder" replace />');
  });
});
