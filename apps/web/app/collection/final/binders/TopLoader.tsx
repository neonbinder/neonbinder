import type { ReactNode } from "react";
import "./top-loader.css";

/**
 * NEO-444 — a card in a top loader, the rigid clear sleeve collectors keep one
 * in. `children` is what sits inside (`top-loader.css`), filling a 5:7 card.
 * The plastic is decoration: it says nothing to assistive tech.
 */
export default function TopLoader({ children }: { children: ReactNode }) {
  return (
    <div className="nb-toploader pointer-events-auto">
      <div aria-hidden="true" className="nb-toploader-back" />
      <div className="nb-toploader-card">{children}</div>
      <div aria-hidden="true" className="nb-toploader-front" />
    </div>
  );
}
