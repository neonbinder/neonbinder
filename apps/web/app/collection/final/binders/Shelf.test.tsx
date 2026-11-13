import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import { contrastRatio } from "@/lib/print/contrast";
import { DemoCollectionProvider } from "../data/demoStore";
import { useCollectionActions, useContainers } from "../data/store";
import type { CollectionActions } from "../data/store";
import type { Container, ContainerLabel } from "../data/types";
import { CollectionModeProvider } from "../mode";
import { SHOW_BOX_ID } from "../store";
import Shelf, { InventoryShelf } from "./Shelf";

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));

/**
 * The shelves pass the contrast check the size their lettering is drawn at:
 * a box end's tape is a fixed hand (`letteringPx`), and a smart binder's
 * "Smart" chip takes room from the lettering's run. Each case is a label
 * whose pair reaches 3:1 but not 4.5:1, so it is kept for large lettering
 * and swapped for normal-size lettering.
 */

// Bears navy and orange, about 3.4:1.
const BETWEEN: ContainerLabel = { background: "#0B162A", text: "#C83803", fontId: "anton" };
// 14 characters: large on My Binders' phone spine, below it once the Smart chip takes its room.
const NAME = "Green Bay 1996";

const store: { actions?: CollectionActions; containers?: Container[] } = {};
function keep(actions: CollectionActions, containers: Container[] | undefined) {
  store.actions = actions;
  store.containers = containers;
}
/** Hands the test the demo store's actions and containers. */
function Probe() {
  const actions = useCollectionActions();
  const containers = useContainers();
  useEffect(() => keep(actions, containers), [actions, containers]);
  return null;
}

function draw(shelf: "binders" | "boxes") {
  return render(
    <Theme>
      <MemoryRouter initialEntries={[shelf === "boxes" ? "/inventory?tab=boxes" : "/collection?tab=binders"]}>
        <CollectionModeProvider mode="app">
          <DemoCollectionProvider>
            <Probe />
            {shelf === "boxes" ? (
              <InventoryShelf onOpen={() => {}} onNewBox={() => {}} />
            ) : (
              <Shelf onOpen={() => {}} onNewBinder={() => {}} />
            )}
          </DemoCollectionProvider>
        </CollectionModeProvider>
      </MemoryRouter>
    </Theme>,
  );
}

async function relabel(match: (c: Container) => boolean, patch: { name?: string; label: ContainerLabel }) {
  const container = store.containers!.find(match)!;
  expect(container).toBeTruthy();
  await act(async () => {
    await store.actions!.updateContainer(container, patch);
  });
  return container.id;
}

const swappedOn = (el: Element) => el.querySelector(".nb-label")?.getAttribute("data-ink-swapped") ?? null;
const spine = (id: string) => document.querySelector(`[data-spine="${id}"]`)!;

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the shelves check contrast at the size they draw", () => {
  it("uses a pair between 3:1 and 4.5:1", () => {
    const ratio = contrastRatio(BETWEEN.text, BETWEEN.background);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.5);
  });

  it("My Boxes: a box end's tape is checked at its fixed 15px hand, so the pair is swapped", async () => {
    draw("boxes");
    await relabel((c) => c.id === SHOW_BOX_ID, { label: BETWEEN });
    const end = screen.getByRole("button", { name: /^Show box, box, / });
    expect(swappedOn(end)).toBe("true");
  });

  it("My Binders: a smart binder's Smart chip shortens the lettering, so its pair is swapped; a plain binder's is kept", async () => {
    draw("binders");
    const smart = await relabel((c) => c.kind === "binder" && !c.system && !!c.rule, { name: NAME, label: BETWEEN });
    const plain = await relabel((c) => c.kind === "binder" && !c.system && !c.rule, { name: "Green Bay 1997", label: BETWEEN });
    expect(spine(smart).textContent).toContain("Smart");
    expect(swappedOn(spine(smart))).toBe("true");
    expect(swappedOn(spine(plain))).toBeNull();
  });
});
