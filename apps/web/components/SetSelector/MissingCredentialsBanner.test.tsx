/**
 * NEO-141 — the Set Builder credential gate.
 *
 * Three Set Builder flows assert this banner verbatim, and two of the three
 * strings here are load-bearing beyond their wording:
 *
 * - the heading is asserted as an exact string by all three gate flows;
 * - the two-site join must render "BuySportsCards and SportLots" (one flow
 *   matches `.*BuySportsCards and SportLots.*`);
 * - the link's `aria-label` is what Maestro selects on (`id:` resolves from
 *   `node.id || node.ariaLabel`).
 *
 * The body copy changed in NEO-141 because "saved credentials" is no longer
 * true — we hold a session, not a password.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import MissingCredentialsBanner from "./MissingCredentialsBanner";

function renderBanner(missing: string[]) {
  return render(
    <MemoryRouter>
      <MissingCredentialsBanner missing={missing} />
    </MemoryRouter>,
  );
}

describe("MissingCredentialsBanner", () => {
  it("keeps the heading the gate flows assert", () => {
    renderBanner(["buysportscards"]);
    expect(
      screen.getByRole("heading", { level: 2 }).textContent,
    ).toBe("Set Builder requires marketplace credentials");
  });

  it("joins two sites as 'BuySportsCards and SportLots'", () => {
    const { container } = renderBanner(["buysportscards", "sportlots"]);
    expect(container.textContent).toContain("BuySportsCards and SportLots");
  });

  it("asks the user to connect, not to have saved credentials", () => {
    const { container } = renderBanner(["sportlots"]);
    expect(container.textContent).toContain("You need to connect");
    expect(container.textContent).toContain("Set them up on your Profile.");
    expect(container.textContent).not.toContain("saved credentials");
  });

  it("keeps the aria-label Maestro selects on", () => {
    renderBanner(["sportlots"]);
    expect(
      screen.getByLabelText("Configure credentials in Profile").getAttribute("href"),
    ).toBe("/profile/credentials");
  });
});
