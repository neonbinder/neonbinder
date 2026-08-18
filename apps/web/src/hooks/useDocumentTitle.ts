import { useEffect } from "react";

/**
 * Sets `document.title` for as long as the calling component is mounted, then
 * restores whatever the title was before.
 *
 * This is a Vite SPA: `index.html` ships one static `<title>Neon Binder</title>`
 * and nothing ever changes it, so every route shares a single tab name. There
 * is no framework metadata API to lean on (no `export const metadata`), so a
 * route that wants its own title sets it imperatively.
 *
 * The restore on unmount is the part that matters: without it, a title set by
 * one route would follow the user around the rest of the app, which is worse
 * than the shared default it was trying to improve on.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
