import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { useAuth } from "@clerk/clerk-react";
import { useNavigate } from "react-router";
import { Bars3Icon, KeyIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { BrandMark } from "@/components/primitives/BrandMark";
import NeonButton from "./NeonButton";
import { MOBILE_NAV_ID } from "./mobile-nav";

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
  //
  // Sticky from `sm` up only (NEO-341). On a phone the bar's controls (the
  // account button, Sign out, the menu toggle) span most of its 412px width,
  // so a pinned bar parks real controls on top of whatever button the page has
  // scrolled up to the top edge: Add player / Add league after the detail
  // panel reveals itself, the credentials site tabs after a rejected sign-in.
  // The covered button keeps a sliver of tappable area under someone else's
  // control (axe target-size, "partially obscured", WCAG 2.5.8). Letting the
  // bar scroll away on a phone removes the overlap rather than chasing each
  // scroll position, and hands the 74px back to the content. globals.css
  // drops `scroll-padding-top` below `sm` to match; keep the two in step.
  return (
    <header className="sm:sticky sm:top-0 z-20 bg-surface p-4 border-b-2 border-rule flex flex-row justify-between items-center pointer-events-none">
      <div className="flex items-center gap-2 pointer-events-auto">
        <BrandMark />
        {/* The wordmark inherits its colour in dark and takes the deep brand
            green in light (`--wordmark`, app/theme.css). */}
        <span className="neon-header neon-header-sm text-wordmark">Neon Binder</span>
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
          <NeonButton variant="negative" onClick={handleSignOut} className="hidden sm:inline-flex">
            Sign out
          </NeonButton>
        </SignedIn>
        <SignedOut>
          <SignInButton />
        </SignedOut>
        {/* One name in both states, with aria-expanded carrying open/closed.
            It used to read "Close menu" while open, the same name as the
            button inside the dialog. While the menu is open this toggle is
            inert anyway (the page behind is), and the dialog's own Close menu
            button takes over. */}
        <button
          type="button"
          onClick={onMobileMenuToggle}
          className="lg:hidden min-h-11 min-w-11 inline-flex items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-hover focus-outline transition-colors"
          aria-label="Open menu"
          aria-expanded={isMobileMenuOpen}
          aria-controls={isMobileMenuOpen ? MOBILE_NAV_ID : undefined}
          aria-haspopup="dialog"
        >
          {isMobileMenuOpen ? (
            <XMarkIcon className="w-6 h-6" aria-hidden="true" />
          ) : (
            <Bars3Icon className="w-6 h-6" aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}
