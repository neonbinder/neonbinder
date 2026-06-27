import { useMemo } from "react";
import { NavLink } from "react-router";
import {
  HomeIcon,
  RectangleStackIcon,
  ArchiveBoxIcon,
  QrCodeIcon,
  UserIcon,
  SquaresPlusIcon,
} from "@heroicons/react/24/outline";
import { useIsAdmin } from "@/src/hooks/useIsAdmin";

export interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  glowClass: string;
  activeColor: string;
  requiresAdmin?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    path: "/dashboard",
    icon: HomeIcon,
    glowClass: "binder-tab-glow-green",
    activeColor: "text-neon-green",
  },
  {
    label: "Collection",
    path: "/collection",
    icon: RectangleStackIcon,
    glowClass: "binder-tab-glow-blue",
    activeColor: "text-neon-blue",
  },
  {
    label: "Inventory",
    path: "/inventory",
    icon: ArchiveBoxIcon,
    glowClass: "binder-tab-glow-yellow",
    activeColor: "text-neon-yellow",
  },
  {
    label: "Set Builder",
    path: "/set-selector",
    icon: SquaresPlusIcon,
    glowClass: "binder-tab-glow-orange",
    activeColor: "text-neon-orange",
    requiresAdmin: true,
  },
  {
    label: "QR Code",
    path: "/qr-code",
    icon: QrCodeIcon,
    glowClass: "binder-tab-glow-pink",
    activeColor: "text-neon-pink",
  },
  {
    label: "Profile",
    path: "/profile",
    icon: UserIcon,
    glowClass: "binder-tab-glow-purple",
    activeColor: "text-neon-purple",
  },
];

/**
 * Returns the nav items visible to the current user. Admin-only items are
 * filtered out until Clerk has loaded and confirmed the admin role. This is
 * a UI gate — the actual authorization boundary is enforced server-side in
 * convex/auth.ts#requireAdmin.
 */
export function useVisibleNavItems(): NavItem[] {
  const { isAdmin, isLoaded } = useIsAdmin();
  return useMemo(() => {
    return NAV_ITEMS.filter((item) => {
      if (!item.requiresAdmin) return true;
      return isLoaded && isAdmin;
    });
  }, [isAdmin, isLoaded]);
}

const STAGGER_OFFSETS = [0, 6, 12, 18, 24, 30];

export default function BinderTabs() {
  const items = useVisibleNavItems();
  return (
    <nav className="fixed right-0 top-1/2 -translate-y-1/2 z-30 hidden lg:flex flex-col gap-2">
      {items.map((item, index) => (
        <NavLink
          key={item.path}
          to={item.path}
          viewTransition
          className={({ isActive }) =>
            `binder-tab flex items-center gap-3 rounded-l-xl cursor-pointer
            transition-all duration-200 ease-out
            py-4 pl-4 pr-5 w-[160px]
            ${isActive
              ? `${item.glowClass} ${item.activeColor} bg-gray-900 w-[170px]`
              : "bg-gray-800/80 text-gray-400 hover:w-[166px] hover:bg-gray-800"
            }`
          }
          style={{ marginRight: `-${STAGGER_OFFSETS[index] ?? 0}px` }}
        >
          <item.icon className="w-6 h-6 shrink-0" />
          <span className="text-base font-medium">
            {item.label}
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
