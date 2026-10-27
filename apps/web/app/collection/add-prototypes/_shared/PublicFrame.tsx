import type { ReactNode } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { BrandMark } from "@/components/primitives/BrandMark";
import { PUBLIC_DESTINATIONS } from "../../final/mode";

/**
 * NEO-369 — the public, logged-out frame around the add-cards prototypes.
 *
 * Jason (2026-10-27): every major feature gets a no-backend, logged-out
 * version beside the collection demo. The prototypes live there from the
 * start, so they are reviewed exactly where the chosen one will end up. Fake
 * data only: nothing here reads or writes Convex.
 */
export default function PublicFrame({ children, wide = true }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-surface px-4 py-5 sm:px-6">
      <div className={`mx-auto ${wide ? "max-w-[1600px]" : "max-w-3xl"}`}>
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Link to="/" aria-label="Neon Binder home" className="focus-outline rounded">
            <BrandMark />
          </Link>
          <nav aria-label="Demo" className="flex flex-wrap items-center gap-2">
            <Link
              to="/binder-tracking?demo=on"
              className="min-h-10 rounded-md px-2 py-2 text-sm text-ink-2 underline underline-offset-4 hover:text-ink focus-outline"
            >
              Back to the demo binder
            </Link>
            <NeonButton asChild className="min-h-10">
              <Link to={PUBLIC_DESTINATIONS.signUp}>Sign up free</Link>
            </NeonButton>
          </nav>
        </header>
        {children}
      </div>
    </main>
  );
}
