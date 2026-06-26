import { useNavigate } from "react-router";

export default function AboutPage() {
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
        <div className="max-w-4xl mx-auto">
          {/* Hero Section */}
          <div className="text-center py-12">
            <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-blue to-neon-green">
              About Neon Binder
            </h1>
          </div>

          {/* Content Section */}
          <div className="space-y-8">
            <section className="bg-gradient-to-br from-slate-900/50 to-slate-800/50 rounded-2xl p-8 border border-slate-700/50">
              <h2 className="text-2xl font-bold mb-4 text-neon-green">What is Neon Binder?</h2>
              <p className="text-lg text-slate-300 leading-relaxed">
                Neon Binder is a comprehensive sports card collection management platform available as both a website and mobile app. 
                For collectors, Neon Binder provides a free way to catalog and track your cards using verified manufacturer checklists 
                or by creating your own custom checklists. Cards can be added to your collection manually or identified automatically 
                using AI-powered image recognition—simply snap a photo and let the platform do the work.
              </p>
            </section>

            <section className="bg-gradient-to-br from-slate-900/50 to-slate-800/50 rounded-2xl p-8 border border-slate-700/50">
              <h2 className="text-2xl font-bold mb-4 text-neon-blue">For Sellers & Dealers</h2>
              <p className="text-lg text-slate-300 leading-relaxed">
                Neon Binder&apos;s paid tier transforms your collection into a cross-platform inventory management system. Sync your 
                inventory to multiple marketplaces including eBay, BuySportsCards.com, SportLots.com, and MySlabs.com, all from one 
                central location. When you list a card, Neon Binder automatically updates inventory across all connected platforms. 
                When a sale occurs, the platform watches for it and adjusts your inventory accordingly, eliminating the risk of overselling. 
                Pull Reports streamline your shipping process, while built-in financial tracking helps you monitor sales performance.
              </p>
            </section>

            <section className="bg-gradient-to-br from-slate-900/50 to-slate-800/50 rounded-2xl p-8 border border-slate-700/50">
              <h2 className="text-2xl font-bold mb-4 text-neon-purple">In-Person Sales & Card Shows</h2>
              <p className="text-lg text-slate-300 leading-relaxed">
                Neon Binder also supports in-person sales at card shows and events through QR code generation. Sellers can print QR codes 
                for inventory tracking—when scanned, cards are marked as sold and inventory updates automatically. Buyers can also scan 
                public-facing QR codes to access payment links for Venmo, PayPal, and other services, making transactions quick and seamless.
              </p>
            </section>

            <section className="bg-gradient-to-br from-slate-900/50 to-slate-800/50 rounded-2xl p-8 border border-slate-700/50">
              <h2 className="text-2xl font-bold mb-4 text-neon-pink">Secure Integrations</h2>
              <p className="text-lg text-slate-300 leading-relaxed">
                To enable marketplace integrations, users authorize Neon Binder to connect with their accounts through secure authentication 
                tokens. In cases where platforms don&apos;t provide API access (such as SportLots), users provide their login credentials which are 
                securely stored to automate listing and inventory management.
              </p>
            </section>
          </div>

          {/* CTA Section */}
          <div className="text-center py-16 border-t border-slate-800 mt-12">
            <p className="text-lg text-slate-400 mb-8 max-w-2xl mx-auto">
              Ready to revolutionize how you manage your card collection? Join collectors and sellers across the country who trust Neon Binder.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
