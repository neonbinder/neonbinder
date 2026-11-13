import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { keepPreviewsFor } from "./previewStore";

/**
 * NEO-481 — forgets the photo viewer's edit previews (each holds a signed URL
 * to a user's picture) when someone signs out or switches account. It sits
 * above the signed-in layout, beside `HeldIntakeOwner`, because the screens
 * that made the previews are unmounted by then. Waits for Clerk: `userId` is
 * undefined until it has loaded, which is not the same as signed out.
 */
export function PreviewOwner() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded) keepPreviewsFor(userId);
  }, [isLoaded, userId]);
  return null;
}
