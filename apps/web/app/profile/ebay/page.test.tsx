import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  // Records what would be forwarded. The real one would unmount the landing.
  Navigate: ({ state }: { state: unknown }) => {
    seen.push(state);
    return null;
  },
}));

import EbayReturnLanding from "./page";

it("a re-render after the forward has replaced the history entry hands on the same return (NEO-434)", () => {
  const ebayReturn = { kind: "code", code: "c1", state: "n1" };
  window.history.replaceState({ ebayReturn }, "");
  const tree = () => (
    <MemoryRouter initialEntries={["/profile/ebay"]}>
      <EbayReturnLanding />
    </MemoryRouter>
  );
  const { rerender } = render(tree());

  window.history.replaceState(null, "");
  rerender(tree());

  expect(seen.length).toBeGreaterThan(1);
  for (const state of seen) expect(state).toEqual({ ebayReturn });
});
