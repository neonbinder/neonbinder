import { Link } from "react-router";

const SITE_LABEL: Record<string, string> = {
  buysportscards: "BuySportsCards",
  sportlots: "SportLots",
};

export interface MissingCredentialsBannerProps {
  missing: string[];
}

export default function MissingCredentialsBanner({
  missing,
}: MissingCredentialsBannerProps) {
  const labels = missing.map((s) => SITE_LABEL[s] ?? s);
  const joined =
    labels.length === 2 ? `${labels[0]} and ${labels[1]}` : labels.join(", ");

  return (
    <div
      role="alert"
      className="max-w-2xl mx-auto mt-12 p-6 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md"
    >
      <h2 className="text-xl font-semibold text-amber-800 dark:text-amber-200 mb-2">
        Set Builder requires marketplace credentials
      </h2>
      <p className="text-amber-800 dark:text-amber-200 mb-4">
        You need saved credentials for <strong>{joined}</strong> before Set
        Builder can work. Configure them on your Profile.
      </p>
      <Link
        to="/profile"
        aria-label="Configure credentials in Profile"
        className="inline-block px-4 py-2 rounded-md bg-neon-green text-black font-semibold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-green"
        style={{ fontFamily: "'Lexend', sans-serif" }}
      >
        Configure credentials in Profile →
      </Link>
    </div>
  );
}
