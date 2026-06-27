import React from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Link, useParams } from "react-router";

// — Inline SVG social icons —

function TwitterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162S8.597 18.163 12 18.163s6.162-2.759 6.162-6.162S15.403 5.838 12 5.838zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.73a4.85 4.85 0 0 1-1.01-.04z" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function ThreadsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
      <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.028-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.476l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 1.677-.011 3.122-.334 4.296-.955.998-.527 1.806-1.29 2.392-2.278-.898.275-1.87.413-2.905.413-2.81 0-5.152-1.035-6.78-2.912-1.462-1.694-2.208-4.013-2.167-6.716.04-2.703.853-5.014 2.288-6.709 1.589-1.869 3.875-2.879 6.617-2.879 2.742 0 4.988.986 6.504 2.852 1.31 1.62 2.056 3.96 2.056 6.546 0 3.85-1.67 6.85-4.591 8.46-1.598.886-3.45 1.354-5.55 1.354zm0-18.45c-1.84 0-3.258.678-4.212 1.951-.94 1.258-1.426 3.082-1.454 5.42.028 2.338.514 4.162 1.454 5.42.954 1.273 2.373 1.951 4.212 1.951h.007c1.838 0 3.257-.678 4.21-1.951.94-1.258 1.426-3.082 1.454-5.42-.028-2.338-.514-4.162-1.454-5.42-.953-1.273-2.372-1.951-4.21-1.951h-.007z" />
    </svg>
  );
}

// — Company favicon helper —

function CompanyIcon({ domain }: { domain: string }) {
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=20`}
      alt={domain}
      className="w-5 h-5"
    />
  );
}

// — Link button component —

function ProfileLinkButton({
  href,
  label,
  color1,
  color2,
  domain,
}: {
  href: string;
  label: string;
  color1: string;
  color2: string;
  domain?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="relative flex items-center justify-center w-full py-3 px-5 rounded-full font-semibold text-white transition-opacity hover:opacity-80"
      style={{
        background: `linear-gradient(135deg, ${color1}, ${color2})`,
        boxShadow: `0 0 12px #00D55899`,
      }}
    >
      {domain && (
        <div className="absolute left-8">
          <CompanyIcon domain={domain} />
        </div>
      )}
      <span>{label}</span>
      <span className="sr-only">{href}</span>
    </a>
  );
}

// — Page —

export default function PublicProfilePage() {
  const { username } = useParams<{ username: string }>();
  const profile = useQuery(api.publicProfile.getPublicProfileByUsername, {
    username: username!,
  });

  const color1 = profile?.brandColor1 ?? "#0a0a0a";
  const color2 = profile?.brandColor2 ?? "#1a1a2e";

  if (profile === undefined) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "#0a0a0a" }}
      >
        <div className="w-8 h-8 rounded-full border-2 border-white border-t-transparent animate-spin" />
      </div>
    );
  }

  if (profile === null) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 text-white px-6 text-center"
        style={{ background: "#0a0a0a" }}
      >
        <h1 className="text-2xl font-bold">Profile not found</h1>
        <p className="text-slate-400">
          Create yours at{" "}
          <Link to="/" className="underline text-white hover:opacity-80">
            NeonBinder
          </Link>
          .
        </p>
      </div>
    );
  }

  const marketplaceLinks = [
    { href: profile.ebayUrl, label: "eBay", domain: "ebay.com" },
    {
      href: profile.buySportsCardsUrl,
      label: "BuySportsCards",
      domain: "buysportscards.com",
    },
    { href: profile.sportlotsUrl, label: "Sportlots", domain: "sportlots.com" },
    { href: profile.mySlabsUrl, label: "MySlabs", domain: "myslabs.com" },
    {
      href: profile.myCardPostUrl,
      label: "MyCardPost",
      domain: "mycardpost.com",
    },
  ].filter(
    (l): l is { href: string; label: string; domain: string } => !!l.href,
  );

  const paymentLinks = [
    {
      href: profile.paypalUsername
        ? `https://paypal.me/${profile.paypalUsername}`
        : undefined,
      label: "PayPal (F&F)",
      domain: "paypal.com",
    },
    {
      href: profile.paypalEmail
        ? `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=${encodeURIComponent(profile.paypalEmail)}`
        : undefined,
      label: "PayPal (G&S)",
      domain: "paypal.com",
    },
    {
      href: profile.venmoUsername
        ? `https://venmo.com/${profile.venmoUsername}`
        : undefined,
      label: "Venmo",
      domain: "venmo.com",
    },
    {
      href: profile.cashAppUsername
        ? `https://cash.app/$${profile.cashAppUsername}`
        : undefined,
      label: "Cash App",
      domain: "cash.app",
    },
  ].filter(
    (l): l is { href: string; label: string; domain: string } => !!l.href,
  );

  const socialLinks = [
    { href: profile.twitterUrl, Icon: TwitterIcon, label: "Twitter/X" },
    { href: profile.instagramUrl, Icon: InstagramIcon, label: "Instagram" },
    { href: profile.tiktokUrl, Icon: TikTokIcon, label: "TikTok" },
    { href: profile.youtubeUrl, Icon: YouTubeIcon, label: "YouTube" },
    { href: profile.facebookUrl, Icon: FacebookIcon, label: "Facebook" },
    { href: profile.threadsUrl, Icon: ThreadsIcon, label: "Threads" },
  ].filter(
    (l): l is { href: string; Icon: () => React.ReactElement; label: string } =>
      !!l.href,
  );

  return (
    <div className="min-h-screen py-12 px-4" style={{ background: "#0a0a0a" }}>
      <div className="max-w-md mx-auto">
        {/* Card */}
        <div className="bg-black/50 backdrop-blur-sm rounded-2xl py-12 px-6 flex flex-col items-center gap-4 text-center">
          {/* Profile photo */}
          {profile.photoUrl ? (
            <img
              src={profile.photoUrl}
              alt={profile.displayName ?? profile.username}
              className="w-24 h-24 rounded-full object-cover border-2 border-white/20"
            />
          ) : (
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center text-3xl font-bold text-white"
              style={{
                background: `linear-gradient(135deg, ${color1}, ${color2})`,
                border: "2px solid rgba(255,255,255,0.2)",
              }}
            >
              {(profile.displayName ?? profile.username)
                .charAt(0)
                .toUpperCase()}
            </div>
          )}

          {/* Name + tagline */}
          <div>
            <h1
              className="text-2xl font-bold text-white"
              style={{ fontFamily: "'Neon', sans-serif" }}
            >
              {profile.displayName ?? profile.username}
            </h1>
            {profile.tagline && (
              <p className="text-slate-300 mt-1 text-sm font-['Lexend']">
                {profile.tagline}
              </p>
            )}
          </div>

          {/* Marketplace buttons */}
          {marketplaceLinks.length > 0 && (
            <div className="w-full mt-6">
              <div className="border-t border-white/10 pt-6">
                <h2 className="text-xs uppercase tracking-widest text-slate-400 font-semibold mb-4">
                  Marketplace Stores
                </h2>
                <div className="space-y-3">
                  {marketplaceLinks.map(({ href, label, domain }) => (
                    <ProfileLinkButton
                      key={label}
                      href={href}
                      label={label}
                      color1={color1}
                      color2={color2}
                      domain={domain}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Payment buttons */}
          {paymentLinks.length > 0 && (
            <div className="w-full mt-6">
              <div className="border-t border-white/10 pt-6">
                <h2 className="text-xs uppercase tracking-widest text-slate-400 font-semibold mb-4">
                  Payment Methods
                </h2>
                <div className="space-y-3">
                  {paymentLinks.map(({ href, label, domain }) => (
                    <ProfileLinkButton
                      key={label}
                      href={href}
                      label={label}
                      color1={color1}
                      color2={color2}
                      domain={domain}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Social icons */}
          {socialLinks.length > 0 && (
            <div className="w-full mt-6">
              <div className="border-t border-white/10 pt-6">
                <div className="flex gap-3 flex-wrap justify-center">
                  {socialLinks.map(({ href, Icon, label }) => (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={label}
                      className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
                    >
                      <Icon />
                      <span className="sr-only">{href}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="flex flex-col items-center gap-3 mt-8 pt-6 border-t border-white/10 w-full">
            <img
              src="/logo.png"
              alt="NeonBinder"
              width={40}
              height={40}
              className="opacity-70 hover:opacity-100 transition-opacity"
            />
            <p className="text-xs text-slate-500">
              Powered by{" "}
              <Link
                href="/"
                className="underline hover:text-slate-300 transition-colors"
              >
                NeonBinder
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
