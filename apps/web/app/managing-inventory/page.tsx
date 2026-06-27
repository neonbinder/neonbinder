import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";

export default function ManagingInventoryPage() {
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
            <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-blue to-neon-green">
              Sell Your Cards Everywhere
            </h1>
            <p className="text-xl text-slate-400 mb-8">
              Manage your entire inventory across all platforms from one totally rad place
            </p>
            <p className="text-lg font-semibold text-neon-blue mt-6">
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
                  <rect x="45" y="60" width="110" height="80" rx="8" stroke="#00D558" strokeWidth="3" />
                  <text x="100" y="105" textAnchor="middle" fill="#00D558" fontSize="10" fontWeight="bold">
                    CARD
                  </text>
                  <circle cx="25" cy="40" r="12" stroke="#00C2FF" strokeWidth="2" />
                  <circle cx="175" cy="40" r="12" stroke="#FFE600" strokeWidth="2" />
                  <circle cx="25" cy="160" r="12" stroke="#A44AFF" strokeWidth="2" />
                  <circle cx="175" cy="160" r="12" stroke="#FF2E9A" strokeWidth="2" />
                  <circle cx="100" cy="20" r="12" stroke="#00D558" strokeWidth="2" />
                  <path d="M 55 70 L 30 48" stroke="#00C2FF" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 145 70 L 170 48" stroke="#FFE600" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 55 130 L 30 152" stroke="#A44AFF" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 145 130 L 170 152" stroke="#FF2E9A" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <path d="M 100 60 L 100 32" stroke="#00D558" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-green">One Upload, Multiple Platforms</h2>
              <p className="text-lg text-slate-300 mb-6">
                List your cards once and watch them sync instantly to eBay, BuySportsCards, MySlabs, MyCardPost, and SportLots.
                No copy-paste, no manual uploads, no duplicate work. One action, five platforms. That&apos;s totally rad.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">List One Time</h4>
                    <p>Upload once, sync everywhere automatically. No extra work needed.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">All 5 Platforms</h4>
                    <p>eBay, BuySportsCards, MySlabs, MyCardPost, SportLots — instantly available.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Zero Duplicate Work</h4>
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
                  <rect x="20" y="30" width="160" height="140" rx="8" stroke="#A44AFF" strokeWidth="2" />
                  <rect x="30" y="40" width="140" height="20" rx="4" fill="#A44AFF" opacity="0.3" />
                  <text x="100" y="54" textAnchor="middle" fill="#A44AFF" fontSize="9" fontWeight="bold">
                    INVENTORY
                  </text>
                  <line x1="30" y1="70" x2="160" y2="70" stroke="#FF2E9A" strokeWidth="1" />
                  <g opacity="0.8">
                    <rect x="30" y="75" width="40" height="12" rx="2" fill="#00D558" />
                    <text x="50" y="83" textAnchor="middle" fill="#000" fontSize="7" fontWeight="bold">
                      eBay
                    </text>
                    <rect x="75" y="75" width="40" height="12" rx="2" fill="#00C2FF" />
                    <text x="95" y="83" textAnchor="middle" fill="#000" fontSize="7" fontWeight="bold">
                      Sports
                    </text>
                    <rect x="120" y="75" width="40" height="12" rx="2" fill="#FFE600" />
                    <text x="140" y="83" textAnchor="middle" fill="#000" fontSize="7" fontWeight="bold">
                      MySlabs
                    </text>
                    <rect x="30" y="95" width="40" height="12" rx="2" fill="#A44AFF" />
                    <text x="50" y="103" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold">
                      MyCard
                    </text>
                    <rect x="75" y="95" width="40" height="12" rx="2" fill="#FF2E9A" />
                    <text x="95" y="103" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold">
                      SportLots
                    </text>
                  </g>
                  <path d="M 165 115 L 175 110 M 165 115 L 170 125" stroke="#00D558" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue">Real-Time Inventory Control</h2>
              <p className="text-lg text-slate-300 mb-6">
                Watch your inventory update instantly across all five platforms. When a card sells on one platform, it&apos;s immediately removed from inventory everywhere else,
                preventing overselling. Stock levels stay perfectly synced, keeping your reputation solid. Every card tracked, every platform in sync, always.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Track Stock Everywhere</h4>
                    <p>See your inventory levels across all platforms instantly.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Prevent Overselling</h4>
                    <p>Never sell the same card twice. Automatic sync keeps you protected.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Perfect Sync Guaranteed</h4>
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
                  <rect x="25" y="30" width="150" height="140" rx="8" stroke="#FFE600" strokeWidth="2" />
                  <line x1="35" y1="150" x2="165" y2="150" stroke="#FFE600" strokeWidth="2" />
                  <line x1="35" y1="150" x2="35" y2="40" stroke="#FFE600" strokeWidth="2" />
                  <rect x="45" y="110" width="15" height="40" fill="#00D558" opacity="0.7" />
                  <rect x="70" y="85" width="15" height="65" fill="#00C2FF" opacity="0.7" />
                  <rect x="95" y="70" width="15" height="80" fill="#A44AFF" opacity="0.7" />
                  <rect x="120" y="95" width="15" height="55" fill="#FF2E9A" opacity="0.7" />
                  <rect x="145" y="60" width="15" height="90" fill="#FFE600" opacity="0.7" />
                  <circle cx="52" cy="105" r="3" fill="#00D558" />
                  <circle cx="77" cy="80" r="3" fill="#00C2FF" />
                  <circle cx="102" cy="65" r="3" fill="#A44AFF" />
                  <circle cx="127" cy="90" r="3" fill="#FF2E9A" />
                  <circle cx="152" cy="55" r="3" fill="#FFE600" />
                  <path d="M 52 105 L 77 80 L 102 65 L 127 90 L 152 55" stroke="#00D558" strokeWidth="1.5" opacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-yellow">Sales Intelligence</h2>
              <p className="text-lg text-slate-300 mb-6">
                Get the full picture of your sales across all platforms. See which cards are selling hot and which ones are sitting.
                Track performance marketplace by marketplace, monitor profitability, and make smart decisions based on real data. Built-in financial tracking keeps you informed every step of the way. Knowledge is power, dude.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">See Which Cards Sold</h4>
                    <p>Track which cards moved and on which platforms. Total visibility.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Platform Performance</h4>
                    <p>Compare sales across eBay, BuySportsCards, MySlabs, MyCardPost, SportLots.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Data-Driven Decisions</h4>
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
                  <rect x="30" y="30" width="70" height="70" stroke="#FF2E9A" strokeWidth="2" />
                  <g opacity="0.6">
                    <rect x="35" y="35" width="8" height="8" fill="#FF2E9A" />
                    <rect x="52" y="35" width="8" height="8" fill="#FF2E9A" />
                    <rect x="69" y="35" width="8" height="8" fill="#FF2E9A" />
                    <rect x="35" y="52" width="8" height="8" fill="#FF2E9A" />
                    <rect x="69" y="52" width="8" height="8" fill="#FF2E9A" />
                    <rect x="35" y="69" width="8" height="8" fill="#FF2E9A" />
                    <rect x="52" y="69" width="8" height="8" fill="#FF2E9A" />
                    <rect x="69" y="69" width="8" height="8" fill="#FF2E9A" />
                  </g>
                  <rect x="115" y="40" width="50" height="50" rx="4" stroke="#A44AFF" strokeWidth="2" />
                  <text x="140" y="72" textAnchor="middle" fill="#A44AFF" fontSize="9" fontWeight="bold">
                    CARD
                  </text>
                  <circle cx="160" cy="120" r="25" stroke="#00C2FF" strokeWidth="2" />
                  <line x1="160" y1="100" x2="160" y2="95" stroke="#00C2FF" strokeWidth="2" strokeLinecap="round" />
                  <line x1="160" y1="140" x2="160" y2="145" stroke="#00C2FF" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 145 125 L 140 130 M 175 125 L 180 130" stroke="#FFE600" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="50" cy="130" r="15" fill="none" stroke="#FF2E9A" strokeWidth="2" />
                  <path d="M 50 118 L 45 125 L 55 125" stroke="#00D558" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <text x="50" y="148" textAnchor="middle" fill="#FF2E9A" fontSize="7" fontWeight="bold">
                    SCAN
                  </text>
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-pink">Dominate the Card Show</h2>
              <p className="text-lg text-slate-300 mb-6">
                Take your business to card shows and beyond. Generate a unique QR code for each card. Buyers scan at the show,
                you get instant updates on your phone. Sell in-person with full platform tracking. That&apos;s the future of card selling, dude.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Generate QR Per Card</h4>
                    <p>Every card gets its own unique QR code for instant identification.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Sell at Card Shows</h4>
                    <p>Buyers scan, you get instant notifications. Totally rad in-person selling.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Instant Platform Updates</h4>
                    <p>Sales tracked automatically across your inventory system in real-time.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800">
            <h2 className="text-3xl font-bold mb-4">Ready to Sell Everywhere?</h2>
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Manage your entire inventory from one place and sell across all platforms simultaneously. One upload, total control, maximum reach.
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
