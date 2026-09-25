/**
 * NEO-307 — make everything behind a portalled modal `inert`, and put it back
 * exactly as it was.
 *
 * `aria-modal="true"` and a Tab trap stop KEYBOARD focus leaving a dialog, but
 * not a screen reader's browse cursor, and not a driver that queries the whole
 * accessibility tree. With the review wizard open and a picker's New Team
 * dialog over it, both carry a `NewTeamForm`, so two comboboxes named "League"
 * were live at once and neither AT nor an E2E selector could tell them apart.
 * `inert` removes the background from both the tab order and the tree, which
 * is what `aria-modal` promises and does not enforce.
 *
 * `inert`, not `aria-hidden`: a hidden subtree that still holds focusable
 * controls is its own violation (axe `aria-hidden-focus`), and `inert` takes
 * them out of focus too. `aria-hidden` is never touched here, whoever set it.
 *
 * ## Works on `document.body`'s children
 *
 * Both modals `createPortal` straight into `document.body`, so the app root and
 * every other portal are the dialog's siblings there. The dialog's own
 * top-level ancestor is skipped; every other element child is made inert.
 *
 * ## Stacks, and never clobbers
 *
 * Modals nest (the wizard, then a New Team dialog over it) and can close in
 * either order, so a plain set-then-remove would be wrong twice over: the inner
 * dialog would un-inert the app root the wizard is still holding, and an
 * element someone ELSE made inert would be released by us. So each element is
 * reference-counted across every holder, and remembers whether it was already
 * inert before the first one: it is released only when the last holder lets
 * go, and only if it was not inert to begin with.
 *
 * ## Inert blurs
 *
 * Making the element that holds focus inert drops focus to `<body>`. A caller
 * that restores focus to its opener must capture that opener BEFORE calling
 * this, and restore focus AFTER calling the release — see `NewTeamDialog`.
 */

type Hold = { count: number; wasInert: boolean };

const holds = new WeakMap<Element, Hold>();

/** Never content, so never worth an attribute — and a `<script>` being inert
 *  means nothing. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "LINK"]);

/**
 * Make every `document.body` child except the one holding `dialog` inert.
 * Returns the release; calling it more than once is harmless.
 */
export function inertBackground(dialog: Element): () => void {
  const body = dialog.ownerDocument.body;
  let top: Element | null = dialog;
  while (top && top.parentElement !== body) top = top.parentElement;
  // Not under <body> (detached, or rendered somewhere unexpected): there is no
  // background we can reason about, so touch nothing.
  if (!top) return () => {};

  const held: Element[] = [];
  for (const sibling of Array.from(body.children)) {
    if (sibling === top || SKIP_TAGS.has(sibling.tagName)) continue;
    const hold = holds.get(sibling);
    if (hold) {
      hold.count += 1;
    } else {
      const wasInert = sibling.hasAttribute("inert");
      holds.set(sibling, { count: 1, wasInert });
      if (!wasInert) sibling.setAttribute("inert", "");
    }
    held.push(sibling);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const sibling of held) {
      const hold = holds.get(sibling);
      if (!hold) continue;
      hold.count -= 1;
      if (hold.count > 0) continue;
      holds.delete(sibling);
      if (!hold.wasInert) sibling.removeAttribute("inert");
    }
  };
}
