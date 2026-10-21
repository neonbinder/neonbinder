import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { useCollectionMode } from "../mode";

/** What a "Print label" link that opens a new tab says about it, as its description. */
export const NEW_TAB_HINT = "Opens in a new tab";

/**
 * A "Print label" link: the Print Shop's spine-label designer with a label
 * filled in (`appHref`), wherever this mode sends it (`printLabelHref`).
 *
 * In the app it opens a new tab, so a label mid-edit in the editor (and the
 * open binder behind it) is still here when the collector comes back. A
 * small out-arrow shows that, and the link's accessible description says it
 * ("Opens in a new tab"); the accessible NAME stays the link's own words.
 * The public demo's tour page opens in place, like any other tour link.
 */
export default function PrintShopLink({
  appHref,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  appHref: string;
  className: string;
  "aria-label"?: string;
  children: ReactNode;
}) {
  const { printLabelHref, printLabelInNewTab } = useCollectionMode();
  const hintId = useId();
  const to = printLabelHref(appHref);
  if (!printLabelInNewTab) {
    return (
      <Link to={to} aria-label={ariaLabel} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <>
      <Link
        to={to}
        target="_blank"
        rel="noopener"
        aria-label={ariaLabel}
        aria-describedby={hintId}
        className={className}
      >
        {children}
        <ArrowTopRightOnSquareIcon
          aria-hidden="true"
          className="ml-0.5 inline-block h-3.5 w-3.5 shrink-0 align-[-2px]"
        />
      </Link>
      <span id={hintId} hidden>
        {NEW_TAB_HINT}
      </span>
    </>
  );
}
