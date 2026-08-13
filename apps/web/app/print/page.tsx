import { Link } from "react-router";
import { QrCodeIcon, TagIcon } from "@heroicons/react/24/outline";
import { SECTIONS } from "@/src/layouts/print-layout";

/**
 * /print — the Print Shop hub (NEO-145).
 *
 * Bare /print lists the tools rather than redirecting to the first one, because
 * the sub-tabs above are a strip of names with no room to say what each tool
 * DOES. The hub is where a tool gets a sentence. It is also the landing page for
 * the two tools still to come (placeholder sheets, spine labels), so an empty
 * "pick a tool" screen is not a thing worth avoiding here.
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
  "/print/shipping": {
    description:
      "Address a package and print a 4″ × 6″ label with your return address filled in.",
    icon: TagIcon,
    accent: "text-neon-teal group-hover:border-neon-teal/50",
  },
  "/print/qr": {
    description:
      "Generate a QR code for an in-person sale that buyers scan to add to their running total.",
    icon: QrCodeIcon,
    accent: "text-neon-pink group-hover:border-neon-pink/50",
  },
};

export default function PrintHubPage() {
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
