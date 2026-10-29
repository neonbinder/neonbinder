/**
 * NEO-377 — a card's real picture wherever a card is drawn. `CardFace` asks
 * for its card through `useCardImage`; this provider gathers every card on
 * screen and reads their photos in one go from the store
 * (`CopyPhotosExtension.useCardImages`), so a binder page or a row of search
 * results is one read, not one per card. Without a provider (the public
 * pages, a test) a card is drawn as it always was.
 *
 * The order, everywhere: the collector's own photo, then (NEO-381) the
 * catalog's, then the drawn stand-in.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CopyPhotos } from "./types";

interface CardImages {
  /** Count a card in while it is on screen; the return counts it out. */
  register(cardId: string): () => void;
  images: ReadonlyMap<string, CopyPhotos> | undefined;
}

const CardImagesContext = createContext<CardImages | null>(null);

const NONE: readonly string[] = [];

export function CardImagesProvider({
  useImages,
  children,
}: {
  /** Reads the photos of these cards; called every render, like a hook. */
  useImages: (cardIds: readonly string[]) => ReadonlyMap<string, CopyPhotos> | undefined;
  children: ReactNode;
}) {
  const counts = useRef(new Map<string, number>());
  const [ids, setIds] = useState<readonly string[]>(NONE);
  const sync = useCallback(() => {
    setIds((prev) => {
      const next = [...counts.current.keys()].sort();
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
  }, []);
  const register = useCallback(
    (cardId: string) => {
      counts.current.set(cardId, (counts.current.get(cardId) ?? 0) + 1);
      sync();
      return () => {
        const n = (counts.current.get(cardId) ?? 1) - 1;
        if (n > 0) counts.current.set(cardId, n);
        else counts.current.delete(cardId);
        sync();
      };
    },
    [sync],
  );
  const images = useImages(ids);
  const value = useMemo(() => ({ register, images }), [register, images]);
  return <CardImagesContext.Provider value={value}>{children}</CardImagesContext.Provider>;
}

/** The collector's photo of this card, if they have one and a provider is mounted. */
export function useCardImage(cardId: string | undefined): CopyPhotos | undefined {
  const ctx = useContext(CardImagesContext);
  const register = ctx?.register;
  useEffect(() => (cardId && register ? register(cardId) : undefined), [cardId, register]);
  return cardId ? ctx?.images?.get(cardId) : undefined;
}
