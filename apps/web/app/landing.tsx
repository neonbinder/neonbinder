import { SignInButton, SignUpButton } from "@clerk/clerk-react";
import { useNavigate } from "react-router";
import { NeonHeader, PullingLogo } from "../components/primitives";
import { BindersIcon } from "../components/icons";

export default function LandingPage() {
  const navigate = useNavigate();

  const handleBindersClick = () => {
    navigate("/binder-tracking");
  };

  const handleAiIdentificationClick = () => {
    navigate("/ai-card-identification");
  };

  const handleManagingInventoryClick = () => {
    navigate("/managing-inventory");
  };

  return (
    <>
      <header className="sticky top-0 z-10 bg-background p-4 border-b-2 border-slate-200 dark:border-slate-800 flex flex-row justify-between items-center">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Neon Binder" width={40} height={40} />
          <span className="neon-header">Neon Binder</span>
        </div>
        <div className="flex items-center gap-3">
          <SignInButton mode="modal">
            <button className="px-4 py-2 rounded-md bg-slate-600 hover:bg-slate-700 text-white transition-colors">
              Sign In
            </button>
          </SignInButton>
        </div>
      </header>
      <main className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-16">
            <div className="flex justify-center mb-8">
              <PullingLogo size="large" animate={true} />
            </div>
            <NeonHeader />
            <p className="text-2xl text-slate-600 dark:text-slate-400 mb-8">
              Your digital card collection hub
            </p>
            <div className="flex gap-4 justify-center">
              <SignInButton mode="modal">
                <button className="px-8 py-4 rounded-lg bg-neon-green hover:bg-neon-green/85 text-black text-lg font-semibold transition-colors">
                  Get Started
                </button>
              </SignInButton>
            </div>
            <p className="text-lg text-slate-500 dark:text-slate-300 mt-6 max-w-2xl mx-auto font-medium">
              Claim your spot before the beta drops. Get early access and insider updates—no FOMO allowed.
            </p>
          </div>

          {/* Free Tier Positioning */}
          <div className="text-center mb-16 p-8 rounded-lg bg-gradient-to-r from-neon-green/10 to-neon-blue/10 border border-neon-green/30">
            <p className="text-2xl font-bold text-neon-green">
              Free Tier: Track your collection for Free Forever
            </p>
            <p className="text-lg text-slate-400 mt-3">
              Paid tier coming soon for multi-platform inventory management
            </p>
          </div>

          {/* Card Show Sales — Available Today */}
          <button
            onClick={handleManagingInventoryClick}
            className="w-full my-16 p-8 rounded-lg bg-gradient-to-r from-pink-900/30 to-green-900/30 border border-pink-500/40 hover:border-green-500 hover:shadow-lg hover:shadow-green-500/20 transition-all cursor-pointer text-left"
          >
            <div className="flex items-center gap-3 mb-4">
              <span className="text-3xl">📱</span>
              <h3 className="text-2xl font-bold">Card Show Sales</h3>
              <span className="ml-auto px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-full bg-green-500 text-black">
                Available Today
              </span>
            </div>
            <p className="text-lg text-slate-300">
              Slap a QR code on each card, and buyers scan to see what they owe. Running total adds up as they shop, then they pay you instantly through PayPal, Venmo, or Cash App. No app download, no awkward math, no fumbling with change. That&apos;s how you run a table, dude.
            </p>
          </button>

          {/* Features Section */}
          <div className="grid md:grid-cols-3 gap-8 mb-16">
            <button
              onClick={handleBindersClick}
              className="p-6 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-green-500 dark:hover:border-green-500 hover:shadow-lg hover:shadow-green-500/20 transition-all cursor-pointer text-left"
            >
              <div className="mb-4">
                <BindersIcon size={60} />
              </div>
              <h3 className="text-xl font-semibold mb-2">
                Fill Binders for Collection Tracking
              </h3>
              <p className="text-slate-600 dark:text-slate-400">
                Organize and track your card collection with digital binders using verified manufacturer checklists or custom organization. See exactly what you own and what you&apos;re missing.
              </p>
            </button>
            <button
              onClick={handleAiIdentificationClick}
              className="p-6 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-purple-500 dark:hover:border-purple-500 hover:shadow-lg hover:shadow-purple-500/20 transition-all cursor-pointer text-left"
            >
              <div className="text-4xl mb-4">🤖</div>
              <h3 className="text-xl font-semibold mb-2">AI-Based Card Identification</h3>
              <p className="text-slate-600 dark:text-slate-400">
                Our AI matches your photos against verified manufacturer databases automatically, taking the guesswork out of cataloging and ensuring accurate collection data.
              </p>
            </button>
            <button
              onClick={handleManagingInventoryClick}
              className="p-6 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-500 dark:hover:border-blue-500 hover:shadow-lg hover:shadow-blue-500/20 transition-all cursor-pointer text-left"
            >
              <div className="text-4xl mb-4">🌐</div>
              <h3 className="text-xl font-semibold mb-2">Manage Multiple Inventory Sites</h3>
              <p className="text-slate-600 dark:text-slate-400">
                Track inventory across eBay, BuySportsCards, MySlabs, MyCardPost, and SportLots all in one place. Coming soon for sellers.
              </p>
            </button>
          </div>

          {/* How It Works Section */}
          <div className="my-16 p-8 rounded-lg bg-gradient-to-br from-green-900/20 to-blue-900/20 border border-green-500/30">
            <h2 className="text-3xl font-bold mb-8 text-center">
              How It Works
            </h2>
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
                  1
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">
                    Take Pictures of Your Cards
                  </h3>
                  <p className="text-slate-600 dark:text-slate-400">
                    Snap photos of your card collection using your phone or camera for quick and easy import.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
                  2
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">
                    Import Your Cards
                  </h3>
                  <p className="text-slate-600 dark:text-slate-400">
                    Upload your photos and let Neon Binder automatically identify and catalog your cards.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
                  3
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">
                    Build Your Binders
                  </h3>
                  <p className="text-slate-600 dark:text-slate-400">
                    Organize your collection into custom binders however you want—by sport, player, year, or any criteria you choose.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
                  4
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">
                    Synchronize to Sales Sites
                  </h3>
                  <p className="text-slate-600 dark:text-slate-400">
                    Automatically sync your listings to eBay, BuySportsCards, MySlabs, MyCardPost, and SportLots all at once.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
                  5
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">
                    Track Sales & Get Daily Pull Sheets
                  </h3>
                  <p className="text-slate-600 dark:text-slate-400">
                    Monitor your sales across all platforms, receive daily shipping-ready pull sheets, and track financial performance with built-in analytics.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center my-16">
            <h2 className="text-4xl font-bold mb-4">
              Ready to Build Your Collection?
            </h2>
            <p className="text-xl text-slate-600 dark:text-slate-400 mb-8">
              Start tracking your collection for free forever. No credit card required.
            </p>
            <div className="flex gap-4 justify-center">
              <SignUpButton mode="modal">
                <button className="px-8 py-4 rounded-lg bg-neon-green hover:bg-neon-green/85 text-black text-lg font-semibold transition-colors">
                  Create Free Account
                </button>
              </SignUpButton>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
