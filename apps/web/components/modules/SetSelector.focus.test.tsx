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
  resolver: (ids: string[]) => Array<{ _id: string }>;
  /** The id each `pick-<level>` button hands the real handler. */
  picks: Record<string, string>;
} = {
  cards: [],
  resolver: (ids) => ids.map((_id) => ({ _id })),
  picks: {},
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
    if (ref === "getAncestorChain") return [];
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
        <input role="combobox" aria-label={`${level} search`} />
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

// The two D3 landing spots, with the accessible names their owners give them.
// With cards the real checklist's header carries a SECOND "Sync card
// checklist" button, so the stub does too: landing on the attributes panel
// must beat it.
vi.mock("../SetSelector/CardChecklist", () => ({
  default: ({ parallelBuild }: { parallelBuild?: { role?: string } }) => (
    <div>
      {world.cards?.length === 0 && parallelBuild?.role !== "parallel" ? (
        <button aria-label="Sync card checklist">Fetch from Marketplaces</button>
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

/** The page's one polite region, found the way a screen reader finds it. */
function liveRegion(): HTMLElement {
  const regions = screen
    .getAllByRole("status")
    .filter((el) => el.className.includes("sr-only"));
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
  world.resolver = (ids) => ids.map((_id) => ({ _id }));
  world.picks = {};
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

  it("a leaf parallel with no cards focuses the attributes panel (its checklist has no fetch)", async () => {
    world.cards = [];
    world.picks.type = "vt-insert";
    mount();
    await pick("sport");
    await pick("year");
    await pick("manufacturer");
    await pick("set");
    await pick("type");
    await pick("insert");
    await pick("parallel");

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

describe("SetSelector — the restore notice (NEO-224)", () => {
  /**
   * The copy is a placeholder awaiting sign-off, so the tests read it off the
   * page instead of spelling it: the status region says `<notice> <column>
   * column opened`, and the visible line must be that same notice.
   */
  function noticeFromRegion(suffix: string): string {
    const spoken = liveRegion().textContent ?? "";
    expect(spoken.endsWith(suffix)).toBe(true);
    return spoken.slice(0, spoken.length - suffix.length).trim();
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

  it("says nothing at all while a link is still being checked", () => {
    world.resolver = (() => undefined) as never;
    mount("/?sport=sp");
    expect(liveRegion().textContent).toBe("");
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
