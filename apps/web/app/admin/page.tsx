import { Link } from "react-router";
import {
  SignalIcon,
  SquaresPlusIcon,
  UserGroupIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { SECTIONS } from "@/src/layouts/admin-section-layout";

/**
 * /admin — the admin tools hub (NEO-155).
 *
 * Bare /admin lists the tools rather than redirecting to the first one, for the
 * same reason /print does: the sub-tabs above are a strip of names with no room
 * to say what each tool DOES. The hub is where a tool gets a sentence. It is
 * also where the sections still to come land (Features, Leagues), so
 * an empty "pick a tool" screen is not a thing worth avoiding here.
 *
 * The cards are driven by the same SECTIONS array the sub-tabs use, so a tool
 * cannot appear in one and be missing from the other.
 */

const TOOL_DETAILS: Record<
  string,
  {
    description: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    accent: string;
  }
> = {
  "/admin/set-builder": {
    description:
      "Build set parameters from marketplace data, map them to NeonBinder sets, and reconcile card checklists.",
    icon: SquaresPlusIcon,
    accent: "text-neon-orange group-hover:border-neon-orange/50",
  },
  "/admin/players": {
    description:
      "Search every player we know, add one by hand, and correct names, Hall of Fame status and career history.",
    icon: UserIcon,
    accent: "text-neon-blue group-hover:border-neon-blue/50",
  },
  "/admin/teams": {
    description:
      "Resolve team colors, confirm ambiguous matches, and correct team details by hand.",
    icon: UserGroupIcon,
    accent: "text-neon-purple group-hover:border-neon-purple/50",
  },
  "/admin/pipeline-runs": {
    description:
      "Watch every user's placeholder pipeline runs and abort the ones that are wedged.",
    icon: SignalIcon,
    accent: "text-neon-green group-hover:border-neon-green/50",
  },
};

export default function AdminHubPage() {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {SECTIONS.map((section) => {
        const detail = TOOL_DETAILS[section.path];
        if (!detail) return null;
        const Icon = detail.icon;
        return (
          <li key={section.path}>
            <Link
              to={section.path}
              className={`group flex h-full gap-4 rounded-lg border border-slate-800 bg-slate-900/40 p-5 transition-colors hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-green-500 ${detail.accent}`}
            >
              <Icon className="w-8 h-8 shrink-0" aria-hidden="true" />
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  {section.label}
                </h2>
                <p className="text-sm text-slate-400">{detail.description}</p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
