import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router";
import { useCardDrawer, type DrawerHistoryState } from "./drawerControl";
import { CollectionModeProvider } from "./mode";

/**
 * NEO-464 — the run of cards the drawer's ↑ ↓ step through belongs to the
 * open it was given for. A card link's own run (its history entry's `list`)
 * is the one the drawer walks, never the run of the last drawer that was
 * open: once the drawer closes, what an earlier opener or a step left behind
 * is gone. Collection's openers hand the run through `openCard`, as before.
 */
afterEach(() => cleanup());

const NEW_LISTINGS = ["l1", "l2", "l3", "shared"];
const PULLS = ["p1", "p2", "p3", "p4", "p5", "shared"];

function Harness() {
  const [params] = useSearchParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const control = useCardDrawer(params);
  const { drawer, drawerIndex } = control;
  const next = control.step(1);
  const linkTo = (cardId: string, list: string[]) => {
    const state: DrawerHistoryState = { drawer: true, list };
    return (
      <Link to={{ search: `?detail=${cardId}` }} state={state}>
        {`Open ${cardId} from its run`}
      </Link>
    );
  };
  return (
    <>
      <output aria-label="Page URL">{search}</output>
      <output aria-label="Drawer">
        {drawer ? `${drawer.cardId}: ${drawerIndex + 1} of ${drawer.listIds.length}` : "closed"}
      </output>
      {linkTo("l2", NEW_LISTINGS)}
      {linkTo("shared", PULLS)}
      <button type="button" onClick={() => control.openCard("p2", { list: PULLS })}>
        Open p2 with its run
      </button>
      <button type="button" onClick={() => control.openCard("shared")}>
        Open shared alone
      </button>
      <button type="button" disabled={!next} onClick={() => next?.()}>
        Step next
      </button>
      <button type="button" onClick={() => control.closeDrawer()}>
        Close drawer
      </button>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        Browser Forward
      </button>
    </>
  );
}

function renderHarness() {
  render(
    <MemoryRouter initialEntries={["/demo"]}>
      <CollectionModeProvider mode="app">
        <Harness />
      </CollectionModeProvider>
    </MemoryRouter>,
  );
}

const drawerText = () => screen.getByRole("status", { name: "Drawer" }).textContent;
const click = async (name: string, role: "link" | "button" = "button") => {
  await act(async () => {
    fireEvent.click(screen.getByRole(role, { name }));
  });
};

describe("useCardDrawer's run of cards", () => {
  it("a card link opens on its own run, not the run a stepped-through drawer left behind before it closed", async () => {
    renderHarness();
    await click("Open l2 from its run", "link");
    expect(drawerText()).toBe("l2: 2 of 4");
    // Step to the run's end: the step hands the drawer the run it walked.
    await click("Step next");
    await click("Step next");
    expect(drawerText()).toBe("shared: 4 of 4");
    await click("Browser Back");
    expect(drawerText()).toBe("closed");
    // The same card, from another run: the drawer walks that run.
    await click("Open shared from its run", "link");
    expect(drawerText()).toBe(`shared: ${PULLS.length} of ${PULLS.length}`);
  });

  it("closing with Close drops the run too", async () => {
    renderHarness();
    await click("Open l2 from its run", "link");
    await click("Step next");
    await click("Close drawer");
    expect(drawerText()).toBe("closed");
    await click("Open shared from its run", "link");
    expect(drawerText()).toBe(`shared: ${PULLS.length} of ${PULLS.length}`);
  });

  it("Collection's openers: the run comes with openCard, ↑ ↓ keep it, and a later open without one holds just its card", async () => {
    renderHarness();
    await click("Open p2 with its run");
    expect(drawerText()).toBe(`p2: 2 of ${PULLS.length}`);
    await click("Step next");
    expect(drawerText()).toBe(`p3: 3 of ${PULLS.length}`);
    await click("Browser Back");
    expect(drawerText()).toBe("closed");
    await click("Open shared alone");
    expect(drawerText()).toBe("shared: 1 of 1");
  });

  it("Collection: Back then Forward reopens the card with the run its opener gave, and ↑ ↓ still walk it", async () => {
    renderHarness();
    await click("Open p2 with its run");
    expect(drawerText()).toBe(`p2: 2 of ${PULLS.length}`);
    await click("Step next");
    await click("Browser Back");
    expect(drawerText()).toBe("closed");
    await click("Browser Forward");
    expect(drawerText()).toBe(`p3: 3 of ${PULLS.length}`);
    await click("Step next");
    expect(drawerText()).toBe(`p4: 4 of ${PULLS.length}`);
  });

  it("an open from inside the drawer without a run holds just its card, whatever run the entry carries", async () => {
    renderHarness();
    await click("Open p2 with its run");
    await click("Open shared alone");
    expect(drawerText()).toBe("shared: 1 of 1");
  });
});
