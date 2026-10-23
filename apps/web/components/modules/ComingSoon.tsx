import { useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Link, NeonHeader } from "../primitives";
import { BindersIcon, ConvertIcon, MaximizeIcon } from "../icons";

export default function ComingSoon() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const completeness = useQuery(api.publicProfile.getProfileCompleteness);
  const percent = completeness ?? 0;
  const totalBlocks = 15;
  const filledBlocks = Math.round((percent / 100) * totalBlocks);
  const progressBar =
    "▓".repeat(filledBlocks) + "░".repeat(totalBlocks - filledBlocks);

  const handleProfileClick = () => {
    navigate("/profile");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface relative overflow-hidden font-sans">
      {/* Content Container */}
      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12 text-center">
        {/* Construction Sign */}
        <div className="mb-0 inline-block">
          <div className="bg-neon-yellow text-on-neon-yellow px-8 py-6 transform -rotate-2 shadow-2xl border-4 border-on-neon-yellow">
            <div className="text-5xl font-bold mb-3">🚧</div>
            <div className="text-3xl font-bold mb-2" style={{ fontFamily: "'Lexend', sans-serif" }}>
              COMING SOON
            </div>
            <div className="text-base font-bold" style={{ fontFamily: "'Lexend', sans-serif" }}>
              UNDER CONSTRUCTION
            </div>
          </div>
        </div>

        {/* Main Heading */}
        <NeonHeader>Neon Binder</NeonHeader>

        {/* Subtitle */}
        <div className="mb-12 space-y-6">
          <p
            className="text-3xl font-bold text-neon-blue-text"
            style={{
              fontFamily: "'Lexend', sans-serif",
              // Scaled by --glow (app/theme.css): lit in dark, none in light.
              textShadow: "0 0 10px rgb(0 194 255 / calc(0.6 * var(--glow)))",
            }}
          >
            Your Collection Management Hub
          </p>

          {/* Features Grid */}
          <div className="grid md:grid-cols-3 gap-8 my-12">
            <div className="p-6 rounded-lg bg-field border border-rule">
              <div className="mb-4 flex justify-center">
                <BindersIcon size={60} />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-neon-green-text">
                Maintain
              </h3>
              <p className="text-ink-3">
                Your complete trading card collection in one powerful platform
              </p>
            </div>
            <div className="p-6 rounded-lg bg-field border border-rule">
              <div className="mb-4 flex justify-center">
                <ConvertIcon size={60} />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-neon-blue-text">
                Convert
              </h3>
              <p className="text-ink-3">
                Your inventory into listings across all major card selling platforms
              </p>
            </div>
            <div className="p-6 rounded-lg bg-field border border-rule">
              <div className="mb-4 flex justify-center">
                <MaximizeIcon size={80} />
              </div>
              <h3 className="text-xl font-semibold mb-2">
                Maximize
              </h3>
              <p className="text-ink-3">
                Your sales with multi-platform distribution
              </p>
            </div>
          </div>

          {/* Mailing List Message */}
          <div className="my-12 text-center">
            <p className="text-lg text-ink leading-relaxed">
              Thanks for signing up for our mailing list! Follow along as we build and launch Neon Binder.
              We&apos;re excited to share our progress and get your feedback as we grow.
            </p>
          </div>

        </div>

        {/* Call to Action */}
        <div className="space-y-6">
          <p className="text-2xl font-bold text-neon-pink-text" style={{ fontFamily: "'Lexend', sans-serif" }}>
            ✨ Get Ready for Launch ✨
          </p>
          {isSignedIn && (
            <Link
              href="#"
              onClick={handleProfileClick}
              className="text-neon-blue-text text-lg font-semibold mb-8"
            >
              Complete Your Profile →
            </Link>
          )}
          <p className="text-xl text-ink">
            Complete your profile information to be ready when we launch
          </p>
        </div>

        {/* 90s Footer Elements */}
        <div className="mt-16 pt-8 border-t-4 border-neon-purple space-y-3">
          <p className="text-lg font-bold text-neon-pink-text animate-neon-glow" style={{ fontFamily: "'Lexend', sans-serif" }}>
            {progressBar} {percent}% Complete
          </p>
          <p className="text-sm text-ink" style={{ fontFamily: "'Lexend', sans-serif" }}>
            Built with retro vibes for the modern collector
          </p>
        </div>
      </div>
    </div>
  );
}
