import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";

export default function AiCardIdentificationPage() {
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
            <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-purple to-neon-blue">
              Identify Cards Like a Pro
            </h1>
            <p className="text-xl text-slate-400 mb-8">
              The totally awesome way to recognize and catalog cards with AI power
            </p>
            <p className="text-lg font-semibold text-neon-purple mt-6">
              Free Tier: For personal collections
            </p>
          </div>

          {/* Section 1: Instant Recognition */}
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
                  <rect x="40" y="35" width="120" height="100" rx="8" stroke="#00D558" strokeWidth="3" />
                  <circle cx="100" cy="85" r="35" stroke="#00D558" strokeWidth="2" />
                  <circle cx="100" cy="85" r="25" stroke="#00C2FF" strokeWidth="1.5" opacity="0.6" />
                  <path d="M 100 50 L 100 30" stroke="#FFE600" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 100 120 L 100 140" stroke="#FFE600" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 65 85 L 45 85" stroke="#FFE600" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 135 85 L 155 85" stroke="#FFE600" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 70 65 L 55 50" stroke="#A44AFF" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <path d="M 130 65 L 145 50" stroke="#A44AFF" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <path d="M 70 105 L 55 120" stroke="#A44AFF" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <path d="M 130 105 L 145 120" stroke="#A44AFF" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-green">Instant Recognition</h2>
              <p className="text-lg text-slate-300 mb-6">
                Snap a photo and boom — our AI matches your card against verified manufacturer databases instantly. No waiting around, no manual searching.
                We&apos;re talking lightning-fast recognition that just works. Your card is identified in seconds with gnarly accuracy.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Lightning-Fast Speed</h4>
                    <p>Millisecond identification. No lag, no delays, totally rad.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Zero Manual Work</h4>
                    <p>No hunting through databases or typing data. The AI handles it all.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Insane Accuracy</h4>
                    <p>Gets it right almost every time. Sick recognition tech you&apos;ll love.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Complete Card Data */}
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
                  <rect x="40" y="35" width="120" height="50" rx="4" fill="#00D558" opacity="0.5" />
                  <text x="100" y="63" textAnchor="middle" fill="#000" fontSize="9" fontWeight="bold">
                    CARD IMAGE
                  </text>
                  <line x1="45" y1="95" x2="155" y2="95" stroke="#A44AFF" strokeWidth="1" />
                  <g opacity="0.8">
                    <line x1="45" y1="105" x2="155" y2="105" stroke="#FF2E9A" strokeWidth="1" />
                    <line x1="45" y1="115" x2="155" y2="115" stroke="#FF2E9A" strokeWidth="1" />
                    <line x1="45" y1="125" x2="155" y2="125" stroke="#FF2E9A" strokeWidth="1" />
                    <line x1="45" y1="135" x2="155" y2="135" stroke="#FF2E9A" strokeWidth="1" />
                    <line x1="45" y1="145" x2="155" y2="145" stroke="#FF2E9A" strokeWidth="1" />
                  </g>
                  <circle cx="165" cy="105" r="6" fill="#00C2FF" />
                  <circle cx="165" cy="125" r="6" fill="#FFE600" />
                  <circle cx="165" cy="145" r="6" fill="#A44AFF" />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue">Complete Card Data</h2>
              <p className="text-lg text-slate-300 mb-6">
                The AI doesn&apos;t just identify the card — it extracts everything about it. Player name, card number, set, year, manufacturer,
                condition grade, rarity, and way more. All the details you need are pulled automatically. You get a complete picture of every card.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">All the Details</h4>
                    <p>Player, set, year, condition, rarity — everything extracted automatically.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Zero Manual Entry</h4>
                    <p>No typing. No searching. The AI does all the work for you.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Complete Records</h4>
                    <p>Every card gets a full profile with all relevant information.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Accuracy & Verification */}
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
                  <circle cx="100" cy="100" r="70" stroke="#FFE600" strokeWidth="2" />
                  <circle cx="100" cy="100" r="65" stroke="#FFE600" strokeWidth="1" opacity="0.4" />
                  <path
                    d="M 75 100 L 90 115 L 130 75"
                    stroke="#00D558"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="100" cy="100" r="50" fill="none" stroke="#00C2FF" strokeWidth="1.5" opacity="0.5" />
                  <text x="100" y="145" textAnchor="middle" fill="#FFE600" fontSize="10" fontWeight="bold">
                    99.2%
                  </text>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-yellow">Accuracy & Verification</h2>
              <p className="text-lg text-slate-300 mb-6">
                The AI is seriously accurate — we&apos;re talking 99%+ on most cards. But you&apos;re in control. Double-check any identification,
                make manual corrections if you want, and verify everything before it goes in your collection. You&apos;ve got total power to fix anything.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Highly Accurate</h4>
                    <p>99%+ accuracy on card identification. That&apos;s rad precision.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Manual Verification</h4>
                    <p>Review and verify every ID before it&apos;s added to your collection.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Easy Corrections</h4>
                    <p>Spot an error? Fix it with one click. Your collection, your rules.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Machine Learning */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div className="md:order-2">
              <div className="bg-gradient-to-br from-neon-pink/10 to-neon-purple/10 rounded-2xl p-12 border border-neon-pink/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle cx="60" cy="80" r="20" stroke="#A44AFF" strokeWidth="2" />
                  <circle cx="140" cy="80" r="20" stroke="#A44AFF" strokeWidth="2" />
                  <circle cx="100" cy="140" r="20" stroke="#FF2E9A" strokeWidth="2" />
                  <path d="M 75 85 L 125 85" stroke="#00C2FF" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 75 75 L 125 135" stroke="#00C2FF" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                  <path d="M 125 75 L 75 135" stroke="#00D558" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                  <path d="M 60 100 L 60 120" stroke="#A44AFF" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M 140 100 L 140 120" stroke="#A44AFF" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M 100 160 L 100 170" stroke="#FF2E9A" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 90 170 L 100 170 L 110 170" stroke="#FFE600" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="50" cy="40" r="8" fill="#00D558" opacity="0.7" />
                  <circle cx="100" cy="30" r="8" fill="#00D558" opacity="0.7" />
                  <circle cx="150" cy="40" r="8" fill="#00D558" opacity="0.7" />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-pink">Machine Learning</h2>
              <p className="text-lg text-slate-300 mb-6">
                Here&apos;s where it gets sick — the system learns from every single correction you make. Catch a misidentification? Fix it,
                and the AI gets smarter. Over time, our model improves constantly, becoming more accurate for your specific collection type.
                The more you use it, the gnarlier it gets.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Learns From You</h4>
                    <p>Every correction improves the system for future identifications.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Gets Better Over Time</h4>
                    <p>The more you use it, the smarter it becomes. Totally rad improvement.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Adaptive AI</h4>
                    <p>The system adapts to your collection style and preferences.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800">
            <h2 className="text-3xl font-bold mb-4">Ready to Identify Cards Like a Boss?</h2>
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Let the AI handle the heavy lifting while you focus on collecting. Lightning-fast, accurate identification for every card in your collection.
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
