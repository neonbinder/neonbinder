/**
 * @vitest-environment happy-dom
 *
 * The docblock is load-bearing: `lib/**\/*.test.ts` runs in `node` unless a
 * file asks for a DOM (see `is-editable-target.test.ts`).
 *
 * NEO-307 — `inertBackground`, the hold every portalled modal puts on the page
 * behind it. What is pinned: siblings go inert and the dialog's own subtree
 * never does; holds STACK, so nested modals can close in either order without
 * releasing what an outer one still holds; and an `inert` someone else set is
 * never cleared, nor is any `aria-hidden` touched.
 */

import { afterEach, describe, expect, it } from "vitest";
import { inertBackground } from "./inert-background";

function portal(name: string): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = name;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("inertBackground", () => {
  it("makes every body child but the dialog's own inert, and releases them", () => {
    const app = portal("app");
    const other = portal("other");
    const host = portal("dialog-host");
    const dialog = document.createElement("div");
    host.appendChild(dialog);

    const release = inertBackground(dialog);
    expect(app.hasAttribute("inert")).toBe(true);
    expect(other.hasAttribute("inert")).toBe(true);
    expect(host.hasAttribute("inert")).toBe(false);

    release();
    expect(app.hasAttribute("inert")).toBe(false);
    expect(other.hasAttribute("inert")).toBe(false);
  });

  it("leaves script and style alone", () => {
    const script = document.createElement("script");
    document.body.appendChild(script);
    const dialog = portal("dialog");
    inertBackground(dialog);
    expect(script.hasAttribute("inert")).toBe(false);
  });

  it("stacks: an inner dialog closing first does not release what the outer holds", () => {
    const app = portal("app");
    const wizard = portal("wizard");
    const teamDialog = portal("team-dialog");

    const releaseWizard = inertBackground(wizard);
    expect(app.hasAttribute("inert")).toBe(true);
    // A team dialog opened while the wizard's own hold is in place (its
    // portal mounted after the wizard's effect ran).
    const releaseTeam = inertBackground(teamDialog);
    expect(wizard.hasAttribute("inert")).toBe(true);
    expect(app.hasAttribute("inert")).toBe(true);

    releaseTeam();
    expect(wizard.hasAttribute("inert")).toBe(false);
    // Still the wizard's.
    expect(app.hasAttribute("inert")).toBe(true);

    releaseWizard();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("stacks in the other order too: the outer closing first", () => {
    const app = portal("app");
    const wizard = portal("wizard");
    const teamDialog = portal("team-dialog");

    const releaseWizard = inertBackground(wizard);
    const releaseTeam = inertBackground(teamDialog);

    releaseWizard();
    // The team dialog still holds the page AND the wizard.
    expect(app.hasAttribute("inert")).toBe(true);
    expect(wizard.hasAttribute("inert")).toBe(true);

    releaseTeam();
    expect(app.hasAttribute("inert")).toBe(false);
    expect(wizard.hasAttribute("inert")).toBe(false);
    // …and the team dialog, held by the wizard's hold while it was up, is
    // free once that hold is gone.
    expect(teamDialog.hasAttribute("inert")).toBe(false);
  });

  it("never clears an inert someone else set, and never touches aria-hidden", () => {
    const theirs = portal("theirs");
    theirs.setAttribute("inert", "");
    const hidden = portal("hidden");
    hidden.setAttribute("aria-hidden", "true");
    const dialog = portal("dialog");

    const release = inertBackground(dialog);
    expect(hidden.hasAttribute("inert")).toBe(true);
    release();

    expect(theirs.hasAttribute("inert")).toBe(true);
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.hasAttribute("inert")).toBe(false);
  });

  it("is safe to release twice", () => {
    const app = portal("app");
    const other = portal("other-dialog");
    const dialog = portal("dialog");
    const releaseOther = inertBackground(other);
    const release = inertBackground(dialog);
    release();
    release();
    // A double release must not steal the other hold's count.
    expect(app.hasAttribute("inert")).toBe(true);
    releaseOther();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("does nothing for an element that is not under <body>", () => {
    const app = portal("app");
    const detached = document.createElement("div");
    const release = inertBackground(detached);
    expect(app.hasAttribute("inert")).toBe(false);
    release();
  });
});
