import { ArchiveBoxIcon } from "@heroicons/react/24/outline";

export default function InventoryPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <ArchiveBoxIcon className="w-16 h-16 text-neon-yellow mb-6" />
      <h1
        className="text-4xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-yellow to-neon-green"
        style={{ fontFamily: "'Lexend', sans-serif" }}
      >
        Your Inventory
      </h1>
      <p className="text-lg text-slate-400 max-w-md">
        Inventory management is coming soon. List your cards across all
        platforms and track stock from one place.
      </p>
      <p
        className="text-neon-yellow font-semibold mt-6"
        style={{ textShadow: "0 0 10px rgba(255, 230, 0, 0.4)" }}
      >
        Stay tuned!
      </p>
    </div>
  );
}
