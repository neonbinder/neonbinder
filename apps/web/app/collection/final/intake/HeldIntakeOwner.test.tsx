import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeldIntakeOwner } from "./HeldIntakeOwner";
import { clearAllHeld, heldIntakeKey, holdFiles, readHeld } from "./heldIntake";

/**
 * NEO-452 — photos held for one collector must not wait in memory for the next
 * person on this browser. The owner sits above the signed-in layout and waits
 * for Clerk: an unloaded `userId` is not the same as signed out.
 */
const auth = vi.hoisted(() => ({ value: { isLoaded: true, userId: "u1" as string | null | undefined } }));
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => auth.value }));

const photo = () => new File(["x"], "a.jpg", { type: "image/jpeg" });
const setup = { homeId: "box1", variant: null, defaults: {} };
const mine = heldIntakeKey("u1", "inventory");
const theirs = heldIntakeKey("u2", "inventory");

beforeEach(() => {
  clearAllHeld();
  auth.value = { isLoaded: true, userId: "u1" };
});
afterEach(cleanup);

describe("HeldIntakeOwner", () => {
  it("renders nothing and forgets other users' photos once Clerk has loaded", () => {
    holdFiles(mine, [photo()], setup);
    holdFiles(theirs, [photo()], setup);
    const { container } = render(<HeldIntakeOwner />);
    expect(container.innerHTML).toBe("");
    expect(readHeld(mine).files).toHaveLength(1);
    expect(readHeld(theirs).files).toHaveLength(0);
  });

  it("while Clerk loads (userId undefined) it forgets nothing", () => {
    auth.value = { isLoaded: false, userId: undefined };
    holdFiles(mine, [photo()], setup);
    render(<HeldIntakeOwner />);
    expect(readHeld(mine).files).toHaveLength(1);
  });

  it("when the user changes, the last user's photos go", () => {
    holdFiles(mine, [photo()], setup);
    const view = render(<HeldIntakeOwner />);
    auth.value = { isLoaded: true, userId: "u2" };
    view.rerender(<HeldIntakeOwner />);
    expect(readHeld(mine).files).toHaveLength(0);
  });

  it("signing out forgets everyone's", () => {
    holdFiles(mine, [photo()], setup);
    const view = render(<HeldIntakeOwner />);
    auth.value = { isLoaded: true, userId: null };
    view.rerender(<HeldIntakeOwner />);
    expect(readHeld(mine).files).toHaveLength(0);
  });
});
