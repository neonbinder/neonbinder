import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { useAuth } from "@clerk/clerk-react";
import { useNavigate } from "react-router";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
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
          <UserButton />
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
