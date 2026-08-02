/**
 * NEO-41 regression coverage — PublicProfileEditor's reactive stomp.
 *
 * The bug: this component is simultaneously a live view of
 * `getMyPublicProfile` and an editor for it. Its hydration effect ran on every
 * re-emit of that query and reset all 20 fields — and Convex's `useQuery` hands
 * back a fresh object on every reactive push, not only when the row's contents
 * change. So any push (this component's own save completing, a concurrent edit,
 * an unrelated reactivity wave) wiped whatever the operator was part-way
 * through typing. It is the NEO-36/38/39 controlled-input race in whole-form
 * shape, which is why the per-field `useReactiveField` primitive did not
 * already cover it.
 *
 * The fix is a form-level analogue of that hook's focus-guard: hydrate only
 * while the form is pristine, and treat any operator edit — typed or via a
 * "Fill" button — as taking ownership for the rest of the mount.
 *
 * These cases cannot be driven from Maestro (a flow cannot make the server push
 * mid-keystroke), so they live here.
 *
 * --- Mocking strategy ---
 * `convex/react` is module-mocked with `useQuery` routed by the (string-mocked)
 * query reference, mirroring CardDetailPanel.test.tsx. `currentProfile` is a
 * module-level handle the tests swap to simulate a reactive push, then force
 * through with RTL's `rerender`.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/convex/_generated/api", () => ({
  api: {
    publicProfile: {
      getMyPublicProfile: "getMyPublicProfile",
      checkUsernameAvailable: "checkUsernameAvailable",
      upsertPublicProfile: "upsertPublicProfile",
    },
    adapters: { gcs: { uploadProfilePhoto: "uploadProfilePhoto" } },
  },
}));

type Profile = Record<string, string | undefined> | undefined;
let currentProfile: Profile;
const mockUpsert = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) =>
    ref === "getMyPublicProfile" ? currentProfile : undefined,
  useMutation: () => mockUpsert,
  useAction: () => vi.fn(),
}));

import PublicProfileEditor from "./PublicProfileEditor";

/** A fresh object each call — exactly what a Convex reactive push looks like. */
const profile = (over: Record<string, string> = {}) => ({
  username: "collector",
  displayName: "Collector",
  tagline: "Vintage baseball",
  venmoUsername: "collector-venmo",
  ebayUrl: "https://www.ebay.com/str/collector",
  ...over,
});

const tagline = () => screen.getByLabelText(/Tagline/i) as HTMLInputElement;
const displayName = () =>
  screen.getByLabelText(/Display Name/i) as HTMLInputElement;

beforeEach(() => {
  currentProfile = undefined;
  mockUpsert.mockReset();
});

describe("PublicProfileEditor — hydration", () => {
  it("populates the form once the profile arrives", () => {
    const { rerender } = render(<PublicProfileEditor />);
    expect(tagline().value).toBe("");

    currentProfile = profile();
    rerender(<PublicProfileEditor />);

    expect(tagline().value).toBe("Vintage baseball");
    expect(displayName().value).toBe("Collector");
  });

  it("re-hydrates on a later push while the form is still pristine", () => {
    currentProfile = profile();
    const { rerender } = render(<PublicProfileEditor />);
    expect(tagline().value).toBe("Vintage baseball");

    currentProfile = profile({ tagline: "Changed elsewhere" });
    rerender(<PublicProfileEditor />);

    expect(tagline().value).toBe("Changed elsewhere");
  });
});

describe("PublicProfileEditor — reactive stomp guard", () => {
  it("does NOT overwrite a field the operator is typing in", () => {
    currentProfile = profile();
    const { rerender } = render(<PublicProfileEditor />);

    fireEvent.change(tagline(), { target: { value: "half-typed thought" } });

    // A reactive push lands mid-edit. Pre-fix this reset all 20 fields.
    currentProfile = profile({ tagline: "server value" });
    rerender(<PublicProfileEditor />);

    expect(tagline().value).toBe("half-typed thought");
  });

  it("protects OTHER fields too, not just the edited one", () => {
    // The stomp was whole-form: editing one field and having a push arrive
    // also reset every untouched field out from under the operator.
    currentProfile = profile();
    const { rerender } = render(<PublicProfileEditor />);

    fireEvent.change(tagline(), { target: { value: "mine" } });
    fireEvent.change(displayName(), { target: { value: "also mine" } });

    currentProfile = profile({ tagline: "server", displayName: "server" });
    rerender(<PublicProfileEditor />);

    expect(tagline().value).toBe("mine");
    expect(displayName().value).toBe("also mine");
  });

  it("survives repeated pushes, not just the first", () => {
    currentProfile = profile();
    const { rerender } = render(<PublicProfileEditor />);

    fireEvent.change(tagline(), { target: { value: "mine" } });

    for (const v of ["a", "b", "c"]) {
      currentProfile = profile({ tagline: v });
      rerender(<PublicProfileEditor />);
    }

    expect(tagline().value).toBe("mine");
  });

  it("treats a Fill-button write as an edit", () => {
    // Fill sets a field programmatically. If that did not mark the form dirty,
    // the next push would silently undo the value the operator just filled.
    currentProfile = profile();
    const { rerender } = render(<PublicProfileEditor />);

    // Every Fill button shares a title, so identify the Venmo one by the
    // inferred URL it renders as its label.
    fireEvent.click(screen.getByText("venmo.com/collector"));

    const venmo = screen.getByLabelText(/Venmo username/i) as HTMLInputElement;
    expect(venmo.value).toBe("collector");

    currentProfile = profile({ venmoUsername: "server-venmo" });
    rerender(<PublicProfileEditor />);

    expect(venmo.value).toBe("collector");
  });
});
