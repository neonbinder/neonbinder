import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { useAuth } from "@clerk/clerk-react";
import { useNavigate } from "react-router";
import { Bars3Icon, KeyIcon, XMarkIcon } from "@heroicons/react/24/outline";
import NeonButton from "./NeonButton";

interface BinderHeaderProps {
  isMobileMenuOpen: boolean;
  onMobileMenuToggle: () => void;
}

export default function BinderHeader({
  isMobileMenuOpen,
  onMobileMenuToggle,
}: BinderHeaderProps) {
  const { isSignedIn, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  // pointer-events-none on the sticky header background (with -auto on the
  // interactive groups) makes the empty middle click-through so it doesn't
  // steal clicks from elements scrolled flush against the top edge.
  return (
    <header className="sticky top-0 z-20 bg-background p-4 border-b-2 border-slate-200 dark:border-slate-800 flex flex-row justify-between items-center pointer-events-none">
      <div className="flex items-center gap-2 pointer-events-auto">
        <img src="/logo.png" alt="Neon Binder" width={40} height={40} />
        <span className="neon-header neon-header-sm">Neon Binder</span>
      </div>
      <div className="flex items-center gap-3 pointer-events-auto">
        <SignedIn>
          {/* NEO-172 — API Keys hangs off the account menu, not the binder tab
              staircase. The staircase is the six-item nav NEO-145 settled on
              and it names FEATURES; an account-level credential screen is the
              same kind of thing as the rest of /profile, so it belongs where
              the account already lives.

              `labelIcon` is required by Clerk, and Clerk renders the node as-is
              next to the label, so the icon must be hidden from assistive tech
              or it doubles the item's accessible name. */}
          <UserButton>
            <UserButton.MenuItems>
              <UserButton.Link
                label="API Keys"
                labelIcon={<KeyIcon className="w-4 h-4" aria-hidden="true" />}
                href="/profile/api-keys"
              />
            </UserButton.MenuItems>
          </UserButton>
          <NeonButton cancel onClick={handleSignOut} className="hidden sm:inline-flex">
            Sign out
          </NeonButton>
        </SignedIn>
        <SignedOut>
          <SignInButton />
        </SignedOut>
        <button
          onClick={onMobileMenuToggle}
          className="lg:hidden p-2 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
        >
          {isMobileMenuOpen ? (
            <XMarkIcon className="w-6 h-6" />
          ) : (
            <Bars3Icon className="w-6 h-6" />
          )}
        </button>
      </div>
    </header>
  );
}
