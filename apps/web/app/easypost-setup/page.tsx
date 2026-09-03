import { useNavigate } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";

/**
 * NEO-207 — public walkthrough for connecting an EasyPost account, the
 * prerequisite for buying PWE postage (NEO-120).
 *
 * Uses the marketing-page shell (sticky header / hero / CTA) but the body is a
 * numbered guide rather than the alternating feature sections — this page's
 * job is to be followed, not to sell.
 *
 * The EasyPost-side steps must stay consistent with the in-app hint in
 * components/modules/EasypostKeyEditor.tsx ("Account Settings → API Keys",
 * Production vs Test, the EZAK… prefix). Verified against EasyPost's docs
 * 2026-09-02; if EasyPost moves its dashboard around, update both places.
 *
 * Deliberately no claims about EasyPost's own plans or fees beyond postage
 * cost — their pricing page is theirs to maintain, not ours to mirror.
 */
export default function EasypostSetupPage() {
  const navigate = useNavigate();

  const steps: { title: string; body: React.ReactNode }[] = [
    {
      title: "Create a free EasyPost account",
      body: (
        <>
          Head to{" "}
          <a
            href="https://www.easypost.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neon-teal underline hover:text-neon-green"
          >
            easypost.com
          </a>{" "}
          and sign up. EasyPost is the postage provider Neon Binder connects to
          — a USPS account is built in from day one, so there&apos;s nothing
          extra to apply for.
        </>
      ),
    },
    {
      title: "Add a payment method",
      body: (
        <>
          In the EasyPost dashboard, open your billing settings and add a card
          or balance. This is what actually pays for postage — Neon Binder
          never handles the money, so without billing set up, purchases will
          fail with an &quot;insufficient funds&quot; error.
        </>
      ),
    },
    {
      title: "Copy your Production API key",
      body: (
        <>
          In EasyPost, go to <strong>Account Settings → API Keys</strong>. You
          will see two kinds of key: use the <strong>Production</strong> key —
          it starts with <code className="text-neon-green">EZAK</code>. (A Test
          key lets you price labels without being charged, but it can&apos;t
          buy real postage.) Treat the key like a password — it can spend your
          EasyPost balance.
        </>
      ),
    },
    {
      title: "Paste it into Neon Binder",
      body: (
        <>
          In Neon Binder, open <strong>Profile → Postage</strong>, paste the
          key, and save. That&apos;s the whole setup: from then on, the
          shipping page prices every letter weight automatically the moment a
          buyer&apos;s address is complete, and the buy button always shows
          exactly what it will charge.
        </>
      ),
    },
  ];

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
        <div className="max-w-4xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-16">
            <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-teal to-neon-green">
              Get Your EasyPost Key
            </h1>
            <p className="text-xl text-slate-400 mb-8">
              Five minutes of setup, and real USPS letter postage is one button
              away — about 80¢ for a card in a plain white envelope.
            </p>
          </div>

          {/* Steps */}
          <div className="my-8 p-8 rounded-lg bg-gradient-to-br from-green-900/20 to-blue-900/20 border border-green-500/30">
            <h2 className="text-3xl font-bold mb-8 text-center">
              Four Steps, One Time
            </h2>
            <div className="space-y-6">
              {steps.map((step, i) => (
                <div key={step.title} className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white font-bold">
                    {i + 1}
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold mb-2">{step.title}</h3>
                    <p className="text-slate-600 dark:text-slate-400">
                      {step.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Good to know */}
          <div className="my-16">
            <h2 className="text-3xl font-bold mb-6 text-center">Good To Know</h2>
            <div className="space-y-4 text-slate-400 max-w-2xl mx-auto">
              <div className="flex items-start gap-3">
                <span className="text-neon-teal font-bold text-xl">▸</span>
                <div>
                  <h4 className="font-semibold text-slate-300">
                    Your Key Is Treated Like A Password
                  </h4>
                  <p>
                    It&apos;s stored encrypted behind the same wall as
                    marketplace credentials, it is never shown back to anyone —
                    including you — and you can remove it any time from Profile
                    → Postage.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-neon-teal font-bold text-xl">▸</span>
                <div>
                  <h4 className="font-semibold text-slate-300">
                    Your Money Stays Yours
                  </h4>
                  <p>
                    Postage is charged by EasyPost to your own account at USPS
                    rates. Neon Binder never touches, holds, or marks up a
                    cent of it.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-neon-teal font-bold text-xl">▸</span>
                <div>
                  <h4 className="font-semibold text-slate-300">
                    Labels Are Free Without It
                  </h4>
                  <p>
                    No EasyPost account? You can still print unlimited 4×6
                    address labels for free — the key only unlocks buying the
                    postage too.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-neon-teal font-bold text-xl">▸</span>
                <div>
                  <h4 className="font-semibold text-slate-300">
                    Addresses Are Checked Before You Pay
                  </h4>
                  <p>
                    USPS verifies the buyer&apos;s address while the label is
                    being priced, so an undeliverable address fails before any
                    money moves — not after.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800">
            <h2 className="text-3xl font-bold mb-4">
              Ready to Ship for Less Than a Stamp?
            </h2>
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Create your free Neon Binder account, save your return address,
              and connect EasyPost when you&apos;re ready to buy postage.
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
