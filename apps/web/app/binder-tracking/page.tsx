import { lazy, Suspense, useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { SignUpButton } from "@clerk/clerk-react";
import type { DemoHistoryState } from "@/app/collection/final/mode";
import { BrandMark } from "@/components/primitives/BrandMark";
import NeonButton from "@/components/modules/NeonButton";

/**
 * NEO-350 — the collection demo, playable right here with no account.
 *
 * `?demo=on` swaps the tour for the demo (the same page signed-in collectors
 * see at `/collection`, in public mode). The flag is in the URL so a link can
 * open it straight away. The demo's views ride beside it, as they do at
 * `/collection` (`?demo=on&tab=binders&b=…`): Back steps back through them,
 * and Back from the demo's first view closes it. "Back to the tour" returns
 * to the tour entry in one step, however deep the visitor went. The demo's
 * code, fake catalog and CSS load only when it opens.
 */
const DEMO_PARAM = "demo";
const DEMO_KEEP = { [DEMO_PARAM]: "on" };
const loadDemo = () => import("@/app/collection/final/PublicCollectionDemo");
const PublicCollectionDemo = lazy(loadDemo);

/** Fetch the demo early when a visitor is about to open it. */
function warmDemo() {
  void loadDemo().catch(() => {
    // A failed warm-up is retried by lazy() when the demo actually opens.
  });
}

export default function BinderTrackingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const demoOpen = params.get(DEMO_PARAM) === "on";
  const demoState = (location.state ?? {}) as DemoHistoryState;

  // Opening starts the demo at the top; closing comes back to the spin
  // section and its link, so the keyboard lands where it left.
  const spinLinkRef = useRef<HTMLAnchorElement>(null);
  const wasOpen = useRef(demoOpen);
  useEffect(() => {
    if (demoOpen === wasOpen.current) return;
    wasOpen.current = demoOpen;
    if (demoOpen) {
      window.scrollTo({ top: 0 });
      return;
    }
    const link = spinLinkRef.current;
    link?.closest("section")?.scrollIntoView({ block: "center" });
    link?.focus({ preventScroll: true });
  }, [demoOpen]);

  // Opened from the tour: go back to that very entry, past every view the
  // demo pushed. Opened from a link: there is no tour entry behind it, so
  // the tour replaces the demo.
  const closeDemo = () => {
    if (demoState.demoFrom === "tour") void navigate(-((demoState.demoDepth ?? 0) + 1));
    else void navigate({ search: "" }, { replace: true });
  };

  // In the demo the header only sticks from `sm` up, like the signed-in
  // shell's: on a phone the pack tray already holds the bottom of the screen.
  const header = (
    <header
      className={`${demoOpen ? "sm:sticky" : "sticky"} top-0 z-10 bg-surface p-4 border-b-2 border-rule flex flex-row justify-between items-center`}
    >
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
  );

  if (demoOpen) {
    return (
      <>
        {header}
        <Suspense
          fallback={
            <main className="min-h-screen bg-surface p-6">
              <p role="status" className="text-ink-3">
                Sleeving the cards…
              </p>
            </main>
          }
        >
          <PublicCollectionDemo onExit={closeDemo} keepParams={DEMO_KEEP} />
        </Suspense>
      </>
    );
  }

  return (
    <>
      {header}

      <main className="min-h-screen bg-surface p-8">
        <div className="max-w-5xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-16">
            <h1 className="text-5xl font-bold mb-4 text-neon-green-text">
              Track Your Collection Like It&apos;s 1995
            </h1>
            <p className="text-xl text-ink-3 mb-8">
              The totally rad way to catalog, organize, and manage your trading cards
            </p>
            <p className="text-lg font-semibold text-neon-green-text mt-6">
              Free Tier: Track your collection for Free Forever
            </p>
            <p className="mt-4">
              <Link
                to={{ search: `?${DEMO_PARAM}=on` }}
                state={{ demoFrom: "tour" }}
                onPointerEnter={warmDemo}
                onFocus={warmDemo}
                className="rounded-sm text-neon-blue-text underline underline-offset-4 hover:text-ink focus-outline"
              >
                Try the demo binder, no sign-up needed
              </Link>
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
                    stroke="var(--neon-green-text)"
                    strokeWidth="3"
                  />
                  <circle cx="100" cy="90" r="30" stroke="var(--neon-green-text)" strokeWidth="2" />
                  <circle cx="100" cy="90" r="20" stroke="var(--neon-blue-text)" strokeWidth="2" />
                  <path
                    d="M 60 130 L 140 130"
                    stroke="var(--neon-yellow-text)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <rect
                    x="50"
                    y="155"
                    width="100"
                    height="8"
                    rx="4"
                    fill="var(--neon-purple)"
                    opacity="0.5"
                  />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-green-text">Snap & Upload</h2>
              <p className="text-lg text-ink-2 mb-6">
                Dude, it&apos;s super easy. Whip out your phone or camera and snap pics of your cards. Upload them to Neon Binder and we&apos;ll handle the rest. 
                No need to be a professional photographer — just point and shoot. We&apos;re all about keeping it simple and rad.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Quick & Dirty</h3>
                    <p>No fancy equipment needed. Your phone camera is totally enough.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Batch Upload</h3>
                    <p>Upload multiple cards at once and we&apos;ll process them all in one go.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-green-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Front & Back</h3>
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
                  <rect x="35" y="25" width="130" height="150" rx="8" stroke="var(--neon-purple-text)" strokeWidth="2" />
                  <g opacity="0.6">
                    <line x1="45" y1="50" x2="155" y2="50" stroke="var(--neon-purple-text)" strokeWidth="1.5" />
                    <line x1="45" y1="70" x2="155" y2="70" stroke="var(--neon-purple-text)" strokeWidth="1" />
                    <line x1="45" y1="90" x2="155" y2="90" stroke="var(--neon-purple-text)" strokeWidth="1" />
                    <line x1="45" y1="110" x2="155" y2="110" stroke="var(--neon-purple-text)" strokeWidth="1" />
                    <line x1="45" y1="130" x2="155" y2="130" stroke="var(--neon-purple-text)" strokeWidth="1" />
                  </g>
                  <circle cx="65" cy="50" r="5" fill="var(--neon-green-text)" />
                  <circle cx="85" cy="70" r="5" fill="var(--neon-green-text)" />
                  <circle cx="105" cy="90" r="5" fill="var(--neon-green-text)" />
                  <path
                    d="M 75 160 L 85 170 L 95 160"
                    stroke="var(--neon-blue-text)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
            <div className="md:order-1">
              <h2 className="text-4xl font-bold mb-4 text-neon-blue-text">We Find Your Cards</h2>
              <p className="text-lg text-ink-2 mb-6">
                This is where the magic happens, my friend. Our insanely comprehensive card set database has got nearly every card ever printed. 
                We&apos;ll automatically match your photos to official data — player names, card numbers, year, manufacturer, condition grades, the whole nine yards.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Massive Database</h3>
                    <p>Thousands of sets spanning decades of card history. We got &apos;em all.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Instant Matching</h3>
                    <p>Automatic identification with zero effort from you. Sick, right?</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-blue-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Verify & Correct</h3>
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
                  <rect x="20" y="30" width="60" height="140" rx="4" stroke="var(--neon-yellow-text)" strokeWidth="2" />
                  <rect x="70" y="30" width="60" height="140" rx="4" stroke="var(--neon-green-text)" strokeWidth="2" />
                  <rect x="120" y="30" width="60" height="140" rx="4" stroke="var(--neon-blue-text)" strokeWidth="2" />
                  <line x1="30" y1="55" x2="70" y2="55" stroke="var(--neon-yellow-text)" strokeWidth="1.5" />
                  <line x1="30" y1="70" x2="70" y2="70" stroke="var(--neon-yellow-text)" strokeWidth="1.5" />
                  <line x1="30" y1="85" x2="70" y2="85" stroke="var(--neon-yellow-text)" strokeWidth="1.5" />
                  <line x1="80" y1="55" x2="120" y2="55" stroke="var(--neon-green-text)" strokeWidth="1.5" />
                  <line x1="80" y1="70" x2="120" y2="70" stroke="var(--neon-green-text)" strokeWidth="1.5" />
                  <line x1="80" y1="85" x2="120" y2="85" stroke="var(--neon-green-text)" strokeWidth="1.5" />
                  <line x1="130" y1="55" x2="170" y2="55" stroke="var(--neon-blue-text)" strokeWidth="1.5" />
                  <line x1="130" y1="70" x2="170" y2="70" stroke="var(--neon-blue-text)" strokeWidth="1.5" />
                  <line x1="130" y1="85" x2="170" y2="85" stroke="var(--neon-blue-text)" strokeWidth="1.5" />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-4xl font-bold mb-4 text-neon-yellow-text">Build It Your Way</h2>
              <p className="text-lg text-ink-2 mb-6">
                Here&apos;s the best part — organize your cards however YOU want. Use our verified manufacturer checklists for instant accuracy or create your own custom binders.
                By set, by player, by team, by year, by condition... organize them however your collecting heart desires. We&apos;ll let you create unlimited custom collections
                and arrange your cards exactly how you like it. No rules. Total freedom.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Unlimited Binders</h3>
                    <p>Create as many custom collections as you want. Go wild.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Mix & Match</h3>
                    <p>Drag cards between binders. Organize however makes sense to you.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-yellow-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Your Rules</h3>
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
                  <rect x="10" y="10" width="200" height="160" rx="8" stroke="var(--neon-pink-text)" strokeWidth="2" />
                  <line x1="10" y1="35" x2="210" y2="35" stroke="var(--neon-pink-text)" strokeWidth="1.5" />
                  <text x="110" y="28" textAnchor="middle" fill="var(--neon-pink-text)" fontSize="11" fontWeight="bold">
                    STATS
                  </text>
                  <rect x="20" y="45" width="180" height="18" rx="2" fill="var(--neon-green)" opacity="0.7" />
                  <text x="25" y="57" fill="#000" fontSize="9" fontWeight="bold">
                    CARDS OWNED
                  </text>
                  <text x="195" y="57" fill="#000" fontSize="9" fontWeight="bold" textAnchor="end">
                    2,847
                  </text>
                  <rect x="20" y="68" width="180" height="18" rx="2" fill="var(--neon-blue)" opacity="0.7" />
                  <text x="25" y="80" fill="#000" fontSize="9" fontWeight="bold">
                    COLLECTION VALUE
                  </text>
                  <text x="195" y="80" fill="#000" fontSize="9" fontWeight="bold" textAnchor="end">
                    $45.2K
                  </text>
                  <rect x="20" y="91" width="180" height="18" rx="2" fill="var(--neon-purple)" opacity="0.7" />
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
              <h2 className="text-4xl font-bold mb-4 text-neon-pink-text">Track Everything</h2>
              <p className="text-lg text-ink-2 mb-6">
                Now for the gnarly part — get all the stats you could ever want. Real-time tracking of your entire collection. 
                See your total card count, estimated collection value, completion percentages for each set, rarity breakdowns, 
                condition distributions, and way more. Knowledge is power, dude. Track it all.
              </p>
              <div className="space-y-4 text-ink-3">
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Collection Value</h3>
                    <p>Automatic valuation based on current market data. Know what you&apos;re holding.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Set Completion</h3>
                    <p>Track percentage complete for each set. See exactly what you&apos;re missing.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Full Analytics</h3>
                    <p>Card counts, condition grades, rarity distributions, and detailed statistics.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-neon-pink-text font-bold text-xl">▸</span>
                  <div>
                    <h3 className="font-semibold text-ink-2">Search & Filter</h3>
                    <p>Instantly find any card or set in your collection with powerful search tools.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <TakeItForASpin linkRef={spinLinkRef} />

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-rule">
            <h2 className="text-3xl font-bold mb-4">Ready to Get Totally Radical?</h2>
            <p className="text-lg text-ink-3 mb-8 max-w-2xl mx-auto">
              Start tracking your collection like a true collector. Upload your first batch of cards and watch Neon Binder do its magic.
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

/**
 * The demo binder's own shelf, as a teaser: the spines a visitor will find
 * when it opens, in the colours they wear there. Pure decoration; the link
 * beside it is the way in.
 */
const SHELF: { name: string; bg: string; ink: string; tall: number }[] = [
  { name: "Main", bg: "#0f3d20", ink: "#00D558", tall: 92 },
  { name: "'96 Contenders", bg: "#14161c", ink: "#ffffff", tall: 100 },
  { name: "Slab case", bg: "#14161c", ink: "#FFE600", tall: 84 },
  { name: "Ohtani rainbow", bg: "#005A9C", ink: "#ffffff", tall: 100 },
  { name: "Red Wings", bg: "#CE1126", ink: "#ffffff", tall: 94 },
  { name: "Want List", bg: "#3a0a24", ink: "#FF2E9A", tall: 88 },
];

function TakeItForASpin({ linkRef }: { linkRef: RefObject<HTMLAnchorElement | null> }) {
  // A shop window at night: the shelf and its neon sign are a lit scene, dark
  // in both modes like a card face (NEO-356). `data-theme="dark"` scopes the
  // dark roles (app/theme.css) to the section, so its ink and the focus
  // outline resolve for a dark ground even on a light page.
  return (
    <section
      data-theme="dark"
      aria-labelledby="take-it-for-a-spin"
      className="mb-20 grid items-center gap-10 rounded-2xl border border-neon-blue/30 bg-[radial-gradient(120%_70%_at_30%_0%,rgba(0,194,255,0.12),transparent_70%),linear-gradient(#0a0f18,#05070c)] p-6 sm:p-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div aria-hidden="true" className="flex h-56 items-end justify-center gap-1.5 border-b-4 border-neon-blue/70 pb-0 shadow-[0_14px_24px_-12px_rgba(0,194,255,0.55)] sm:h-64 sm:gap-2">
        {SHELF.map((spine) => (
          <span
            key={spine.name}
            style={{ height: `${spine.tall}%`, backgroundColor: spine.bg, color: spine.ink } as CSSProperties}
            className="flex w-10 items-center justify-center rounded-t-md border border-ink/10 py-3 shadow-[inset_-6px_0_10px_rgba(0,0,0,0.35)] sm:w-12"
          >
            <span className="rotate-180 truncate text-lg font-extrabold leading-none tracking-tight [writing-mode:vertical-rl] sm:text-xl">
              {spine.name}
            </span>
          </span>
        ))}
      </div>

      <div className="space-y-4">
        <h2
          id="take-it-for-a-spin"
          // The tube's own ink, a fixed colour of the sign like the spines'.
          style={{ color: "#d6f6ff" }}
          className="inline-block rounded-full border-2 border-neon-blue px-4 py-1 font-['Neon',sans-serif] text-3xl shadow-[0_0_12px_rgba(0,194,255,0.55),inset_0_0_10px_rgba(0,194,255,0.35)] [text-shadow:0_0_6px_rgba(0,194,255,0.9),0_0_18px_rgba(0,194,255,0.5)] sm:text-4xl"
        >
          Take it for a spin
        </h2>
        <p className="text-lg text-ink-2">
          A whole collection, already sleeved. Hunt down a card, fill a page, light up a checklist.
        </p>
        <p className="text-ink-3">It&apos;s all pretend cards, so go wild.</p>
        {/* A link that looks like the button: NeonButton paints it (asChild),
            so its colour comes from the one place a button's colour is set. */}
        <NeonButton asChild variant="secondary" size="3" className="min-h-12">
          <Link
            ref={linkRef}
            to={{ search: `?${DEMO_PARAM}=on` }}
            state={{ demoFrom: "tour" }}
            onPointerEnter={warmDemo}
            onFocus={warmDemo}
          >
            Open the demo binder
          </Link>
        </NeonButton>
        <p className="text-sm text-ink-3">No sign-up. Your changes stay in this tab.</p>
      </div>
    </section>
  );
}
