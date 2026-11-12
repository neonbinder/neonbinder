import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { BrandMark } from "@/components/primitives/BrandMark";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";

/** Where privacy questions and deletion requests go. */
export const PRIVACY_CONTACT_EMAIL = "support@neonbinder.io";

/** The date this policy last changed, shown at the top. Update it with the text. */
const LAST_UPDATED = { iso: "2026-11-11", label: "November 11, 2026" };

/**
 * NEO-421 — the public privacy policy at /privacy. eBay asks for its URL
 * before it registers a developer app, and every collector deserves to read
 * it. Signed out, static, no Convex: every claim here was checked against the
 * code that does the thing, so change the text when the practice changes.
 */

const SECTIONS = [
  { id: "who-we-are", title: "Who we are" },
  { id: "what-we-collect", title: "What we collect" },
  { id: "analytics", title: "Analytics and error reports" },
  { id: "how-we-use-it", title: "How we use it" },
  { id: "who-we-share-with", title: "Who we share it with" },
  { id: "ebay", title: "eBay" },
  { id: "your-choices", title: "Your choices" },
  { id: "keeping-data", title: "How long we keep it" },
  { id: "security", title: "Keeping it safe" },
  { id: "kids", title: "Kids" },
  { id: "changes", title: "Changes to this policy" },
  { id: "contact", title: "Contact us" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function titleOf(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.title ?? id;
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h2 id={id} className="text-2xl font-bold text-ink scroll-mt-24 text-balance">
        {titleOf(id)}
      </h2>
      {children}
    </section>
  );
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      {children}
    </div>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-pretty">{children}</p>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-6 space-y-2 marker:text-ink-3">{children}</ul>;
}

const linkClass =
  "text-neon-blue-text underline underline-offset-2 hover:text-neon-teal-text focus-outline rounded-sm";

function ContactLink() {
  return (
    <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className={linkClass}>
      {PRIVACY_CONTACT_EMAIL}
    </a>
  );
}

export default function PrivacyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  useDocumentTitle("Privacy Policy · Neon Binder");

  // Opened straight from a link (eBay's developer portal, a bookmark), there
  // is no page of ours to go back to, so Back goes home instead of off-site.
  const goBack = () => (location.key === "default" ? navigate("/") : navigate(-1));

  return (
    <>
      <header className="sticky top-0 z-10 bg-surface p-4 border-b-2 border-rule flex flex-row justify-between items-center">
        <button
          onClick={goBack}
          className="flex items-center gap-2 px-4 py-2 rounded-md hover:bg-hover focus-outline transition-colors"
        >
          <span className="text-xl" aria-hidden="true">←</span>
          <span>Back</span>
        </button>
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="neon-header text-wordmark whitespace-nowrap max-sm:!text-xl">Neon Binder</span>
        </div>
        <div className="w-20" />
      </header>

      <main className="min-h-screen bg-surface px-4 py-8 sm:p-8">
        <article className="max-w-2xl mx-auto text-base leading-relaxed text-ink-2 space-y-12">
          <div className="space-y-4 pt-4 sm:pt-8">
            <h1 className="text-4xl sm:text-5xl font-bold text-neon-blue-text text-balance">
              Privacy Policy
            </h1>
            <p className="text-sm text-ink-3">
              Last updated <time dateTime={LAST_UPDATED.iso}>{LAST_UPDATED.label}</time>
            </p>
            <P>
              Your cards are your business. This page explains, in plain words, what NeonBinder keeps
              about you, why, who else touches it, and how to get it back out. No fine print hiding
              under the toploader.
            </P>
          </div>

          <aside
            aria-labelledby="short-version"
            className="bg-raised border border-rule-strong rounded-lg p-6 shadow-offset space-y-3"
          >
            <h2 id="short-version" className="text-xl font-semibold text-neon-green-text">
              The short version
            </h2>
            <List>
              <li>We keep what you put in: your collection, your boxes, your sales and your photos.</li>
              <li>
                We never store your marketplace passwords. eBay you connect on eBay&apos;s own page,
                so we never see that password at all.
              </li>
              <li>We do not sell your personal data, and we do not run ads.</li>
              <li>
                Want something gone? Disconnect it, or email <ContactLink /> and we&apos;ll delete it.
              </li>
            </List>
          </aside>

          <nav aria-label="Policy sections" className="space-y-2">
            <h2 className="text-sm font-semibold text-ink-3">On this page</h2>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className={linkClass}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <Section id="who-we-are">
            <P>
              NeonBinder is a home for your trading card collection: track it against real checklists,
              identify cards from photos, list them on the marketplaces you connect, ship them and print
              what your binders need. It runs at neonbinder.io. When this page says &ldquo;we&rdquo; or
              &ldquo;us&rdquo;, it means NeonBinder.
            </P>
          </Section>

          <Section id="what-we-collect">
            <Sub title="Your account">
              <P>
                Sign-up and sign-in are handled by Clerk, our sign-in provider. Clerk holds your email
                address, your name and picture if you give them, and how you sign in. Our own database
                knows you by the account id Clerk issues.
              </P>
            </Sub>
            <Sub title="Your collection, inventory and sales">
              <P>
                Everything you build in NeonBinder is stored so we can show it back to you: your binders
                and boxes, the copies in them and their condition, your want list and trade shelf, and
                the settings you choose.
              </P>
              <P>
                When a card sells on a marketplace you&apos;ve connected, we pull the order back so your
                counts stay right: the order number, date, status, the cards sold, their prices and the
                totals. We don&apos;t store the buyer&apos;s name, address, email or phone number.
              </P>
            </Sub>
            <Sub title="Card photos">
              <P>
                Photos you add to your copies go from your browser straight to Cloudflare R2, a storage
                service. We keep a full-size image (1600 pixels on the long side) and a thumbnail. The
                original file you picked is never kept.
              </P>
              <P>
                Card scans you upload to identify cards or make placeholders go to a private Google Cloud
                Storage bucket, along with the cropped and resized images we make from them, and all of it
                is deleted automatically after two days. To figure out which card is which, our image
                service reads them with Google Cloud Vision and Anthropic&apos;s Claude.
              </P>
              <P>
                When you save a scanned card, a full-size image and a thumbnail made from the scans of its
                front and back go on that copy in Cloudflare R2, just like a photo you add yourself. They
                stay until you replace or remove them. They go on the listing when that
                copy lists on a marketplace you&apos;ve connected, and they show on your public profile
                if you show that copy there.
              </P>
              <P>
                When a copy sells, its photos stay with the sale, so your Pick List can show you the exact
                card to pull. Only you see them there. They&apos;re kept until you delete your account; to
                have them removed sooner, email <ContactLink />.
              </P>
            </Sub>
            <Sub title="Marketplace connections">
              <P>
                <strong className="text-ink font-semibold">BuySportsCards and SportLots.</strong> You type
                your marketplace password once. We use it for a single sign-in and throw it away; it is
                never stored. What we keep is your marketplace username and the session the marketplace
                hands back, so you stay signed in.
              </P>
              <P>
                <strong className="text-ink font-semibold">eBay.</strong> You sign in on eBay&apos;s own
                page and approve access there, so we never see your eBay password. eBay gives us
                authorization tokens for your account.
              </P>
              <P>
                Those sessions and tokens live in Google Cloud Secret Manager, and only our browser service
                (the part of NeonBinder that talks to marketplaces) can read them. Our app database keeps
                just the flags that say whether you&apos;re connected, plus the marketplace&apos;s id for
                your seller account (and your eBay username, so we can show which account is connected).
              </P>
            </Sub>
            <Sub title="Shipping labels">
              <P>
                If you buy postage through NeonBinder, you use your own EasyPost account. Your EasyPost API
                key is kept in Google Cloud Secret Manager the same way. For each label you buy we keep the
                tracking code, cost, weight, the address it was sent to, the return address you saved, and
                the tracking scans EasyPost reports.
              </P>
            </Sub>
            <Sub title="Your public profile">
              <P>
                A public profile is optional. If you make one, what you put on it is public: your username,
                display name, photo, tagline, links and payment handles. Your trade shelf and the cards
                you have for sale show there too, and photos of the copies they show; each shelf has a
                switch to make it private.
              </P>
            </Sub>
          </Section>

          <Section id="analytics">
            <P>
              We use PostHog for product analytics. It records which pages you visit, what you click,
              how fast pages load, and errors the app runs into, along with the usual details any website
              receives, like your IP address and browser. Some events from our servers are tied to your
              account id. PostHog session recording is switched off.
            </P>
            <P>
              We use Sentry to catch errors and slow pages. Sentry also replays a sample of visits (about
              one in ten, and visits where something broke) so we can see what went wrong. Every bit of
              text on the screen and everything you type is masked in those replays, and the private
              upload links your browser uses are scrubbed out before anything is sent.
            </P>
            <P>
              Clerk uses cookies to keep you signed in, and PostHog keeps an anonymous id in your
              browser.
            </P>
          </Section>

          <Section id="how-we-use-it">
            <List>
              <li>To run the features you use: your collection, card identification, printing and shipping.</li>
              <li>To list your cards on the marketplaces you connect, and keep those listings in step with your counts.</li>
              <li>To pull your sales back, so a card that sold comes out of your box.</li>
              <li>To fix bugs and make NeonBinder better.</li>
            </List>
            <P>
              We do not sell your personal data, and we do not share it for advertising.
            </P>
          </Section>

          <Section id="who-we-share-with">
            <P>Only the services that run NeonBinder for you, and only what each one needs:</P>
            <List>
              <li><strong className="text-ink font-semibold">Clerk</strong> for sign-in.</li>
              <li><strong className="text-ink font-semibold">Convex</strong> for our app database and backend.</li>
              <li><strong className="text-ink font-semibold">Vercel</strong> to host the website.</li>
              <li>
                <strong className="text-ink font-semibold">Google Cloud</strong> to run our services, hold
                marketplace sessions and keys in Secret Manager, store card scans, and read them with Cloud
                Vision.
              </li>
              <li><strong className="text-ink font-semibold">Cloudflare R2</strong> to store your card photos.</li>
              <li><strong className="text-ink font-semibold">Anthropic</strong> to help identify cards from scans.</li>
              <li><strong className="text-ink font-semibold">PostHog</strong> for analytics.</li>
              <li><strong className="text-ink font-semibold">Sentry</strong> for error reports.</li>
              <li><strong className="text-ink font-semibold">EasyPost</strong>, if you buy postage.</li>
              <li>
                <strong className="text-ink font-semibold">The marketplaces you connect</strong>
                (BuySportsCards, SportLots, eBay), to list your cards and read your orders there.
              </li>
            </List>
            <P>
              We&apos;d also hand over data if the law required it. Otherwise it stays between you and
              NeonBinder.
            </P>
          </Section>

          <Section id="ebay">
            <P>
              When you connect eBay, NeonBinder uses eBay&apos;s APIs only for the account you connected,
              and only to:
            </P>
            <List>
              <li>create and update listings for your cards;</li>
              <li>
                read your business policies and ship-from location, and create NeonBinder&apos;s standard
                ones on your account if you press &ldquo;Set me up&rdquo;;
              </li>
              <li>read your orders, so sales come back to your boxes;</li>
              <li>read your eBay user id and username, so we know which account is yours.</li>
            </List>
            <P>
              Disconnect eBay and we take down the listings NeonBinder made where eBay lets us, delete the
              stored tokens, and forget your eBay settings and user id. Your past sales stay in your
              history.
            </P>
            <P>
              eBay notifies us when someone deletes their eBay account. When that happens we delete
              everything we hold for that eBay account: the tokens, the links between your cards and
              your eBay listings, and the eBay sales records. Your NeonBinder collection stays exactly
              where it is.
            </P>
          </Section>

          <Section id="your-choices">
            <List>
              <li>Disconnect eBay from your profile whenever you like.</li>
              <li>Remove your EasyPost key from your profile whenever you like.</li>
              <li>
                Want a BuySportsCards or SportLots sign-in removed? Email us and we&apos;ll delete it.
              </li>
              <li>Edit or delete your cards, boxes and photos any time. Photos of copies that sold are removed on request.</li>
              <li>Make your trade shelf or for-sale cards private from your public profile settings.</li>
              <li>
                To see what we hold about you, or to delete your account and its data, email <ContactLink />.
              </li>
            </List>
          </Section>

          <Section id="keeping-data">
            <P>
              We keep your data while your account is open, because it&apos;s your collection. Card scans
              are deleted after two days, apart from the photos we make from them for a card you save,
              which stay on that copy. Photos you replace or remove are deleted from storage soon
              after. Photos of a copy that sold stay with the sale until you delete your account or ask
              us to remove them. When you ask us to delete your account, we delete it and the data tied to it.
              PostHog and Sentry keep analytics and error reports for their own standard periods.
            </P>
          </Section>

          <Section id="security">
            <P>
              Everything travels over HTTPS. Marketplace sessions, eBay tokens and EasyPost keys sit in
              Google Cloud Secret Manager, out of reach of the app database and the website. Photos are
              served through short-lived signed links. No system is perfect, but we guard this stuff
              like a graded rookie.
            </P>
          </Section>

          <Section id="kids">
            <P>
              NeonBinder is not for kids under 13, and we don&apos;t knowingly collect anything from them.
              If you think a child under 13 has signed up, email us and we&apos;ll delete the account.
            </P>
          </Section>

          <Section id="changes">
            <P>
              If our practices change, we update this page and the &ldquo;Last updated&rdquo; date at the
              top.
            </P>
          </Section>

          <Section id="contact">
            <P>
              Questions, or something you want deleted? Email <ContactLink />.
            </P>
          </Section>
        </article>
        {/* Scroll headroom (NEO-260), the same 208px as the About page and the
            signed-in shell (arithmetic in src/layouts/binder-layout.tsx). */}
        <div aria-hidden="true" className="h-[208px]" />
      </main>
    </>
  );
}
