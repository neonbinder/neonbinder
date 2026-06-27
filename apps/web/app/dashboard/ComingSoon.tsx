import { useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Link, NeonHeader } from "../../components/primitives";
import { BindersIcon, ConvertIcon, MaximizeIcon } from "../../components/icons";

export default function ComingSoon() {
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const completeness = useQuery(api.publicProfile.getProfileCompleteness);
  const percent = completeness ?? 0;
  const totalBlocks = 15;
  const filledBlocks = Math.round((percent / 100) * totalBlocks);
  const clampedFilledBlocks = Math.min(Math.max(filledBlocks, 0), totalBlocks);
  const progressBar =
    "▓".repeat(clampedFilledBlocks) + "░".repeat(totalBlocks - clampedFilledBlocks);

  const handleProfileClick = () => {
    navigate("/profile");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-black relative overflow-hidden font-sans">
      {/* Content Container */}
      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12 text-center">
        {/* Construction Sign */}
        <div className="mb-0 inline-block">
          <div className="bg-neon-yellow text-black px-8 py-6 transform -rotate-2 shadow-2xl border-4 border-black">
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
            className="text-3xl font-bold text-neon-blue"
            style={{
              fontFamily: "'Lexend', sans-serif",
              textShadow: "0 0 10px rgba(0, 194, 255, 0.6)",
            }}
          >
            Your Collection Management Hub
          </p>

          {/* Features Grid */}
          <div className="grid md:grid-cols-3 gap-8 my-12">
            <div className="p-6 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="mb-4 flex justify-center">
                <BindersIcon size={60} />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-neon-green">
                Maintain
              </h3>
              <p className="text-slate-600 dark:text-slate-400">
                Your complete trading card collection in one powerful platform
              </p>
            </div>
            <div className="p-6 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="mb-4 flex justify-center">
                <ConvertIcon size={60} />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-neon-blue">
                Convert
              </h3>
              <p className="text-slate-600 dark:text-slate-400">
                Your inventory into listings across all major card selling platforms
              </p>
            </div>
            <div className="p-6 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="mb-4 flex justify-center">
                <MaximizeIcon size={80} />
              </div>
              <h3 className="text-xl font-semibold mb-2">
                Maximize
              </h3>
              <p className="text-slate-600 dark:text-slate-400">
                Your sales with multi-platform distribution
              </p>
            </div>
          </div>

          {/* Mailing List Message */}
          <div className="my-12 text-center">
            <p className="text-lg text-white leading-relaxed">
              Thanks for signing up for our mailing list! Follow along as we build and launch Neon Binder.
              We&apos;re excited to share our progress and get your feedback as we grow.
            </p>
          </div>

        </div>

        {/* Call to Action */}
        <div className="space-y-6">
          <p className="text-2xl font-bold text-neon-pink" style={{ fontFamily: "'Lexend', sans-serif" }}>
            ✨ Get Ready for Launch ✨
          </p>
          {isSignedIn && (
            <Link
              href="#"
              onClick={handleProfileClick}
              className="text-neon-blue text-lg font-semibold mb-8"
              style={{ color: "#00C2FF" }}
            >
              Complete Your Profile →
            </Link>
          )}
          <p className="text-xl text-white">
            Complete your profile information to be ready when we launch
          </p>
        </div>

        {/* 90s Footer Elements */}
        <div className="mt-16 pt-8 border-t-4 border-neon-purple space-y-3">
          <p className="text-lg font-bold text-neon-pink animate-pulse" style={{ fontFamily: "'Lexend', sans-serif" }}>
            {progressBar} {percent}% Complete
          </p>
          <p className="text-sm text-white" style={{ fontFamily: "'Lexend', sans-serif" }}>
            Built with retro vibes for the modern collector
          </p>
        </div>
      </div>
    </div>
  );
}
