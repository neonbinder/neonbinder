import type { CSSProperties, ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { shelfColors } from "@/app/collection/final/binders/label";
import { spineFontById, spineFontFamilyCss } from "@/lib/print/spine-fonts";
import { count, sideHref } from "./bits";
import type { ShelfBinder } from "./shelf-model";

/**
 * NEO-464 combined dashboard — a binder seen from the front, shut: its vinyl
 * in the binder's label colour, the hinge down the left, and the name on the
 * insert in the clear cover, lettered in the binder's own face. It stands
 * where the pocket page opens.
 *
 * - No binder open: the first binder on the shelf, shut. The whole cover is
 *   one button that opens it (pushes `?binder=`, like its spine).
 * - An open binder with nothing in it: there are no pages to turn, so it
 *   stays shut, and the insert says how to fill it.
 */

/** Lettering this big always counts as large text (3:1 is enough). */
const COVER_LETTERING_PX = 28;

function CoverFace({ binder, children }: { binder: ShelfBinder; children?: ReactNode }) {
  const font = spineFontById(binder.label.fontId);
  const colors = shelfColors(binder.label, COVER_LETTERING_PX);
  return (
    <>
      <span aria-hidden="true" className="cb-cover-hinge" />
      <span className="cb-cover-window">
        <span
          aria-hidden="true"
          className="cb-cover-name"
          style={{ color: colors.text, fontFamily: spineFontFamilyCss(font) }}
        >
          {binder.name}
        </span>
        {children}
      </span>
    </>
  );
}

function coverStyle(binder: ShelfBinder): CSSProperties {
  return { "--vinyl": shelfColors(binder.label, COVER_LETTERING_PX).background } as CSSProperties;
}

/** No binder open: the first one on the shelf, shut, waiting to be opened. */
export function ClosedCover({ binder, onOpen }: { binder: ShelfBinder; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(binder.id)}
      className="cb-cover cb-cover--closed"
      style={coverStyle(binder)}
    >
      <CoverFace binder={binder}>
        <span aria-hidden="true" className="cb-cover-count">
          {count(binder.cardCount, "card")}
        </span>
      </CoverFace>
      <span className="cb-cover-tab">Crack open {binder.name}</span>
    </button>
  );
}

/** An open binder with no cards: still shut, with the way to fill it. */
export function EmptyCover({ binder }: { binder: ShelfBinder }) {
  const { pathname } = useLocation();
  return (
    <div className="cb-cover cb-cover-in" style={coverStyle(binder)}>
      <CoverFace binder={binder}>
        <span className="cb-cover-slip">
          No cards in here yet.
          <Link to={sideHref(pathname, "collection", { tab: "add" })} className="cb-cover-link focus-outline">
            Fill this binder
          </Link>
        </span>
      </CoverFace>
    </div>
  );
}
