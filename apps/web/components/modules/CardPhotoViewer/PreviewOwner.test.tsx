import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewOwner } from "./PreviewOwner";
import { previewCountForTest, rememberPreview, resetPreviewsForTest } from "./previewStore";

/**
 * NEO-481 — an edit preview holds a signed URL to one user's picture. It must
 * not wait in the page for the next person on this browser: signing out or
 * switching account forgets every preview. An unloaded Clerk is not a sign-out.
 */
const auth = vi.hoisted(() => ({ value: { isLoaded: true, userId: "u1" as string | null | undefined } }));
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => auth.value }));

const remember = (key: string) =>
  rememberPreview(key, { edit: { turns: 1, crop: null }, sourceUrl: `https://signed.example/${key}`, srcW: 10, srcH: 14 });

beforeEach(() => {
  resetPreviewsForTest();
  auth.value = { isLoaded: true, userId: "u1" };
});
afterEach(cleanup);

describe("PreviewOwner", () => {
  it("renders nothing and keeps the signed-in user's previews", () => {
    const { container } = render(<PreviewOwner />);
    remember("copy:a:front");
    expect(container.innerHTML).toBe("");
    expect(previewCountForTest()).toBe(1);
  });

  it("while Clerk loads it forgets nothing", () => {
    auth.value = { isLoaded: false, userId: undefined };
    remember("copy:a:front");
    render(<PreviewOwner />);
    expect(previewCountForTest()).toBe(1);
  });

  it("switching account forgets the last user's previews", () => {
    const view = render(<PreviewOwner />);
    remember("copy:a:front");
    remember("scan:j:0");
    auth.value = { isLoaded: true, userId: "u2" };
    view.rerender(<PreviewOwner />);
    expect(previewCountForTest()).toBe(0);
  });

  it("signing out forgets them", () => {
    const view = render(<PreviewOwner />);
    remember("copy:a:front");
    auth.value = { isLoaded: true, userId: null };
    view.rerender(<PreviewOwner />);
    expect(previewCountForTest()).toBe(0);
  });
});
