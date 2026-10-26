import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { ReactNode } from "react";
import {
  CollectionModeProvider,
  ParamLink,
  SideLink,
  deeperDemoState,
  sideOf,
  takeSideArrival,
  useCollectionParams,
  useCollectionSide,
  useGoToSide,
  usePushParams,
  type DemoHistoryState,
} from "./mode";
import type { Side } from "./data/types";

/**
 * NEO-364 — which side a URL stands for, the side link, and the demo's
 * history depth across a side switch (so "Back to the tour" is one step).
 */
afterEach(() => {
  cleanup();
  // The arrival note is module state: drain it so one test's link never leaks into the next.
  takeSideArrival("inventory");
  takeSideArrival("collection");
});

describe("sideOf", () => {
  it("the app: the page's surface wins, else the route", () => {
    expect(sideOf("app", { pathname: "/collection", search: "" }, "inventory")).toBe("inventory");
    expect(sideOf("app", { pathname: "/inventory", search: "" }, "collection")).toBe("collection");
    expect(sideOf("app", { pathname: "/inventory", search: "?tab=boxes" })).toBe("inventory");
    expect(sideOf("app", { pathname: "/inventory/x", search: "" })).toBe("inventory");
    expect(sideOf("app", { pathname: "/collection", search: "" })).toBe("collection");
    expect(sideOf("app", { pathname: "/inventory-ish", search: "" })).toBe("collection");
  });

  it("the app never reads side= from the URL", () => {
    expect(sideOf("app", { pathname: "/collection", search: "?side=inventory" })).toBe("collection");
  });

  it("the demo: side=inventory, else the collection, whatever the path", () => {
    expect(sideOf("public", { pathname: "/binder-tracking", search: "?demo=on&side=inventory" })).toBe("inventory");
    expect(sideOf("public", { pathname: "/binder-tracking", search: "?demo=on" })).toBe("collection");
    expect(sideOf("public", { pathname: "/inventory", search: "?demo=on&side=collection" })).toBe("collection");
    expect(sideOf("public", { pathname: "/inventory", search: "?demo=on" }, "inventory")).toBe("collection");
  });
});

function Where() {
  const { pathname, search, state } = useLocation();
  const navigate = useNavigate();
  const side = useCollectionSide();
  return (
    <>
      <output aria-label="where">{pathname + search}</output>
      <output aria-label="side">{side}</output>
      <output aria-label="depth">{String((state as DemoHistoryState | null)?.demoDepth ?? "none")}</output>
      <output aria-label="from">{String((state as DemoHistoryState | null)?.demoFrom ?? "none")}</output>
      <output aria-label="drawer">{String((state as { drawer?: boolean } | null)?.drawer ?? "none")}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
    </>
  );
}

type Start = string | { pathname: string; search: string; state: unknown };

function wrap(children: ReactNode, start: Start, mode: "app" | "public" = "app", paths = ["/collection", "/inventory", "/binder-tracking"]) {
  render(
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        {paths.map((p) => (
          <Route
            key={p}
            path={p}
            element={
              <CollectionModeProvider mode={mode} keepParams={mode === "public" ? { demo: "on" } : undefined}>
                <Where />
                {children}
              </CollectionModeProvider>
            }
          />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}
const at = () => screen.getByLabelText("where").textContent;
const sideNow = () => screen.getByLabelText("side").textContent;
const depth = () => screen.getByLabelText("depth").textContent;
const from = () => screen.getByLabelText("from").textContent;
const drawerFlag = () => screen.getByLabelText("drawer").textContent;

describe("useCollectionSide", () => {
  it("is the route's side in the app", () => {
    wrap(null, "/inventory?tab=boxes");
    expect(sideNow()).toBe("inventory");
    cleanup();
    wrap(null, "/collection");
    expect(sideNow()).toBe("collection");
  });

  it("is side= in the demo", () => {
    wrap(null, "/binder-tracking?demo=on&side=inventory&tab=cards", "public");
    expect(sideNow()).toBe("inventory");
    cleanup();
    wrap(null, "/binder-tracking?demo=on", "public");
    expect(sideNow()).toBe("collection");
  });
});

describe("SideLink", () => {
  const link = (side: Side, search?: Record<string, string>) => <SideLink side={side} search={search}>go</SideLink>;

  it("in the app, goes to the other side's route with the view's params", () => {
    wrap(link("inventory", { tab: "cards" }), "/collection?tab=binders");
    expect(screen.getByRole("link", { name: "go" }).getAttribute("href")).toBe("/inventory?tab=cards");
    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(at()).toBe("/inventory?tab=cards");
    expect(sideNow()).toBe("inventory");
  });

  it("in the app, never carries the collection's scope across", () => {
    wrap(link("inventory"), "/collection?tab=cards&scope=binder-x");
    expect(screen.getByRole("link", { name: "go" }).getAttribute("href")).toBe("/inventory");
  });

  it("in the demo, the collection's link adds no side param, and the inventory's adds side=inventory", () => {
    wrap(
      <>
        {link("collection")}
        <SideLink side="inventory" search={{ tab: "cards" }}>
          inv
        </SideLink>
      </>,
      "/binder-tracking?demo=on&side=inventory&tab=boxes",
      "public",
    );
    expect(screen.getByRole("link", { name: "go" }).getAttribute("href")).toBe("/binder-tracking?demo=on");
    expect(screen.getByRole("link", { name: "inv" }).getAttribute("href")).toBe("/binder-tracking?demo=on&side=inventory&tab=cards");
  });

  it("in the demo, a switch is a pushed view that counts one deeper, so Back to the tour is one step", () => {
    wrap(
      <>
        {link("collection")}
        <SideLink side="inventory" search={{ tab: "cards" }}>
          inv
        </SideLink>
      </>,
      "/binder-tracking?demo=on",
      "public",
    );
    expect(depth()).toBe("none");
    fireEvent.click(screen.getByRole("link", { name: "inv" }));
    expect(at()).toBe("/binder-tracking?demo=on&side=inventory&tab=cards");
    expect(depth()).toBe("1");
    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(at()).toBe("/binder-tracking?demo=on");
    expect(depth()).toBe("2");
    fireEvent.click(screen.getByRole("link", { name: "inv" }));
    expect(depth()).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(at()).toBe("/binder-tracking?demo=on");
  });

  it("a modified click is the browser's own: no arrival is recorded", () => {
    wrap(link("inventory"), "/collection");
    fireEvent.click(screen.getByRole("link", { name: "go" }), { ctrlKey: true });
    expect(takeSideArrival("inventory")).toBe(false);
  });

  it("a followed link records the arrival once, for that side only", () => {
    wrap(link("inventory"), "/collection");
    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(takeSideArrival("collection")).toBe(false);
    expect(takeSideArrival("inventory")).toBe(true);
    expect(takeSideArrival("inventory")).toBe(false);
  });
});

describe("useGoToSide", () => {
  function Go({ replace = false }: { replace?: boolean }) {
    const go = useGoToSide();
    return (
      <button type="button" onClick={() => go("inventory", { tab: "boxes", b: "box-show" }, { replace })}>
        redirect
      </button>
    );
  }

  it("a push is a Back step", () => {
    wrap(<Go />, "/collection?tab=binders");
    fireEvent.click(screen.getByRole("button", { name: "redirect" }));
    expect(at()).toBe("/inventory?tab=boxes&b=box-show");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(at()).toBe("/collection?tab=binders");
  });

  it("a replace takes the place of the entry, so Back skips it", () => {
    wrap(<Go replace />, "/collection?tab=binders");
    fireEvent.click(screen.getByRole("button", { name: "redirect" }));
    expect(at()).toBe("/inventory?tab=boxes&b=box-show");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(at()).toBe("/inventory?tab=boxes&b=box-show");
  });

  it("in the demo a replace keeps the entry's depth and a push adds one", () => {
    wrap(<><Go replace /></>, "/binder-tracking?demo=on&tab=inventory", "public");
    fireEvent.click(screen.getByRole("button", { name: "redirect" }));
    expect(at()).toBe("/binder-tracking?demo=on&side=inventory&tab=boxes&b=box-show");
    expect(depth()).toBe("none");
    cleanup();
    wrap(<Go />, "/binder-tracking?demo=on", "public");
    fireEvent.click(screen.getByRole("button", { name: "redirect" }));
    expect(depth()).toBe("1");
  });
});

describe("deeperDemoState", () => {
  it("counts one deeper and keeps the way in", () => {
    expect(deeperDemoState({ demoFrom: "tour" })).toEqual({ demoFrom: "tour", demoDepth: 1 });
    expect(deeperDemoState({ demoFrom: "tour", demoDepth: 3 })).toEqual({ demoFrom: "tour", demoDepth: 4 });
    expect(deeperDemoState(null)).toEqual({ demoDepth: 1 });
  });

  it("never carries the entry's own state (the drawer's flag) onto the new one", () => {
    expect(deeperDemoState({ demoFrom: "tour", demoDepth: 2, drawer: true })).toEqual({ demoFrom: "tour", demoDepth: 3 });
  });
});

/**
 * NEO-364 — a view link rendered by a Back must count from the entry Back
 * landed on, not the one it left, or "Back to the tour" overshoots history.
 */
describe("demo depth across a Back", () => {
  const tour = { pathname: "/binder-tracking", search: "?demo=on", state: { demoFrom: "tour" } };

  function Views() {
    const push = usePushParams();
    const [, setParams] = useCollectionParams();
    return (
      <>
        <ParamLink search={{ tab: "binders" }}>binders</ParamLink>
        <ParamLink search={{ tab: "binders", b: "main" }}>open main</ParamLink>
        <ParamLink search={{ tab: "cards" }}>cards</ParamLink>
        <SideLink side="inventory" search={{ tab: "cards" }}>
          door
        </SideLink>
        <button type="button" onClick={() => push((p) => p.set("detail", "card-1"), { drawer: true })}>
          open card
        </button>
        <button type="button" onClick={() => setParams({ tab: "checklists" })}>
          checklists
        </button>
      </>
    );
  }
  const click = (name: string) => fireEvent.click(screen.getByRole("link", { name }));
  const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

  it("a view link pushed after a Back lands one deeper than the entry Back landed on", () => {
    wrap(<Views />, tour, "public");
    click("binders");
    click("open main");
    expect(depth()).toBe("2");
    press("Back");
    expect(at()).toBe("/binder-tracking?demo=on&tab=binders");
    expect(depth()).toBe("1");
    click("cards");
    expect(at()).toBe("/binder-tracking?demo=on&tab=cards");
    expect(depth()).toBe("2");
    expect(from()).toBe("tour");
  });

  it("the side door after a Back lands one deeper than the entry Back landed on", () => {
    wrap(<Views />, tour, "public");
    click("binders");
    click("open main");
    press("Back");
    click("door");
    expect(at()).toBe("/binder-tracking?demo=on&side=inventory&tab=cards");
    expect(depth()).toBe("2");
    expect(from()).toBe("tour");
  });

  it("push, push, Back, push: going back depth + 1 entries reaches the tour entry", () => {
    wrap(<Views />, tour, "public");
    click("binders");
    press("checklists");
    press("Back");
    click("door");
    expect(depth()).toBe("2");
    // What "Back to the tour" does: back past every view the demo pushed.
    for (let i = 0; i < 2; i++) press("Back");
    expect(at()).toBe("/binder-tracking?demo=on");
    expect(depth()).toBe("none");
    expect(from()).toBe("tour");
  });

  it("a link to the view on screen replaces it and keeps its depth", () => {
    wrap(<Views />, tour, "public");
    click("binders");
    click("binders");
    expect(at()).toBe("/binder-tracking?demo=on&tab=binders");
    expect(depth()).toBe("1");
    press("Back");
    expect(at()).toBe("/binder-tracking?demo=on");
  });

  it("the card drawer's flag stays on the drawer's entry, never on a view pushed from it", () => {
    wrap(<Views />, tour, "public");
    click("binders");
    press("open card");
    expect(at()).toBe("/binder-tracking?demo=on&tab=binders&detail=card-1");
    expect(drawerFlag()).toBe("true");
    expect(depth()).toBe("2");
    click("cards");
    expect(drawerFlag()).toBe("none");
    expect(depth()).toBe("3");
    press("checklists");
    expect(drawerFlag()).toBe("none");
    click("door");
    expect(drawerFlag()).toBe("none");
    expect(depth()).toBe("5");
  });

  it("in the app a view link carries no history state", () => {
    wrap(<Views />, "/collection?tab=cards");
    click("binders");
    expect(at()).toBe("/collection?tab=binders");
    expect(depth()).toBe("none");
  });

  it("a modified click is left to the browser", () => {
    wrap(<Views />, tour, "public");
    fireEvent.click(screen.getByRole("link", { name: "binders" }), { metaKey: true });
    expect(at()).toBe("/binder-tracking?demo=on");
  });
});
