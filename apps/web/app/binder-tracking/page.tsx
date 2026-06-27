import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";

export default function BinderTrackingPage() {
  const navigate = useNavigate();

  return (
    <>
      <header className="sticky top-0 z-10 bg-background p-4 border-b-2 border-slate-200 dark:border-slate-800 flex flex-row justify-between items-center">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 px-4 py-2 rounded-md hover:bg-slate-700 transition-colors"
        >
          <span className="text-xl">←</span>
          <span>Back</span>
        </button>
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Neon Binder" width={40} height={40} />
          <span className="neon-header">Neon Binder</span>
        </div>
        <div className="w-20" />
      </header>

      <main className="min-h-screen bg-background p-8">
        <div className="max-w-5xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-16">
            <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-green to-neon-blue">
              Track Your Collection Like It&apos;s 1995
            </h1>
            <p className="text-xl text-slate-400 mb-8">
              The totally rad way to catalog, organize, and manage your trading cards
            </p>
            <p className="text-lg font-semibold text-neon-green mt-6">
              Free Tier: Track your collection for Free Forever
            </p>
          </div>

          {/* Section 1: Upload Cards */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div>
              <div className="bg-gradient-to-br from-neon-green/10 to-neon-blue/10 rounded-2xl p-12 border border-neon-green/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect
                    x="30"
                    y="40"
                    width="140"
                    height="100"
                    rx="8"
                    stroke="#00D558"
                    strokeWidth="3"
                  />
                  <circle cx="100" cy="90" r="30" stroke="#00D558" strokeWidth="2" />
                  <circle cx="100" cy="90" r="20" stroke="#00C2FF" strokeWidth="2" />
                  <path
                    d="M 60 130 L 140 130"
                    stroke="#FFE600"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <rect
                    x="50"
                    y="155"
                    width="100"
                    height="8"
                    rx="4"
                    fill="#A44AFF"
                    opacity="0.5"
                  />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-green">Snap & Upload</h2>
              <p className="text-lg text-slate-300 mb-6">
                Dude, it&apos;s super easy. Whip out your phone or camera and snap pics of your cards. Upload them to Neon Binder and we&apos;ll handle the rest. 
                No need to be a professional photographer — just point and shoot. We&apos;re all about keeping it simple and rad.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Quick & Dirty</h4>
                    <p>No fancy equipment needed. Your phone camera is totally enough.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Batch Upload</h4>
                    <p>Upload multiple cards at once and we&apos;ll process them all in one go.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Front & Back</h4>
                    <p>Capture both sides for maximum info and killer accuracy.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Locate in Database */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div className="md:order-2">
              <div className="bg-gradient-to-br from-neon-purple/10 to-neon-pink/10 rounded-2xl p-12 border border-neon-purple/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect x="35" y="25" width="130" height="150" rx="8" stroke="#A44AFF" strokeWidth="2" />
                  <g opacity="0.6">
                    <line x1="45" y1="50" x2="155" y2="50" stroke="#A44AFF" strokeWidth="1.5" />
                    <line x1="45" y1="70" x2="155" y2="70" stroke="#A44AFF" strokeWidth="1" />
                    <line x1="45" y1="90" x2="155" y2="90" stroke="#A44AFF" strokeWidth="1" />
                    <line x1="45" y1="110" x2="155" y2="110" stroke="#A44AFF" strokeWidth="1" />
                    <line x1="45" y1="130" x2="155" y2="130" stroke="#A44AFF" strokeWidth="1" />
                  </g>
                  <circle cx="65" cy="50" r="5" fill="#00D558" />
                  <circle cx="85" cy="70" r="5" fill="#00D558" />
                  <circle cx="105" cy="90" r="5" fill="#00D558" />
                  <path
                    d="M 75 160 L 85 170 L 95 160"
                    stroke="#00C2FF"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue">We Find Your Cards</h2>
              <p className="text-lg text-slate-300 mb-6">
                This is where the magic happens, my friend. Our insanely comprehensive card set database has got nearly every card ever printed. 
                We&apos;ll automatically match your photos to official data — player names, card numbers, year, manufacturer, condition grades, the whole nine yards.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Massive Database</h4>
                    <p>Thousands of sets spanning decades of card history. We got &apos;em all.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Instant Matching</h4>
                    <p>Automatic identification with zero effort from you. Sick, right?</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Verify & Correct</h4>
                    <p>Double-check the matches and make manual adjustments if needed. Total control.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Build Your Binder */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div>
              <div className="bg-gradient-to-br from-neon-yellow/10 to-neon-green/10 rounded-2xl p-12 border border-neon-yellow/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect x="20" y="30" width="60" height="140" rx="4" stroke="#FFE600" strokeWidth="2" />
                  <rect x="70" y="30" width="60" height="140" rx="4" stroke="#00D558" strokeWidth="2" />
                  <rect x="120" y="30" width="60" height="140" rx="4" stroke="#00C2FF" strokeWidth="2" />
                  <line x1="30" y1="55" x2="70" y2="55" stroke="#FFE600" strokeWidth="1.5" />
                  <line x1="30" y1="70" x2="70" y2="70" stroke="#FFE600" strokeWidth="1.5" />
                  <line x1="30" y1="85" x2="70" y2="85" stroke="#FFE600" strokeWidth="1.5" />
                  <line x1="80" y1="55" x2="120" y2="55" stroke="#00D558" strokeWidth="1.5" />
                  <line x1="80" y1="70" x2="120" y2="70" stroke="#00D558" strokeWidth="1.5" />
                  <line x1="80" y1="85" x2="120" y2="85" stroke="#00D558" strokeWidth="1.5" />
                  <line x1="130" y1="55" x2="170" y2="55" stroke="#00C2FF" strokeWidth="1.5" />
                  <line x1="130" y1="70" x2="170" y2="70" stroke="#00C2FF" strokeWidth="1.5" />
                  <line x1="130" y1="85" x2="170" y2="85" stroke="#00C2FF" strokeWidth="1.5" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-yellow">Build It Your Way</h2>
              <p className="text-lg text-slate-300 mb-6">
                Here&apos;s the best part — organize your cards however YOU want. Use our verified manufacturer checklists for instant accuracy or create your own custom binders.
                By set, by player, by team, by year, by condition... organize them however your collecting heart desires. We&apos;ll let you create unlimited custom collections
                and arrange your cards exactly how you like it. No rules. Total freedom.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Unlimited Binders</h4>
                    <p>Create as many custom collections as you want. Go wild.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Mix & Match</h4>
                    <p>Drag cards between binders. Organize however makes sense to you.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Your Rules</h4>
                    <p>Custom sorting, filtering, and organization options for maximum control.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Track Everything */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div className="md:order-2">
              <div className="bg-gradient-to-br from-neon-pink/10 to-neon-purple/10 rounded-2xl p-12 border border-neon-pink/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 220 180"
                  width="200"
                  height="180"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect x="10" y="10" width="200" height="160" rx="8" stroke="#FF2E9A" strokeWidth="2" />
                  <line x1="10" y1="35" x2="210" y2="35" stroke="#FF2E9A" strokeWidth="1.5" />
                  <text x="110" y="28" textAnchor="middle" fill="#FF2E9A" fontSize="11" fontWeight="bold">
                    STATS
                  </text>
                  <rect x="20" y="45" width="180" height="18" rx="2" fill="#00D558" opacity="0.7" />
                  <text x="25" y="57" fill="#000" fontSize="9" fontWeight="bold">
                    CARDS OWNED
                  </text>
                  <text x="195" y="57" fill="#000" fontSize="9" fontWeight="bold" textAnchor="end">
                    2,847
                  </text>
                  <rect x="20" y="68" width="180" height="18" rx="2" fill="#00C2FF" opacity="0.7" />
                  <text x="25" y="80" fill="#000" fontSize="9" fontWeight="bold">
                    COLLECTION VALUE
                  </text>
                  <text x="195" y="80" fill="#000" fontSize="9" fontWeight="bold" textAnchor="end">
                    $45.2K
                  </text>
                  <rect x="20" y="91" width="180" height="18" rx="2" fill="#A44AFF" opacity="0.7" />
                  <text x="25" y="103" fill="#000" fontSize="9" fontWeight="bold">
                    SETS COMPLETE
                  </text>
                  <text x="195" y="103" fill="#000" fontSize="9" fontWeight="bold" textAnchor="end">
                    73%
                  </text>
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-pink">Track Everything</h2>
              <p className="text-lg text-slate-300 mb-6">
                Now for the gnarly part — get all the stats you could ever want. Real-time tracking of your entire collection. 
                See your total card count, estimated collection value, completion percentages for each set, rarity breakdowns, 
                condition distributions, and way more. Knowledge is power, dude. Track it all.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Collection Value</h4>
                    <p>Automatic valuation based on current market data. Know what you&apos;re holding.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Set Completion</h4>
                    <p>Track percentage complete for each set. See exactly what you&apos;re missing.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Full Analytics</h4>
                    <p>Card counts, condition grades, rarity distributions, and detailed statistics.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Search & Filter</h4>
                    <p>Instantly find any card or set in your collection with powerful search tools.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800">
            <h2 className="text-3xl font-bold mb-4">Ready to Get Totally Radical?</h2>
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Start tracking your collection like a true collector. Upload your first batch of cards and watch Neon Binder do its magic.
            </p>
            <SignUpButton mode="modal">
              <button className="px-8 py-4 rounded-lg bg-neon-green hover:bg-neon-green/85 text-black text-lg font-semibold transition-colors">
                Get Started
              </button>
            </SignUpButton>
          </div>
        </div>
      </main>
    </>
  );
}
