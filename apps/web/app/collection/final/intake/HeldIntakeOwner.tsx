import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { keepHeldFor } from "./heldIntake";

/**
 * NEO-452 — clears photos held for anyone but whoever is signed in. It sits above
 * the signed-in layout, not in the Add cards tab, because that tab is unmounted by
 * the time someone signs out or switches account. Waits for Clerk: `userId` is
 * undefined until it has loaded, which is not the same as signed out.
 */
export function HeldIntakeOwner() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded) keepHeldFor(userId);
  }, [isLoaded, userId]);
  return null;
}
