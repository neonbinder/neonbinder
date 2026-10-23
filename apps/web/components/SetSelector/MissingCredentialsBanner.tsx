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
      className="max-w-2xl mx-auto mt-12 p-6 bg-notice-warn-bg border border-notice-warn-rule rounded-md"
    >
      <h2 className="text-xl font-semibold text-notice-warn-ink mb-2">
        Set Builder requires marketplace credentials
      </h2>
      <p className="text-notice-warn-ink mb-4">
        You need to connect <strong>{joined}</strong> before Set Builder can
        work. Set them up on your Profile.
      </p>
      <Link
        to="/profile/credentials"
        aria-label="Configure credentials in Profile"
        className="inline-block px-4 py-2 rounded-md bg-neon-green text-on-neon-green font-semibold hover:opacity-90 focus-outline"
        style={{ fontFamily: "'Lexend', sans-serif" }}
      >
        Configure credentials in Profile →
      </Link>
    </div>
  );
}
