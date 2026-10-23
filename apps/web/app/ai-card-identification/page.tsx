import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";
import { BrandMark } from "@/components/primitives/BrandMark";
import NeonButton from "@/components/modules/NeonButton";

export default function AiCardIdentificationPage() {
  const navigate = useNavigate();

  return (
    <>
      <header className="sticky top-0 z-10 bg-surface p-4 border-b-2 border-rule flex flex-row justify-between items-center">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 px-4 py-2 rounded-md hover:bg-hover focus-outline transition-colors"
        >
          <span className="text-xl">←</span>
          <span>Back</span>
        </button>
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="neon-header text-wordmark whitespace-nowrap max-sm:!text-xl">Neon Binder</span>
        </div>
        <div className="w-20" />
      </header>

      <main className="min-h-screen bg-surface p-8">
        <div className="max-w-5xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-16">
            <h1 className="text-5xl font-bold mb-4 text-neon-purple-text">
              Identify Cards Like a Pro
            </h1>
            <p className="text-xl text-ink-3 mb-8">
              The totally awesome way to recognize and catalog cards with AI power
            </p>
            <p className="text-lg font-semibold text-neon-purple-text mt-6">
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
                  <rect x="40" y="35" width="120" height="100" rx="8" stroke="var(--neon-green-text)" strokeWidth="3" />
                  <circle cx="100" cy="85" r="35" stroke="var(--neon-green-text)" strokeWidth="2" />
                  <circle cx="100" cy="85" r="25" stroke="var(--neon-blue-text)" strokeWidth="1.5" opacity="0.6" />
                  <path d="M 100 50 L 100 30" stroke="var(--neon-yellow-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 100 120 L 100 140" stroke="var(--neon-yellow-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 65 85 L 45 85" stroke="var(--neon-yellow-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 135 85 L 155 85" stroke="var(--neon-yellow-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 70 65 L 55 50" stroke="var(--neon-purple-text)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <path d="M 130 65 L 145 50" stroke="var(--neon-purple-text)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <path d="M 70 105 L 55 120" stroke="var(--neon-purple-text)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <path d="M 130 105 L 145 120" stroke="var(--neon-purple-text)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-green-text">Instant Recognition</h2>
              <p className="text-lg text-ink-2 mb-6">
                Snap a photo and boom — our AI matches your card against verified manufacturer databases instantly. No waiting around, no manual searching.
                We&apos;re talking lightning-fast recognition that just works. Your card is identified in seconds with gnarly accuracy.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Lightning-Fast Speed</h3>
                    <p>Millisecond identification. No lag, no delays, totally rad.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Zero Manual Work</h3>
                    <p>No hunting through databases or typing data. The AI handles it all.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Insane Accuracy</h3>
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
                  <rect x="35" y="25" width="130" height="150" rx="8" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <rect x="40" y="35" width="120" height="50" rx="4" fill="var(--neon-green)" opacity="0.5" />
                  <text x="100" y="63" textAnchor="middle" fill="#000" fontSize="9" fontWeight="bold">
                    CARD IMAGE
                  </text>
                  <line x1="45" y1="95" x2="155" y2="95" stroke="var(--neon-purple-text)" strokeWidth="1" />
                  <g opacity="0.8">
                    <line x1="45" y1="105" x2="155" y2="105" stroke="var(--neon-pink-text)" strokeWidth="1" />
                    <line x1="45" y1="115" x2="155" y2="115" stroke="var(--neon-pink-text)" strokeWidth="1" />
                    <line x1="45" y1="125" x2="155" y2="125" stroke="var(--neon-pink-text)" strokeWidth="1" />
                    <line x1="45" y1="135" x2="155" y2="135" stroke="var(--neon-pink-text)" strokeWidth="1" />
                    <line x1="45" y1="145" x2="155" y2="145" stroke="var(--neon-pink-text)" strokeWidth="1" />
                  </g>
                  <circle cx="165" cy="105" r="6" fill="var(--neon-blue-text)" />
                  <circle cx="165" cy="125" r="6" fill="var(--neon-yellow-text)" />
                  <circle cx="165" cy="145" r="6" fill="var(--neon-purple-text)" />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue-text">Complete Card Data</h2>
              <p className="text-lg text-ink-2 mb-6">
                The AI doesn&apos;t just identify the card — it extracts everything about it. Player name, card number, set, year, manufacturer,
                condition grade, rarity, and way more. All the details you need are pulled automatically. You get a complete picture of every card.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">All the Details</h3>
                    <p>Player, set, year, condition, rarity — everything extracted automatically.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Zero Manual Entry</h3>
                    <p>No typing. No searching. The AI does all the work for you.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Complete Records</h3>
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
                  <circle cx="100" cy="100" r="70" stroke="var(--neon-yellow-text)" strokeWidth="2" />
                  <circle cx="100" cy="100" r="65" stroke="var(--neon-yellow-text)" strokeWidth="1" opacity="0.4" />
                  <path
                    d="M 75 100 L 90 115 L 130 75"
                    stroke="var(--neon-green-text)"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="100" cy="100" r="50" fill="none" stroke="var(--neon-blue-text)" strokeWidth="1.5" opacity="0.5" />
                  <text x="100" y="145" textAnchor="middle" fill="var(--neon-yellow-text)" fontSize="10" fontWeight="bold">
                    99.2%
                  </text>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-yellow-text">Accuracy & Verification</h2>
              <p className="text-lg text-ink-2 mb-6">
                The AI is seriously accurate — we&apos;re talking 99%+ on most cards. But you&apos;re in control. Double-check any identification,
                make manual corrections if you want, and verify everything before it goes in your collection. You&apos;ve got total power to fix anything.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Highly Accurate</h3>
                    <p>99%+ accuracy on card identification. That&apos;s rad precision.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Manual Verification</h3>
                    <p>Review and verify every ID before it&apos;s added to your collection.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Easy Corrections</h3>
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
                  <circle cx="60" cy="80" r="20" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <circle cx="140" cy="80" r="20" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <circle cx="100" cy="140" r="20" stroke="var(--neon-pink-text)" strokeWidth="2" />
                  <path d="M 75 85 L 125 85" stroke="var(--neon-blue-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 75 75 L 125 135" stroke="var(--neon-blue-text)" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                  <path d="M 125 75 L 75 135" stroke="var(--neon-green-text)" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                  <path d="M 60 100 L 60 120" stroke="var(--neon-purple-text)" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M 140 100 L 140 120" stroke="var(--neon-purple-text)" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M 100 160 L 100 170" stroke="var(--neon-pink-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 90 170 L 100 170 L 110 170" stroke="var(--neon-yellow-text)" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="50" cy="40" r="8" fill="var(--neon-green-text)" opacity="0.7" />
                  <circle cx="100" cy="30" r="8" fill="var(--neon-green-text)" opacity="0.7" />
                  <circle cx="150" cy="40" r="8" fill="var(--neon-green-text)" opacity="0.7" />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-pink-text">Machine Learning</h2>
              <p className="text-lg text-ink-2 mb-6">
                Here&apos;s where it gets sick — the system learns from every single correction you make. Catch a misidentification? Fix it,
                and the AI gets smarter. Over time, our model improves constantly, becoming more accurate for your specific collection type.
                The more you use it, the gnarlier it gets.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Learns From You</h3>
                    <p>Every correction improves the system for future identifications.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Gets Better Over Time</h3>
                    <p>The more you use it, the smarter it becomes. Totally rad improvement.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Adaptive AI</h3>
                    <p>The system adapts to your collection style and preferences.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-rule">
            <h2 className="text-3xl font-bold mb-4">Ready to Identify Cards Like a Boss?</h2>
            <p className="text-lg text-ink-3 mb-8 max-w-2xl mx-auto">
              Let the AI handle the heavy lifting while you focus on collecting. Lightning-fast, accurate identification for every card in your collection.
            </p>
            <SignUpButton mode="modal">
              <NeonButton size="3">
                Get Started
              </NeonButton>
            </SignUpButton>
          </div>
        </div>
        {/* Scroll headroom (NEO-260) — 208px of empty space so the CTA above
            is not pinned to the bottom edge of the viewport when the document
            bottoms out. Same value as the signed-in shell; the arithmetic
            behind it is in src/layouts/binder-layout.tsx. Keep them in step,
            and do not express it in vh. */}
        <div aria-hidden="true" className="h-[208px]" />
      </main>
    </>
  );
}
