/**
 * @vitest-environment happy-dom
 *
 * The docblock is load-bearing: `lib/**\/*.test.ts` runs in `node` unless a
 * file asks for a DOM.
 *
 * NEO-417 — the press recorder. What is pinned: real users get no listeners at
 * all, any number of holders means one set of listeners, the shape a red's
 * timeline is read from, that field values and plain-element text are never
 * read, and that a control's own name is, even when it echoes what was typed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture } }));

import {
  describePress,
  E2E_DIAGNOSTIC_EVENTS,
  holdE2EPressListeners,
  keepDiagnosticEvent,
} from "./e2e-diagnostics";
import type { CaptureResult } from "posthog-js";

const LISTENED = ["pointerdown", "pointerup", "click"];

function fixture(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** The one recorded press, by its properties. */
function recorded(): Record<string, unknown> {
  expect(capture).toHaveBeenCalledTimes(1);
  const [name, properties] = capture.mock.calls[0];
  expect(name).toBe("e2e_press");
  return properties as Record<string, unknown>;
}

beforeEach(() => {
  capture.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the press listeners outside E2E", () => {
  it("adds no listener and records nothing", () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "false");
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");

    const release = holdE2EPressListeners();
    fixture(`<button>Add</button>`).querySelector("button")!.click();
    release();

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("the press listeners under E2E", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
  });

  it("names e2e_press as an event the filter lets through", () => {
    expect(E2E_DIAGNOSTIC_EVENTS.has("e2e_press")).toBe(true);
    expect(keepDiagnosticEvent({ event: "e2e_press" } as CaptureResult)).not.toBeNull();
  });

  it("installs one set for any number of holders and removes it at zero", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");

    const releases = Array.from({ length: 6 }, () => holdE2EPressListeners());
    expect(add.mock.calls.map(([type]) => type)).toEqual(LISTENED);
    for (const call of add.mock.calls) {
      expect(call[2]).toMatchObject({ capture: true });
    }

    const button = fixture(`<button>Add</button>`).querySelector("button")!;
    button.click();
    expect(capture).toHaveBeenCalledTimes(1);

    for (const release of releases.slice(0, 5)) release();
    expect(remove).not.toHaveBeenCalled();
    button.click();
    expect(capture).toHaveBeenCalledTimes(2);

    releases[5]();
    expect(remove.mock.calls.map(([type]) => type)).toEqual(LISTENED);
    button.click();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(3);
  });

  it("counts a holder once even if it releases twice", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const first = holdE2EPressListeners();
    const second = holdE2EPressListeners();

    first();
    first();
    expect(remove).not.toHaveBeenCalled();

    second();
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("hears a press the page stopped, because it listens in the capture phase", () => {
    const release = holdE2EPressListeners();
    const stage = fixture(`<div><button>Add</button></div>`);
    stage
      .querySelector("div")!
      .addEventListener("click", (e) => e.stopPropagation(), true);

    stage.querySelector("button")!.click();
    release();

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("records the press's fields", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const release = holdE2EPressListeners();
    const button = fixture(`
      <div data-cascade-level="insert">
        <button aria-label="Add custom Parallels"><span>+ Custom</span></button>
      </div>
    `).querySelector("span")!;
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 10.6,
      clientY: 20.2,
    });
    Object.defineProperty(event, "timeStamp", { value: 958.4 });

    button.dispatchEvent(event);
    release();

    expect(recorded()).toEqual({
      type: "pointerdown",
      tag: "span",
      role: null,
      name: "Add custom Parallels",
      level: "insert",
      connected: true,
      x: 11,
      y: 20,
      input_delay_ms: 42,
      at_ms: 1000,
    });
  });

  it("does not break the page when the send throws", () => {
    capture.mockImplementation(() => {
      throw new Error("send failed");
    });
    const release = holdE2EPressListeners();
    const onClick = vi.fn();
    const button = fixture(`<button>Add</button>`).querySelector("button")!;
    button.addEventListener("click", onClick);

    expect(() => button.click()).not.toThrow();
    release();

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("describePress", () => {
  const pressOn = (el: Element) => {
    const event = new MouseEvent("click", { bubbles: true });
    let described: Record<string, unknown> = {};
    el.addEventListener("click", (e) => {
      described = describePress(e);
    });
    el.dispatchEvent(event);
    return described;
  };

  it("reads a control's own short text when it has no aria-label", () => {
    const button = fixture(`<button>  Sync
      Parallels </button>`).querySelector("button")!;
    expect(pressOn(button)).toMatchObject({
      tag: "button",
      name: "Sync Parallels",
      level: null,
    });
  });

  it("caps a long name", () => {
    const button = fixture(`<button>${"x".repeat(500)}</button>`).querySelector("button")!;
    expect(pressOn(button).name).toBe("x".repeat(60));
  });

  it("gives an explicit role, from the control the target sits in", () => {
    const span = fixture(`<li role="option"><span>Topps</span></li>`).querySelector("span")!;
    expect(pressOn(span)).toMatchObject({ tag: "span", role: "option", name: "Topps" });
  });

  it("says where a plain element sits rather than reading its text", () => {
    const p = fixture(`
      <div role="dialog" aria-label="Match Cards"><p>Create set 'typed-away'?</p></div>
    `).querySelector("p")!;
    const described = pressOn(p);
    expect(described).toMatchObject({ tag: "p", name: "Match Cards" });
    expect(JSON.stringify(described)).not.toContain("typed-away");
  });

  it("gives a plain element in no labelled region no name at all", () => {
    const p = fixture(`<p>Create set 'typed-away'?</p>`).querySelector("p")!;
    expect(pressOn(p).name).toBeNull();
  });

  it("reports a target already out of the document", () => {
    const button = document.createElement("button");
    button.textContent = "Add";
    expect(pressOn(button)).toMatchObject({ name: "Add", connected: false });
  });

  it("copes with a target that is not an element", () => {
    const event = new Event("click");
    let described: Record<string, unknown> = {};
    document.addEventListener(
      "click",
      (e) => {
        described = describePress(e);
      },
      { once: true },
    );
    document.dispatchEvent(event);
    expect(described).toMatchObject({
      type: "click",
      tag: null,
      role: null,
      name: null,
      level: null,
      connected: null,
      x: null,
      y: null,
    });
  });
});

const SECRET = "typed-away";

const describeOn = (el: Element) => {
  let described: Record<string, unknown> = {};
  el.addEventListener("click", (e) => {
    described = describePress(e);
  });
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return JSON.stringify(described);
};

describe("field values and plain-element text are never read", () => {
  it("from a plain element that repeats what was typed", () => {
    const p = fixture(`<p>Create set '${SECRET}'?</p>`).querySelector("p")!;
    expect(describeOn(p)).not.toContain(SECRET);
  });

  it("from an input, naming it by its label or placeholder", () => {
    const body = fixture(`
      <input aria-label="Search sets" />
      <input placeholder="Enter custom value..." />
    `);
    const [labelled, placeholdered] = Array.from(body.querySelectorAll("input"));
    labelled.value = SECRET;
    placeholdered.value = SECRET;

    expect(describeOn(labelled)).toContain("Search sets");
    expect(describeOn(labelled)).not.toContain(SECRET);
    expect(describeOn(placeholdered)).toContain("Enter custom value...");
    expect(describeOn(placeholdered)).not.toContain(SECRET);
  });

  it("from a textarea, whose content is its text", () => {
    const textarea = fixture(`<textarea>${SECRET}</textarea>`).querySelector("textarea")!;
    expect(describeOn(textarea)).not.toContain(SECRET);
  });

  it("from a select's options", () => {
    const select = fixture(
      `<select aria-label="Sport"><option>${SECRET}</option></select>`,
    ).querySelector("select")!;
    expect(describeOn(select)).toContain("Sport");
    expect(describeOn(select)).not.toContain(SECRET);
  });

  it("from an editable element, or anything inside one", () => {
    const span = fixture(
      `<div contenteditable="true"><span>${SECRET}</span></div>`,
    ).querySelector("span")!;
    expect(describeOn(span)).not.toContain(SECRET);
  });

  it("from a control wrapping a field", () => {
    const anchor = fixture(
      `<a href="#x"><textarea>${SECRET}</textarea>Open</a>`,
    ).querySelector("a")!;
    expect(describeOn(anchor)).not.toContain(SECRET);
  });
});

// Stated, not endorsed: these are the shapes of TeamPicker's and PlayerPicker's
// create options, which put the live query in the control's own name.
describe("a control's own name can echo what was typed", () => {
  it("through an aria-label holding the query, as TeamPicker's does", () => {
    const button = fixture(
      `<button type="button" aria-label="New team ${SECRET}">New team</button>`,
    ).querySelector("button")!;
    expect(describeOn(button)).toContain(`New team ${SECRET}`);
  });

  it("through an aria-label and visible text, as PlayerPicker's does", () => {
    const option = fixture(
      `<div role="option" aria-label="Create player ${SECRET}">+ Create "${SECRET}"</div>`,
    ).querySelector("div")!;
    expect(describeOn(option)).toContain(`Create player ${SECRET}`);
  });

  it("through a control's visible text when it has no aria-label", () => {
    const button = fixture(`<button>+ Create "${SECRET}"</button>`).querySelector("button")!;
    expect(describeOn(button)).toContain(SECRET);
  });

  it("only up to the name's cap", () => {
    const query = "q".repeat(200);
    const button = fixture(
      `<button aria-label="New team ${query}">New team</button>`,
    ).querySelector("button")!;
    const name = `New team ${query}`.slice(0, 60);
    expect(JSON.parse(describeOn(button)).name).toBe(name);
  });
});
