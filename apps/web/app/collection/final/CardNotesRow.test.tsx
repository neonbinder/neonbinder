import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

import { CardNotesRow } from "./CardDetail";

/** NEO-367 — the collector's card detail shows NB's note, or nothing. */
afterEach(cleanup);

describe("CardNotesRow", () => {
  it("renders a Notes term with the note, line breaks kept in one entry", () => {
    render(
      <dl>
        <CardNotesRow notes={"Short print\nabout 1:120 packs"} />
      </dl>,
    );
    const term = screen.getByRole("term");
    expect(term.textContent).toBe("Notes");
    const def = screen.getByRole("definition");
    expect(def.textContent).toBe("Short print\nabout 1:120 packs");
    expect(def.className).toContain("whitespace-pre-line");
  });

  it("renders nothing when the card has no note", () => {
    const { container } = render(
      <dl>
        <CardNotesRow />
      </dl>,
    );
    expect(container.querySelector("dt, dd")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
  });
});
