import { useState } from "react";

/**
 * A URL param a master-detail screen follows ONCE per distinct value.
 *
 * NEO-235 wrote this inside `components/admin/TeamManagement.tsx`; NEO-254
 * moved it here so Franchise Management could not end up with a second,
 * subtly-different copy. The reasoning is unchanged and it is worth reading
 * before touching it, because the bug it closes is invisible in a type check.
 *
 * These screens re-render on every reactive update to the tables they read, so
 * a param applied on each of them would keep yanking the operator back to the
 * state they arrived in. This remembers what has already been applied.
 *
 * TWO values are remembered, not one, and that is not belt-and-braces. React
 * Router applies every location update inside `startTransition` — the app's
 * `BrowserRouter` and the tests' `MemoryRouter` share that code path — so the
 * render that commits a change is a render in which `searchParams` STILL
 * CARRIES THE PREVIOUS VALUE; the URL catches up one render later. A one-slot
 * marker cannot tell that stale value apart from a fresh link back to it, so it
 * follows it — undoing the operator's own action under their hands. Remembering
 * the superseded value closes exactly that window.
 *
 * The cost of the second slot is that a link back to the value just left is
 * ignored for as long as the screen stays mounted. Every write through these
 * screens is a `replace`, so there is no history entry to go back to, and every
 * inbound link arrives as a fresh mount.
 */
export function useFollowedParam() {
  const [slots, setSlots] = useState<readonly [string | null, string | null]>([
    null,
    null,
  ]);
  return {
    /** The value most recently followed — an effect dependency, not state. */
    latest: slots[0],
    hasFollowed: (value: string) => slots.includes(value),
    follow: (value: string) => setSlots(([current]) => [value, current]),
  };
}
