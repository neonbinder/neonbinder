import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";

/**
 * NEO-207 — public marketing page for the Print Shop's binder tools: spine
 * labels (NEO-147) and 9-pocket placeholder sheets (NEO-146/152).
 *
 * Structure follows app/managing-inventory/page.tsx, the established template
 * for these pages: sticky header with Back, hero, alternating two-column
 * sections pairing an inline SVG in a gradient tile with `▸` bullets, then a
 * sign-up CTA.
 *
 * Placeholders are pitched as "hold the spot for a card that lives somewhere
 * else" (sold / slabbed / at grading) — NOT as blanks for cards you don't own.
 * That framing comes from the feature itself: sheets are printed from the
 * user's own scans, so there is nothing to print for a card never in hand.
 */
export default function PrintShopPage() {
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
            <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-teal to-neon-green">
              The Print Shop
            </h1>
            <p className="text-xl text-slate-400 mb-8">
              Totally rad paper goods for your binders — spine labels in team
              colors and placeholder sheets for the cards that got away. Printed
              on the printer you already own.
            </p>
            <p className="text-lg font-semibold text-neon-teal mt-6">
              Free during beta
            </p>
          </div>

          {/* Section 1: Spine labels */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div>
              <div className="bg-gradient-to-br from-neon-teal/10 to-neon-green/10 rounded-2xl p-12 border border-neon-teal/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  {/* Three binder spines on a shelf, middle one labeled */}
                  <line x1="25" y1="168" x2="175" y2="168" stroke="#00E5C0" strokeWidth="3" strokeLinecap="round" />
                  <rect x="40" y="45" width="32" height="123" rx="3" stroke="#00E5C0" strokeWidth="2.5" />
                  <rect x="84" y="35" width="32" height="133" rx="3" stroke="#00D558" strokeWidth="2.5" />
                  <rect x="128" y="50" width="32" height="118" rx="3" stroke="#00E5C0" strokeWidth="2.5" />
                  {/* The label on the middle spine */}
                  <rect x="90" y="52" width="20" height="86" rx="2" fill="#0a0a0a" stroke="#00D558" strokeWidth="2" />
                  <text
                    x="100"
                    y="95"
                    textAnchor="middle"
                    fill="#00D558"
                    fontSize="11"
                    fontWeight="bold"
                    transform="rotate(90 100 95)"
                    letterSpacing="2"
                  >
                    RODGERS
                  </text>
                  <text x="100" y="188" textAnchor="middle" fill="#00E5C0" fontSize="9" fontWeight="bold">
                    TEAM COLORS
                  </text>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-teal">
                Spine Labels In Team Colors
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                Type a player&apos;s name and the label builds itself — their
                name in the colors of the team they wore longest, set in a big
                athletic typeface. Or type anything you want and pick your own
                colors. Queue up a stack, print the sheet, cut on the guides,
                and your shelf finally says what&apos;s inside every binder.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-teal font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Team Colors, Automatic</h4>
                    <p>Search a player and their team&apos;s real colorway fills in. Switch teams with one tap, or enter any colors yourself.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-teal font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Eleven Athletic Typefaces</h4>
                    <p>Jersey-block, varsity, and card-shop fonts. Long names auto-shrink to fit instead of getting chopped.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-teal font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Any Binder, Any Size</h4>
                    <p>1&quot;, 2&quot;, and 3&quot; ring presets or your own width — and one sheet can mix sizes and fonts, packed to waste as little paper as possible.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Placeholder sheets */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div className="md:order-2">
              <div className="bg-gradient-to-br from-neon-green/10 to-neon-blue/10 rounded-2xl p-12 border border-neon-green/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  {/* 9-pocket page, one pocket getting its card back */}
                  {[0, 1, 2].map((row) =>
                    [0, 1, 2].map((col) => (
                      <rect
                        key={`${row}-${col}`}
                        x={38 + col * 44}
                        y={28 + row * 48}
                        width="36"
                        height="40"
                        rx="3"
                        stroke={row === 1 && col === 1 ? "#00D558" : "#00C2FF"}
                        strokeWidth={row === 1 && col === 1 ? "3" : "2"}
                        opacity={row === 1 && col === 1 ? 1 : 0.55}
                      />
                    )),
                  )}
                  {/* The placeholder card sliding into the center pocket */}
                  <rect x="86" y="82" width="28" height="32" rx="2" fill="#0a0a0a" stroke="#00D558" strokeWidth="2" />
                  <circle cx="100" cy="93" r="6" stroke="#00D558" strokeWidth="1.5" />
                  <line x1="92" y1="106" x2="108" y2="106" stroke="#00D558" strokeWidth="1.5" strokeLinecap="round" />
                  <text x="100" y="188" textAnchor="middle" fill="#00D558" fontSize="9" fontWeight="bold">
                    9 POCKETS, FILLED
                  </text>
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-green">
                Hold Their Spot In The Binder
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                Sold it? Slabbed it? Shipped it off for grading? The card is
                gone but the set page shouldn&apos;t look gutted. Drop in your
                scans and Neon Binder crops every card, matches each front to
                its back, and lays them out nine to a sheet at exactly
                2.5&quot; × 3.5&quot; — cut them out and the binder still shows
                every card you pulled.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Scan, Drop, Done</h4>
                    <p>One drop zone takes loose photos or a whole zip. Cropping and straightening are automatic.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Fronts Meet Their Backs</h4>
                    <p>Cards pair up automatically as they&apos;re read, and you can fix any pairing with two clicks while the rest keep processing.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">One Sheet, One Page</h4>
                    <p>Nine true-size cards per sheet on Letter or A4 — print the backs too and the placeholders are double-sided, just like the real thing.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Works with your printer */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div>
              <div className="bg-gradient-to-br from-neon-purple/10 to-neon-teal/10 rounded-2xl p-12 border border-neon-purple/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  {/* Sheet with cut guides and scissors on the dashed line */}
                  <rect x="45" y="30" width="110" height="140" rx="4" stroke="#A44AFF" strokeWidth="3" />
                  {/* Corner ticks pointing inward */}
                  <path d="M 60 45 L 70 45 M 60 45 L 60 55" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 140 45 L 130 45 M 140 45 L 140 55" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 60 155 L 70 155 M 60 155 L 60 145" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" />
                  <path d="M 140 155 L 130 155 M 140 155 L 140 145" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" />
                  {/* Dashed cut line with scissors */}
                  <line x1="45" y1="100" x2="155" y2="100" stroke="#A44AFF" strokeWidth="2" strokeDasharray="6 5" />
                  <circle cx="30" cy="93" r="5" stroke="#00E5C0" strokeWidth="2" />
                  <circle cx="30" cy="107" r="5" stroke="#00E5C0" strokeWidth="2" />
                  <path d="M 34 96 L 52 103 M 34 104 L 52 97" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" />
                  <text x="100" y="188" textAnchor="middle" fill="#A44AFF" fontSize="9" fontWeight="bold">
                    CUT ON THE GUIDES
                  </text>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-purple">
                Print, Cut, Slide In
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                No plotter, no label printer, no craft store run. Everything in
                the Print Shop comes out of a regular inkjet or laser at true
                size, with hairline cut guides that disappear the moment you
                cut. What&apos;s on screen is exactly what prints.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-purple font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">No Special Printer</h4>
                    <p>Plain paper for spine labels, cardstock if you&apos;re fancy. Any printer that takes Letter or A4.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-purple font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">True To Size</h4>
                    <p>Placeholders print at exactly 2.5&quot; × 3.5&quot; and labels at your binder&apos;s exact width — no shrink-to-fit surprises.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-purple font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Cut Guides Included</h4>
                    <p>Corner ticks sit inside the cut line, so the guides end up in the scrap pile — not on your label.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800">
            <h2 className="text-3xl font-bold mb-4">
              Ready to Trick Out Your Binders?
            </h2>
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Label every spine and fill every pocket — even the ones whose
              cards live somewhere else now. Free during beta.
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
