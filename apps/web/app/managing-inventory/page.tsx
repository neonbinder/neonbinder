import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";
import { BrandMark } from "@/components/primitives/BrandMark";

export default function ManagingInventoryPage() {
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
          <span className="neon-header text-wordmark">Neon Binder</span>
        </div>
        <div className="w-20" />
      </header>

      <main className="min-h-screen bg-surface p-8">
        <div className="max-w-5xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-16">
            <h1 className="text-5xl font-bold mb-4 text-neon-blue-text">
              Sell Your Cards Everywhere
            </h1>
            <p className="text-xl text-ink-3 mb-8">
              Manage your entire inventory across all platforms from one totally rad place
            </p>
            <p className="text-lg font-semibold text-neon-blue-text mt-6">
              Paid tier: Coming soon for sellers
            </p>
          </div>

          {/* Section 1: One Upload, Multiple Platforms */}
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
                  <rect x="45" y="60" width="110" height="80" rx="8" stroke="var(--neon-green-text)" strokeWidth="3" />
                  <text x="100" y="105" textAnchor="middle" fill="var(--neon-green-text)" fontSize="10" fontWeight="bold">
                    CARD
                  </text>
                  <circle cx="25" cy="40" r="12" stroke="var(--neon-blue-text)" strokeWidth="2" />
                  <circle cx="175" cy="40" r="12" stroke="var(--neon-yellow-text)" strokeWidth="2" />
                  <circle cx="25" cy="160" r="12" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <circle cx="175" cy="160" r="12" stroke="var(--neon-pink-text)" strokeWidth="2" />
                  <circle cx="100" cy="20" r="12" stroke="var(--neon-green-text)" strokeWidth="2" />
                  <path d="M 55 70 L 30 48" stroke="var(--neon-blue-text)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 145 70 L 170 48" stroke="var(--neon-yellow-text)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 55 130 L 30 152" stroke="var(--neon-purple-text)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 145 130 L 170 152" stroke="var(--neon-pink-text)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 100 60 L 100 32" stroke="var(--neon-green-text)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-green-text">One Upload, Multiple Platforms</h2>
              <p className="text-lg text-ink-2 mb-6">
                List your cards once and watch them sync instantly to eBay, BuySportsCards, MySlabs, MyCardPost, and SportLots.
                No copy-paste, no manual uploads, no duplicate work. One action, five platforms. That&apos;s totally rad.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">List One Time</h3>
                    <p>Upload once, sync everywhere automatically. No extra work needed.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">All 5 Platforms</h3>
                    <p>eBay, BuySportsCards, MySlabs, MyCardPost, SportLots — instantly available.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Zero Duplicate Work</h3>
                    <p>Never manually upload the same card twice. Automation handles it all.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Real-Time Inventory Control */}
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
                  <rect x="20" y="30" width="160" height="140" rx="8" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <rect x="30" y="40" width="140" height="20" rx="4" fill="var(--neon-purple)" opacity="0.3" />
                  <text x="100" y="54" textAnchor="middle" fill="var(--neon-purple-text)" fontSize="9" fontWeight="bold">
                    INVENTORY
                  </text>
                  <line x1="30" y1="70" x2="160" y2="70" stroke="var(--neon-pink-text)" strokeWidth="1" />
                  <g opacity="0.8">
                    <rect x="30" y="75" width="40" height="12" rx="2" fill="var(--neon-green)" />
                    <text x="50" y="83" textAnchor="middle" fill="#000" fontSize="7" fontWeight="bold">
                      eBay
                    </text>
                    <rect x="75" y="75" width="40" height="12" rx="2" fill="var(--neon-blue)" />
                    <text x="95" y="83" textAnchor="middle" fill="#000" fontSize="7" fontWeight="bold">
                      Sports
                    </text>
                    <rect x="120" y="75" width="40" height="12" rx="2" fill="var(--neon-yellow)" />
                    <text x="140" y="83" textAnchor="middle" fill="#000" fontSize="7" fontWeight="bold">
                      MySlabs
                    </text>
                    <rect x="30" y="95" width="40" height="12" rx="2" fill="var(--neon-purple)" />
                    <text x="50" y="103" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold">
                      MyCard
                    </text>
                    <rect x="75" y="95" width="40" height="12" rx="2" fill="var(--neon-pink)" />
                    <text x="95" y="103" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold">
                      SportLots
                    </text>
                  </g>
                  <path d="M 165 115 L 175 110 M 165 115 L 170 125" stroke="var(--neon-green-text)" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue-text">Real-Time Inventory Control</h2>
              <p className="text-lg text-ink-2 mb-6">
                Watch your inventory update instantly across all five platforms. When a card sells on one platform, it&apos;s immediately removed from inventory everywhere else,
                preventing overselling. Stock levels stay perfectly synced, keeping your reputation solid. Every card tracked, every platform in sync, always.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Track Stock Everywhere</h3>
                    <p>See your inventory levels across all platforms instantly.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Prevent Overselling</h3>
                    <p>Never sell the same card twice. Automatic sync keeps you protected.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Perfect Sync Guaranteed</h3>
                    <p>All platforms stay in perfect sync at all times. That&apos;s gnarly accuracy.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Sales Intelligence */}
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
                  <rect x="25" y="30" width="150" height="140" rx="8" stroke="var(--neon-yellow-text)" strokeWidth="2" />
                  <line x1="35" y1="150" x2="165" y2="150" stroke="var(--neon-yellow-text)" strokeWidth="2" />
                  <line x1="35" y1="150" x2="35" y2="40" stroke="var(--neon-yellow-text)" strokeWidth="2" />
                  <rect x="45" y="110" width="15" height="40" fill="var(--neon-green)" opacity="0.7" />
                  <rect x="70" y="85" width="15" height="65" fill="var(--neon-blue)" opacity="0.7" />
                  <rect x="95" y="70" width="15" height="80" fill="var(--neon-purple)" opacity="0.7" />
                  <rect x="120" y="95" width="15" height="55" fill="var(--neon-pink)" opacity="0.7" />
                  <rect x="145" y="60" width="15" height="90" fill="var(--neon-yellow)" opacity="0.7" />
                  <circle cx="52" cy="105" r="3" fill="var(--neon-green-text)" />
                  <circle cx="77" cy="80" r="3" fill="var(--neon-blue-text)" />
                  <circle cx="102" cy="65" r="3" fill="var(--neon-purple-text)" />
                  <circle cx="127" cy="90" r="3" fill="var(--neon-pink-text)" />
                  <circle cx="152" cy="55" r="3" fill="var(--neon-yellow-text)" />
                  <path d="M 52 105 L 77 80 L 102 65 L 127 90 L 152 55" stroke="var(--neon-green-text)" strokeWidth="1.5" opacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-yellow-text">Sales Intelligence</h2>
              <p className="text-lg text-ink-2 mb-6">
                Get the full picture of your sales across all platforms. See which cards are selling hot and which ones are sitting.
                Track performance marketplace by marketplace, monitor profitability, and make smart decisions based on real data. Built-in financial tracking keeps you informed every step of the way. Knowledge is power, dude.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">See Which Cards Sold</h3>
                    <p>Track which cards moved and on which platforms. Total visibility.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Platform Performance</h3>
                    <p>Compare sales across eBay, BuySportsCards, MySlabs, MyCardPost, SportLots.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Data-Driven Decisions</h3>
                    <p>Use sales data to optimize your inventory strategy. Smart moves based on facts.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: QR Codes for In-Person Sales */}
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
                  <rect x="30" y="30" width="70" height="70" stroke="var(--neon-pink-text)" strokeWidth="2" />
                  <g opacity="0.6">
                    <rect x="35" y="35" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="52" y="35" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="69" y="35" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="35" y="52" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="69" y="52" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="35" y="69" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="52" y="69" width="8" height="8" fill="var(--neon-pink)" />
                    <rect x="69" y="69" width="8" height="8" fill="var(--neon-pink)" />
                  </g>
                  <rect x="115" y="40" width="50" height="50" rx="4" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <text x="140" y="72" textAnchor="middle" fill="var(--neon-purple-text)" fontSize="9" fontWeight="bold">
                    CARD
                  </text>
                  <circle cx="160" cy="120" r="25" stroke="var(--neon-blue-text)" strokeWidth="2" />
                  <line x1="160" y1="100" x2="160" y2="95" stroke="var(--neon-blue-text)" strokeWidth="2" strokeLinecap="round" />
                  <line x1="160" y1="140" x2="160" y2="145" stroke="var(--neon-blue-text)" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 145 125 L 140 130 M 175 125 L 180 130" stroke="var(--neon-yellow-text)" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="50" cy="130" r="15" fill="none" stroke="var(--neon-pink-text)" strokeWidth="2" />
                  <path d="M 50 118 L 45 125 L 55 125" stroke="var(--neon-green-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <text x="50" y="148" textAnchor="middle" fill="var(--neon-pink-text)" fontSize="7" fontWeight="bold">
                    SCAN
                  </text>
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-pink-text">Dominate the Card Show</h2>
              <p className="text-lg text-ink-2 mb-6">
                Take your business to card shows and beyond. Generate a unique QR code for each card. Buyers scan at the show,
                you get instant updates on your phone. Sell in-person with full platform tracking. That&apos;s the future of card selling, dude.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Generate QR Per Card</h3>
                    <p>Every card gets its own unique QR code for instant identification.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Sell at Card Shows</h3>
                    <p>Buyers scan, you get instant notifications. Totally rad in-person selling.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Instant Platform Updates</h3>
                    <p>Sales tracked automatically across your inventory system in real-time.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-rule">
            <h2 className="text-3xl font-bold mb-4">Ready to Sell Everywhere?</h2>
            <p className="text-lg text-ink-3 mb-8 max-w-2xl mx-auto">
              Manage your entire inventory from one place and sell across all platforms simultaneously. One upload, total control, maximum reach.
            </p>
            <SignUpButton mode="modal">
              <button className="px-8 py-4 rounded-lg bg-neon-green hover:bg-neon-green-hover text-on-neon-green text-lg font-semibold transition-colors focus-outline">
                Get Started
              </button>
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
