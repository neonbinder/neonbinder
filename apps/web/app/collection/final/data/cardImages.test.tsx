import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CardImagesProvider, useCardImage } from "./cardImages";
import type { CopyPhotos } from "./types";

/**
 * NEO-377 — every card on screen is read in one go: a card drawn twice asks
 * once, a card leaving the screen stops being asked for, and without a
 * provider a card simply has no photo.
 */
const PHOTO: CopyPhotos = { front: { imageUrl: "i", thumbUrl: "t" } };

function Face({ id }: { id: string }) {
  const photo = useCardImage(id);
  return <span data-card={id}>{photo?.front?.thumbUrl ?? "drawn"}</span>;
}

afterEach(cleanup);

describe("CardImagesProvider", () => {
  it("asks once for a card drawn twice, and drops it when both leave", () => {
    const asked: Array<readonly string[]> = [];
    const useImages = vi.fn((ids: readonly string[]) => {
      asked.push(ids);
      return new Map(ids.map((id) => [id, PHOTO] as const));
    });
    function Page({ shown }: { shown: number }) {
      return (
        <CardImagesProvider useImages={useImages}>
          {Array.from({ length: shown }, (_, i) => (
            <Face key={i} id="card-a" />
          ))}
          <Face id="card-b" />
        </CardImagesProvider>
      );
    }
    const { container, rerender } = render(<Page shown={2} />);
    expect(asked.at(-1)).toEqual(["card-a", "card-b"]);
    expect(container.querySelector('[data-card="card-a"]')?.textContent).toBe("t");

    rerender(<Page shown={1} />);
    expect(asked.at(-1)).toEqual(["card-a", "card-b"]);
    rerender(<Page shown={0} />);
    expect(asked.at(-1)).toEqual(["card-b"]);
  });

  it("without a provider a card has no photo", () => {
    const { container } = render(<Face id="card-a" />);
    expect(container.textContent).toBe("drawn");
  });
});
