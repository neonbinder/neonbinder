import { Link, useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";

/**
 * NEO-118 / NEO-207 — public marketing page for the shipping-label feature.
 *
 * Structure follows app/managing-inventory/page.tsx, the established template
 * for these pages: sticky header with Back, hero, alternating two-column
 * sections pairing an inline SVG in a gradient tile with `▸` bullets, then a
 * sign-up CTA.
 *
 * Copy covers only what the feature does today. NEO-118 deliberately omitted
 * postage; NEO-120 shipped it (EasyPost, USPS First-Class letters, address
 * verification during rating), so the postage section below replaced that
 * omission. NEO-213 shipped label purchase history — every purchase saved and
 * reprintable — so that is now claimable too, and the postage section says so.
 * Still deliberately absent: any marketplace-order integration. The seller
 * addresses each envelope by hand. Do not promise that here.
 */
export default function ShippingLabelsPage() {
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
              Print the Label, Ship the Card
            </h1>
            <p className="text-xl text-slate-400 mb-8">
              Stop hand-writing envelopes. Type where it&apos;s going, hit
              print, slap it on. Want real postage on there too? One more
              button.
            </p>
            <p className="text-lg font-semibold text-neon-teal mt-6">
              Labels are free during beta — postage costs what USPS charges
            </p>
          </div>

          {/* Section 1: Your address, saved once */}
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
                  {/* Profile card holding a saved address */}
                  <rect x="35" y="45" width="130" height="90" rx="8" stroke="#00E5C0" strokeWidth="3" />
                  <circle cx="65" cy="72" r="12" stroke="#00D558" strokeWidth="2" />
                  <path d="M 50 95 Q 65 82 80 95" stroke="#00D558" strokeWidth="2" strokeLinecap="round" />
                  <line x1="95" y1="66" x2="150" y2="66" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" />
                  <line x1="95" y1="78" x2="140" y2="78" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <line x1="95" y1="90" x2="145" y2="90" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                  <line x1="50" y1="115" x2="150" y2="115" stroke="#00E5C0" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
                  {/* Saved checkmark */}
                  <circle cx="155" cy="130" r="18" fill="#0a0a0a" stroke="#00D558" strokeWidth="2.5" />
                  <path d="M 147 130 L 153 137 L 164 124" stroke="#00D558" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  <text x="100" y="168" textAnchor="middle" fill="#00E5C0" fontSize="9" fontWeight="bold">
                    SAVED ONCE
                  </text>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-teal">
                Your Address, Saved Once
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                Put your return address on your profile one time and forget
                about it. Every label you print already has it, and it follows
                the name on your public profile. No sticker sheets, no rubber
                stamp, no rewriting the same nine words a hundred times.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-teal font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Set It And Forget It</h4>
                    <p>Enter it once on your profile. It fills in on every label after that.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-teal font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Private To You</h4>
                    <p>Your address stays on your account. It never shows on your public collector page.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-teal font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Change It Anytime</h4>
                    <p>Moved? Update it in one place and every future label follows.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Type the buyer, hit print */}
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
                  {/* Form fields on the left */}
                  <rect x="20" y="45" width="60" height="12" rx="3" stroke="#00C2FF" strokeWidth="2" />
                  <rect x="20" y="65" width="60" height="12" rx="3" stroke="#00C2FF" strokeWidth="2" />
                  <rect x="20" y="85" width="60" height="12" rx="3" stroke="#00C2FF" strokeWidth="2" />
                  <rect x="20" y="105" width="36" height="12" rx="3" stroke="#00C2FF" strokeWidth="2" />
                  {/* Arrow across */}
                  <path d="M 92 82 L 112 82" stroke="#00D558" strokeWidth="2.5" strokeLinecap="round" />
                  <path d="M 106 76 L 112 82 L 106 88" stroke="#00D558" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  {/* Live label preview on the right */}
                  <rect x="122" y="52" width="60" height="40" rx="3" fill="#0a0a0a" stroke="#00D558" strokeWidth="2.5" />
                  <line x1="128" y1="60" x2="146" y2="60" stroke="#00D558" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
                  <line x1="134" y1="72" x2="170" y2="72" stroke="#00D558" strokeWidth="2.5" strokeLinecap="round" />
                  <line x1="134" y1="80" x2="164" y2="80" stroke="#00D558" strokeWidth="2.5" strokeLinecap="round" />
                  {/* Printer below */}
                  <rect x="118" y="108" width="68" height="30" rx="5" stroke="#00C2FF" strokeWidth="2.5" />
                  <rect x="132" y="138" width="40" height="24" rx="2" fill="#0a0a0a" stroke="#00E5C0" strokeWidth="2" />
                  <line x1="138" y1="147" x2="166" y2="147" stroke="#00E5C0" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="138" y1="154" x2="158" y2="154" stroke="#00E5C0" strokeWidth="1.5" strokeLinecap="round" />
                  <circle cx="175" cy="118" r="3" fill="#00D558" />
                  <text x="100" y="182" textAnchor="middle" fill="#00C2FF" fontSize="9" fontWeight="bold">
                    ONE BUTTON
                  </text>
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-green">
                Type The Buyer, Hit Print
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                Card sold? Open the Labels tab, type where it&apos;s going, and
                watch the label build itself as you type. What you see on screen
                is exactly what comes out of the printer — same size, same
                layout, no surprises. Then one button.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Live Preview</h4>
                    <p>The label updates as you type, at actual size. No guessing.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Nothing To Install</h4>
                    <p>It runs in your browser and uses the printer you already have.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Big, Readable Addresses</h4>
                    <p>Clean uppercase type that carriers and sorting machines read easily.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Fits any 4x6 label printer */}
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
                  {/* Landscape 4x6 label with dimension marks */}
                  <rect x="30" y="62" width="140" height="93" rx="4" stroke="#00E5C0" strokeWidth="3" />
                  {/* FROM block */}
                  <line x1="42" y1="76" x2="66" y2="76" stroke="#A44AFF" strokeWidth="2" strokeLinecap="round" />
                  <line x1="42" y1="84" x2="80" y2="84" stroke="#A44AFF" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  <line x1="42" y1="91" x2="74" y2="91" stroke="#A44AFF" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
                  {/* TO block, centered and larger */}
                  <line x1="72" y1="112" x2="128" y2="112" stroke="#00E5C0" strokeWidth="3.5" strokeLinecap="round" />
                  <line x1="66" y1="124" x2="134" y2="124" stroke="#00E5C0" strokeWidth="3.5" strokeLinecap="round" />
                  <line x1="78" y1="136" x2="122" y2="136" stroke="#00E5C0" strokeWidth="3.5" strokeLinecap="round" />
                  {/* Width dimension */}
                  <line x1="30" y1="48" x2="170" y2="48" stroke="#A44AFF" strokeWidth="1.5" />
                  <line x1="30" y1="43" x2="30" y2="53" stroke="#A44AFF" strokeWidth="1.5" />
                  <line x1="170" y1="43" x2="170" y2="53" stroke="#A44AFF" strokeWidth="1.5" />
                  <text x="100" y="40" textAnchor="middle" fill="#A44AFF" fontSize="11" fontWeight="bold">
                    6&quot;
                  </text>
                  {/* Height dimension */}
                  <line x1="184" y1="62" x2="184" y2="155" stroke="#A44AFF" strokeWidth="1.5" />
                  <line x1="179" y1="62" x2="189" y2="62" stroke="#A44AFF" strokeWidth="1.5" />
                  <line x1="179" y1="155" x2="189" y2="155" stroke="#A44AFF" strokeWidth="1.5" />
                  <text x="176" y="112" textAnchor="middle" fill="#A44AFF" fontSize="11" fontWeight="bold">
                    4&quot;
                  </text>
                  <text x="100" y="176" textAnchor="middle" fill="#00E5C0" fontSize="9" fontWeight="bold">
                    ACTUAL SIZE
                  </text>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-purple">
                Fits Any 4×6 Label Printer
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                Standard 4×6, printed landscape, at true size. If you already
                own a Rollo, a Zebra, or a DYMO 4XL, it just works. No thermal
                printer? A sheet of 4×6 labels in a regular printer works fine
                too.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-purple font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">The Standard Size</h4>
                    <p>The same 4×6 label every shipping service uses. Buy them anywhere.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-purple font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Thermal Or Inkjet</h4>
                    <p>Pure black on white, so it comes out crisp on either one.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-purple font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">True To Size</h4>
                    <p>Prints at exactly 6 by 4 inches — no shrink-to-fit, no crooked labels.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Buy the postage too (NEO-120) */}
          <div className="grid md:grid-cols-2 gap-12 items-center mb-20">
            <div className="md:order-2">
              <div className="bg-gradient-to-br from-neon-blue/10 to-neon-green/10 rounded-2xl p-12 border border-neon-blue/30 aspect-square flex items-center justify-center">
                <svg
                  viewBox="0 0 200 200"
                  width="200"
                  height="200"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  {/* PWE with printed indicia where the stamp would go */}
                  <rect x="25" y="55" width="150" height="95" rx="5" stroke="#00C2FF" strokeWidth="3" />
                  {/* Indicia box, top-right */}
                  <rect x="128" y="65" width="38" height="30" rx="2" stroke="#00D558" strokeWidth="2" strokeDasharray="4 3" />
                  <text x="147" y="79" textAnchor="middle" fill="#00D558" fontSize="9" fontWeight="bold">
                    USPS
                  </text>
                  <text x="147" y="90" textAnchor="middle" fill="#00D558" fontSize="9" fontWeight="bold">
                    $0.80
                  </text>
                  {/* Delivery address block */}
                  <line x1="62" y1="108" x2="138" y2="108" stroke="#00C2FF" strokeWidth="3" strokeLinecap="round" />
                  <line x1="55" y1="120" x2="145" y2="120" stroke="#00C2FF" strokeWidth="3" strokeLinecap="round" />
                  <line x1="70" y1="132" x2="130" y2="132" stroke="#00C2FF" strokeWidth="3" strokeLinecap="round" />
                  {/* Tracking barcode along the bottom */}
                  {[38, 43, 50, 56, 60, 67, 73, 78, 85, 91, 96, 103, 109, 114, 121, 127, 132, 139, 145, 150, 157].map(
                    (x, i) => (
                      <line
                        key={x}
                        x1={x}
                        y1="160"
                        x2={x}
                        y2="172"
                        stroke="#00D558"
                        strokeWidth={i % 3 === 0 ? "3" : "1.5"}
                      />
                    ),
                  )}
                  <text x="100" y="188" textAnchor="middle" fill="#00C2FF" fontSize="9" fontWeight="bold">
                    POSTAGE + TRACKING
                  </text>
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue">
                Buy The Postage Too
              </h2>
              <p className="text-lg text-slate-300 mb-6">
                Connect your own EasyPost account and the same page prices real
                USPS First-Class letter postage for a plain white envelope —
                about $0.80 for a 1oz PWE, a little less than a stamp. Print
                the stamped label, drop the envelope in the mailbox, done.
              </p>
              <div className="space-y-4 text-slate-400">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Letter Rates, Not Package Rates</h4>
                    <p>A PWE ships as a First-Class letter, with 1, 2, and 3oz tiers priced up front — every weight shows its real price before you pick one.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Verified Before You&apos;re Charged</h4>
                    <p>USPS checks the buyer&apos;s address while the label is priced, so an undeliverable address fails before any money moves. The buy button always shows the exact amount it will charge.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Tracking, Copied, Done</h4>
                    <p>Every purchase hands you a tracking number with a copy button, ready to paste back to your buyer.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue font-bold text-xl">▸</span>
                  <div>
                    <h4 className="font-semibold text-slate-300">Reprint Without Re-Buying</h4>
                    <p>Every label you buy is saved. Jammed printer, wrong tray, lost sheet — pull it back up and print it again for free.</p>
                  </div>
                </div>
              </div>
              {/* The link is its own block, not inline in the paragraph:
                  Maestro taps the matched element's center, and an inline
                  link's position inside a wrapped paragraph depends on the
                  runner's font metrics — it missed on CI Linux while passing
                  on macOS. A standalone link is tappable everywhere. */}
              <p className="text-slate-400 mt-6">
                New to EasyPost? Setting up takes about five minutes, once.
              </p>
              <Link
                to="/easypost-setup"
                className="inline-block mt-2 text-neon-blue underline hover:text-neon-teal"
              >
                Follow the EasyPost setup guide →
              </Link>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800">
            <h2 className="text-3xl font-bold mb-4">Ready to Ship Faster?</h2>
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Save your return address once, print a clean 4×6 label for every
              card you sell, and buy the postage without leaving the page.
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
